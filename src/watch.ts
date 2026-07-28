import { appendTurn, openCsv, turnRowKey } from "./core/store/csv.js";
import { wrapWords } from "./core/text.js";
import { byteLength, followLines, readCompleteLines } from "./core/tail.js";
import { TurnAssembler } from "./core/turn-assembler.js";
import { computeTurnCost } from "./pricing/cost.js";
import {
  FULL_TABLE_WIDTH,
  MINIMUM_TABLE_WIDTH,
  formatTableHeader,
  formatTurnRow,
  selectLayout,
} from "./ui/live-table.js";
import { terminalWidth } from "./ui/terminal.js";
import type { AssembledTurn } from "./core/turn-assembler.js";
import type { Layout } from "./ui/live-table.js";
import type { NormalizedTurn, ProviderAdapter, SessionRef, TokenUsage } from "./core/types.js";
import type { PricingResolver } from "./pricing/types.js";

export interface WatchOptions {
  readonly session: SessionRef;
  readonly adapter: ProviderAdapter;
  readonly csvPath: string;
  readonly includePromptPreview: boolean;
  /** Resolves model rates. Constructed once per run so its cache is shared. */
  readonly pricing: PricingResolver;
  readonly signal?: AbortSignal;
  readonly write?: (line: string) => void;
  /**
   * The width to fit the table into. Measured from the terminal when absent.
   *
   * A parameter rather than only a measurement so a narrow terminal is
   * reachable from a test, which is the rule `src/options.ts` already follows.
   */
  readonly terminalWidth?: number;
}

/** Where rows go, and the layout the header committed them to. */
interface TableOutput {
  readonly write: (line: string) => void;
  readonly layout: Layout;
}

/** Mutable per-run state: the assembler plus what the CSV already holds. */
interface Recorder {
  readonly assembler: TurnAssembler;
  readonly recordedKeys: Set<string>;
  turnNumber: number;
}

/**
 * Replays the records already in the session file, up to `stopAtByte`.
 *
 * Returns how many turns were newly recorded. Turns already present in the CSV
 * are skipped by turn id, so importing the same history twice is a no-op rather
 * than a duplicate.
 *
 * **No CLI flag reaches this, on purpose.** Backfilled turns would be priced at
 * today's rates, and a rate frozen at the moment a turn closed is the only thing
 * a recorded row has that a row reconstructed from the transcript does not. Rows
 * added here would therefore carry nothing the reporting command cannot rebuild.
 *
 * It stays because it is the batch path through the pipeline -- one file in,
 * turns out -- which is what reporting needs, and because the fixture tests that
 * lock the arithmetic drive it rather than `runWatch`. Reporting will reuse the
 * traversal without the CSV write; its own difference is that it chooses the
 * files instead of being handed one.
 */
export async function importHistory(
  options: WatchOptions & { readonly stopAtByte: number },
): Promise<number> {
  const recorder = await createRecorder(options, {});

  let recorded = 0;
  for await (const line of readCompleteLines(options.session.path, options.stopAtByte)) {
    recorded += await consumeLine(line, options, recorder);
  }

  return recorded;
}

/**
 * Follows the session file and records each turn as it closes, until aborted.
 *
 * Only turns that close after monitoring starts are recorded. The cumulative
 * counter already reflects everything before that point, so the reader seeds the
 * assembler with that prefix as a baseline; without it the first turn would be
 * reported as the whole session.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const startByte = await byteLength(options.session.path);
  const baseline = await readBaseline(options, startByte);
  const recorder = await createRecorder(options, baseline === undefined ? {} : { baseline });

  // Measured once, here, and never again: the layout it produces is handed to
  // the header and to every row after it, so a window resized mid-run cannot
  // leave rows misaligned with the header they were printed under.
  const width = options.terminalWidth ?? terminalWidth(process.stdout);
  const layout = selectLayout(width);

  for (const line of describeNarrowing(layout, width)) write(line);
  for (const line of formatTableHeader(layout)) write(line);

  // Awaited: followLines opens the file and captures its rewrite anchor eagerly,
  // so the window between measuring startByte and reading from it stays closed.
  const lines = await followLines(options.session.path, startByte, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  for await (const line of lines) {
    await consumeLine(line, options, recorder, { write, layout });
  }
}

/**
 * Explains a table that is showing fewer columns than it has.
 *
 * Empty when nothing was dropped, because silence is the honest signal that
 * everything is present. A user who sees a short table asks where the rest
 * went, and the answer needs three parts: the width there is, the width it
 * would take, and what to do about it.
 */
export function describeNarrowing(
  layout: Layout,
  width: number | undefined,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const total = selectLayout(undefined).columns.length;
  if (width === undefined || layout.columns.length === total) return [];

  const wrapping =
    width < MINIMUM_TABLE_WIDTH ? " No layout fits this width, so rows will wrap." : "";

  const text =
    `Terminal is ${width} columns wide; ${FULL_TABLE_WIDTH} are needed for all ${total} ` +
    `columns. Showing ${layout.columns.length}. Widen the window, or force every ` +
    `column with ${overrideCommand(platform)} -- which will wrap until the window ` +
    `is wide enough.${wrapping}`;

  return wrapWords(text, Math.max(width - 1, MINIMUM_TABLE_WIDTH));
}

/**
 * The `COLUMNS` override, written the way the reader's own shell accepts it.
 *
 * Advice in the wrong syntax is not advice. PowerShell rejects a leading
 * `NAME=value`, and a POSIX shell has no idea what `$env:` means, so printing
 * one form to everybody leaves half the users with a command that errors.
 */
function overrideCommand(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `$env:COLUMNS=${FULL_TABLE_WIDTH}`
    : `COLUMNS=${FULL_TABLE_WIDTH}`;
}


async function createRecorder(
  options: WatchOptions,
  baseline: { readonly baseline?: TokenUsage },
): Promise<Recorder> {
  const state = await openCsv(options.csvPath);

  return {
    assembler: new TurnAssembler({
      usageModel: options.adapter.usageModel,
      includePromptPreview: options.includePromptPreview,
      ...baseline,
    }),
    recordedKeys: new Set(state.recordedKeys),
    turnNumber: state.maxTurnNumber,
  };
}

/**
 * Reads the cumulative usage reached by the file prefix that already existed.
 *
 * Per-event providers have no cumulative counter to catch up on, so they need no
 * baseline and the file is not read at all.
 */
async function readBaseline(
  options: WatchOptions,
  stopAtByte: number,
): Promise<TokenUsage | undefined> {
  if (options.adapter.usageModel !== "cumulative") return undefined;

  let latest: TokenUsage | undefined;
  for await (const line of readCompleteLines(options.session.path, stopAtByte)) {
    const record = parseJson(line);
    if (record === undefined) continue;

    for (const event of options.adapter.parseRecord(record)) {
      if (event.kind === "usage") latest = event.usage;
    }
  }

  return latest;
}

/**
 * Feeds one raw line through the adapter and records any turn it closes.
 *
 * `output` is absent when there is nothing to print to, as in `importHistory`.
 * The writer and the layout travel together because neither is usable without
 * the other: a row printed under a layout the header never saw is misaligned.
 */
async function consumeLine(
  line: string,
  options: WatchOptions,
  recorder: Recorder,
  output?: TableOutput,
): Promise<number> {
  const record = parseJson(line);
  if (record === undefined) return 0;

  let recorded = 0;
  for (const event of options.adapter.parseRecord(record)) {
    const assembled = recorder.assembler.push(event);
    if (assembled === undefined) continue;

    const turnId = resolveTurnId(assembled, options.session.sessionId);
    const key = turnRowKey({ turnId, status: assembled.status, at: assembled.at });
    if (recorder.recordedKeys.has(key)) continue;
    recorder.recordedKeys.add(key);

    recorder.turnNumber += 1;
    const turn = normalise(assembled, turnId, recorder.turnNumber, options);

    await appendTurn(options.csvPath, turn);
    recorded += 1;
    if (output !== undefined) {
      for (const row of formatTurnRow(output.layout, turn)) output.write(row);
    }
  }

  return recorded;
}

/**
 * Turns an assembled turn into a recordable row, including its cost.
 *
 * Stays synchronous: the resolver loaded every layer before monitoring started,
 * so this is a map lookup. Pricing happens here rather than in the assembler so
 * the assembler stays pure and clock-free.
 */
function normalise(
  assembled: AssembledTurn,
  turnId: string,
  turnNumber: number,
  options: WatchOptions,
): NormalizedTurn {
  const lookup = options.pricing.lookup(assembled.model);
  const cost = computeTurnCost(assembled.usage, lookup.pricing);

  return {
    provider: options.adapter.id,
    sessionId: options.session.sessionId,
    sessionName: options.session.sessionName,
    turnNumber,
    turnId,
    status: assembled.status,
    at: assembled.at,
    usage: assembled.usage,
    toolCalls: assembled.toolCalls,
    model: assembled.model,
    reasoningEffort: assembled.reasoningEffort,
    promptPreview: assembled.promptPreview,
    costStatus: cost.status,
    pricingVersion: lookup.version,
    ...(cost.amountUsd === undefined ? {} : { costUsd: cost.amountUsd }),
    ...(assembled.durationMs === undefined ? {} : { durationMs: assembled.durationMs }),
    ...(assembled.rateLimits === undefined ? {} : { rateLimits: assembled.rateLimits }),
  };
}

/**
 * The provider's turn id, or a stable substitute when it reported none.
 *
 * Derived only from the session, the closing timestamp and the token total, so
 * re-importing the same history produces the same id and the turn is recognised
 * as already recorded. A random id would duplicate the row on every import.
 */
function resolveTurnId(assembled: AssembledTurn, sessionId: string): string {
  if (assembled.turnId !== undefined) return assembled.turnId;
  return `synthetic-${sessionId}-${assembled.at}-${assembled.usage.total}`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

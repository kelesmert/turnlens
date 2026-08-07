import { normaliseTurn, parseJson, replaySession, resolveTurnId } from "./core/replay.js";
import { appendTurn, openCsv, turnRowKey } from "./core/store/csv.js";
import { wrapWords } from "./core/text.js";
import { byteLength, followLines, readCompleteLines } from "./core/tail.js";
import { TurnAssembler } from "./core/turn-assembler.js";
import { addUsage, emptyUsage } from "./core/usage.js";
import { formatHistoryBlock } from "./ui/history.js";
import {
  FULL_TABLE_WIDTH,
  MINIMUM_TABLE_WIDTH,
  formatTableHeader,
  formatTurnRow,
  selectLayout,
} from "./ui/live-table.js";
import { PLAIN } from "./ui/colour.js";
import { terminalWidth } from "./ui/terminal.js";
import type { HistoryTotals } from "./ui/history.js";
import type { Layout } from "./ui/live-table.js";
import type { Paint } from "./ui/colour.js";
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
  /**
   * How each role is painted. Absent means plain, which is what every test uses.
   *
   * Chosen by the caller so this module never asks whether the output is a
   * terminal; it already takes its width the same way.
   */
  readonly paint?: Paint;
}

/** Where rows go, the layout the header committed them to, and how they are painted. */
interface TableOutput {
  readonly write: (line: string) => void;
  readonly layout: Layout;
  readonly paint: Paint;
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
 * It stays because the fixture tests that lock the arithmetic drive it rather
 * than `runWatch`. What it no longer owns is the traversal: `replaySession` in
 * `core/replay.ts` is the batch path, and this is that path plus a CSV. The only
 * things left here are the three the store needs, which is deduping by turn id,
 * continuing the CSV's turn numbering, and appending.
 */
export async function importHistory(
  options: WatchOptions & { readonly stopAtByte: number },
): Promise<number> {
  const state = await openCsv(options.csvPath);
  const recordedKeys = new Set(state.recordedKeys);
  let turnNumber = state.maxTurnNumber;

  let recorded = 0;
  for await (const replayed of replaySession({
    session: options.session,
    adapter: options.adapter,
    pricing: options.pricing,
    stopAtByte: options.stopAtByte,
    includePromptPreview: options.includePromptPreview,
  })) {
    const key = turnRowKey(replayed);
    if (recordedKeys.has(key)) continue;
    recordedKeys.add(key);

    // Renumbered rather than taken from the replay. Replay counts within the
    // transcript; the CSV counts within itself, and an import into a file that
    // already holds rows continues that file's sequence.
    turnNumber += 1;
    await appendTurn(options.csvPath, { ...replayed, turnNumber });
    recorded += 1;
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
  const history = await readHistory(options, startByte);
  const recorder = await createRecorder(options, baseline === undefined ? {} : { baseline });

  // Measured once, here, and never again: the layout it produces is handed to
  // the header and to every row after it, so a window resized mid-run cannot
  // leave rows misaligned with the header they were printed under.
  const width = options.terminalWidth ?? terminalWidth(process.stdout);
  const layout = selectLayout(width);
  const paint = options.paint ?? PLAIN;

  for (const line of formatHistoryBlock(history, width)) write(line);
  for (const line of describeNarrowing(layout, width)) write(line);
  for (const line of formatTableHeader(layout, paint)) write(line);

  // Awaited: followLines opens the file and captures its rewrite anchor eagerly,
  // so the window between measuring startByte and reading from it stays closed.
  const lines = await followLines(options.session.path, startByte, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  for await (const line of lines) {
    await consumeLine(line, options, recorder, { write, layout, paint });
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
 * Prices the turns the session closed before monitoring started.
 *
 * Read for every provider, unlike the baseline below, because the figure is for
 * the user rather than for the arithmetic: it answers what this session has cost
 * so far, which is the question the live table cannot answer on its own.
 *
 * **This is a second pass over the prefix for cumulative providers,** which
 * already read it for the baseline. Merging the two would mean seeding the
 * assembler from what this pass ends up holding, and the two candidate values
 * differ: `readBaseline` returns the last cumulative counter the file reported,
 * while an assembler's own baseline counts only the turns it closed. They come
 * apart exactly when the prefix ends mid-turn, and which one should seed the
 * watch is a behavioural question with a live turn's cost hanging on it. Not one
 * to settle as a side effect of adding a summary.
 */
async function readHistory(
  options: WatchOptions,
  stopAtByte: number,
): Promise<HistoryTotals> {
  let turns = 0;
  let unpricedTurns = 0;
  let pricedTurns = 0;
  let costUsd = 0;
  let usage = emptyUsage();

  for await (const turn of replaySession({
    session: options.session,
    adapter: options.adapter,
    pricing: options.pricing,
    stopAtByte,
  })) {
    turns += 1;
    usage = addUsage(usage, turn.usage);
    if (turn.costUsd === undefined) unpricedTurns += 1;
    else {
      costUsd += turn.costUsd;
      pricedTurns += 1;
    }
  }

  // Absent rather than zero when nothing could be priced. A zero would read as a
  // free session and would join a sum as one.
  return { turns, usage, unpricedTurns, ...(pricedTurns === 0 ? {} : { costUsd }) };
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
    const turn = normaliseTurn({
      assembled,
      turnNumber: recorder.turnNumber,
      session: options.session,
      provider: options.adapter.id,
      pricing: options.pricing,
    });

    await appendTurn(options.csvPath, turn);
    recorded += 1;
    if (output !== undefined) {
      for (const row of formatTurnRow(output.layout, turn, output.paint)) output.write(row);
    }
  }

  return recorded;
}


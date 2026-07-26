import { appendTurn, openCsv, turnRowKey } from "./core/store/csv.js";
import { byteLength, followLines, readCompleteLines } from "./core/tail.js";
import { TurnAssembler } from "./core/turn-assembler.js";
import { computeTurnCost } from "./pricing/cost.js";
import { formatTableHeader, formatTurnRow } from "./ui/live-table.js";
import type { AssembledTurn } from "./core/turn-assembler.js";
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

  for (const line of formatTableHeader()) write(line);

  // Awaited: followLines opens the file and captures its rewrite anchor eagerly,
  // so the window between measuring startByte and reading from it stays closed.
  const lines = await followLines(options.session.path, startByte, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  for await (const line of lines) {
    await consumeLine(line, options, recorder, write);
  }
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

/** Feeds one raw line through the adapter and records any turn it closes. */
async function consumeLine(
  line: string,
  options: WatchOptions,
  recorder: Recorder,
  write?: (line: string) => void,
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
    if (write !== undefined) for (const row of formatTurnRow(turn)) write(row);
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

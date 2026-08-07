import { readCompleteLines } from "./tail.js";
import { TurnAssembler } from "./turn-assembler.js";
import { computeTurnCost } from "../pricing/cost.js";
import type { AssembledTurn } from "./turn-assembler.js";
import type { NormalizedTurn, ProviderAdapter, SessionRef } from "./types.js";
import type { PricingResolver } from "../pricing/types.js";

export interface ReplayOptions {
  readonly session: SessionRef;
  readonly adapter: ProviderAdapter;
  /** Resolves model rates. Constructed once per run so its cache is shared. */
  readonly pricing: PricingResolver;
  /** Stop at this byte offset. Absent reads the whole file. */
  readonly stopAtByte?: number;
  /** Defaults to false. Reporting never wants prompt text. */
  readonly includePromptPreview?: boolean;
}

/**
 * Yields every turn a transcript closes, in file order, priced.
 *
 * This is the batch path through the pipeline: one file in, turns out, and
 * nowhere for them to be written. Everything that reads a whole transcript sits
 * on it, which is why it takes no destination. `importHistory` adds the CSV,
 * `runWatch` adds the tail and the table, and reporting adds aggregation; none of
 * them re-implements the traversal.
 *
 * A generator rather than an array because reporting reads every session in turn
 * and one session here is 25 MB. Yielding keeps one transcript's turns in memory
 * instead of every session's.
 *
 * **No baseline is seeded.** Codex reports cumulative counters, and a replay from
 * the beginning of the file measures the first turn's delta from zero, which is
 * correct. `runWatch` starts mid-file and needs the opposite, which is why
 * `readBaseline` lives there and not here.
 */
export async function* replaySession(options: ReplayOptions): AsyncGenerator<NormalizedTurn> {
  const assembler = new TurnAssembler({
    usageModel: options.adapter.usageModel,
    includePromptPreview: options.includePromptPreview ?? false,
  });

  let turnNumber = 0;
  for await (const line of readCompleteLines(options.session.path, options.stopAtByte)) {
    const record = parseJson(line);
    if (record === undefined) continue;

    for (const event of options.adapter.parseRecord(record)) {
      const assembled = assembler.push(event);
      if (assembled === undefined) continue;

      turnNumber += 1;
      yield normaliseTurn({
        assembled,
        turnNumber,
        session: options.session,
        provider: options.adapter.id,
        pricing: options.pricing,
      });
    }
  }
}

interface NormaliseInput {
  readonly assembled: AssembledTurn;
  readonly turnNumber: number;
  readonly session: SessionRef;
  readonly provider: string;
  readonly pricing: PricingResolver;
}

/**
 * Turns an assembled turn into a recordable row, including its cost.
 *
 * Stays synchronous: the resolver loaded every layer before any loop started, so
 * this is a map lookup. Pricing happens here rather than in the assembler so the
 * assembler stays pure and clock-free.
 */
export function normaliseTurn(input: NormaliseInput): NormalizedTurn {
  const { assembled, session } = input;
  const lookup = input.pricing.lookup(assembled.model);
  const cost = computeTurnCost(assembled.usage, lookup.pricing);

  return {
    provider: input.provider,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    turnNumber: input.turnNumber,
    turnId: resolveTurnId(assembled, session.sessionId),
    status: assembled.status,
    at: assembled.at,
    ...(assembled.startedAt === undefined ? {} : { startedAt: assembled.startedAt }),
    usage: assembled.usage,
    toolCalls: assembled.toolCalls,
    model: assembled.model,
    reasoningEffort: assembled.reasoningEffort,
    promptPreview: assembled.promptPreview,
    costStatus: cost.status,
    pricingVersion: lookup.version,
    ...(cost.amountUsd === undefined ? {} : { costUsd: cost.amountUsd }),
    ...(assembled.durationMs === undefined ? {} : { durationMs: assembled.durationMs }),
  };
}

/**
 * The provider's turn id, or a stable substitute when it reported none.
 *
 * Derived only from the session, the closing timestamp and the token total, so
 * re-reading the same history produces the same id and the turn is recognised as
 * already recorded. A random id would duplicate the row on every import.
 */
export function resolveTurnId(assembled: AssembledTurn, sessionId: string): string {
  if (assembled.turnId !== undefined) return assembled.turnId;
  return `synthetic-${sessionId}-${assembled.at}-${assembled.usage.total}`;
}

export function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

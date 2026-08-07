import { addUsage, emptyUsage } from "../core/usage.js";
import { wrapWords } from "../core/text.js";
import type { NormalizedTurn, TokenUsage } from "../core/types.js";

const LABEL_WIDTH = 24;
const ABSENT = "-";

/**
 * One column of the terminal is left unused, for the reason the table leaves
 * one: a line filling the last column is recorded as continuing into the next,
 * and widening the window afterwards re-flows the two together.
 */
const RULE_RESERVE = 1;

/**
 * Everything the history block and the exit summary say, folded from turns.
 *
 * **Folded rather than read back.** This used to be computed by reparsing the
 * session CSV, which made the summary a statement about one file: a run that
 * recorded nothing still reported the whole file's totals, and the figures
 * changed with the directory the command was run from, because that is where the
 * CSV lands. Turns come from the transcript, so these figures describe the
 * session and nothing else.
 *
 * The cost is therefore at today's rates throughout, matching the history block
 * above the table. A recorded row still carries the rate that was in force when
 * its turn closed; that is what the CSV is for, and nothing here reads it.
 *
 * Durations are kept as a count, a sum and a maximum rather than as a list,
 * because only an average and a longest are printed and a list grows with the
 * session.
 */
export interface SessionTotals {
  readonly turns: number;
  readonly aborted: number;
  readonly usage: TokenUsage;
  readonly toolCalls: number;
  /** Absent when nothing here could be priced. Absent never means free. */
  readonly costUsd?: number;
  readonly pricedTurns: number;
  readonly unpricedTurns: number;
  /** Keyed by `costStatus`, which is why a turn could not be priced. */
  readonly unpricedReasons: ReadonlyMap<string, number>;
  readonly pricingVersions: ReadonlyMap<string, number>;
  readonly models: ReadonlyMap<string, number>;
  readonly efforts: ReadonlyMap<string, number>;
  readonly tools: ReadonlyMap<string, number>;
  readonly durationCount: number;
  readonly durationTotalMs: number;
  readonly longestDurationMs: number;
}

export function emptyTotals(): SessionTotals {
  return {
    turns: 0,
    aborted: 0,
    usage: emptyUsage(),
    toolCalls: 0,
    pricedTurns: 0,
    unpricedTurns: 0,
    unpricedReasons: new Map(),
    pricingVersions: new Map(),
    models: new Map(),
    efforts: new Map(),
    tools: new Map(),
    durationCount: 0,
    durationTotalMs: 0,
    longestDurationMs: 0,
  };
}

/**
 * Folds one turn in, returning new totals.
 *
 * Pure, like `report/aggregate.ts`'s fold and for the same reason: a caller can
 * keep the session's running totals beside anything else without the two
 * interfering.
 */
export function addTurn(totals: SessionTotals, turn: NormalizedTurn): SessionTotals {
  const priced = turn.costUsd !== undefined;
  const duration = turn.durationMs;

  return {
    turns: totals.turns + 1,
    aborted: totals.aborted + (turn.status === "aborted" ? 1 : 0),
    usage: addUsage(totals.usage, turn.usage),
    toolCalls: totals.toolCalls + countToolCalls(turn),
    pricedTurns: totals.pricedTurns + (priced ? 1 : 0),
    unpricedTurns: totals.unpricedTurns + (priced ? 0 : 1),
    unpricedReasons: priced
      ? totals.unpricedReasons
      : counted(totals.unpricedReasons, turn.costStatus),
    pricingVersions: counted(totals.pricingVersions, turn.pricingVersion),
    models: counted(totals.models, turn.model),
    efforts: counted(totals.efforts, turn.reasoningEffort),
    tools: withToolCalls(totals.tools, turn.toolCalls),
    durationCount: totals.durationCount + (duration === undefined ? 0 : 1),
    durationTotalMs: totals.durationTotalMs + (duration ?? 0),
    longestDurationMs: Math.max(totals.longestDurationMs, duration ?? 0),
    ...sumCost(totals.costUsd, turn.costUsd),
  };
}

/**
 * Adds two costs, keeping absent distinct from zero.
 *
 * Returned as an object to spread rather than as a number, because the field has
 * to stay absent when neither side has one: a zero would join a spreadsheet sum
 * and could not be told from a session that genuinely cost nothing.
 */
function sumCost(
  running: number | undefined,
  addition: number | undefined,
): { readonly costUsd?: number } {
  if (addition === undefined) return running === undefined ? {} : { costUsd: running };
  return { costUsd: (running ?? 0) + addition };
}

/**
 * Renders the block printed when monitoring ends.
 *
 * Describes the session, never the account as a whole. The cost total covers
 * only the turns that could be priced; turns that could not be are counted
 * separately rather than folded in as free, because a zero and an unknown are
 * different facts and only one of them belongs in a sum.
 */
export function formatSessionSummary(
  totals: SessionTotals,
  availableWidth?: number,
): readonly string[] {
  const ceiling =
    availableWidth === undefined ? Number.POSITIVE_INFINITY : availableWidth - RULE_RESERVE;

  if (totals.turns === 0) return boxed(["No turns in this session."], ceiling);

  const { usage } = totals;
  const totalInput = usage.inputUncached + usage.cacheRead;
  const cacheRatio = totalInput === 0 ? 0 : (usage.cacheRead / totalInput) * 100;

  const lines = [
    entry("Session turns", formatCount(totals.turns)),
    entry("Aborted turns", formatCount(totals.aborted)),
    entry("Uncached input tokens", formatCount(usage.inputUncached)),
    entry("Cache read tokens", formatCount(usage.cacheRead)),
    entry("Cache ratio", `${cacheRatio.toFixed(1)}%`),
    entry("Output tokens", formatCount(usage.output)),
    entry("Reasoning tokens", formatCount(usage.reasoning)),
    entry("Total tokens", formatCount(usage.total)),
    entry("Tool calls", formatCount(totals.toolCalls)),
    entry(
      "Estimated cost",
      totals.pricedTurns === 0 || totals.costUsd === undefined
        ? "unavailable"
        : `$${totals.costUsd.toFixed(6)}`,
    ),
    entry("Average duration", formatSeconds(averageDuration(totals))),
    entry("Longest duration", formatSeconds(longestDuration(totals))),
  ];

  if (totals.unpricedTurns > 0) {
    lines.push(
      entry(
        "Unpriced turns",
        `${formatCount(totals.unpricedTurns)} (${describe(totals.unpricedReasons)})`,
      ),
    );
  }
  if (totals.pricingVersions.size > 0) {
    lines.push(entry("Pricing data", describe(totals.pricingVersions)));
  }
  if (totals.models.size > 0) lines.push(entry("Models", describe(totals.models)));
  if (totals.efforts.size > 0) lines.push(entry("Reasoning efforts", describe(totals.efforts)));
  if (totals.tools.size > 0) lines.push(entry("Tool breakdown", describe(totals.tools)));

  return boxed(lines, ceiling);
}

function entry(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}: ${value}`;
}

/**
 * Wraps the entries, then draws the rule around what they came to.
 *
 * The rule used to be a fixed 72 while a tool breakdown measured 106, so the
 * block drew a box its own contents broke out of -- the same defect the startup
 * banner had, at the other end of the run and on the last line the user sees.
 *
 * Continuation lines are indented under the value rather than the label, so a
 * wrapped breakdown still reads as one entry.
 */
function boxed(entries: readonly string[], ceiling: number): readonly string[] {
  const indent = " ".repeat(LABEL_WIDTH + 2);
  const body = entries.flatMap((line) => {
    if (line.length <= ceiling) return [line];

    // Only the value is wrapped, to the room left beside the indent the
    // continuation lines carry. Wrapping the whole line instead would size
    // every part to the full width and then push the indented ones past it.
    const [head, ...parts] = wrapWords(
      line.slice(indent.length),
      Math.max(ceiling - indent.length, 1),
    );
    return [line.slice(0, indent.length) + head, ...parts.map((part) => indent + part)];
  });

  const longest = Math.max(...body.map((line) => line.length), "Session summary".length);
  const rule = "=".repeat(Math.max(Math.min(longest, ceiling), 1));

  return ["", "Session summary", rule, ...body, rule];
}

/** Returns a counter with one added against `key`. An empty key counts nothing. */
function counted(counter: ReadonlyMap<string, number>, key: string): ReadonlyMap<string, number> {
  if (key === "") return counter;
  return new Map(counter).set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * Folds a turn's tool calls into the running breakdown.
 *
 * The turn carries them as an object, so nothing is parsed here. The CSV column
 * holding the same figures is written from this object rather than read back
 * into it.
 */
function withToolCalls(
  counter: ReadonlyMap<string, number>,
  calls: Readonly<Record<string, number>>,
): ReadonlyMap<string, number> {
  const entries = Object.entries(calls);
  if (entries.length === 0) return counter;

  const next = new Map(counter);
  for (const [name, count] of entries) next.set(name, (next.get(name) ?? 0) + count);
  return next;
}

function countToolCalls(turn: NormalizedTurn): number {
  return Object.values(turn.toolCalls).reduce((sum, count) => sum + count, 0);
}

function describe(counter: ReadonlyMap<string, number>): string {
  return [...counter.entries()]
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

function averageDuration(totals: SessionTotals): number | undefined {
  if (totals.durationCount === 0) return undefined;
  return totals.durationTotalMs / totals.durationCount;
}

function longestDuration(totals: SessionTotals): number | undefined {
  return totals.durationCount === 0 ? undefined : totals.longestDurationMs;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSeconds(durationMs: number | undefined): string {
  return durationMs === undefined ? ABSENT : `${(durationMs / 1_000).toFixed(1)}s`;
}

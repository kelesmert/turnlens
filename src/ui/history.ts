import { wrapWords } from "../core/text.js";
import type { TokenUsage } from "../core/types.js";

/** What the session already held when the watch started. */
export interface HistoryTotals {
  readonly turns: number;
  readonly usage: TokenUsage;
  /** Absent when no turn in the history could be priced. Absent never means free. */
  readonly costUsd?: number;
  readonly unpricedTurns: number;
}

/**
 * Describes the turns a session closed before the watch started.
 *
 * Prose above the table rather than rows inside it, and the reasoning is the
 * difference between the two figures. Every turn here is priced at today's
 * rates, because the transcript records tokens and not the rate that was in
 * force when the turn closed. A row the watcher records carries the rate of its
 * own moment. Mixing the two in one table would mean marking the difference on
 * every row of it; saying it once, here, costs one line.
 *
 * Empty when nothing closed, because a session with no history has none to
 * describe and a block reading zero is noise.
 */
export function formatHistoryBlock(
  totals: HistoryTotals,
  /** Absent when there is no terminal to measure, as in a pipe. Nothing wraps. */
  availableWidth: number | undefined,
): readonly string[] {
  if (totals.turns === 0) return [];

  const width = availableWidth ?? Number.POSITIVE_INFINITY;

  const cost = totals.costUsd === undefined ? "unavailable" : `$${totals.costUsd.toFixed(2)}`;
  const lines = [
    ...wrapWords(
      `History: ${count(totals.turns, "turn")}, ` +
        `${totals.usage.total.toLocaleString("en-US")} tokens, ` +
        `${cost} at today's rates.`,
      width,
    ),
  ];

  if (totals.unpricedTurns > 0) {
    lines.push(...wrapWords(`${count(totals.unpricedTurns, "turn")} could not be priced.`, width));
  }

  return lines;
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

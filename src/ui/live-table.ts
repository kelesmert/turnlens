import { truncate } from "../core/text.js";
import type { NormalizedTurn, RateLimits } from "../core/types.js";

const MODEL_WIDTH = 18;
const PREVIEW_WIDTH = 20;
const ABSENT = "-";

interface Column {
  readonly label: string;
  readonly width: number;
  /** Counts and percentages read better right-aligned under their heading. */
  readonly alignRight?: true;
}

/**
 * Renders a rate-limit window length in the units the agent actually reported.
 *
 * The previous implementation printed fixed `5 hour` and `Week` headings while
 * recording `window_minutes` and never reading it, so the labels were a guess
 * presented as fact (known-bugs.md P3-5). An unreported window reads as `-`.
 */
export function formatWindowLabel(windowMinutes: number | undefined): string {
  if (windowMinutes === undefined || windowMinutes <= 0) return ABSENT;
  if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/**
 * Builds the column line and its separator rule.
 *
 * `rateLimits` only supplies the two limit-column headings. Passing none is the
 * normal case at startup, before any usage record has been seen.
 */
export function formatTableHeader(rateLimits?: RateLimits): readonly string[] {
  const columns = describeColumns(rateLimits);
  const header = columns.map((column) => fit(column.label, column)).join(" ");

  return [header, "-".repeat(header.length)];
}

/**
 * Renders one turn as a row, plus a tool-breakdown line when tools were called.
 *
 * Always at least one line, never more than two, and never containing a newline:
 * the caller writes each returned string as its own line.
 */
export function formatTurnRow(turn: NormalizedTurn): readonly string[] {
  const columns = describeColumns(turn.rateLimits);
  const values = [
    String(turn.turnNumber),
    formatClockTime(turn.at),
    turn.status,
    orAbsent(truncate(turn.promptPreview, PREVIEW_WIDTH)),
    formatCount(turn.usage.inputUncached),
    formatCount(turn.usage.cacheRead),
    formatCount(turn.usage.output),
    formatCount(turn.usage.reasoning),
    formatCount(turn.usage.total),
    formatPercent(turn.rateLimits?.primaryUsedPercent),
    formatPercent(turn.rateLimits?.secondaryUsedPercent),
    formatCount(countToolCalls(turn)),
    orAbsent(truncate(turn.model, MODEL_WIDTH)),
    orAbsent(turn.reasoningEffort),
    formatDuration(turn.durationMs),
  ];

  const lines = [columns.map((column, index) => fit(values[index] ?? ABSENT, column)).join(" ")];

  const breakdown = describeToolCalls(turn.toolCalls);
  if (breakdown !== "") lines.push(`      Tool calls: ${breakdown}`);

  return lines;
}

/**
 * The column layout, shared by the header and the rows so they cannot drift.
 *
 * The two limit headings are the only part that depends on observed data.
 */
function describeColumns(rateLimits: RateLimits | undefined): readonly Column[] {
  return [
    { label: "#", width: 4, alignRight: true },
    { label: "Time", width: 8 },
    { label: "Status", width: 9 },
    { label: "Prompt", width: PREVIEW_WIDTH },
    { label: "Input", width: 11, alignRight: true },
    { label: "Cache", width: 11, alignRight: true },
    { label: "Output", width: 9, alignRight: true },
    { label: "Reason", width: 9, alignRight: true },
    { label: "Total", width: 12, alignRight: true },
    { label: formatWindowLabel(rateLimits?.primaryWindowMinutes), width: 8, alignRight: true },
    { label: formatWindowLabel(rateLimits?.secondaryWindowMinutes), width: 8, alignRight: true },
    { label: "Tools", width: 5, alignRight: true },
    { label: "Model", width: MODEL_WIDTH },
    { label: "Effort", width: 8 },
    { label: "Duration", width: 9, alignRight: true },
  ];
}

function describeToolCalls(toolCalls: Readonly<Record<string, number>>): string {
  return Object.entries(toolCalls)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

function countToolCalls(turn: NormalizedTurn): number {
  return Object.values(turn.toolCalls).reduce((sum, count) => sum + count, 0);
}

/** Local wall-clock time of the turn. Unparseable timestamps read as `-`. */
function formatClockTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return ABSENT;
  return parsed.toTimeString().slice(0, 8);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? ABSENT : `${value.toFixed(1)}%`;
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? ABSENT : `${(durationMs / 1_000).toFixed(1)}s`;
}

function orAbsent(value: string): string {
  return value === "" ? ABSENT : value;
}

/** Pads to the column width, truncating anything that would break the layout. */
function fit(value: string, column: Column): string {
  const clipped = truncate(value, column.width);
  return column.alignRight === true
    ? clipped.padStart(column.width)
    : clipped.padEnd(column.width);
}

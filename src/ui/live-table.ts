import { truncate, truncateEnd } from "../core/text.js";
import type { NormalizedTurn, RateLimits, SessionRef } from "../core/types.js";

const MODEL_WIDTH = 18;
const COST_WIDTH = 10;
const PREVIEW_WIDTH = 20;
const ABSENT = "-";

/**
 * Names the columns so a value can be paired with its heading by identity.
 *
 * The pairing used to be positional, which held only while every column was
 * always present. It is not, and a value list one shorter than the column list
 * renders a full row of headings above the wrong numbers.
 */
export type ColumnId =
  | "index"
  | "time"
  | "status"
  | "prompt"
  | "input"
  | "cache"
  | "output"
  | "reasoning"
  | "total"
  | "cost"
  | "primaryLimit"
  | "secondaryLimit"
  | "tools"
  | "model"
  | "effort"
  | "duration";

interface Column {
  readonly id: ColumnId;
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
 * presented as fact. An unreported window reads as `-`.
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
  const values = describeValues(turn);

  const lines = [columns.map((column) => fit(values[column.id], column)).join(" ")];

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
    { id: "index", label: "#", width: 4, alignRight: true },
    { id: "time", label: "Time", width: 8 },
    { id: "status", label: "Status", width: 9 },
    { id: "prompt", label: "Prompt", width: PREVIEW_WIDTH },
    { id: "input", label: "Input", width: 11, alignRight: true },
    { id: "cache", label: "Cache", width: 11, alignRight: true },
    { id: "output", label: "Output", width: 9, alignRight: true },
    { id: "reasoning", label: "Reason", width: 9, alignRight: true },
    { id: "total", label: "Total", width: 12, alignRight: true },
    { id: "cost", label: "Cost", width: COST_WIDTH, alignRight: true },
    {
      id: "primaryLimit",
      label: formatWindowLabel(rateLimits?.primaryWindowMinutes),
      width: 8,
      alignRight: true,
    },
    {
      id: "secondaryLimit",
      label: formatWindowLabel(rateLimits?.secondaryWindowMinutes),
      width: 8,
      alignRight: true,
    },
    { id: "tools", label: "Tools", width: 5, alignRight: true },
    { id: "model", label: "Model", width: MODEL_WIDTH },
    { id: "effort", label: "Effort", width: 8 },
    { id: "duration", label: "Duration", width: 9, alignRight: true },
  ];
}

/**
 * The width the full table renders to, computed from the columns themselves.
 *
 * Never written down. A column added, removed or resized moves this without
 * anyone remembering to, which is the property that keeps the layout rules
 * honest once they start comparing it against a terminal.
 */
export const FULL_TABLE_WIDTH = renderedWidth(describeColumns(undefined));

/** Column widths plus the single space between each neighbouring pair. */
function renderedWidth(columns: readonly Column[]): number {
  if (columns.length === 0) return 0;
  return columns.reduce((sum, column) => sum + column.width, 0) + columns.length - 1;
}

/**
 * Every cell one turn can produce, keyed by the column it belongs under.
 *
 * Building all of them regardless of which columns are shown keeps this free of
 * layout decisions: the renderer reads the cells it has headings for.
 */
function describeValues(turn: NormalizedTurn): Readonly<Record<ColumnId, string>> {
  return {
    index: String(turn.turnNumber),
    time: formatClockTime(turn.at),
    status: turn.status,
    prompt: orAbsent(truncate(turn.promptPreview, PREVIEW_WIDTH)),
    input: formatCount(turn.usage.inputUncached),
    cache: formatCount(turn.usage.cacheRead),
    output: formatCount(turn.usage.output),
    reasoning: formatCount(turn.usage.reasoning),
    total: formatCount(turn.usage.total),
    cost: formatCost(turn.costUsd),
    primaryLimit: formatPercent(turn.rateLimits?.primaryUsedPercent),
    secondaryLimit: formatPercent(turn.rateLimits?.secondaryUsedPercent),
    tools: formatCount(countToolCalls(turn)),
    model: orAbsent(truncate(turn.model, MODEL_WIDTH)),
    effort: orAbsent(turn.reasoningEffort),
    duration: formatDuration(turn.durationMs),
  };
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

/**
 * Renders a turn cost for a terminal.
 *
 * Four decimals is the finest a reader can compare at a glance; the CSV keeps
 * six for arithmetic. An unpriced turn reads as `-`, never as `$0.0000`, which
 * would be indistinguishable from a genuinely free turn.
 */
function formatCost(amountUsd: number | undefined): string {
  return amountUsd === undefined ? ABSENT : `$${amountUsd.toFixed(4)}`;
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

/**
 * Width of the session listing, and of the rule drawn above it.
 *
 * The columns below add up to exactly this. They used to add up to more: the
 * rule was 100 characters and a row was 106 for Claude Code and 145 for Codex,
 * whose session id carries a date path. Any terminal narrower than the row
 * wrapped it, and a wrapped row reads as corruption rather than as a long line.
 */
export const SESSION_LISTING_WIDTH = 100;

const INDEX_WIDTH = 3;
const WHEN_WIDTH = 19;

/**
 * The name gives up six characters so the id can keep a whole uuid.
 *
 * 39 is not arbitrary: a uuid is 36 characters, and three more hold the mark
 * that says a longer id was cut. At that width a Claude Code id is shown whole
 * and a Codex id keeps its uuid, which is the part that matches a CSV filename.
 * Anything narrower and one of the two providers loses its identifier.
 */
const SESSION_NAME_WIDTH = 33;
const SESSION_ID_WIDTH = 39;

/**
 * Renders the numbered session list the user chooses from.
 *
 * The name is cut from the right and the id from the left. A name reads
 * front-to-back, while an id is identified by its tail: a Codex id is
 * `<year>/<month>/<day>/rollout-<timestamp>-<uuid>`, and its date is already in
 * the column beside it. The full id stays available in the startup banner and in
 * the CSV filename; nothing here is the only copy.
 */
export function formatSessionListing(sessions: readonly SessionRef[]): readonly string[] {
  const rows = sessions.map((session, index) => {
    const when = new Date(session.lastActivityMs).toISOString().slice(0, 19).replace("T", " ");
    return [
      String(index + 1).padStart(INDEX_WIDTH),
      when.padEnd(WHEN_WIDTH),
      truncate(session.sessionName, SESSION_NAME_WIDTH).padEnd(SESSION_NAME_WIDTH),
      truncateEnd(session.sessionId, SESSION_ID_WIDTH),
    ].join("  ");
  });

  return ["", "Available sessions, most recent first", "=".repeat(SESSION_LISTING_WIDTH), ...rows];
}

import { truncate, truncateEnd } from "../core/text.js";
import type { NormalizedTurn, RateLimits, SessionRef } from "../core/types.js";

const MODEL_WIDTH = 18;
const COST_WIDTH = 10;
const PREVIEW_WIDTH = 20;
const ABSENT = "-";

/**
 * How far the two flexible columns may be squeezed.
 *
 * Twelve characters still shows the distinguishing head of a prompt and enough
 * of a model name to tell one family from another. Below that both become
 * ellipsis with a hint attached, which is worse than dropping the column.
 */
const PREVIEW_MIN_WIDTH = 12;
const MODEL_MIN_WIDTH = 12;

/**
 * One column of the terminal is never used, and the reason is not aesthetic.
 *
 * A line that fills the last column leaves the cursor at the right margin, and
 * terminals record such a line as continuing into the next one. Widening the
 * window afterwards re-flows the pair together: a rule printed at exactly the
 * terminal width was seen running past the last column it belonged to, on
 * Windows, after the window was maximised. Fitting one character short means no
 * line is ever a continuation, whatever the terminal believes about margins. It
 * also absorbs the terminals and remote sessions that report their width off by
 * one.
 */
const LAST_COLUMN_RESERVE = 1;

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

/**
 * The only two things `fit` needs to know about a column.
 *
 * Structural rather than `Column`, because the report has its own column ids and
 * the padding is the same job in both tables. Widening this instead of copying
 * `fit` keeps one place deciding how a cell is cut and padded.
 */
export interface FittedColumn {
  readonly width: number;
  /** Counts and percentages read better right-aligned under their heading. */
  readonly alignRight?: true;
}

export interface Column extends FittedColumn {
  readonly id: ColumnId;
  readonly label: string;
  /** Absent when the column cannot be shortened without becoming unreadable. */
  readonly minWidth?: number;
  /** Absent when the column is never dropped. Lower goes first. */
  readonly dropPriority?: number;
}

/**
 * The columns chosen for one run, fixed for its whole life.
 *
 * A layout is selected once, before the header is printed, and handed to every
 * row after it. Nothing downstream measures anything, so a row cannot disagree
 * with the header above it however the window is resized afterwards.
 */
export interface Layout {
  readonly columns: readonly Column[];
  readonly width: number;
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
export function formatTableHeader(layout: Layout, rateLimits?: RateLimits): readonly string[] {
  const header = layout.columns
    .map((column) => fit(labelFor(column, rateLimits), column))
    .join(" ");

  return [header, "-".repeat(header.length)];
}

/**
 * The heading a column shows, which for the two limit columns is observed.
 *
 * Their labels are the only part of the header that depends on data, so they
 * are resolved here rather than baked into the layout, which is chosen before
 * any usage record has been seen.
 */
function labelFor(column: Column, rateLimits: RateLimits | undefined): string {
  if (column.id === "primaryLimit") return formatWindowLabel(rateLimits?.primaryWindowMinutes);
  if (column.id === "secondaryLimit") return formatWindowLabel(rateLimits?.secondaryWindowMinutes);
  return column.label;
}

/**
 * Renders one turn as a row, plus a tool-breakdown line when tools were called.
 *
 * Always at least one line, never more than two, and never containing a newline:
 * the caller writes each returned string as its own line.
 */
export function formatTurnRow(layout: Layout, turn: NormalizedTurn): readonly string[] {
  const values = describeValues(turn);
  const lines = [layout.columns.map((column) => fit(values[column.id], column)).join(" ")];

  const breakdown = describeToolCalls(turn.toolCalls);
  if (breakdown !== "") lines.push(formatToolCallLine(layout, breakdown));

  return lines;
}

/**
 * The tool breakdown, indented under the row it belongs to and clipped to it.
 *
 * The indent is measured from the turn-number column rather than fixed, because
 * that column is dropped on a narrow terminal and an indent sized for a column
 * that is not there points at nothing. Clipping matters for the same reason the
 * row is clipped: a wrapped continuation line reads as damage.
 */
function formatToolCallLine(layout: Layout, breakdown: string): string {
  const indexWidth = layout.columns.find((column) => column.id === "index")?.width ?? 0;
  return truncate(`${" ".repeat(indexWidth + 2)}Tool calls: ${breakdown}`, layout.width);
}

/**
 * Every column the table can show, widest form, in the order they are printed.
 *
 * `dropPriority` orders what goes first when the terminal cannot hold them all,
 * and each position has a reason. `Reason` is already counted inside `Total`.
 * The two limit columns read `-` on most rows and their information survives in
 * the summary block. `Effort` is populated only for reasoning models. `Status`
 * is near-constant, and an unusual value stands out without a heading. `Tools`
 * loses only a count -- the breakdown line below the row survives it.
 * `Duration` is useful but is not part of the token-and-cost question the table
 * exists to answer. `Model` goes late because it is worth its 18 characters
 * right up until it is the only thing left to give. `#` goes last because a row
 * can be identified by its time.
 *
 * The seven columns with no `dropPriority` are never dropped: they are the
 * question the table was built to answer.
 */
function describeColumns(): readonly Column[] {
  return [
    { id: "index", label: "#", width: 4, dropPriority: 9, alignRight: true },
    { id: "time", label: "Time", width: 8 },
    { id: "status", label: "Status", width: 9, dropPriority: 5 },
    { id: "prompt", label: "Prompt", width: PREVIEW_WIDTH, minWidth: PREVIEW_MIN_WIDTH },
    { id: "input", label: "Input", width: 11, alignRight: true },
    { id: "cache", label: "Cache", width: 11, alignRight: true },
    { id: "output", label: "Output", width: 9, alignRight: true },
    { id: "reasoning", label: "Reason", width: 9, dropPriority: 1, alignRight: true },
    { id: "total", label: "Total", width: 12, alignRight: true },
    { id: "cost", label: "Cost", width: COST_WIDTH, alignRight: true },
    { id: "primaryLimit", label: ABSENT, width: 8, dropPriority: 3, alignRight: true },
    { id: "secondaryLimit", label: ABSENT, width: 8, dropPriority: 2, alignRight: true },
    { id: "tools", label: "Tools", width: 5, dropPriority: 6, alignRight: true },
    { id: "model", label: "Model", width: MODEL_WIDTH, minWidth: MODEL_MIN_WIDTH, dropPriority: 8 },
    { id: "effort", label: "Effort", width: 8, dropPriority: 4 },
    { id: "duration", label: "Duration", width: 9, dropPriority: 7, alignRight: true },
  ];
}

/**
 * The width the full table renders to, computed from the columns themselves.
 *
 * Never written down. A column added, removed or resized moves this without
 * anyone remembering to, which is the property that keeps the layout rules
 * honest once they start comparing it against a terminal.
 */
export const FULL_TABLE_WIDTH = renderedWidth(describeColumns());

/**
 * The narrowest terminal the table can be fitted to without wrapping.
 *
 * Everything droppable is gone and both flexible columns are at their minimum,
 * so there is nothing left to give. Derived for the same reason as the width
 * above: it is a consequence of the columns, not a decision about them.
 */
export const MINIMUM_TABLE_WIDTH = renderedWidth(
  describeColumns()
    .filter((column) => column.dropPriority === undefined)
    .map(shrunk),
);

/**
 * Chooses the columns for a terminal of the given width.
 *
 * Four steps: keep everything if it fits or if there is no terminal to fit;
 * shrink the flexible columns to their minimums; drop columns in priority order
 * until the rest fit; then hand any space left over back to the flexible
 * columns. The last step matters because dropping a column usually frees more
 * than was needed, and returning that space to the prompt is what makes a
 * narrow table worth reading.
 *
 * Below `MINIMUM_TABLE_WIDTH` the narrowest layout is returned rather than an
 * impossible one. The caller says so; the table does not pretend to have fitted.
 */
export function selectLayout(availableWidth: number | undefined): Layout {
  const all = describeColumns();
  if (availableWidth === undefined) return { columns: all, width: FULL_TABLE_WIDTH };

  const usable = availableWidth - LAST_COLUMN_RESERVE;
  if (usable >= FULL_TABLE_WIDTH) return { columns: all, width: FULL_TABLE_WIDTH };

  const droppable = all
    .filter((column) => column.dropPriority !== undefined)
    .sort((a, b) => (a.dropPriority ?? 0) - (b.dropPriority ?? 0));

  let kept = all.map(shrunk);
  for (const victim of droppable) {
    if (renderedWidth(kept) <= usable) break;
    kept = kept.filter((column) => column.id !== victim.id);
  }

  const grown = grow(kept, all, usable);
  return { columns: grown, width: renderedWidth(grown) };
}

/** The column at its minimum width, or unchanged when it has none. */
function shrunk(column: Column): Column {
  return column.minWidth === undefined ? column : { ...column, width: column.minWidth };
}

/**
 * Spends leftover width on the flexible columns, prompt first.
 *
 * Prompt first rather than evenly: on a narrow terminal the prompt is what
 * tells one row from another, while a model name repeats down the whole column.
 */
function grow(
  kept: readonly Column[],
  all: readonly Column[],
  availableWidth: number,
): readonly Column[] {
  let columns = kept;

  for (const id of GROWTH_ORDER) {
    const spare = availableWidth - renderedWidth(columns);
    if (spare <= 0) break;

    const index = columns.findIndex((column) => column.id === id);
    const column = columns[index];
    const fullWidth = all.find((candidate) => candidate.id === id)?.width;
    if (column === undefined || fullWidth === undefined) continue;

    const width = Math.min(column.width + spare, fullWidth);
    columns = columns.with(index, { ...column, width });
  }

  return columns;
}

const GROWTH_ORDER: readonly ColumnId[] = ["prompt", "model"];

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
/**
 * Cuts a cell to its column and pads it to the same width.
 *
 * Shared with the report, which has its own columns but the same job to do here.
 * `truncate` cuts on grapheme boundaries; the padding counts UTF-16 code units,
 * deliberately, and `docs/ROADMAP.md` records why that is left as it is.
 */
export function fit(value: string, column: FittedColumn): string {
  const clipped = truncate(value, column.width);
  return column.alignRight === true
    ? clipped.padStart(column.width)
    : clipped.padEnd(column.width);
}

const INDEX_WIDTH = 3;
const WHEN_WIDTH = 19;
const LISTING_GAP = "  ";

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

/** Still enough of a name to recognise a session by. Matches the table's floor. */
const SESSION_NAME_MIN_WIDTH = 12;

/**
 * The name width below which the date is dropped instead of squeezing further.
 *
 * The date is the listing's droppable column, but dropping it frees 21
 * characters, so doing it to recover one wastes the rest of the terminal: a
 * 100-column window would print a 79-column listing. Below 24 the name stops
 * carrying enough of a session title to recognise it by, and at that point the
 * date is the cheaper thing to lose.
 */
const SESSION_NAME_KEEPS_WHEN = 24;

/**
 * Width of the full session listing, and of the rule drawn above it.
 *
 * Derived, for the reason `FULL_TABLE_WIDTH` is. The columns used to add up to
 * more than the rule: it was 100 characters while a row was 106 for Claude Code
 * and 145 for Codex, whose session id carries a date path. Any terminal
 * narrower than the row wrapped it, and a wrapped row reads as corruption
 * rather than as a long line. That was fixed by making the columns add up to
 * 100; what stayed broken is that 100 itself was never compared against a
 * terminal, and two of the three platforms open theirs at 80.
 */
export const SESSION_LISTING_WIDTH =
  INDEX_WIDTH + WHEN_WIDTH + SESSION_NAME_WIDTH + SESSION_ID_WIDTH + LISTING_GAP.length * 3;

/**
 * The narrowest listing that still holds a number, a name and an id.
 *
 * The date is gone and the name is at its floor, so there is nothing left to
 * give. No terminal opens this narrow; it exists so the arithmetic has an end.
 */
export const MINIMUM_SESSION_LISTING_WIDTH =
  INDEX_WIDTH + SESSION_NAME_MIN_WIDTH + SESSION_ID_WIDTH + LISTING_GAP.length * 2;

/**
 * Renders the numbered session list the user chooses from.
 *
 * The name is cut from the right and the id from the left. A name reads
 * front-to-back, while an id is identified by its tail: a Codex id is
 * `<year>/<month>/<day>/rollout-<timestamp>-<uuid>`, and its date is already in
 * the column beside it. The full id stays available in the startup banner and in
 * the CSV filename; nothing here is the only copy.
 */
export function formatSessionListing(
  sessions: readonly SessionRef[],
  availableWidth?: number,
): readonly string[] {
  const shape = describeListing(availableWidth);

  const rows = sessions.map((session, index) => {
    const when = new Date(session.lastActivityMs).toISOString().slice(0, 19).replace("T", " ");
    const cells = [
      String(index + 1).padStart(INDEX_WIDTH),
      ...(shape.showWhen ? [when.padEnd(WHEN_WIDTH)] : []),
      truncate(session.sessionName, shape.nameWidth).padEnd(shape.nameWidth),
      truncateEnd(session.sessionId, SESSION_ID_WIDTH),
    ];
    return cells.join(LISTING_GAP);
  });

  return ["", "Available sessions, most recent first", "=".repeat(shape.width), ...rows];
}

/**
 * Chooses which listing columns a terminal of the given width can hold.
 *
 * The date is the only column that can go. The number is what the user types in
 * answer to the prompt below the list, the name is how a session is recognised,
 * and the id is what matches a CSV filename -- take any of the three away and
 * the list stops being usable for choosing. Recency survives losing the date,
 * because the heading above already says the list is most recent first.
 *
 * An absent width means no terminal, and the full listing is printed for the
 * same reason the full table is.
 */
function describeListing(availableWidth: number | undefined): {
  readonly showWhen: boolean;
  readonly nameWidth: number;
  readonly width: number;
} {
  const usable =
    availableWidth === undefined
      ? SESSION_LISTING_WIDTH
      : availableWidth - LAST_COLUMN_RESERVE;

  // What the name could be if the date stayed. The date leaves only when that
  // is too little to recognise a session by, so a 21-character column is never
  // dropped to recover one character.
  const nameBesideWhen =
    usable - (INDEX_WIDTH + WHEN_WIDTH + SESSION_ID_WIDTH) - LISTING_GAP.length * 3;
  const showWhen = nameBesideWhen >= SESSION_NAME_KEEPS_WHEN;

  const fixed = INDEX_WIDTH + SESSION_ID_WIDTH + (showWhen ? WHEN_WIDTH : 0);
  const gaps = LISTING_GAP.length * (showWhen ? 3 : 2);

  const nameWidth = Math.min(
    Math.max(usable - fixed - gaps, SESSION_NAME_MIN_WIDTH),
    SESSION_NAME_WIDTH,
  );

  return { showWhen, nameWidth, width: fixed + gaps + nameWidth };
}

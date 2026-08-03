import { truncate, wrapWords } from "../core/text.js";
import { mergeBuckets } from "./aggregate.js";
import { shortenModelNames } from "./models.js";
import { fit } from "../ui/live-table.js";
import type { FittedColumn } from "../ui/live-table.js";
import type { Grouping } from "../options.js";
import type { Bucket } from "./aggregate.js";
import type { Coverage, ReportData } from "./collect.js";

/**
 * Below this width the report drops its cache and total-token columns.
 *
 * The same threshold ccusage uses, read from
 * `rust/crates/ccusage-core/src/lib.rs` at `c462cb5`, and the same answer
 * Plan 3.7 already reached for the live table: measure the terminal, drop what
 * does not fit, and never wrap.
 */
export const REPORT_COMPACT_THRESHOLD = 100;

/** One column of the terminal is left unused, as the live table leaves one. */
const LAST_COLUMN_RESERVE = 1;

const ABSENT = "";

/** What each model line is prefixed with, so a list reads as a list. */
const MODEL_BULLET = "- ";

/** The models column never narrows past its own heading. */
const MODELS_HEADING_WIDTH = "Models".length;

/**
 * The ceiling on the models column in the narrow tier.
 *
 * A narrow terminal has already given up its cache columns, so a long model name
 * is cut here rather than pushing the numbers off the screen. This is the one
 * place a model name is still truncated, and only when the window leaves no
 * choice.
 */
const NARROW_MODEL_WIDTH = 16;

/** Spaces between a cell's content and the vertical rule on either side. */
const CELL_PADDING = 1;

/**
 * Light box drawing, the one set that is safe everywhere this runs.
 *
 * Light is what CP437 carried, what VT100 drew and what every modern terminal
 * font still has, so it renders on a Windows console as well as on a Linux one.
 * Heavy and double are not mixed in: a table that is right on one machine and
 * ragged on another is worse than a plain one.
 *
 * Drawn whatever the output is, including a pipe or a redirect. Two output
 * shapes would be two test surfaces, and a consumer that wants the figures
 * rather than the picture has `--json`.
 */
const BORDER = {
  horizontal: "─",
  vertical: "│",
  top: { left: "┌", join: "┬", right: "┐" },
  mid: { left: "├", join: "┼", right: "┤" },
  bottom: { left: "└", join: "┴", right: "┘" },
} as const;

export interface RenderOptions {
  /** Absent when output is not going to a terminal, so nothing is dropped. */
  readonly width: number | undefined;
  /** Forces the narrow column set regardless of width. */
  readonly compact: boolean;
  /** True when more than one agent is in scope, which turns on nesting. */
  readonly nested: boolean;
  readonly grouping: Grouping;
  /** Display names of the agents covered. Empty means every agent on the machine. */
  readonly agents: readonly string[];
}

/**
 * Renders a report: a header, its rows, a total, and the coverage line.
 *
 * Bordered, and a row is as tall as its tallest cell. This is where the report
 * parts company with the live table, which stays borderless: a watcher writes a
 * row at a time and would have to redraw its bottom edge on every turn, while a
 * report knows all of its rows before it draws any of them.
 *
 * The box is drawn whatever the output is, including a pipe. Two output shapes
 * are two test surfaces, and a consumer that wants figures rather than a picture
 * has `--json`.
 */
export function formatReport(data: ReportData, options: RenderOptions): readonly string[] {
  // Resolved once for the whole report rather than per row, because a collision
  // is a property of the set: two models clash or they do not, and a row cannot
  // see far enough to tell.
  const names = shortenModelNames(data.buckets.flatMap((bucket) => bucket.models));

  const { columns, dropped } = describeColumns(options, widestModel(names));
  const header = line(columns, (column) => column.label);
  const coverage = formatCoverage(data.coverage, options.width, dropped);

  if (data.buckets.length === 0) {
    return [`No turns found${describeWindow(data.coverage)}.`, ...coverage];
  }

  return [
    ...formatTitle(options),
    rule(columns, "top"),
    header,
    rule(columns, "mid"),
    ...formatBody(data.buckets, columns, options, names),
    rule(columns, "bottom"),
    ...coverage,
  ];
}

/**
 * The banner above the table: which agents it covers, and how it is grouped.
 *
 * These are the two facts the table never carried. Saved to a file, a report
 * gave no way to tell a Codex one from a Claude Code one, and a weekly one from
 * a daily one only by reading the dates. Everything else a reader needs is in
 * the coverage line under the table, and is deliberately not repeated here.
 *
 * Rounded corners against the table's square ones, which is the distinction
 * ccusage draws too: the box that frames data and the box that labels it should
 * not look like the same thing.
 */
function formatTitle(options: RenderOptions): readonly string[] {
  const scope = options.agents.length === 0 ? "All agents" : options.agents.join(" and ");
  const text = `${scope}, ${GROUPING_PHRASE[options.grouping]}`;
  const span = TITLE_BORDER.horizontal.repeat(text.length + TITLE_PADDING * 2);
  const pad = " ".repeat(TITLE_PADDING);

  return [
    `${TITLE_BORDER.topLeft}${span}${TITLE_BORDER.topRight}`,
    `${BORDER.vertical}${pad}${text}${pad}${BORDER.vertical}`,
    `${TITLE_BORDER.botLeft}${span}${TITLE_BORDER.botRight}`,
    "",
  ];
}

/** How each grouping reads in a sentence, rather than as a flag. */
const GROUPING_PHRASE: Readonly<Record<Grouping, string>> = {
  daily: "by day",
  weekly: "by week",
  monthly: "by month",
  session: "by session",
};

const TITLE_PADDING = 3;

/** Rounded, so the label around the table is not mistaken for part of it. */
const TITLE_BORDER = {
  horizontal: "─",
  topLeft: "╭",
  topRight: "╮",
  botLeft: "╰",
  botRight: "╯",
} as const;

/**
 * A horizontal rule matching the column layout, at the junction set it needs.
 *
 * The three kinds differ only in which characters sit at the ends and between
 * the columns, so one function draws all of them and no two can disagree about
 * where a column boundary is.
 */
function rule(columns: readonly ReportColumn[], kind: "top" | "mid" | "bottom"): string {
  const { left, join, right } = BORDER[kind];
  const spans = columns.map((column) =>
    BORDER.horizontal.repeat(column.width + CELL_PADDING * 2),
  );

  return `${left}${spans.join(join)}${right}`;
}

/**
 * How wide the models column has to be to print a name whole.
 *
 * One model per line means the column is sized by the longest single name
 * rather than by the joined list, which is what made the old column overflow at
 * any width. Two characters are added for the `- ` each line carries, and the
 * heading sets the floor.
 */
function widestModel(names: ReadonlyMap<string, string>): number {
  const longest = Math.max(0, ...[...names.values()].map((name) => name.length));
  return Math.max(MODELS_HEADING_WIDTH, longest + MODEL_BULLET.length);
}

/**
 * The rows, nested under their period when more than one agent is in scope.
 *
 * Nesting rather than a column per agent: two agents read well side by side and
 * four do not, and a column per agent leaves nowhere to put the token counts.
 * The period label is printed on the total row and blank beneath it, so a reader
 * sees one date rather than the same date three times.
 */
function formatBody(
  buckets: readonly Bucket[],
  columns: readonly ReportColumn[],
  options: RenderOptions,
  names: ReadonlyMap<string, string>,
): readonly string[] {
  const rows: string[] = [];
  const row = (bucket: Bucket, overrides: RowOverrides): readonly string[] =>
    renderRow(bucket, columns, overrides, names);

  // Nesting groups rows that share a label, which only periods do. A session
  // belongs to exactly one agent by construction, so nesting a session report
  // would print a total row above a single child that repeats it, and the total
  // would lose the session's id on the way through the merge.
  const separator = rule(columns, "mid");

  if (!options.nested || options.grouping === "session") {
    for (const bucket of buckets) {
      if (rows.length > 0) rows.push(separator);
      rows.push(...row(bucket, { label: bucket.label }));
    }
  } else {
    // A separator between a period and its own agents would say they are apart,
    // which is the opposite of what nesting means. Groups are separated from each
    // other; inside one, the blank label column already carries the grouping.
    for (const label of distinctLabels(buckets)) {
      if (rows.length > 0) rows.push(separator);

      // The period total's models are exactly the union of the rows beneath it,
      // so printing them says nothing twice and makes the tallest row in the
      // table out of a repeat. The agents below carry the answer.
      const group = buckets.filter((bucket) => bucket.label === label);
      rows.push(...row(mergeBuckets(group, label), { label, agent: "All", models: [] }));
      for (const bucket of group) {
        rows.push(...row(bucket, { label: ABSENT, agent: `- ${bucket.provider ?? ""}` }));
      }
    }
  }

  const total = mergeBuckets(buckets, "TOTAL");
  rows.push(separator);
  rows.push(...row(total, { label: "TOTAL", agent: ABSENT }));

  return rows;
}

/** Labels in the order they first appear, which is the order they were sorted into. */
function distinctLabels(buckets: readonly Bucket[]): readonly string[] {
  return [...new Set(buckets.map((bucket) => bucket.label))];
}

interface RowOverrides {
  readonly label: string;
  readonly agent?: string;
  /** Set empty on a period total, whose models are the union of the rows below. */
  readonly models?: readonly string[];
}

/**
 * The visual lines one bucket occupies, top-aligned.
 *
 * A row is a list of lines rather than a string because a cell can hold more
 * than one fact: a day that used three models has three of them, and joining
 * them into one cell is what forced the old column to cut a model name in half.
 * The tallest cell sets the height and the shorter ones are blank beneath, which
 * reads as "nothing more here" rather than as a repeat.
 */
function renderRow(
  bucket: Bucket,
  columns: readonly ReportColumn[],
  overrides: RowOverrides,
  names: ReadonlyMap<string, string>,
): readonly string[] {
  const values = describeValues(bucket, overrides, names);
  const height = Math.max(1, ...columns.map((column) => values[column.id].length));

  return Array.from({ length: height }, (_, index) =>
    line(columns, (column) => values[column.id][index] ?? ABSENT),
  );
}

/**
 * Joins one row of cells between vertical rules.
 *
 * Every cell is padded, including the last: the row ends in a border rather than
 * in whitespace, so there is nothing to trim and no special case for the final
 * column. Borderless rows needed one and it was a source of ragged output.
 */
function line(
  columns: readonly ReportColumn[],
  cell: (column: ReportColumn) => string,
): string {
  const pad = " ".repeat(CELL_PADDING);
  const cells = columns.map((column) => `${pad}${fit(cell(column), column)}${pad}`);

  return `${BORDER.vertical}${cells.join(BORDER.vertical)}${BORDER.vertical}`;
}

/**
 * Every cell of one row, as the lines it occupies.
 *
 * An array rather than a string carrying newlines. `core/text.ts` records that a
 * line holding a newline is what this format is careful never to produce, and a
 * cell that is explicitly a list cannot drift from that by accident.
 */
type CellLines = Readonly<Record<ReportColumnId, readonly string[]>>;

type ReportColumnId =
  | "label"
  | "id"
  | "agent"
  | "models"
  | "input"
  | "output"
  | "cacheCreate"
  | "cacheRead"
  | "total"
  | "cost"
  | "lastActivity";

interface ReportColumn extends FittedColumn {
  readonly id: ReportColumnId;
  readonly label: string;
  /** Absent when the column cannot be shortened without becoming unreadable. */
  readonly minWidth?: number;
}

/**
 * Column widths plus what the border costs: a vertical rule either side of every
 * column, shared between neighbours, and a pad on each side of every cell.
 *
 * `sum + 3n + 1` where the borderless table was `sum + n - 1`, so eight columns
 * pay eighteen characters for the box. Changing the formula rather than adding a
 * second one keeps `shrinkToFit` and `dropToFit` correct for free: both ask this
 * same question, so neither can be told a width the renderer disagrees with.
 */
function renderedWidth(columns: readonly ReportColumn[]): number {
  if (columns.length === 0) return 0;

  const content = columns.reduce((sum, column) => sum + column.width, 0);
  const padding = columns.length * CELL_PADDING * 2;
  const rules = columns.length + 1;

  return content + padding + rules;
}

/**
 * Shrinks the flexible columns until the table fits, widest give first.
 *
 * The numeric columns are never shrunk: a count cut in half is a wrong number,
 * while a cut model name is still recognisably a cut model name. If it still does
 * not fit after every flexible column has reached its minimum, the table is
 * printed as it is and the terminal wraps it. That is the honest end of a fixed
 * set of numbers and a window too narrow to hold them.
 */
function shrinkToFit(
  columns: readonly ReportColumn[],
  availableWidth: number | undefined,
): readonly ReportColumn[] {
  if (availableWidth === undefined) return columns;

  const usable = availableWidth - LAST_COLUMN_RESERVE;
  let fitted = [...columns];

  for (const id of SHRINK_ORDER) {
    if (renderedWidth(fitted) <= usable) break;

    const index = fitted.findIndex((column) => column.id === id);
    const column = fitted[index];
    if (column?.minWidth === undefined) continue;

    const over = renderedWidth(fitted) - usable;
    const width = Math.max(column.width - over, column.minWidth);
    fitted = fitted.with(index, { ...column, width });
  }

  return fitted;
}

/**
 * Which flexible column gives up width first.
 *
 * Models before the label: a label tells one row from another, which is what the
 * table is read down, while a model name repeats down the whole column.
 */
const SHRINK_ORDER: readonly ReportColumnId[] = ["models", "label"];

/**
 * Every cell a bucket can produce, keyed by the column it belongs under.
 *
 * Built regardless of which columns are shown, so this stays free of layout
 * decisions: the renderer reads the cells it has headings for. The live table
 * already works this way.
 */
function describeValues(
  bucket: Bucket,
  overrides: RowOverrides,
  names: ReadonlyMap<string, string>,
): CellLines {
  return {
    label: [overrides.label],
    id: [overrides.label === "" ? "" : bucket.id ?? ""],
    agent: [overrides.agent ?? bucket.provider ?? ""],
    // One model per line, bulleted. A list read down needs no separator, and the
    // bullet is what tells a two-model row from a row whose neighbour ran over.
    models: (overrides.models ?? bucket.models).map(
      (id) => `${MODEL_BULLET}${names.get(id) ?? id}`,
    ),
    input: [count(bucket.usage.inputUncached)],
    output: [count(bucket.usage.output)],
    cacheCreate: [count(bucket.usage.cacheCreation5m + bucket.usage.cacheCreation1h)],
    cacheRead: [count(bucket.usage.cacheRead)],
    total: [count(bucket.usage.total)],
    cost: [cost(bucket.costUsd)],
    lastActivity: [bucket.lastActivity.slice(0, "YYYY-MM-DD".length)],
  };
}

/**
 * The columns for one report, at the tier its width allows.
 *
 * The agent column appears only when nesting is on. With one agent in scope it
 * would repeat the same word down the whole table and take width from the
 * numbers, which are what the table is for.
 */
function describeColumns(
  options: RenderOptions,
  modelWidth: number,
): {
  readonly columns: readonly ReportColumn[];
  readonly dropped: readonly string[];
} {
  const narrow =
    options.compact ||
    (options.width !== undefined && options.width - LAST_COLUMN_RESERVE < REPORT_COMPACT_THRESHOLD);

  // Three steps in this order. The tier is the documented choice at a known
  // threshold. Shrinking only shortens a name, so it happens whenever the window
  // asks. Dropping loses a fact, so it is last and it is reported.
  const shrunk = shrinkToFit(describeTier(options, narrow, modelWidth), options.width);
  return dropToFit(shrunk, options.width);
}

/**
 * Drops columns, cheapest fact first, until the table fits.
 *
 * Reached only when every flexible column is already at its minimum, which is a
 * window too narrow for the numbers rather than for the names. The label and the
 * cost are never dropped: without them there is no report, only a shape.
 *
 * What went is returned rather than swallowed. A table quietly missing a column
 * is a table a reader will draw a wrong conclusion from.
 */
function dropToFit(
  columns: readonly ReportColumn[],
  availableWidth: number | undefined,
): { readonly columns: readonly ReportColumn[]; readonly dropped: readonly string[] } {
  if (availableWidth === undefined) return { columns, dropped: [] };

  const usable = availableWidth - LAST_COLUMN_RESERVE;
  let kept = [...columns];
  const dropped: string[] = [];

  for (const id of DROP_ORDER) {
    if (renderedWidth(kept) <= usable) break;

    const victim = kept.find((column) => column.id === id);
    if (victim === undefined) continue;

    kept = kept.filter((column) => column.id !== id);
    dropped.push(victim.label);
  }

  return { columns: kept, dropped };
}

/** Cheapest fact first. Never the label and never the cost. */
const DROP_ORDER: readonly ReportColumnId[] = [
  "lastActivity",
  "models",
  "id",
  "cacheCreate",
  "cacheRead",
  "total",
  "output",
  "input",
  "agent",
];

function describeTier(
  options: RenderOptions,
  narrow: boolean,
  modelWidth: number,
): readonly ReportColumn[] {

  const columns: ReportColumn[] = [
    options.grouping === "session"
      ? { id: "label", label: "Session", width: 28, minWidth: 12 }
      : { id: "label", label: "Date", width: 10 },
  ];

  // Its own column, never merged into the label. The label is truncatable and
  // this is not: a name cut short is still recognisable, an id cut short resolves
  // to nothing, and this is the string a reader pastes into `--id`.
  if (options.grouping === "session") columns.push({ id: "id", label: "Id", width: 12 });

  if (options.nested) columns.push({ id: "agent", label: "Agent", width: 14 });
  // Sized by the data rather than by a constant. One model per line means the
  // width the column needs is knowable, so a fixed 22 would either cut a name
  // that fits or reserve space for one that does not exist.
  columns.push({
    id: "models",
    label: "Models",
    width: narrow ? Math.min(modelWidth, NARROW_MODEL_WIDTH) : modelWidth,
    minWidth: MODELS_HEADING_WIDTH,
  });
  columns.push({ id: "input", label: "Input", width: 12, alignRight: true });
  columns.push({ id: "output", label: "Output", width: 12, alignRight: true });

  if (!narrow) {
    columns.push({ id: "cacheCreate", label: "Cache Create", width: 13, alignRight: true });
    columns.push({ id: "cacheRead", label: "Cache Read", width: 14, alignRight: true });
    columns.push({ id: "total", label: "Total Tokens", width: 14, alignRight: true });
  }

  columns.push({ id: "cost", label: "Cost (USD)", width: 11, alignRight: true });
  if (options.grouping === "session") {
    columns.push({ id: "lastActivity", label: "Last Activity", width: 13 });
  }

  return columns;
}

/**
 * What the report covered, and what its figures are.
 *
 * This carries the honesty a `--no-archived` flag would have carried. Nothing is
 * left out of a total, so the line says what went in rather than what did not.
 */
function formatCoverage(
  coverage: Coverage,
  width: number | undefined,
  droppedColumns: readonly string[] = [],
): readonly string[] {
  const ceiling = width === undefined ? Number.POSITIVE_INFINITY : width - LAST_COLUMN_RESERVE;
  const lines = [
    "",
    ...wrapWords(
      `${plural(coverage.sessions, "session")}${describeWindow(coverage)}, ${coverage.timeZone}.`,
      ceiling,
    ),
    ...wrapWords(
      `Every figure is priced at today's rates, from ${coverage.pricingVersion}.`,
      ceiling,
    ),
  ];

  if (coverage.unpricedTurns > 0) {
    lines.push(...wrapWords(`${plural(coverage.unpricedTurns, "turn")} could not be priced.`, ceiling));
  }

  // Said because a table quietly missing a column is one a reader will draw a
  // wrong conclusion from. The tier drop above the threshold is not reported:
  // that one is documented behaviour at a known width, and saying it on every
  // narrow run would be noise. This one only happens when the window is too
  // narrow for the numbers themselves.
  if (droppedColumns.length > 0) {
    lines.push(
      ...wrapWords(
        `Too narrow for every column, so these are not shown: ${droppedColumns.join(", ")}. ` +
          "Widen the window to see them.",
        ceiling,
      ),
    );
  }

  return lines;
}

/**
 * The window the report found, never the one it was asked for.
 *
 * Claude Code prunes transcripts at `cleanupPeriodDays`, thirty days by default,
 * so "all history" is a claim TurnLens cannot make about data it does not
 * control. What it can say is which days it saw.
 */
function describeWindow(coverage: Coverage): string {
  if (coverage.oldestDay === undefined || coverage.newestDay === undefined) return "";
  if (coverage.oldestDay === coverage.newestDay) return `, ${coverage.oldestDay}`;
  return `, ${coverage.oldestDay} to ${coverage.newestDay}`;
}

function plural(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * A token count, zero included.
 *
 * Zero is printed rather than blanked. A token count is never unknown, so a blank
 * cell here would be the inverse of the mistake this codebase cares about: it
 * would make a figure that is known to be zero look like one nobody could work
 * out. Codex reports no cache-creation tokens at all, and that column reading `0`
 * down its whole length is the truth about Codex.
 *
 * The cost column is the opposite case and is handled separately: there, blank
 * means could not be priced, and a zero would read as free.
 */
function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** Empty rather than `$0.00` when nothing here could be priced. */
function cost(amountUsd: number | undefined): string {
  return amountUsd === undefined ? ABSENT : `$${amountUsd.toFixed(2)}`;
}

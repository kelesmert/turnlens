import { readFile } from "node:fs/promises";
import { toFiniteFloat, toFiniteInt } from "../core/numbers.js";
import { CSV_HEADER, parseCsvRow } from "../core/store/csv.js";
import { wrapWords } from "../core/text.js";

const LABEL_WIDTH = 24;
const ABSENT = "-";

/**
 * One column of the terminal is left unused, for the reason the table leaves
 * one: a line filling the last column is recorded as continuing into the next,
 * and widening the window afterwards re-flows the two together.
 */
const RULE_RESERVE = 1;

interface Totals {
  inputUncached: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  total: number;
  toolCalls: number;
}

/**
 * Summarises the turns recorded in one session CSV.
 *
 * Describes the contents of that file only, never the account as a whole. The
 * cost total covers only the turns that could be priced; turns that could not
 * be are counted separately rather than folded in as free, because a zero and
 * an unknown are different facts and only one of them belongs in a sum.
 */
export async function summariseCsv(
  path: string,
  availableWidth?: number,
): Promise<readonly string[]> {
  const ceiling =
    availableWidth === undefined ? Number.POSITIVE_INFINITY : availableWidth - RULE_RESERVE;

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return ["", "Session summary unavailable: the CSV could not be read.", ""];
  }

  const rows = contents.split("\n").filter((row) => row.trim() !== "").slice(1);
  if (rows.length === 0) return boxed(["No recorded turns."], ceiling);

  const totals: Totals = {
    inputUncached: 0,
    cacheRead: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    toolCalls: 0,
  };
  const models = new Map<string, number>();
  const efforts = new Map<string, number>();
  const tools = new Map<string, number>();
  const durations: number[] = [];
  let aborted = 0;
  let costUsd = 0;
  let pricedTurns = 0;
  const unpriced = new Map<string, number>();
  const pricingVersions = new Map<string, number>();

  for (const row of rows) {
    // Parsed as CSV rather than split on commas: a session name or prompt
    // preview may legitimately contain one, which would shift every later column.
    const fields = parseCsvRow(row);
    const read = (column: (typeof CSV_HEADER)[number]): string =>
      fields[CSV_HEADER.indexOf(column)] ?? "";

    totals.inputUncached += toFiniteInt(read("input_uncached"), 0);
    totals.cacheRead += toFiniteInt(read("cache_read"), 0);
    totals.output += toFiniteInt(read("output_including_reasoning"), 0);
    totals.reasoning += toFiniteInt(read("reasoning_subset"), 0);
    totals.total += toFiniteInt(read("total_tokens"), 0);
    totals.toolCalls += toFiniteInt(read("tool_call_count"), 0);

    if (read("status") === "aborted") aborted += 1;
    countValue(models, read("model"));
    countValue(efforts, read("reasoning_effort"));
    addToolCalls(tools, read("tool_calls_json"));

    const rowCost = toFiniteFloat(read("estimated_cost_usd"));
    const costStatus = read("cost_status");
    if (rowCost === undefined) countValue(unpriced, costStatus === "" ? "unknown" : costStatus);
    else {
      costUsd += rowCost;
      pricedTurns += 1;
    }
    countValue(pricingVersions, read("pricing_version"));

    const durationMs = toFiniteInt(read("duration_ms"));
    if (durationMs !== undefined) durations.push(durationMs);
  }

  const totalInput = totals.inputUncached + totals.cacheRead;
  const cacheRatio = totalInput === 0 ? 0 : (totals.cacheRead / totalInput) * 100;

  const lines = [
    entry("Recorded turns", formatCount(rows.length)),
    entry("Aborted turns", formatCount(aborted)),
    entry("Uncached input tokens", formatCount(totals.inputUncached)),
    entry("Cache read tokens", formatCount(totals.cacheRead)),
    entry("Cache ratio", `${cacheRatio.toFixed(1)}%`),
    entry("Output tokens", formatCount(totals.output)),
    entry("Reasoning tokens", formatCount(totals.reasoning)),
    entry("Total tokens", formatCount(totals.total)),
    entry("Tool calls", formatCount(totals.toolCalls)),
    entry("Estimated cost", pricedTurns === 0 ? "unavailable" : `$${costUsd.toFixed(6)}`),
    entry("Average duration", formatSeconds(average(durations))),
    entry("Longest duration", formatSeconds(longest(durations))),
  ];

  if (unpriced.size > 0) {
    const total = [...unpriced.values()].reduce((sum, count) => sum + count, 0);
    lines.push(entry("Unpriced turns", `${formatCount(total)} (${describe(unpriced)})`));
  }
  if (pricingVersions.size > 0) lines.push(entry("Pricing data", describe(pricingVersions)));
  if (models.size > 0) lines.push(entry("Models", describe(models)));
  if (efforts.size > 0) lines.push(entry("Reasoning efforts", describe(efforts)));
  if (tools.size > 0) lines.push(entry("Tool breakdown", describe(tools)));

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

function countValue(counter: Map<string, number>, key: string): void {
  if (key === "") return;
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** Adds one row's tool counts. An unreadable cell is skipped, never guessed at. */
function addToolCalls(counter: Map<string, number>, json: string): void {
  if (json === "") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;

  for (const [name, count] of Object.entries(parsed)) {
    counter.set(name, (counter.get(name) ?? 0) + toFiniteInt(count, 0));
  }
}

function describe(counter: ReadonlyMap<string, number>): string {
  return [...counter.entries()]
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function longest(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSeconds(durationMs: number | undefined): string {
  return durationMs === undefined ? ABSENT : `${(durationMs / 1_000).toFixed(1)}s`;
}

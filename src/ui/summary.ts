import { readFile } from "node:fs/promises";
import { toFiniteFloat, toFiniteInt } from "../core/numbers.js";
import { CSV_HEADER, parseCsvRow } from "../core/store/csv.js";

const RULE_WIDTH = 72;
const LABEL_WIDTH = 24;
const ABSENT = "-";

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
export async function summariseCsv(path: string): Promise<readonly string[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return ["", "Session summary unavailable: the CSV could not be read.", ""];
  }

  const rule = "=".repeat(RULE_WIDTH);
  const rows = contents.split("\n").filter((row) => row.trim() !== "").slice(1);
  if (rows.length === 0) return ["", "Session summary", rule, "No recorded turns.", rule];

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
    "",
    "Session summary",
    rule,
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
  lines.push(rule);

  return lines;
}

function entry(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}: ${value}`;
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

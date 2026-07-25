import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { toFiniteInt } from "../numbers.js";
import type { NormalizedTurn } from "../types.js";

export const CSV_HEADER = [
  "timestamp",
  "provider",
  "session_id",
  "session_name",
  "turn_number",
  "turn_id",
  "status",
  "prompt_preview",
  "model",
  "reasoning_effort",
  "tool_call_count",
  "tool_calls_json",
  "input_uncached",
  "cache_read",
  "cache_creation_5m",
  "cache_creation_1h",
  "output_including_reasoning",
  "reasoning_subset",
  "total_tokens",
  "estimated_cost_usd",
  "cost_status",
  "pricing_version",
  "primary_used_percent",
  "primary_window_minutes",
  "secondary_used_percent",
  "secondary_window_minutes",
  "duration_ms",
] as const;

type CsvColumn = (typeof CSV_HEADER)[number];

export interface CsvState {
  readonly maxTurnNumber: number;
  /** Keys of the rows already recorded, for skipping them on re-import. */
  readonly recordedKeys: ReadonlySet<string>;
}

/** The parts of a turn that identify its row. */
export interface TurnRowIdentity {
  readonly turnId: string;
  readonly status: string;
  readonly at: string;
}

const HEADER_LINE = CSV_HEADER.join(",");

// A NUL can never occur in a session field, so two distinct rows cannot collide
// into one key. A printable separator could appear inside a provider turn id.
const KEY_SEPARATOR = "\u0000";

/**
 * Identifies one recorded row.
 *
 * A provider turn id is deliberately not enough on its own. When a context
 * compaction happens mid-turn, Codex closes the turn at the compaction and then
 * reports `task_complete` carrying the *same* turn id, so keying on the id alone
 * discards the second row: measured on a real session, that silently dropped
 * 4,134,039 tokens and 59 tool calls across four turns. Adding the status and the
 * closing timestamp makes the key unique per row while leaving the `turn_id`
 * column faithful to what the provider reported.
 *
 * Every part comes from the session file, so re-importing the same history
 * produces the same keys and records nothing twice.
 */
export function turnRowKey(row: TurnRowIdentity): string {
  return [row.turnId, row.status, row.at].join(KEY_SEPARATOR);
}

/**
 * Ensures the CSV exists with the current header and reports what it holds.
 *
 * An existing file whose header matches is never rewritten; the Python
 * implementation streamed the whole file through a temporary copy on every
 * start, even when nothing changed (known-bugs.md P3-4). A mismatched header is
 * an error rather than an automatic conversion, so an unrecognised schema cannot
 * be silently reshaped.
 */
export async function openCsv(path: string): Promise<CsvState> {
  await mkdir(dirname(path), { recursive: true });

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return await createEmpty(path);
  }

  const rows = contents.split("\n").filter((row) => row.trim() !== "");
  const header = rows[0];
  if (header === undefined) return await createEmpty(path);

  if (header !== HEADER_LINE) {
    throw new Error(
      [
        "The CSV header does not match the current schema.",
        "",
        `File:\n${path}`,
        "",
        `Found:\n${header}`,
        "",
        `Expected:\n${HEADER_LINE}`,
        "",
        "The schema gained cost_status and pricing_version when native pricing",
        "was added. This file was written by an earlier version. It is left",
        "untouched: move or rename it and TurnScope will start a new one.",
      ].join("\n"),
    );
  }

  const recordedKeys = new Set<string>();
  let maxTurnNumber = 0;

  for (const row of rows.slice(1)) {
    const fields = parseCsvRow(row);
    maxTurnNumber = Math.max(maxTurnNumber, toFiniteInt(read(fields, "turn_number"), 0));

    recordedKeys.add(
      turnRowKey({
        turnId: read(fields, "turn_id"),
        status: read(fields, "status"),
        at: read(fields, "timestamp"),
      }),
    );
  }

  return { maxTurnNumber, recordedKeys };
}

/**
 * Appends one turn and flushes it to disk.
 *
 * `fsync` is what makes a recorded turn survive an abrupt exit. No file locking
 * is taken here: the session lock already guarantees a single writer, so
 * per-write locking would add cost without adding safety.
 *
 * Exactly one physical line is written per turn. Line breaks inside a field are
 * collapsed rather than quoted: a quoted multi-line field is valid CSV, but it
 * would let a trailing fragment read as a row of its own on the next `openCsv`,
 * fabricating a turn id and skipping the next real turn as a duplicate.
 */
export async function appendTurn(path: string, turn: NormalizedTurn): Promise<void> {
  const sortedToolCalls = Object.fromEntries(
    Object.entries(turn.toolCalls).sort(([a], [b]) => a.localeCompare(b)),
  );
  const toolCallCount = Object.values(turn.toolCalls).reduce((sum, count) => sum + count, 0);

  const fields: readonly string[] = [
    turn.at,
    turn.provider,
    turn.sessionId,
    turn.sessionName,
    String(turn.turnNumber),
    turn.turnId,
    turn.status,
    turn.promptPreview,
    turn.model,
    turn.reasoningEffort,
    String(toolCallCount),
    JSON.stringify(sortedToolCalls),
    String(turn.usage.inputUncached),
    String(turn.usage.cacheRead),
    String(turn.usage.cacheCreation5m),
    String(turn.usage.cacheCreation1h),
    String(turn.usage.output),
    String(turn.usage.reasoning),
    String(turn.usage.total),
    // Empty when the turn could not be priced: an empty cell stays out of a
    // spreadsheet sum, while a 0 silently joins it.
    turn.costUsd === undefined ? "" : formatCostUsd(turn.costUsd),
    turn.costStatus,
    turn.pricingVersion,
    optionalNumber(turn.rateLimits?.primaryUsedPercent),
    optionalNumber(turn.rateLimits?.primaryWindowMinutes),
    optionalNumber(turn.rateLimits?.secondaryUsedPercent),
    optionalNumber(turn.rateLimits?.secondaryWindowMinutes),
    optionalNumber(turn.durationMs),
  ];

  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${fields.map(toCsvField).join(",")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createEmpty(path: string): Promise<CsvState> {
  await writeFile(path, `${HEADER_LINE}\n`, "utf8");
  return { maxTurnNumber: 0, recordedKeys: new Set() };
}

function read(fields: readonly string[], column: CsvColumn): string {
  return fields[CSV_HEADER.indexOf(column)] ?? "";
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * Renders a cost in fixed decimals.
 *
 * Six places because a short turn can cost fractions of a cent, and exponential
 * notation (`3.8e-5`) is not something a spreadsheet or `awk` reads as a number.
 */
export function formatCostUsd(amountUsd: number): string {
  return amountUsd.toFixed(6);
}

/** Renders one field as a single-line, quote-safe CSV value. */
function toCsvField(value: string): string {
  const singleLine = value.replace(/[\r\n]+/gu, " ").trim();
  if (!/[",]/u.test(singleLine)) return singleLine;
  return `"${singleLine.replaceAll('"', '""')}"`;
}

/** Splits one CSV row, honouring quoted fields and doubled quotes. */
export function parseCsvRow(row: string): readonly string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];

    if (inQuotes) {
      if (char === '"') {
        if (row[index + 1] === '"') {
          current += '"';
          index += 1;
        } else inQuotes = false;
      } else current += char ?? "";
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ",") {
      fields.push(current);
      current = "";
    } else current += char ?? "";
  }

  fields.push(current);
  return fields;
}

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
  "primary_used_percent",
  "primary_window_minutes",
  "secondary_used_percent",
  "secondary_window_minutes",
  "duration_ms",
] as const;

type CsvColumn = (typeof CSV_HEADER)[number];

export interface CsvState {
  readonly maxTurnNumber: number;
  readonly turnIds: ReadonlySet<string>;
}

const HEADER_LINE = CSV_HEADER.join(",");

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
      ].join("\n"),
    );
  }

  const turnIds = new Set<string>();
  let maxTurnNumber = 0;

  for (const row of rows.slice(1)) {
    const fields = parseCsvRow(row);
    maxTurnNumber = Math.max(maxTurnNumber, toFiniteInt(read(fields, "turn_number"), 0));

    const turnId = read(fields, "turn_id");
    if (turnId !== "") turnIds.add(turnId);
  }

  return { maxTurnNumber, turnIds };
}

/**
 * Appends one turn and flushes it to disk.
 *
 * `fsync` is what makes a recorded turn survive an abrupt exit. No file locking
 * is taken here: the session lock already guarantees a single writer, so
 * per-write locking would add cost without adding safety.
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
    // Native pricing arrives in a later plan; an empty cell is honest, 0 is not.
    "",
    optionalNumber(turn.rateLimits?.primaryUsedPercent),
    optionalNumber(turn.rateLimits?.primaryWindowMinutes),
    optionalNumber(turn.rateLimits?.secondaryUsedPercent),
    optionalNumber(turn.rateLimits?.secondaryWindowMinutes),
    optionalNumber(turn.durationMs),
  ];

  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${fields.map(escapeCsvField).join(",")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createEmpty(path: string): Promise<CsvState> {
  await writeFile(path, `${HEADER_LINE}\n`, "utf8");
  return { maxTurnNumber: 0, turnIds: new Set() };
}

function read(fields: readonly string[], column: CsvColumn): string {
  return fields[CSV_HEADER.indexOf(column)] ?? "";
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function escapeCsvField(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/** Splits one CSV row, honouring quoted fields and doubled quotes. */
function parseCsvRow(row: string): readonly string[] {
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

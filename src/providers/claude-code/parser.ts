import { toFiniteInt } from "../../core/numbers.js";
import { collapseWhitespace } from "../../core/text.js";
import type { ProviderEvent, TokenUsage, UsageModel } from "../../core/types.js";

/** Claude Code reports each message's own usage, so a turn is a sum. */
export const CLAUDE_CODE_USAGE_MODEL: UsageModel = "per-event";

export type ClaudeCodeParser = (record: unknown) => readonly ProviderEvent[];

/**
 * Fields that identify an entry. Absent is acceptable; present but empty means
 * the record is malformed and is dropped whole. Adopted from ccusage's Claude
 * adapter, which applies the same filter.
 */
const IDENTIFYING_RECORD_FIELDS = ["sessionId", "requestId"] as const;
const IDENTIFYING_MESSAGE_FIELDS = ["id", "model"] as const;

/** Any one of these present means the object is a usage report worth reading. */
const USAGE_FIELD_NAMES = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/**
 * Builds a parser for one Claude Code session file.
 *
 * Unlike the Codex parser this is stateful, because the file contains two
 * independent duplications and neither can be recognised from a single record.
 *
 * A compaction re-appends the preserved segment verbatim, same `uuid` and all,
 * so a record whose uuid was already seen is replayed history and is dropped
 * whole. Measured on a real session: four contiguous replay blocks, and turn
 * boundaries falling from a phantom 87 to the true 59.
 *
 * Separately, one API response is written as several records, one per content
 * block, each carrying the full usage. Those share `message.id` and
 * `requestId`, so their usage travels with a `dedupKey` and the assembler
 * counts it once. Deduplicating on uuid instead would bill a three-block
 * response three times.
 *
 * State lives for the lifetime of one run, which is the lifetime of one watch.
 */
export function createClaudeCodeParser(): ClaudeCodeParser {
  const seenUuids = new Set<string>();

  return function parseClaudeCodeRecord(record: unknown): readonly ProviderEvent[] {
    if (!isRecord(record)) return [];

    // Titles, modes and queue operations carry no uuid and no usage.
    const uuid = collapseWhitespace(record["uuid"]);
    if (uuid === "") return [];
    if (seenUuids.has(uuid)) return [];
    seenUuids.add(uuid);

    // Subagent traffic is deliberately out of scope; see docs/ROADMAP.md.
    if (record["isSidechain"] === true) return [];
    if (!hasUsableIdentifiers(record)) return [];

    if (collapseWhitespace(record["type"]) !== "assistant") return [];
    return parseAssistant(record, collapseWhitespace(record["timestamp"]));
  };
}

function parseAssistant(
  record: Readonly<Record<string, unknown>>,
  at: string,
): readonly ProviderEvent[] {
  const message = record["message"];
  if (!isRecord(message)) return [];

  const usage = readUsage(message["usage"]);
  if (usage === undefined) return [];

  const dedupKey = readDedupKey(record, message);
  return [{ kind: "usage", at, usage, ...(dedupKey === undefined ? {} : { dedupKey }) }];
}

/**
 * Identifies the API response a record belongs to.
 *
 * Undefined when either half is missing, which leaves the record counted rather
 * than silently merged with an unrelated one.
 */
function readDedupKey(
  record: Readonly<Record<string, unknown>>,
  message: Readonly<Record<string, unknown>>,
): string | undefined {
  const messageId = collapseWhitespace(message["id"]);
  const requestId = collapseWhitespace(record["requestId"]);
  if (messageId === "" || requestId === "") return undefined;
  return `${messageId}|${requestId}`;
}

/**
 * Reads one response's token usage.
 *
 * Two differences from Codex are load-bearing. `input_tokens` already excludes
 * cached tokens, so nothing is subtracted. And Anthropic reports no reasoning
 * counter at all -- `thinking` blocks exist but are not measured -- so
 * `reasoning` is 0 rather than estimated from anything.
 */
function readUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  if (!USAGE_FIELD_NAMES.some((field) => value[field] !== undefined)) return undefined;

  const inputUncached = readCount(value["input_tokens"]);
  const cacheRead = readCount(value["cache_read_input_tokens"]);
  const output = readCount(value["output_tokens"]);

  // The split object is authoritative when present. Without it the tier is
  // unknown, so the whole amount goes to the cheaper 5-minute rate: a turn that
  // is underpriced is recoverable, one that is overpriced is a false claim.
  const creation = value["cache_creation"];
  const cacheCreation5m = isRecord(creation)
    ? readCount(creation["ephemeral_5m_input_tokens"])
    : readCount(value["cache_creation_input_tokens"]);
  const cacheCreation1h = isRecord(creation) ? readCount(creation["ephemeral_1h_input_tokens"]) : 0;

  return {
    inputUncached,
    cacheRead,
    cacheCreation5m,
    cacheCreation1h,
    output,
    reasoning: 0,
    total: inputUncached + cacheRead + cacheCreation5m + cacheCreation1h + output,
  };
}

function readCount(value: unknown): number {
  return Math.max(toFiniteInt(value, 0), 0);
}

function hasUsableIdentifiers(record: Readonly<Record<string, unknown>>): boolean {
  for (const field of IDENTIFYING_RECORD_FIELDS) {
    if (record[field] !== undefined && collapseWhitespace(record[field]) === "") return false;
  }

  const message = record["message"];
  if (!isRecord(message)) return true;

  for (const field of IDENTIFYING_MESSAGE_FIELDS) {
    if (message[field] !== undefined && collapseWhitespace(message[field]) === "") return false;
  }

  return true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

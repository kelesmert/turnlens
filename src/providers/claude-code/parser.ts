import { toFiniteInt } from "../../core/numbers.js";
import { collapseWhitespace } from "../../core/text.js";
import type { ProviderEvent, TokenUsage, UsageModel } from "../../core/types.js";

/** Claude Code reports each message's own usage, so a turn is a sum. */
export const CLAUDE_CODE_USAGE_MODEL: UsageModel = "per-event";

/**
 * The text Claude Code writes as a user message when a turn is interrupted.
 *
 * There is no dedicated record type for an interruption, so this string is the
 * signal. Deliberately **unterminated**: Claude Code writes two markers and the
 * difference falls after the word "user".
 *
 *   [Request interrupted by user]                 stopped while replying
 *   [Request interrupted by user for tool use]    stopped mid tool call
 *
 * Matching the first as a whole bracketed string silently misses the second,
 * which is how a live session recorded an interrupted WebSearch turn's tokens
 * and tool call against the next prompt instead of its own.
 *
 * The structural fields on the record that precedes the marker
 * (`toolDenialKind`, `toolUseResult`, `is_error`) are deliberately not used as
 * the signal. `toolDenialKind` was measured locally with three values --
 * `user-rejected`, `permission-rule` and `automode-unavailable` -- and only the
 * first means the user stopped the agent. The other two are tools refused while
 * the turn kept running, so treating the field as an abort would split turns
 * that never ended.
 */
export const INTERRUPT_MARKER = "[Request interrupted by user";

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
  let openPromptId: string | undefined;

  return function parseClaudeCodeRecord(record: unknown): readonly ProviderEvent[] {
    if (!isRecord(record)) return [];

    // Titles, modes and queue operations carry no uuid and no usage.
    const uuid = collapseWhitespace(record["uuid"]);
    if (uuid === "") return [];
    if (seenUuids.has(uuid)) return [];
    seenUuids.add(uuid);

    // Subagent traffic is deliberately out of scope: Claude Code writes it to a
    // separate transcript, so nothing here accounts for it.
    if (record["isSidechain"] === true) return [];
    if (!hasUsableIdentifiers(record)) return [];

    const at = collapseWhitespace(record["timestamp"]);

    switch (collapseWhitespace(record["type"])) {
      case "user":
        return parseUser(record, at);
      case "assistant":
        return parseAssistant(record, at);
      case "system":
        return parseSystem(record, at);
      default:
        return [];
    }
  };

  /** Declared inside the factory because it reads and writes `openPromptId`. */
  function parseUser(
    record: Readonly<Record<string, unknown>>,
    at: string,
  ): readonly ProviderEvent[] {
    const message = record["message"];
    const content = isRecord(message) ? message["content"] : undefined;
    const text = readUserText(content);

    if (text.includes(INTERRUPT_MARKER)) {
      return [{ kind: "turnAbort", at, reason: "interrupted" }];
    }

    // The summary a compaction writes is not a prompt; the boundary record that
    // precedes it already closed the turn.
    if (record["isCompactSummary"] === true) return [];
    if (hasToolResult(content)) return [];

    const promptId = collapseWhitespace(record["promptId"]);
    if (promptId === "" || promptId === openPromptId) return [];
    openPromptId = promptId;

    const events: ProviderEvent[] = [{ kind: "turnStart", at, turnId: promptId }];
    if (text !== "") events.push({ kind: "meta", at, promptText: text });
    return events;
  }
}

/**
 * Converts one assistant record into events.
 *
 * Order matters and is asserted by a test. `meta` first so the model is known
 * before anything is priced, tool calls next, then usage, then the close, so a
 * turn ending on this record includes this record's own tokens.
 */
function parseAssistant(
  record: Readonly<Record<string, unknown>>,
  at: string,
): readonly ProviderEvent[] {
  const message = record["message"];
  if (!isRecord(message)) return [];

  const events: ProviderEvent[] = [];

  const model = collapseWhitespace(message["model"]);
  // Codex buries this under turn_context.collaboration_mode.settings; Claude
  // Code puts it on the record itself.
  const reasoningEffort = collapseWhitespace(record["effort"]);
  if (model !== "" || reasoningEffort !== "") {
    events.push({
      kind: "meta",
      at,
      ...(model === "" ? {} : { model }),
      ...(reasoningEffort === "" ? {} : { reasoningEffort }),
    });
  }

  events.push(...readToolCalls(message["content"], at));

  const usage = readUsage(message["usage"]);
  if (usage !== undefined) {
    const dedupKey = readDedupKey(record, message);
    events.push({ kind: "usage", at, usage, ...(dedupKey === undefined ? {} : { dedupKey }) });
  }

  // Emitted after the usage of the same response so the closing turn includes it.
  if (collapseWhitespace(message["stop_reason"]) === "end_turn") {
    events.push({ kind: "turnEnd", at });
  }

  return events;
}

/**
 * One event per `tool_use` block.
 *
 * No deduplication is needed here: a content block appears in exactly one
 * record, and the replayed copies of that record were already dropped by uuid.
 * The block id is passed as `callId` so the assembler's own guard also holds.
 */
function readToolCalls(content: unknown, at: string): readonly ProviderEvent[] {
  if (!Array.isArray(content)) return [];

  const events: ProviderEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (collapseWhitespace(block["type"]) !== "tool_use") continue;

    // An unnamed tool call is not counted under an invented name.
    const name = collapseWhitespace(block["name"]);
    if (name === "") continue;

    const callId = collapseWhitespace(block["id"]);
    events.push({ kind: "toolCall", at, name, ...(callId === "" ? {} : { callId }) });
  }
  return events;
}

/**
 * Closes a turn on compaction.
 *
 * `subtype` is the discriminator rather than the presence of `compactMetadata`,
 * because the metadata's shape is richer than anything TurnScope reads and a
 * future field there should not change whether a turn closes.
 */
function parseSystem(
  record: Readonly<Record<string, unknown>>,
  at: string,
): readonly ProviderEvent[] {
  if (collapseWhitespace(record["subtype"]) !== "compact_boundary") return [];
  return [{ kind: "boundary", at, reason: "compacted" }];
}

/** `message.content` is a plain string as often as it is an array of blocks. */
function readUserText(content: unknown): string {
  if (typeof content === "string") return collapseWhitespace(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (collapseWhitespace(block["type"]) !== "text") continue;
    const text = collapseWhitespace(block["text"]);
    if (text !== "") parts.push(text);
  }
  return parts.join(" ");
}

/** A tool result carries the prompt id of the turn it belongs to, but is not a prompt. */
function hasToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => isRecord(block) && collapseWhitespace(block["type"]) === "tool_result",
  );
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

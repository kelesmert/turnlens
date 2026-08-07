import { toFiniteFloat, toFiniteInt } from "../../core/numbers.js";
import { collapseWhitespace } from "../../core/text.js";
import type { ProviderEvent, TokenUsage, UsageModel } from "../../core/types.js";

/** Codex writes session-cumulative counters, so a turn is a delta. */
export const CODEX_USAGE_MODEL: UsageModel = "cumulative";

/**
 * Tool-call payload types, mapped to the name used when the record carries none.
 *
 * Only `response_item` types are listed. The legacy `*_begin` event names the
 * previous implementation handled never appear in real sessions, and their
 * `*_end` counterparts arrive with no matching start, so both are omitted
 * rather than silently dropping data.
 */
const TOOL_CALL_TYPE_ALIASES: Readonly<Record<string, string>> = {
  apply_patch_call: "apply_patch",
  code_interpreter_call: "code_interpreter",
  computer_call: "computer",
  custom_tool_call: "custom_tool",
  file_search_call: "file_search",
  function_call: "function_call",
  image_generation_call: "image_generation",
  local_shell_call: "local_shell",
  mcp_call: "mcp",
  shell_call: "shell",
  tool_search_call: "tool_search",
  web_search_call: "web_search",
};

const USAGE_FIELD_NAMES = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

/**
 * Converts one Codex JSONL record into events.
 *
 * The record is untrusted parsed JSON: every field is read through a guard and
 * any shape that is not recognised yields an empty array, so a Codex format
 * change degrades to missing data rather than a crash or an invented number.
 */
export function parseCodexRecord(record: unknown): readonly ProviderEvent[] {
  if (!isRecord(record)) return [];

  const payload = record["payload"];
  if (!isRecord(payload)) return [];

  const recordType = collapseWhitespace(record["type"]);
  const at = collapseWhitespace(record["timestamp"]);
  const payloadType = collapseWhitespace(payload["type"]);

  if (recordType === "turn_context") return parseTurnContext(payload, at);
  if (recordType === "event_msg") return parseEventMessage(payload, payloadType, at);
  if (recordType === "response_item" && payloadType in TOOL_CALL_TYPE_ALIASES) {
    return [parseToolCall(payload, payloadType, at)];
  }

  return [];
}

function parseTurnContext(
  payload: Readonly<Record<string, unknown>>,
  at: string,
): readonly ProviderEvent[] {
  const events: ProviderEvent[] = [];

  const turnId = collapseWhitespace(payload["turn_id"]);
  if (turnId !== "") events.push({ kind: "turnStart", at, turnId });

  const model = collapseWhitespace(payload["model"]);
  const reasoningEffort = readReasoningEffort(payload);
  if (model !== "" || reasoningEffort !== "") {
    events.push({
      kind: "meta",
      at,
      ...(model === "" ? {} : { model }),
      ...(reasoningEffort === "" ? {} : { reasoningEffort }),
    });
  }

  return events;
}

function parseEventMessage(
  payload: Readonly<Record<string, unknown>>,
  payloadType: string,
  at: string,
): readonly ProviderEvent[] {
  switch (payloadType) {
    case "token_count": {
      const usage = readCumulativeUsage(payload);
      if (usage === undefined) return [];

      return [{ kind: "usage", at, usage }];
    }

    case "task_complete":
    case "turn_complete": {
      const turnId = collapseWhitespace(payload["turn_id"]);
      const durationMs = toFiniteFloat(payload["duration_ms"]);
      return [
        {
          kind: "turnEnd",
          at,
          ...(turnId === "" ? {} : { turnId }),
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      ];
    }

    case "turn_aborted": {
      const turnId = collapseWhitespace(payload["turn_id"]);
      const reason = collapseWhitespace(payload["reason"]);
      const durationMs = toFiniteFloat(payload["duration_ms"]);
      return [
        {
          kind: "turnAbort",
          at,
          ...(turnId === "" ? {} : { turnId }),
          ...(reason === "" ? {} : { reason }),
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      ];
    }

    case "context_compacted":
      return [{ kind: "boundary", at, reason: "compacted" }];

    case "user_message": {
      const promptText = collapseWhitespace(payload["message"] ?? payload["text"]);
      return promptText === "" ? [] : [{ kind: "meta", at, promptText }];
    }

    default:
      return [];
  }
}

function parseToolCall(
  payload: Readonly<Record<string, unknown>>,
  payloadType: string,
  at: string,
): ProviderEvent {
  const callId = collapseWhitespace(payload["call_id"] ?? payload["id"]);
  return {
    kind: "toolCall",
    at,
    name: readToolName(payload, payloadType),
    ...(callId === "" ? {} : { callId }),
  };
}

function readToolName(payload: Readonly<Record<string, unknown>>, payloadType: string): string {
  const explicit = collapseWhitespace(payload["name"] ?? payload["tool_name"]);
  if (explicit === "") return TOOL_CALL_TYPE_ALIASES[payloadType] ?? payloadType;

  const namespace = collapseWhitespace(payload["namespace"]);
  if (namespace !== "" && !explicit.startsWith(`${namespace}.`)) return `${namespace}.${explicit}`;
  return explicit;
}

/**
 * Reads the reasoning effort for a turn.
 *
 * Codex leaves the top-level `effort` field null and records the real value
 * under the collaboration mode's settings, so the fallback is the normal path.
 */
function readReasoningEffort(payload: Readonly<Record<string, unknown>>): string {
  const direct = collapseWhitespace(payload["reasoning_effort"] ?? payload["effort"]);
  if (direct !== "") return direct;

  const collaborationMode = payload["collaboration_mode"];
  if (!isRecord(collaborationMode)) return "";

  const settings = collaborationMode["settings"];
  if (!isRecord(settings)) return "";

  return collapseWhitespace(settings["reasoning_effort"]);
}

function readCumulativeUsage(payload: Readonly<Record<string, unknown>>): TokenUsage | undefined {
  const info = payload["info"];
  if (!isRecord(info)) return undefined;

  const totals = info["total_token_usage"];
  if (!isRecord(totals)) return undefined;
  if (!USAGE_FIELD_NAMES.some((field) => totals[field] !== undefined)) return undefined;

  const rawInput = toFiniteInt(totals["input_tokens"], 0);
  const cacheRead = toFiniteInt(totals["cached_input_tokens"], 0);
  const output = toFiniteInt(totals["output_tokens"], 0);
  const reasoning = toFiniteInt(totals["reasoning_output_tokens"], 0);
  const declaredTotal = toFiniteInt(totals["total_tokens"]);

  return {
    // Codex reports cached tokens inside input_tokens; the uncached remainder is
    // what is billed at the full input rate.
    inputUncached: Math.max(rawInput - cacheRead, 0),
    cacheRead: Math.max(cacheRead, 0),
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    output: Math.max(output, 0),
    reasoning: Math.max(reasoning, 0),
    total: Math.max(declaredTotal ?? rawInput + output, 0),
  };
}


function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

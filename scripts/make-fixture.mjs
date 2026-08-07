// Builds an anonymized test fixture from a real Codex session file.
//
// Redaction is an allowlist, not a blocklist: only the fields the parser reads
// are copied, so a field Codex adds later cannot leak by default. A blocklist
// would have carried task_complete.last_agent_message, which holds the agent's
// full prose and absolute paths.
//
// Usage: node scripts/make-fixture.mjs <source.jsonl> <destination.jsonl>

import { readFileSync, writeFileSync } from "node:fs";

const REDACTED_PROMPT = "redacted prompt";

const [, , source, destination] = process.argv;
if (source === undefined || destination === undefined) {
  console.error("Usage: node scripts/make-fixture.mjs <source.jsonl> <destination.jsonl>");
  process.exit(1);
}

/** Copies only the listed keys, omitting any that are absent. */
function pick(value, keys) {
  const result = {};
  if (!isRecord(value)) return result;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) result[key] = value[key];
  }
  return result;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

/** Returns the anonymized record, or undefined to drop it. */
function anonymize(record) {
  const { type, timestamp, payload } = record;
  if (!isRecord(payload)) return undefined;

  if (type === "turn_context") {
    return {
      type,
      timestamp,
      payload: {
        ...pick(payload, ["turn_id", "model"]),
        collaboration_mode: {
          settings: pick(payload["collaboration_mode"]?.settings, ["reasoning_effort"]),
        },
      },
    };
  }

  if (type === "event_msg") {
    const inner = anonymizeEventPayload(payload);
    return inner === undefined ? undefined : { type, timestamp, payload: inner };
  }

  // Tool calls only; the *_output counterparts carry command output verbatim.
  if (type === "response_item" && String(payload["type"]).endsWith("_call")) {
    return {
      type,
      timestamp,
      payload: pick(payload, ["type", "name", "call_id", "namespace"]),
    };
  }

  return undefined;
}

function anonymizeEventPayload(payload) {
  switch (payload["type"]) {
    case "token_count": {
      const totals = payload["info"]?.total_token_usage;
      return { type: "token_count", info: { total_token_usage: pick(totals, USAGE_KEYS) } };
    }

    // last_agent_message is deliberately not copied.
    case "task_complete":
      return { type: "task_complete", ...pick(payload, ["turn_id", "duration_ms"]) };

    case "turn_aborted":
      return { type: "turn_aborted", ...pick(payload, ["turn_id", "reason", "duration_ms"]) };

    case "context_compacted":
      return { type: "context_compacted" };

    case "user_message":
      return { type: "user_message", message: REDACTED_PROMPT };

    default:
      return undefined;
  }
}

const output = [];
for (const line of readFileSync(source, "utf8").split("\n")) {
  if (line.trim() === "") continue;

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (!isRecord(record)) continue;

  const anonymized = anonymize(record);
  if (anonymized !== undefined) output.push(JSON.stringify(anonymized));
}

writeFileSync(destination, `${output.join("\n")}\n`, "utf8");
console.log(`${output.length} records written to ${destination}`);

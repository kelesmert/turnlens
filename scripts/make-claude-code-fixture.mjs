// Builds an anonymized test fixture from a real Claude Code session file.
//
// Redaction is an allowlist, not a blocklist: only the fields the parser reads
// are copied, so a field Claude Code adds later cannot leak by default. This
// matters more here than for Codex, because a Claude Code transcript records
// every tool result verbatim -- file contents, command output, pasted text.
//
// Usage: node scripts/make-claude-code-fixture.mjs <source.jsonl> <destination.jsonl>

import { readFileSync, writeFileSync } from "node:fs";

const REDACTED_PROMPT = "redacted prompt";
const REDACTED_TEXT = "redacted text";

const [, , source, destination] = process.argv;
if (source === undefined || destination === undefined) {
  console.error(
    "Usage: node scripts/make-claude-code-fixture.mjs <source.jsonl> <destination.jsonl>",
  );
  process.exit(1);
}

const RECORD_KEYS = [
  "uuid",
  "type",
  "timestamp",
  "isSidechain",
  "promptId",
  "requestId",
  "effort",
  "subtype",
  "isCompactSummary",
];
const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];
const CACHE_CREATION_KEYS = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copies only the listed keys, omitting any that are absent or null. */
function pick(value, keys) {
  const result = {};
  if (!isRecord(value)) return result;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) result[key] = value[key];
  }
  return result;
}

/** Keeps a content block's shape and drops everything a human wrote or a tool printed. */
function anonymizeBlock(block) {
  if (!isRecord(block)) return undefined;
  switch (block.type) {
    case "tool_use":
      return { type: "tool_use", name: block.name, id: block.id };
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.tool_use_id };
    case "text":
      return {
        type: "text",
        text: String(block.text ?? "").includes("[Request interrupted by user]")
          ? "[Request interrupted by user]"
          : REDACTED_TEXT,
      };
    default:
      return { type: block.type };
  }
}

function anonymizeContent(content, isUser) {
  if (typeof content === "string") return isUser ? REDACTED_PROMPT : REDACTED_TEXT;
  if (!Array.isArray(content)) return [];
  return content.map(anonymizeBlock).filter((block) => block !== undefined);
}

/** Returns the anonymized record, or undefined to drop it. */
function anonymize(record) {
  if (!isRecord(record)) return undefined;

  if (record.type === "custom-title") {
    return { type: "custom-title", customTitle: "redacted title" };
  }
  if (record.type === "ai-title") return { type: "ai-title", aiTitle: "redacted title" };
  if (record.type !== "user" && record.type !== "assistant" && record.type !== "system") {
    return undefined;
  }

  const result = pick(record, RECORD_KEYS);
  if (!isRecord(record.message)) return result;

  const usage = pick(record.message.usage, USAGE_KEYS);
  if (isRecord(record.message.usage?.cache_creation)) {
    usage.cache_creation = pick(record.message.usage.cache_creation, CACHE_CREATION_KEYS);
  }

  result.message = {
    ...pick(record.message, ["role", "model", "id", "stop_reason"]),
    content: anonymizeContent(record.message.content, record.type === "user"),
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
  };
  return result;
}

const lines = readFileSync(source, "utf8").split("\n");
const output = [];
for (const line of lines) {
  if (line.trim() === "") continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  const anonymized = anonymize(parsed);
  if (anonymized !== undefined) output.push(JSON.stringify(anonymized));
}

writeFileSync(destination, `${output.join("\n")}\n`);
console.log(`Wrote ${output.length} records to ${destination}`);

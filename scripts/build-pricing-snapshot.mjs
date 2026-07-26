// Regenerates src/pricing/snapshot.generated.ts from the LiteLLM pricing document.
//
// Run: npm run pricing:snapshot
//
// The output is committed. Only the providers TurnLens monitors and only the
// fields src/pricing/litellm.ts reads are kept, which turns a 1.67 MB document
// into roughly 17 KB. Field names stay exactly as LiteLLM spells them so the
// embedded data and a freshly fetched document are parsed by the same code.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const KEEP_PROVIDERS = new Set(["openai", "anthropic"]);
const KEEP_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
];
const OUTPUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "pricing",
  "snapshot.generated.ts",
);

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  console.error(`Failed to fetch ${SOURCE_URL}: HTTP ${response.status}`);
  process.exit(1);
}

const body = await response.text();
const hash = `sha256:${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;

let document;
try {
  document = JSON.parse(body);
} catch (error) {
  console.error(`The source document is not valid JSON: ${error.message}`);
  process.exit(1);
}

const kept = {};
for (const model of Object.keys(document).sort()) {
  const entry = document[model];
  if (typeof entry !== "object" || entry === null) continue;
  if (!KEEP_PROVIDERS.has(entry.litellm_provider)) continue;
  if (entry.mode !== "chat") continue;
  if (typeof entry.input_cost_per_token !== "number") continue;
  if (typeof entry.output_cost_per_token !== "number") continue;

  const rates = {};
  for (const field of KEEP_FIELDS) {
    if (typeof entry[field] === "number") rates[field] = entry[field];
  }
  kept[model] = rates;
}

const modelCount = Object.keys(kept).length;
if (modelCount === 0) {
  console.error("No models survived filtering; refusing to write an empty snapshot.");
  process.exit(1);
}

const generatedAt = new Date().toISOString().slice(0, 10);
const lines = [
  "// GENERATED FILE -- do not edit by hand.",
  "// Regenerate with: npm run pricing:snapshot",
  "//",
  "// Source: LiteLLM model_prices_and_context_window.json (MIT, BerriAI/litellm),",
  "// filtered to the providers TurnLens monitors. TurnLens is not affiliated",
  "// with LiteLLM or with ccusage.",
  'import type { RawPricingEntry } from "./types.js";',
  "",
  `export const SNAPSHOT_SOURCE_URL = ${JSON.stringify(SOURCE_URL)};`,
  `export const SNAPSHOT_CONTENT_HASH = ${JSON.stringify(hash)};`,
  `export const SNAPSHOT_GENERATED_AT = ${JSON.stringify(generatedAt)};`,
  `export const SNAPSHOT_MODEL_COUNT = ${modelCount};`,
  `export const SNAPSHOT_VERSION = ${JSON.stringify(`litellm@${hash}`)};`,
  "",
  "export const PRICING_SNAPSHOT: Readonly<Record<string, RawPricingEntry>> = {",
  ...Object.entries(kept).map(
    ([model, rates]) => `  ${JSON.stringify(model)}: ${JSON.stringify(rates)},`,
  ),
  "};",
  "",
];

writeFileSync(OUTPUT_PATH, lines.join("\n"), "utf8");
console.log(`${modelCount} models written to ${OUTPUT_PATH} (${hash}, generated ${generatedAt})`);

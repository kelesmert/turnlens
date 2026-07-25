import { toFiniteFloat } from "../core/numbers.js";
import type { ModelPricing } from "./types.js";

/**
 * The only fields read from a LiteLLM entry.
 *
 * The snapshot generator copies exactly these, so the embedded data and a
 * freshly fetched document are parsed by the same code path.
 */
export const PRICING_FIELD_NAMES = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
] as const;

/**
 * Converts one untrusted LiteLLM entry into rates, or nothing.
 *
 * A rate is accepted only when it is a finite number at or above zero. Booleans
 * and null are rejected rather than coerced, because a `true` read as `1` would
 * price a token at one dollar, and a negative rate would pay the user for
 * tokens. An entry without both an input and an output rate cannot price a turn
 * at all, so it is dropped rather than half-used.
 */
export function parseLiteLlmEntry(value: unknown): ModelPricing | undefined {
  if (!isRecord(value)) return undefined;

  const inputPerToken = readRate(value["input_cost_per_token"]);
  const outputPerToken = readRate(value["output_cost_per_token"]);
  if (inputPerToken === undefined || outputPerToken === undefined) return undefined;

  const cacheReadPerToken = readRate(value["cache_read_input_token_cost"]);
  const cacheCreationPerToken = readRate(value["cache_creation_input_token_cost"]);
  const cacheCreation1hPerToken = readRate(value["cache_creation_input_token_cost_above_1hr"]);

  return {
    inputPerToken,
    outputPerToken,
    ...(cacheReadPerToken === undefined ? {} : { cacheReadPerToken }),
    ...(cacheCreationPerToken === undefined ? {} : { cacheCreationPerToken }),
    ...(cacheCreation1hPerToken === undefined ? {} : { cacheCreation1hPerToken }),
  };
}

/** Parses a whole document, keeping only entries that can price a turn. */
export function parseLiteLlmDocument(value: unknown): ReadonlyMap<string, ModelPricing> {
  const models = new Map<string, ModelPricing>();
  if (!isRecord(value)) return models;

  for (const [model, entry] of Object.entries(value)) {
    const pricing = parseLiteLlmEntry(entry);
    if (pricing !== undefined) models.set(model, pricing);
  }
  return models;
}

/**
 * The `typeof` guard comes first on purpose. `toFiniteFloat` accepts numeric
 * strings, which is right for session counters but wrong here: LiteLLM's
 * `sample_spec` placeholder entry carries string rates, and accepting it would
 * put a fake model in the table.
 */
function readRate(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  const rate = toFiniteFloat(value);
  return rate === undefined || rate < 0 ? undefined : rate;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

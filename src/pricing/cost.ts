import type { TokenUsage } from "../core/types.js";
import type { ModelPricing, TurnCost } from "./types.js";

/**
 * Prices one turn.
 *
 * Pure and total: the same usage and rates always produce the same amount, and
 * no input makes it throw.
 *
 * `usage.reasoning` is a subset of `usage.output` and is never billed again.
 * A component with non-zero usage and no rate makes the whole turn
 * unpriceable: a partial total looks like a real number while understating the
 * cost, which is worse than an honest gap.
 */
export function computeTurnCost(usage: TokenUsage, pricing: ModelPricing | undefined): TurnCost {
  if (pricing === undefined) return { status: "model_unknown" };

  // The one-hour tier falls back to the standard cache-write rate: a provider
  // without a separate tier still charges for the write.
  const components: readonly (readonly [number, number | undefined])[] = [
    [usage.inputUncached, pricing.inputPerToken],
    [usage.output, pricing.outputPerToken],
    [usage.cacheRead, pricing.cacheReadPerToken],
    [usage.cacheCreation5m, pricing.cacheCreationPerToken],
    [usage.cacheCreation1h, pricing.cacheCreation1hPerToken ?? pricing.cacheCreationPerToken],
  ];

  let amountUsd = 0;
  for (const [tokens, rate] of components) {
    if (tokens <= 0) continue;
    if (rate === undefined) return { status: "no_pricing_data" };
    amountUsd += tokens * rate;
  }

  return { status: "priced", amountUsd };
}

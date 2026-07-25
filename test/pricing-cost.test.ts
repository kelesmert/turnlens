import { describe, expect, it } from "vitest";
import { computeTurnCost } from "../src/pricing/cost.js";
import { emptyUsage } from "../src/core/usage.js";
import type { TokenUsage } from "../src/core/types.js";
import type { ModelPricing } from "../src/pricing/types.js";

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { ...emptyUsage(), ...partial };
}

const CODEX: ModelPricing = {
  inputPerToken: 5e-6,
  outputPerToken: 3e-5,
  cacheReadPerToken: 5e-7,
  cacheCreationPerToken: 6.25e-6,
};

const CLAUDE: ModelPricing = {
  inputPerToken: 5e-6,
  outputPerToken: 2.5e-5,
  cacheReadPerToken: 5e-7,
  cacheCreationPerToken: 6.25e-6,
  cacheCreation1hPerToken: 1e-5,
};

describe("computeTurnCost", () => {
  // The first turn of test/fixtures/codex-abort-session.jsonl:
  // 4018 * 5e-6 + 11008 * 5e-7 + 415 * 3e-5 = 0.038044
  it("prices a real Codex turn", () => {
    const cost = computeTurnCost(
      usage({ inputUncached: 4_018, cacheRead: 11_008, output: 415, reasoning: 122, total: 15_441 }),
      CODEX,
    );

    expect(cost.status).toBe("priced");
    expect(cost.amountUsd).toBeCloseTo(0.038_044, 10);
  });

  // Reasoning is a subset of output. Billing it again would overstate every
  // reasoning-heavy turn.
  it("does not bill reasoning tokens on top of output", () => {
    const withReasoning = computeTurnCost(usage({ output: 1_000, reasoning: 900 }), CODEX);
    const withoutReasoning = computeTurnCost(usage({ output: 1_000, reasoning: 0 }), CODEX);

    expect(withReasoning.amountUsd).toBe(withoutReasoning.amountUsd);
    expect(withReasoning.amountUsd).toBeCloseTo(0.03, 10);
  });

  it("prices both cache-creation tiers separately", () => {
    const cost = computeTurnCost(
      usage({
        inputUncached: 1_000,
        cacheRead: 2_000,
        cacheCreation5m: 3_000,
        cacheCreation1h: 4_000,
        output: 500,
        reasoning: 100,
      }),
      CLAUDE,
    );

    // 0.005 + 0.001 + 0.01875 + 0.04 + 0.0125
    expect(cost.amountUsd).toBeCloseTo(0.077_25, 10);
  });

  // Without a one-hour rate the five-minute rate is the provider's only stated
  // price for a cache write, so it is used rather than treating the tokens as free.
  it("falls back to the five-minute cache rate when no one-hour rate exists", () => {
    const cost = computeTurnCost(usage({ cacheCreation1h: 1_000 }), CODEX);
    expect(cost.amountUsd).toBeCloseTo(0.006_25, 10);
  });

  it("reports model_unknown with no amount when there is no pricing", () => {
    expect(computeTurnCost(usage({ inputUncached: 10_000 }), undefined)).toEqual({
      status: "model_unknown",
    });
  });

  // The alternative is charging nothing for tokens that certainly cost money.
  it("refuses to price a turn whose non-zero component has no rate", () => {
    const cost = computeTurnCost(
      { ...emptyUsage(), cacheRead: 50_000 },
      { inputPerToken: 5e-6, outputPerToken: 3e-5 },
    );

    expect(cost).toEqual({ status: "no_pricing_data" });
  });

  it("prices a turn whose missing rates all have zero usage", () => {
    const cost = computeTurnCost(usage({ inputUncached: 100, output: 10 }), {
      inputPerToken: 5e-6,
      outputPerToken: 3e-5,
    });

    expect(cost.status).toBe("priced");
    expect(cost.amountUsd).toBeCloseTo(0.0008, 10);
  });

  it("prices an empty turn as zero rather than refusing", () => {
    expect(computeTurnCost(emptyUsage(), CODEX)).toEqual({ status: "priced", amountUsd: 0 });
  });

  it("treats a free model as free", () => {
    expect(
      computeTurnCost(usage({ inputUncached: 1_000, output: 100 }), {
        inputPerToken: 0,
        outputPerToken: 0,
      }),
    ).toEqual({ status: "priced", amountUsd: 0 });
  });
});

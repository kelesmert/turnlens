import { describe, expect, it } from "vitest";
import { addUsage, emptyUsage, subtractUsageClamped } from "../src/core/usage.js";
import type { TokenUsage } from "../src/core/types.js";

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { ...emptyUsage(), ...partial };
}

describe("emptyUsage", () => {
  it("starts every counter at zero", () => {
    expect(emptyUsage()).toEqual({
      inputUncached: 0,
      cacheRead: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    });
  });

  it("returns a fresh object so callers cannot share mutable state", () => {
    expect(emptyUsage()).not.toBe(emptyUsage());
  });
});

describe("addUsage", () => {
  it("sums each counter field by field", () => {
    const sum = addUsage(
      usage({ inputUncached: 100, output: 20, total: 120 }),
      usage({ inputUncached: 5, cacheRead: 7, output: 3, total: 15 }),
    );

    expect(sum).toEqual(usage({ inputUncached: 105, cacheRead: 7, output: 23, total: 135 }));
  });

  it("carries the Anthropic cache-creation tiers separately", () => {
    const sum = addUsage(
      usage({ cacheCreation5m: 100, cacheCreation1h: 7 }),
      usage({ cacheCreation5m: 20, cacheCreation1h: 3 }),
    );

    expect(sum.cacheCreation5m).toBe(120);
    expect(sum.cacheCreation1h).toBe(10);
  });
});

describe("subtractUsageClamped", () => {
  it("returns the field-by-field difference", () => {
    const delta = subtractUsageClamped(
      usage({ inputUncached: 500, cacheRead: 40, output: 60, reasoning: 10, total: 600 }),
      usage({ inputUncached: 200, cacheRead: 10, output: 20, reasoning: 4, total: 230 }),
    );

    expect(delta).toEqual(
      usage({ inputUncached: 300, cacheRead: 30, output: 40, reasoning: 6, total: 370 }),
    );
  });

  it("clamps a field at zero without affecting the other fields", () => {
    const delta = subtractUsageClamped(
      usage({ inputUncached: 500, reasoning: 2, total: 600 }),
      usage({ inputUncached: 200, reasoning: 50, total: 230 }),
    );

    expect(delta.reasoning).toBe(0);
    expect(delta.inputUncached).toBe(300);
    expect(delta.total).toBe(370);
  });
});

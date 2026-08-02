import { describe, expect, it } from "vitest";
import { addTurn, emptyBucket, mergeBuckets } from "../src/report/aggregate.js";
import type { NormalizedTurn } from "../src/core/types.js";

function turn(overrides: Partial<NormalizedTurn> = {}): NormalizedTurn {
  return {
    provider: "claude-code",
    sessionId: "s1",
    sessionName: "work",
    turnNumber: 1,
    turnId: "t1",
    status: "completed",
    at: "2026-08-02T09:00:00.000Z",
    usage: {
      inputUncached: 10,
      cacheRead: 20,
      cacheCreation5m: 3,
      cacheCreation1h: 2,
      output: 5,
      reasoning: 1,
      total: 40,
    },
    toolCalls: {},
    model: "opus-5",
    reasoningEffort: "",
    promptPreview: "",
    costStatus: "priced",
    pricingVersion: "test",
    costUsd: 1.5,
    ...overrides,
  };
}

/** A turn whose model no pricing layer knew. Cost absent, never zero. */
function unpriced(overrides: Partial<NormalizedTurn> = {}): NormalizedTurn {
  const { costUsd: _ignored, ...rest } = turn(overrides);
  return { ...rest, costStatus: "model_unknown" };
}

describe("addTurn", () => {
  it("sums every usage field", () => {
    const bucket = addTurn(addTurn(emptyBucket("2026-08-02"), turn()), turn());

    expect(bucket.turns).toBe(2);
    expect(bucket.usage.total).toBe(80);
    expect(bucket.usage.cacheCreation5m).toBe(6);
    expect(bucket.usage.cacheCreation1h).toBe(4);
    expect(bucket.usage.reasoning).toBe(2);
  });

  it("sums cost across priced turns", () => {
    const bucket = addTurn(addTurn(emptyBucket("2026-08-02"), turn()), turn({ costUsd: 0.25 }));

    expect(bucket.costUsd).toBeCloseTo(1.75);
  });

  /**
   * A day is the sum of many turns, so it prints what it could price and counts
   * what it could not. Leaving the day empty would hide real spend.
   */
  it("sums what it can price and counts what it cannot", () => {
    const bucket = addTurn(addTurn(emptyBucket("2026-08-02"), turn()), unpriced());

    expect(bucket.costUsd).toBeCloseTo(1.5);
    expect(bucket.unpricedTurns).toBe(1);
    expect(bucket.turns).toBe(2);
  });

  /**
   * The invariant that survives aggregation. A zero joins a spreadsheet sum and
   * cannot be told from a genuinely free period.
   */
  it("leaves cost absent, not zero, when nothing could be priced", () => {
    const bucket = addTurn(emptyBucket("2026-08-02"), unpriced());

    expect(bucket.costUsd).toBeUndefined();
    expect("costUsd" in bucket).toBe(false);
    expect(bucket.unpricedTurns).toBe(1);
  });

  it("counts a turn priced at genuinely zero as priced", () => {
    const bucket = addTurn(emptyBucket("2026-08-02"), turn({ costUsd: 0 }));

    expect(bucket.costUsd).toBe(0);
    expect(bucket.unpricedTurns).toBe(0);
  });

  it("collects each model once, in a stable order", () => {
    const bucket = [
      turn({ model: "opus-5" }),
      turn({ model: "haiku-4-5" }),
      turn({ model: "opus-5" }),
    ].reduce(addTurn, emptyBucket("2026-08-02"));

    expect(bucket.models).toEqual(["haiku-4-5", "opus-5"]);
  });

  it("keeps the latest activity whichever order the turns arrive in", () => {
    const later = "2026-08-02T09:00:00.000Z";
    const earlier = "2026-08-01T09:00:00.000Z";

    expect(
      addTurn(addTurn(emptyBucket("x"), turn({ at: later })), turn({ at: earlier })).lastActivity,
    ).toBe(later);
    expect(
      addTurn(addTurn(emptyBucket("x"), turn({ at: earlier })), turn({ at: later })).lastActivity,
    ).toBe(later);
  });

  it("does not mutate the bucket it was given", () => {
    const before = emptyBucket("2026-08-02");
    addTurn(before, turn());

    expect(before.turns).toBe(0);
    expect(before.usage.total).toBe(0);
  });

  it("carries a provider when one is set on the bucket", () => {
    const bucket = addTurn({ ...emptyBucket("2026-08-02"), provider: "codex" }, turn());

    expect(bucket.provider).toBe("codex");
  });
});

describe("mergeBuckets", () => {
  it("adds up a total row without repricing anything", () => {
    const a = addTurn(emptyBucket("a"), turn());
    const b = addTurn(emptyBucket("b"), unpriced());

    const total = mergeBuckets([a, b], "All");

    expect(total.label).toBe("All");
    expect(total.turns).toBe(2);
    expect(total.costUsd).toBeCloseTo(1.5);
    expect(total.unpricedTurns).toBe(1);
  });

  it("has no cost when neither side had one", () => {
    const total = mergeBuckets(
      [addTurn(emptyBucket("x"), unpriced()), addTurn(emptyBucket("y"), unpriced())],
      "All",
    );

    expect(total.costUsd).toBeUndefined();
  });

  it("unions the models and keeps the latest activity", () => {
    const a = addTurn(emptyBucket("a"), turn({ model: "opus-5", at: "2026-08-01T00:00:00.000Z" }));
    const b = addTurn(emptyBucket("b"), turn({ model: "codex-1", at: "2026-08-02T00:00:00.000Z" }));

    const total = mergeBuckets([a, b], "All");

    expect(total.models).toEqual(["codex-1", "opus-5"]);
    expect(total.lastActivity).toBe("2026-08-02T00:00:00.000Z");
  });

  it("merges nothing into an empty bucket rather than throwing", () => {
    const total = mergeBuckets([], "All");

    expect(total.turns).toBe(0);
    expect(total.costUsd).toBeUndefined();
  });
});

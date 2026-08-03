import { describe, expect, it } from "vitest";
import { formatReportJson } from "../src/report/json.js";
import type { Bucket } from "../src/report/aggregate.js";
import type { Coverage, ReportData } from "../src/report/collect.js";

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    label: "2026-08-02",
    turns: 31,
    usage: {
      inputUncached: 15_368,
      cacheRead: 270_881_293,
      cacheCreation5m: 5_036_370,
      cacheCreation1h: 0,
      output: 1_234_868,
      reasoning: 0,
      total: 277_167_899,
    },
    models: ["opus-5"],
    costUsd: 215.68,
    unpricedTurns: 0,
    lastActivity: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

const COVERAGE: Coverage = {
  sessions: 2,
  days: 5,
  agents: [
    { provider: "claude-code", sessions: 1 },
    { provider: "codex", sessions: 1 },
  ],
  oldestDay: "2026-07-04",
  newestDay: "2026-08-02",
  timeZone: "Europe/Istanbul",
  unpricedTurns: 0,
  pricingVersion: "litellm@sha256:abcdef123456",
};

function fixture(): ReportData {
  return { buckets: [bucket(), bucket({ label: "2026-08-01" })], coverage: COVERAGE };
}

function unpricedFixture(): ReportData {
  const { costUsd: _dropped, ...rest } = bucket();
  return { buckets: [{ ...rest, unpricedTurns: 31 }], coverage: { ...COVERAGE, unpricedTurns: 31 } };
}

describe("formatReportJson", () => {
  it("parses back to the buckets and the coverage", () => {
    const parsed = JSON.parse(formatReportJson(fixture()));

    expect(parsed.buckets).toHaveLength(2);
    expect(parsed.buckets[0].label).toBe("2026-08-02");
    expect(parsed.coverage.timeZone).toBe("Europe/Istanbul");
    expect(parsed.coverage.sessions).toBe(2);
  });

  it("carries every usage field, so a consumer need not recompute one", () => {
    const parsed = JSON.parse(formatReportJson(fixture()));

    expect(parsed.buckets[0].usage.cacheRead).toBe(270_881_293);
    expect(parsed.buckets[0].usage.total).toBe(277_167_899);
  });

  /**
   * The same rule the CSV follows for the same reason. A consumer summing this
   * field must not read a missing price as free, and `null` invites exactly that.
   */
  it("omits the cost rather than emitting null", () => {
    const json = formatReportJson(unpricedFixture());

    expect(json).not.toMatch(/null/u);
    expect("costUsd" in JSON.parse(json).buckets[0]).toBe(false);
  });

  it("keeps a cost that is genuinely zero, which is a different fact", () => {
    const json = formatReportJson({ ...fixture(), buckets: [bucket({ costUsd: 0 })] });

    expect(JSON.parse(json).buckets[0].costUsd).toBe(0);
  });

  it("names the pricing data, so a stored figure stays explainable", () => {
    expect(JSON.parse(formatReportJson(fixture())).coverage.pricingVersion).toBe(
      "litellm@sha256:abcdef123456",
    );
  });

  it("ends with a newline, so a shell prompt lands on its own line", () => {
    expect(formatReportJson(fixture()).endsWith("\n")).toBe(true);
  });

  it("emits an empty bucket list rather than nothing at all", () => {
    const { oldestDay: _old, newestDay: _new, ...window } = COVERAGE;
    const parsed = JSON.parse(formatReportJson({ buckets: [], coverage: { ...window, sessions: 0 } }));

    expect(parsed.buckets).toEqual([]);
    expect(parsed.coverage.sessions).toBe(0);
    expect("oldestDay" in parsed.coverage).toBe(false);
  });
});

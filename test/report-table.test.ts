import { describe, expect, it } from "vitest";
import { REPORT_COMPACT_THRESHOLD, formatReport } from "../src/report/table.js";
import type { Bucket } from "../src/report/aggregate.js";
import type { Coverage, ReportData } from "../src/report/collect.js";
import type { TokenUsage } from "../src/core/types.js";

const USAGE: TokenUsage = {
  inputUncached: 15_368,
  cacheRead: 270_881_293,
  cacheCreation5m: 5_036_370,
  cacheCreation1h: 0,
  output: 1_234_868,
  reasoning: 0,
  total: 277_167_899,
};

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    label: "2026-08-02",
    turns: 31,
    usage: USAGE,
    models: ["opus-5"],
    costUsd: 215.68,
    unpricedTurns: 0,
    lastActivity: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

const COVERAGE: Coverage = {
  sessions: 2,
  oldestDay: "2026-07-04",
  newestDay: "2026-08-02",
  timeZone: "Europe/Istanbul",
  unpricedTurns: 0,
  pricingVersion: "litellm@sha256:abcdef123456",
};

function fixture(): ReportData {
  return {
    buckets: [bucket(), bucket({ label: "2026-08-01", costUsd: 113.39 })],
    coverage: COVERAGE,
  };
}

function nestedFixture(): ReportData {
  return {
    buckets: [
      bucket({ provider: "claude-code", costUsd: 2.14 }),
      bucket({ provider: "codex", costUsd: 0.31 }),
      bucket({ label: "2026-08-01", provider: "claude-code", costUsd: 3.9 }),
    ],
    coverage: COVERAGE,
  };
}

function unpricedFixture(): ReportData {
  const { costUsd: _dropped, ...rest } = bucket();
  return {
    buckets: [{ ...rest, unpricedTurns: 31 }],
    coverage: { ...COVERAGE, unpricedTurns: 31 },
  };
}

const WIDE = { width: 200, compact: false, nested: false, grouping: "daily" } as const;

describe("formatReport, column tiers", () => {
  it("shows the cache and total-token columns when there is room", () => {
    const lines = formatReport(fixture(), WIDE);

    expect(lines[0]).toMatch(/Cache Read/u);
    expect(lines[0]).toMatch(/Cache Create/u);
    expect(lines[0]).toMatch(/Total Tokens/u);
  });

  /**
   * The same answer Plan 3.7 reached for the live table, and the same threshold
   * ccusage uses: measure the terminal, drop what does not fit, never wrap.
   */
  it("drops them below the threshold", () => {
    const lines = formatReport(fixture(), { ...WIDE, width: REPORT_COMPACT_THRESHOLD - 1 });

    expect(lines[0]).not.toMatch(/Cache Read/u);
    expect(lines[0]).not.toMatch(/Total Tokens/u);
    expect(lines[0]).toMatch(/Cost/u);
    expect(lines[0]).toMatch(/Input/u);
  });

  it("honours --compact in a wide terminal", () => {
    const lines = formatReport(fixture(), { ...WIDE, compact: true });

    expect(lines[0]).not.toMatch(/Cache Read/u);
  });

  /**
   * Every grouping, not only the narrowest set of columns. The session grouping
   * carries two columns the period one does not, a wider label and a last-activity
   * date, and it overflowed every width below 200 until this was asserted.
   */
  it("fits the width it was given, at every tier and grouping", () => {
    for (const grouping of ["daily", "session"] as const) {
      for (const width of [60, REPORT_COMPACT_THRESHOLD - 1, 120, 140, 200]) {
        for (const line of formatReport(fixture(), { ...WIDE, width, grouping })) {
          expect(line.length, `${grouping} at ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("fits a nested table too, which carries an extra column", () => {
    for (const width of [80, 120, 200]) {
      for (const line of formatReport(nestedFixture(), { ...WIDE, width, nested: true })) {
        expect(line.length, `nested at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  /**
   * A window too narrow for the numbers themselves, rather than for the names.
   * Reported because a table quietly missing a column is one a reader will draw a
   * wrong conclusion from.
   */
  it("names the columns it had to drop in a very narrow window", () => {
    // Collapsed, because at 60 columns the sentence naming them is itself
    // wrapped and a column name can straddle two lines.
    const text = formatReport(fixture(), { ...WIDE, width: 60, grouping: "session" })
      .join(" ")
      .replaceAll(/\s+/gu, " ");

    expect(text).toMatch(/not shown/u);
    expect(text).toMatch(/Last Activity/u);
  });

  it("says nothing about dropped columns when none were", () => {
    expect(formatReport(fixture(), WIDE).join("\n")).not.toMatch(/not shown/u);
  });

  it("drops nothing when there is no terminal to fit, as a pipe has none", () => {
    const lines = formatReport(fixture(), { ...WIDE, width: undefined });

    expect(lines[0]).toMatch(/Cache Read/u);
  });

  /**
   * A line ending in spaces is invisible until it is pasted somewhere that keeps
   * it, and the last column has nothing to line up with anyway.
   */
  it("leaves no trailing whitespace on any line", () => {
    for (const grouping of ["daily", "session"] as const) {
      for (const line of formatReport(fixture(), { ...WIDE, grouping })) {
        expect(line).toBe(line.trimEnd());
      }
    }
  });
});

describe("formatReport, rows", () => {
  it("prints a row per bucket, newest first as collected", () => {
    const lines = formatReport(fixture(), WIDE);

    expect(lines.join("\n")).toMatch(/2026-08-02/u);
    expect(lines.join("\n")).toMatch(/2026-08-01/u);
    expect(lines.findIndex((line) => line.includes("2026-08-02"))).toBeLessThan(
      lines.findIndex((line) => line.includes("2026-08-01")),
    );
  });

  it("names the models a period used", () => {
    expect(formatReport(fixture(), WIDE).join("\n")).toMatch(/opus-5/u);
  });

  it("joins several models onto one line rather than wrapping the cell", () => {
    const data = { ...fixture(), buckets: [bucket({ models: ["haiku-4-5", "opus-5"] })] };
    // Only the body: the coverage line names dates too, and it is prose.
    const rows = formatReport(data, WIDE)
      .slice(2)
      .filter((line) => line.startsWith("2026-08-02"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/haiku-4-5, opus-5/u);
  });

  /** The invariant at the last place it can be broken: on the way to a screen. */
  it("prints an empty cost cell rather than a zero", () => {
    const text = formatReport(unpricedFixture(), WIDE).join("\n");

    expect(text).not.toMatch(/\$0\.00/u);
    expect(text).not.toMatch(/\$0 /u);
  });

  /**
   * The inverse of the rule the cost column follows. A token count is never
   * unknown, so blanking a zero would make a known figure look unknowable. Codex
   * reports no cache-creation tokens, and that column reading zero throughout is
   * the truth about Codex.
   */
  it("prints a token count of zero rather than blanking it", () => {
    const zeroed = {
      ...fixture(),
      buckets: [bucket({ usage: { ...USAGE, cacheCreation5m: 0, cacheCreation1h: 0 } })],
    };
    const row = formatReport(zeroed, WIDE)[2] ?? "";

    expect(row).toMatch(/\s0\s/u);
  });

  it("prints a total row under the periods", () => {
    const lines = formatReport(fixture(), WIDE);

    expect(lines.join("\n")).toMatch(/TOTAL/u);
    // 215.68 + 113.39
    expect(lines.join("\n")).toMatch(/329\.07/u);
  });
});

describe("formatReport, nested agents", () => {
  it("prints a merged total per period with the agents beneath it", () => {
    const lines = formatReport(nestedFixture(), { ...WIDE, nested: true });
    const body = lines.slice(2, -1);
    const first = body.findIndex((line) => line.includes("2026-08-02"));

    expect(body[first]).toMatch(/All/u);
    // 2.14 + 0.31 for that day
    expect(body[first]).toMatch(/2\.45/u);
    expect(body[first + 1]).toMatch(/- claude-code/u);
    expect(body[first + 2]).toMatch(/- codex/u);
  });

  it("blanks the repeated period label on the agent rows", () => {
    const lines = formatReport(nestedFixture(), { ...WIDE, nested: true });
    const agentRows = lines.filter((line) => /- (claude-code|codex)/u.test(line));

    expect(agentRows.length).toBeGreaterThan(0);
    for (const row of agentRows) expect(row).not.toMatch(/2026-08-0/u);
  });

  it("shows no agent column when only one agent is in scope", () => {
    expect(formatReport(fixture(), WIDE)[0]).not.toMatch(/Agent/u);
  });

  /**
   * A session belongs to exactly one agent, so a total row above it would repeat
   * the single child beneath it, and the merge would lose the session's id on the
   * way. The agent column stays; the nesting does not.
   */
  it("does not nest a session report, where every group has one member", () => {
    const data = {
      ...fixture(),
      buckets: [{ ...bucket(), id: "019f838c-9", provider: "claude-code" }],
    };
    const lines = formatReport(data, { ...WIDE, nested: true, grouping: "session" });

    expect(lines.join("\n")).not.toMatch(/All/u);
    expect(lines.join("\n")).not.toMatch(/- claude-code/u);
    // The id survives, which it does not through a merge.
    expect(lines[2]).toMatch(/019f838c-9/u);
  });
});

describe("formatReport, the session grouping", () => {
  it("heads the label column with Session and adds last activity", () => {
    const lines = formatReport(fixture(), { ...WIDE, grouping: "session" });

    expect(lines[0]).toMatch(/Session/u);
    expect(lines[0]).toMatch(/Last Activity/u);
    expect(lines.join("\n")).toMatch(/2026-08-02/u);
  });

  it("heads it with the period otherwise", () => {
    expect(formatReport(fixture(), WIDE)[0]).toMatch(/Date/u);
  });
});

describe("formatReport, the coverage line", () => {
  it("says how much was read, over what window, in which zone", () => {
    const text = formatReport(fixture(), WIDE).join("\n");

    expect(text).toMatch(/2 sessions/u);
    expect(text).toMatch(/2026-07-04 to 2026-08-02/u);
    expect(text).toMatch(/Europe\/Istanbul/u);
  });

  /**
   * Said once at the bottom rather than marked on every row. Every figure in a
   * report is reconstructed and none of them reaches the CSV, so one line carries
   * what a column would have had to repeat.
   */
  it("says every figure is priced at today's rates", () => {
    expect(formatReport(fixture(), WIDE).join("\n")).toMatch(/today's rates/u);
  });

  it("says how many turns could not be priced, when any could not", () => {
    expect(formatReport(unpricedFixture(), WIDE).join("\n")).toMatch(
      /31 turns could not be priced/u,
    );
  });

  it("says nothing about pricing failures when there were none", () => {
    expect(formatReport(fixture(), WIDE).join("\n")).not.toMatch(/could not be priced/u);
  });

  it("says it found nothing rather than printing an empty table", () => {
    const { oldestDay: _old, newestDay: _new, ...window } = COVERAGE;
    const text = formatReport({ buckets: [], coverage: { ...window, sessions: 0 } }, WIDE).join("\n");

    expect(text).toMatch(/No turns/u);
  });

  it("names the pricing data it used, so an old figure stays explainable", () => {
    expect(formatReport(fixture(), WIDE).join("\n")).toMatch(/litellm@sha256:abcdef123456/u);
  });
});

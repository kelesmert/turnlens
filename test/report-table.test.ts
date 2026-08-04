import { describe, expect, it } from "vitest";
import { REPORT_COMPACT_THRESHOLD, formatReport } from "../src/report/table.js";
import { COLOUR } from "../src/ui/colour.js";
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

/** Escapes removed, so a shape can be recognised whether or not it is painted. */
function strip(text: string): string {
  return text.replaceAll(/\u001b\[[0-9;]*m/gu, "");
}

/** Whether a line is a given piece of box drawing, ignoring any colour on it. */
function drawn(line: string, glyph: string): boolean {
  return strip(line).startsWith(glyph);
}

/**
 * The table itself, with the title box above it discarded.
 *
 * Found by looking for the top rule rather than by counting lines, so a change
 * to the title cannot silently shift every assertion in this file by four.
 */
function table(lines: readonly string[]): readonly string[] {
  const top = lines.findIndex((line) => drawn(line, "┌"));
  return top === -1 ? lines : lines.slice(top);
}

/** The heading row, which sits under the table's top rule. */
function header(lines: readonly string[]): string {
  return table(lines)[1] ?? "";
}

/**
 * The data rows only: no rules, no TOTAL, no coverage.
 *
 * Found by drawing rather than by content. The coverage line is prose and names
 * dates, so it cannot be told from a data row by what it says.
 */
function body(lines: readonly string[]): readonly string[] {
  const rows = table(lines).slice(3);
  const bottom = rows.findIndex((line) => drawn(line, "└"));
  const beforeTotal = rows.slice(0, bottom === -1 ? rows.length : bottom);
  const totalRule = beforeTotal.findLastIndex((line) => drawn(line, "├"));

  return (totalRule === -1 ? beforeTotal : beforeTotal.slice(0, totalRule)).filter(
    (line) => !drawn(line, "├"),
  );
}

/** The cells of one rendered row, with the borders and their padding removed. */
function cells(row: string): readonly string[] {
  return strip(row).split("│").slice(1, -1).map((cell) => cell.trim());
}

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

/** The title box, which sits above the table's top rule. */
function title(lines: readonly string[]): readonly string[] {
  const top = lines.findIndex((line) => drawn(line, "┌"));
  return top === -1 ? [] : lines.slice(0, top);
}

describe("formatReport, column tiers", () => {
  it("shows the cache and total-token columns when there is room", () => {
    const lines = formatReport(fixture(), WIDE);

    expect(header(lines)).toMatch(/Cache Read/u);
    expect(header(lines)).toMatch(/Cache Create/u);
    expect(header(lines)).toMatch(/Total Tokens/u);
  });

  /**
   * The same answer Plan 3.7 reached for the live table, and the same threshold
   * ccusage uses: measure the terminal, drop what does not fit, never wrap.
   */
  it("drops them below the threshold", () => {
    const lines = formatReport(fixture(), { ...WIDE, width: REPORT_COMPACT_THRESHOLD - 1 });

    expect(header(lines)).not.toMatch(/Cache Read/u);
    expect(header(lines)).not.toMatch(/Total Tokens/u);
    expect(header(lines)).toMatch(/Cost/u);
    expect(header(lines)).toMatch(/Input/u);
  });

  it("honours --compact in a wide terminal", () => {
    const lines = formatReport(fixture(), { ...WIDE, compact: true });

    expect(header(lines)).not.toMatch(/Cache Read/u);
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

    expect(header(lines)).toMatch(/Cache Read/u);
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

describe("formatReport, the title", () => {
  /**
   * What the table itself never carried. Redirected to a file, a report gave no
   * way to tell which agents it covered, nor a weekly one from a daily one
   * except by reading the dates.
   */
  it("names the grouping, taken from the shape the rows took", () => {
    const heading = (grouping: "daily" | "weekly" | "monthly" | "session"): string =>
      title(formatReport(fixture(), { ...WIDE, grouping }))[1] ?? "";

    expect(heading("daily")).toMatch(/Report - Daily/u);
    expect(heading("weekly")).toMatch(/Report - Weekly/u);
    expect(heading("monthly")).toMatch(/Report - Monthly/u);
    expect(heading("session")).toMatch(/Report - Session/u);
  });

  /**
   * Read off the coverage rather than off a flag, so the heading describes what
   * was searched rather than what was typed.
   */
  it("names the one agent in scope", () => {
    const data = {
      ...fixture(),
      coverage: { ...COVERAGE, agents: [{ provider: "codex", sessions: 35 }] },
    };

    expect(title(formatReport(data, WIDE))[1]).toMatch(/Codex Token Usage Report - Daily/u);
  });

  it("says all agents when more than one was searched", () => {
    expect(title(formatReport(fixture(), WIDE))[1]).toMatch(/All Agents Token Usage Report/u);
  });

  it("writes Claude Code as a reader would say it", () => {
    const data = {
      ...fixture(),
      coverage: { ...COVERAGE, agents: [{ provider: "claude-code", sessions: 4 }] },
    };

    expect(title(formatReport(data, WIDE))[1]).toMatch(/Claude Code Token Usage Report/u);
  });

  /**
   * The day count is the one fact neither the table nor the coverage line
   * carries. A range says a fortnight; this says whether that fortnight held
   * three days of work or fourteen.
   */
  it("says how much was read and over how many days", () => {
    expect(title(formatReport(fixture(), WIDE)).join("\n")).toMatch(/2 sessions over 5 days/u);
  });

  it("counts one session and one day in the singular", () => {
    const data = {
      ...fixture(),
      coverage: { ...COVERAGE, sessions: 1, days: 1, agents: [{ provider: "codex", sessions: 1 }] },
    };

    expect(title(formatReport(data, WIDE)).join("\n")).toMatch(/1 session over 1 day\b/u);
  });

  it("breaks the sessions down per agent when more than one was searched", () => {
    const text = title(formatReport(fixture(), WIDE)).join("\n");

    expect(text).toMatch(/Claude Code\s+1 session\b/u);
    expect(text).toMatch(/Codex\s+1 session\b/u);
  });

  /** With one agent the heading already names it, so the breakdown would repeat it. */
  it("gives no breakdown when the report was narrowed to one agent", () => {
    const data = {
      ...fixture(),
      coverage: { ...COVERAGE, agents: [{ provider: "codex", sessions: 35 }] },
    };

    expect(title(formatReport(data, WIDE)).join("\n")).not.toMatch(/Codex\s+35 sessions/u);
  });

  /**
   * A reader who sees no Codex row wants to know whether Codex was searched and
   * found empty, or was never in scope. Only the coverage can answer that.
   */
  it("lists an agent that contributed no rows", () => {
    const data = {
      ...fixture(),
      coverage: {
        ...COVERAGE,
        agents: [
          { provider: "claude-code", sessions: 2 },
          { provider: "codex", sessions: 0 },
        ],
      },
    };

    expect(title(formatReport(data, WIDE)).join("\n")).toMatch(/Codex\s+0 sessions/u);
  });

  it("says so when no agent was found at all", () => {
    const data = { ...fixture(), coverage: { ...COVERAGE, agents: [] } };

    expect(title(formatReport(data, WIDE)).join("\n")).toMatch(/No agents found/u);
  });

  /** Rounded, so the box that labels the table is not read as part of it. */
  it("draws the title box with rounded corners and closes it", () => {
    const box = title(formatReport(fixture(), WIDE));

    expect(box[0]?.startsWith("╭")).toBe(true);
    expect(box[0]?.endsWith("╮")).toBe(true);
    expect(box.at(-2)?.startsWith("╰")).toBe(true);
    expect(box.at(-2)?.endsWith("╯")).toBe(true);
  });

  it("draws every line of the title box to one length", () => {
    for (const data of [fixture(), nestedFixture()]) {
      const box = title(formatReport(data, WIDE)).filter((line) => line !== "");
      expect(new Set(box.map((line) => line.length)).size).toBe(1);
    }
  });

  it("puts a blank line between the title and the table", () => {
    expect(title(formatReport(fixture(), WIDE)).at(-1)).toBe("");
  });

  /**
   * Moved up from under the table. A reader wanting to know what a number covers
   * is looking at the number, and reading upwards past two hundred rows to find
   * the answer is the wrong direction.
   */
  it("carries the window, the timezone and the pricing list", () => {
    const text = title(formatReport(fixture(), WIDE)).join("\n");

    expect(text).toMatch(/2026-07-04 to 2026-08-02, Europe\/Istanbul/u);
    expect(text).toMatch(/Priced at today's rates, from litellm@sha256:abcdef123456/u);
  });

  it("says how many turns could not be priced, and only when some could not", () => {
    expect(title(formatReport(unpricedFixture(), WIDE)).join("\n")).toMatch(
      /31 turns could not be priced/u,
    );
    expect(title(formatReport(fixture(), WIDE)).join("\n")).not.toMatch(/could not be priced/u);
  });

  /**
   * A long pricing version is what pushes the box past the window. Wrapped to
   * what the borders leave rather than allowed to run off the edge, which is the
   * one thing a box cannot survive.
   */
  it("wraps its own lines to the window rather than overflowing", () => {
    for (const width of [60, 80, 100]) {
      for (const line of title(formatReport(fixture(), { ...WIDE, width }))) {
        expect(line.length, `title at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  /**
   * A report that found no turns is exactly when a reader needs to know what was
   * searched, and since the scope moved into the box there is nowhere else for
   * that answer to be.
   */
  it("draws the box even with no table to label", () => {
    const lines = formatReport({ ...fixture(), buckets: [] }, WIDE);

    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines.join("\n")).toMatch(/2 sessions over 5 days/u);
    expect(lines.join("\n")).toMatch(/litellm@sha256:abcdef123456/u);
    expect(lines.join("\n")).toMatch(/No turns found/u);
    expect(lines.join("\n")).not.toMatch(/[┌└]/u);
  });
});

describe("formatReport, borders", () => {
  /**
   * A box whose lines disagree about their length is a box with a hole in it,
   * and it is the failure a width change makes first. Asserted across every
   * grouping and tier, including rows tall enough to need a continuation line.
   */
  it("draws every line of the table to one length", () => {
    const data = {
      ...fixture(),
      buckets: [bucket({ models: ["haiku-4-5", "opus-5", "sonnet-5"] }), bucket()],
    };

    for (const grouping of ["daily", "session"] as const) {
      for (const width of [80, 100, 120, 174]) {
        const lines = table(formatReport(data, { ...WIDE, width, grouping }));
        const boxed = lines.slice(0, lines.findIndex((line) => line.startsWith("└")) + 1);
        const widths = new Set(boxed.map((line) => line.length));

        expect(widths.size, `${grouping} at ${width}: ${[...widths].join()}`).toBe(1);
      }
    }
  });

  it("closes the box: a top rule, a heading rule, and a bottom rule", () => {
    const lines = table(formatReport(fixture(), WIDE));

    expect(lines[0]?.startsWith("┌")).toBe(true);
    expect(lines[0]?.endsWith("┐")).toBe(true);
    expect(lines[2]?.startsWith("├")).toBe(true);
    expect(lines.some((line) => line.startsWith("└"))).toBe(true);
  });

  /**
   * The border costs `3n + 1` where a borderless table paid `n - 1`, and
   * `shrinkToFit` and `dropToFit` both size the table by asking the renderer for
   * that number. A disagreement between the two is what puts a row past the edge
   * of a window, so the junctions are counted against the columns rather than
   * against a remembered total.
   */
  it("charges one rule per column boundary to the width budget", () => {
    const lines = table(formatReport(fixture(), { ...WIDE, width: undefined }));
    const columns = cells(lines[1] ?? "").length;

    for (const line of [lines[0], lines[1], lines[2]]) {
      const junctions = [...(line ?? "")].filter((glyph) => "┌┬┐├┼┤│".includes(glyph));
      expect(junctions).toHaveLength(columns + 1);
    }
  });

  /** Every cell is padded on both sides, so no value touches a rule. */
  it("pads each cell away from its rules", () => {
    const row = body(formatReport(fixture(), WIDE))[0] ?? "";

    for (const segment of row.split("│").slice(1, -1)) {
      expect(segment.startsWith(" ")).toBe(true);
      expect(segment.endsWith(" ")).toBe(true);
    }
  });

  it("separates every period from the next", () => {
    const lines = formatReport(fixture(), WIDE);
    const rules = lines.filter((line) => line.startsWith("├"));

    // One under the heading, one between the two periods, one above TOTAL.
    expect(rules).toHaveLength(3);
  });

  /**
   * Reversed after seeing it drawn. Without a rule under an agent's last model
   * line there is nothing to say where one agent's block ends, and an agent's
   * models run down several lines. The earlier reasoning, that a rule between a
   * period and its children says they are apart, lost to the fact that a reader
   * could not tell whose models were whose.
   */
  it("separates a period total from its agents, and each agent from the next", () => {
    const lines = formatReport(nestedFixture(), { ...WIDE, nested: true });
    const rules = lines.filter((line) => line.startsWith("├"));

    // The fixture is two periods, the first with two agents and the second with
    // one. Heading, two inside the first period, one between the periods, one
    // inside the second, one above TOTAL.
    expect(rules).toHaveLength(6);
  });

  it("draws the box when there is no terminal, as a redirect has none", () => {
    const lines = table(formatReport(fixture(), { ...WIDE, width: undefined }));

    expect(lines[0]?.startsWith("┌")).toBe(true);
  });

  it("draws no box at all when there is nothing to put in one", () => {
    const empty = { ...fixture(), buckets: [] };

    expect(formatReport(empty, WIDE).join("\n")).not.toMatch(/[┌└├]/u);
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

  /**
   * The reason this table was rewritten. Joined and cut, a two-model day read
   * `gpt-5.6-luna, gpt-5...`, which names one model and half of nothing.
   */
  it("gives each model its own line rather than joining and cutting", () => {
    const data = { ...fixture(), buckets: [bucket({ models: ["haiku-4-5", "opus-5"] })] };
    const rows = body(formatReport(data, WIDE));

    expect(rows).toHaveLength(2);
    expect(cells(rows[0] ?? "").slice(0, 2)).toEqual(["2026-08-02", "- haiku-4-5"]);
    expect(cells(rows[1] ?? "").slice(0, 2)).toEqual(["", "- opus-5"]);
  });

  it("keeps a single-model day on one line", () => {
    const data = { ...fixture(), buckets: [bucket({ models: ["opus-5"] })] };
    expect(body(formatReport(data, WIDE))).toHaveLength(1);
  });

  /**
   * The continuation line carries the model and nothing else. Repeating the date
   * would read as a second day and repeating a count would double the report.
   */
  it("leaves every other column blank on a continuation line", () => {
    const data = { ...fixture(), buckets: [bucket({ models: ["haiku-4-5", "opus-5"] })] };
    const [, second] = body(formatReport(data, WIDE));

    expect(second).not.toMatch(/2026-08-02/u);
    expect(second).not.toMatch(/\d,\d/u);
    expect(second).not.toMatch(/\$/u);
  });

  it("sizes the models column to the longest single name, not the joined list", () => {
    const short = table(
      formatReport({ ...fixture(), buckets: [bucket({ models: ["opus-5"] })] }, WIDE),
    );
    const long = table(
      formatReport({ ...fixture(), buckets: [bucket({ models: ["opus-5", "haiku-4-5"] })] }, WIDE),
    );

    // Two models, but the wider name is only three characters longer than the
    // other, so the table grows by three rather than by a joined list.
    expect(long[0]?.length).toBe((short[0]?.length ?? 0) + 3);
  });

  /**
   * The full identifier is what the shortening rule falls back to, and it has to
   * survive the trip to a screen rather than being cut on arrival.
   */
  it("prints full identifiers whole when shortening would collide", () => {
    const data = {
      ...fixture(),
      buckets: [bucket({ models: ["claude-opus-5", "opus-5"] })],
    };
    const rows = body(formatReport(data, WIDE));

    expect(rows[0]).toMatch(/- claude-opus-5/u);
    expect(rows[1]).toMatch(/- opus-5/u);
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
    const row = body(formatReport(zeroed, WIDE))[0] ?? "";

    expect(cells(row)).toContain("0");
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
    const rows = body(formatReport(nestedFixture(), { ...WIDE, nested: true }));
    const first = rows.findIndex((line) => line.includes("2026-08-02"));

    expect(rows[first]).toMatch(/All/u);
    // 2.14 + 0.31 for that day
    expect(rows[first]).toMatch(/2\.45/u);
    expect(rows[first + 1]).toMatch(/- claude-code/u);
    expect(rows[first + 2]).toMatch(/- codex/u);
  });

  it("blanks the repeated period label on the agent rows", () => {
    const lines = formatReport(nestedFixture(), { ...WIDE, nested: true });
    const agentRows = lines.filter((line) => /- (claude-code|codex)/u.test(line));

    expect(agentRows.length).toBeGreaterThan(0);
    for (const row of agentRows) expect(row).not.toMatch(/2026-08-0/u);
  });

  it("shows no agent column when only one agent is in scope", () => {
    expect(header(formatReport(fixture(), WIDE))).not.toMatch(/Agent/u);
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

    // The table only: the title says "All Agents" because both were searched,
    // which is about scope rather than about nesting.
    expect(table(lines).join("\n")).not.toMatch(/All/u);
    expect(table(lines).join("\n")).not.toMatch(/- claude-code/u);
    // The id survives, which it does not through a merge.
    expect(body(lines)[0]).toMatch(/019f838c-9/u);
  });
});

describe("formatReport, the session grouping", () => {
  it("heads the label column with Session and adds last activity", () => {
    const lines = formatReport(fixture(), { ...WIDE, grouping: "session" });

    expect(header(lines)).toMatch(/Session/u);
    expect(header(lines)).toMatch(/Last Activity/u);
    expect(lines.join("\n")).toMatch(/2026-08-02/u);
  });

  it("heads it with the period otherwise", () => {
    expect(header(formatReport(fixture(), WIDE))).toMatch(/Date/u);
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

describe("formatReport, colour", () => {
  /**
   * The whole reason colour is injected rather than decided inside the renderer.
   * An escape lengthens a string without occupying a column, so a table that
   * measured its own coloured output would come out ragged.
   */
  it("renders the same text coloured as plain", () => {
    const plain = formatReport(fixture(), WIDE);
    const painted = formatReport(fixture(), { ...WIDE, paint: COLOUR });

    expect(painted.map(strip)).toEqual([...plain]);
  });

  it("keeps every line of the table one width once the escapes are removed", () => {
    // From the table's top rule onwards. The title box is drawn with the same
    // vertical rule and is deliberately narrower, so it is not part of this.
    const stripped = formatReport(fixture(), { ...WIDE, paint: COLOUR }).map(strip);
    const boxed = stripped
      .slice(stripped.findIndex((line) => line.startsWith("┌")))
      .filter((line) => /^[┌├└│]/u.test(line));
    const widths = new Set(boxed.map((line) => line.length));

    expect(boxed.length).toBeGreaterThan(4);
    expect(widths.size).toBe(1);
  });

  /**
   * The failure this whole design exists to prevent. Measured with the escapes
   * still in, the box looks ragged by exactly the number of bytes colour added.
   */
  it("would not fit its own width if the escapes were counted", () => {
    const painted = formatReport(fixture(), { ...WIDE, paint: COLOUR });
    const rules = painted.filter((line) => /^\u001b.*┌/u.test(line));

    expect(rules[0]?.length).toBeGreaterThan(strip(rules[0] ?? "").length);
  });

  it("paints nothing at all when no paint is given", () => {
    for (const line of formatReport(fixture(), WIDE)) {
      expect(line).not.toMatch(/\u001b/u);
    }
  });

  /**
   * The row a reader scanning a nested report is actually looking for. The
   * agents beneath it answer "which one"; it answers "how much", and it is what
   * separates one period from the next.
   */
  it("emphasises a period total and leaves its agents plain", () => {
    const rows = body(formatReport(nestedFixture(), { ...WIDE, nested: true, paint: COLOUR }));
    const [parent, ...children] = rows;

    expect(strip(parent ?? "")).toMatch(/All/u);
    expect(parent).toMatch(/\u001b\[1m/u);
    expect(children[0]).not.toMatch(/\u001b\[1m/u);
  });

  it("emphasises the grand total, at the same weight", () => {
    const painted = formatReport(fixture(), { ...WIDE, paint: COLOUR });
    const total = painted.find((line) => strip(line).includes("TOTAL"));

    expect(total).toMatch(/\u001b\[1m/u);
  });

  it("marks the unpriced warning for attention", () => {
    const painted = formatReport(unpricedFixture(), { ...WIDE, paint: COLOUR }).join("\n");
    const warning = painted.split("\n").find((line) => line.includes("could not be priced"));

    expect(warning).toBeDefined();
    expect(warning).toMatch(/\u001b/u);
  });
});

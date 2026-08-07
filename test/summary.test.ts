import { describe, expect, it } from "vitest";
import { addTurn, emptyTotals, formatSessionSummary } from "../src/ui/summary.js";
import { emptyUsage } from "../src/core/usage.js";
import type { NormalizedTurn } from "../src/core/types.js";
import type { SessionTotals } from "../src/ui/summary.js";

/** Folds a session's turns the way `runWatch` does, then renders the block. */
function fold(turns: readonly NormalizedTurn[]): SessionTotals {
  return turns.reduce(addTurn, emptyTotals());
}

function turn(overrides: Partial<NormalizedTurn> = {}): NormalizedTurn {
  return {
    provider: "codex",
    sessionId: "s",
    sessionName: "n",
    turnNumber: 1,
    turnId: "turn-a",
    status: "completed",
    at: "2026-07-22T02:31:05.000Z",
    usage: { ...emptyUsage(), inputUncached: 900, cacheRead: 100, output: 50, reasoning: 20, total: 1_050 },
    toolCalls: { exec: 2 },
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    promptPreview: "",
    costStatus: "priced",
    costUsd: 0.038_044,
    pricingVersion: "litellm@sha256:0123456789ab",
    ...overrides,
  };
}

/** A turn with no cost at all: the property is omitted, never set to undefined. */
function unpricedTurn(overrides: Partial<NormalizedTurn> = {}): NormalizedTurn {
  const { costUsd, ...rest } = turn(overrides);
  void costUsd;
  return { ...rest, costStatus: "model_unknown" };
}

function summaryOf(turns: readonly NormalizedTurn[], width?: number): string {
  return formatSessionSummary(fold(turns), width).join("\n");
}

describe("formatSessionSummary", () => {
  it("says so plainly when the session closed no turns at all", () => {
    expect(summaryOf([])).toContain("No turns in this session");
  });

  it("totals tokens, cache ratio and tools, counting aborted turns separately", () => {
    const text = summaryOf([
      turn({ turnNumber: 1, turnId: "a" }),
      turn({ turnNumber: 2, turnId: "b", status: "aborted" }),
    ]);

    expect(text).toContain("Session turns           : 2");
    expect(text).toContain("Aborted turns           : 1");
    expect(text).toContain("Uncached input tokens   : 1,800");
    expect(text).toContain("Cache read tokens       : 200");
    expect(text).toContain("Cache ratio             : 10.0%");
    expect(text).toContain("Reasoning tokens        : 40");
    expect(text).toContain("Total tokens            : 2,100");
    expect(text).toContain("Tool calls              : 4");
  });

  it("breaks down models, efforts and tools by frequency", () => {
    const text = summaryOf([
      turn({ turnNumber: 1, turnId: "a" }),
      turn({ turnNumber: 2, turnId: "b", model: "gpt-5.6-terra", reasoningEffort: "low" }),
      turn({ turnNumber: 3, turnId: "c", toolCalls: { exec: 1, web_search: 5 } }),
    ]);

    expect(text).toContain("gpt-5.6-sol=2");
    expect(text).toContain("gpt-5.6-terra=1");
    expect(text).toContain("medium=2");
    expect(text).toContain("web_search=5");
    expect(text).toContain("exec=5");
  });

  it("never reports an unpriced turn as free", () => {
    const text = summaryOf([unpricedTurn()]);

    expect(text).not.toContain("$0.0000");
    expect(text).not.toContain("$0.000000");
  });

  it("reports average and longest duration only from turns that recorded one", () => {
    const text = summaryOf([
      turn({ turnNumber: 1, turnId: "a", durationMs: 10_000 }),
      turn({ turnNumber: 2, turnId: "b", durationMs: 20_000 }),
      turn({ turnNumber: 3, turnId: "c" }),
    ]);

    expect(text).toContain("Average duration        : 15.0s");
    expect(text).toContain("Longest duration        : 20.0s");
  });

  it("shows a dash for duration when no turn recorded one", () => {
    expect(summaryOf([turn()])).toContain("Average duration        : -");
  });

  it("reports a zero cache ratio without dividing by zero", () => {
    const text = summaryOf([
      turn({ usage: { ...emptyUsage(), output: 10, total: 10 } }),
    ]);

    expect(text).toContain("Cache ratio             : 0.0%");
  });

  it("handles a session name containing a comma without shifting columns", () => {
    const text = summaryOf([turn({ sessionName: "a, b", model: "gpt-5.6-sol" })]);

    expect(text).toContain("Total tokens            : 1,050");
    expect(text).toContain("gpt-5.6-sol=1");
  });
});

describe("formatSessionSummary reports cost", () => {
  it("totals the costs it can and counts the turns it cannot price", () => {
    const text = summaryOf([
      turn({ turnNumber: 1, turnId: "a", costUsd: 0.038_044 }),
      turn({ turnNumber: 2, turnId: "b", costUsd: 0.001_956 }),
      unpricedTurn({ turnNumber: 3, turnId: "c" }),
    ]);

    expect(text).toContain("Estimated cost          : $0.040000");
    expect(text).toContain("Unpriced turns          : 1 (model_unknown=1)");
    expect(text).toContain("Pricing data            : litellm@sha256:0123456789ab");
    expect(text).not.toContain("not implemented yet");
  });

  it("says so plainly when nothing could be priced", () => {
    expect(summaryOf([unpricedTurn()])).toContain("Estimated cost          : unavailable");
  });
});

describe("summary block width", () => {
  /**
   * The same defect the startup banner had, at the other end of the run: the
   * rule was a fixed 72 while a tool breakdown measured 106, so the block drew
   * a box its own contents broke out of. This is the last line the user sees.
   */
  it("draws its rule around its own longest line", () => {
    const lines = formatSessionSummary(fold([turn({ toolCalls: manyTools() })]));
    const longest = Math.max(...lines.map((line) => line.length));

    for (const rule of lines.filter((line) => /^=+$/u.test(line))) {
      expect(rule).toHaveLength(longest);
    }
  });

  it("keeps every line inside the terminal it is printed into", () => {
    for (const width of [60, 80, 120]) {
      for (const line of formatSessionSummary(fold([turn({ toolCalls: manyTools() })]), width)) {
        expect(line.length).toBeLessThanOrEqual(width - 1);
      }
    }
  });

  /** Wrapping may move a name to the next line; it may never lose one. */
  it("still reports every tool once the breakdown is wrapped", () => {
    const text = summaryOf([turn({ toolCalls: manyTools() })], 80);

    for (const name of Object.keys(manyTools())) expect(text).toContain(name);
  });
});

/** Enough tool names that the breakdown outgrows any fixed rule. */
function manyTools(): Record<string, number> {
  return {
    Bash: 46,
    Edit: 33,
    TaskUpdate: 17,
    Read: 12,
    TaskCreate: 11,
    WebSearch: 4,
    AskUserQuestion: 3,
    Write: 3,
    Skill: 2,
    ToolSearch: 1,
  };
}

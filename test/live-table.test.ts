import { describe, expect, it } from "vitest";
import {
  FULL_TABLE_WIDTH,
  SESSION_LISTING_WIDTH,
  formatSessionListing,
  formatTableHeader,
  formatTurnRow,
  formatWindowLabel,
} from "../src/ui/live-table.js";
import { emptyUsage } from "../src/core/usage.js";
import type { NormalizedTurn, SessionRef } from "../src/core/types.js";

function turn(overrides: Partial<NormalizedTurn> = {}): NormalizedTurn {
  return {
    provider: "codex",
    sessionId: "s",
    sessionName: "n",
    turnNumber: 7,
    turnId: "turn-a",
    status: "completed",
    at: "2026-07-22T02:31:05.000Z",
    usage: { ...emptyUsage(), inputUncached: 117_483, cacheRead: 11_008, output: 5, total: 128_496 },
    toolCalls: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    promptPreview: "sadece a yaz",
    costStatus: "priced",
    costUsd: 0.038_044,
    pricingVersion: "litellm@sha256:0123456789ab",
    ...overrides,
  };
}

const ABSENT_CELL = "-";

/** A turn with no cost at all: the property is omitted, never set to undefined. */
function unpricedTurn(): NormalizedTurn {
  const { costUsd, ...rest } = turn();
  void costUsd;
  return { ...rest, costStatus: "model_unknown" };
}

describe("formatWindowLabel", () => {
  it("renders a dash when the window length is unknown", () => {
    expect(formatWindowLabel(undefined)).toBe("-");
    expect(formatWindowLabel(0)).toBe("-");
  });

  it("renders whole days, hours and minutes from the recorded value", () => {
    expect(formatWindowLabel(10_080)).toBe("7d");
    expect(formatWindowLabel(1_440)).toBe("1d");
    expect(formatWindowLabel(300)).toBe("5h");
    expect(formatWindowLabel(60)).toBe("1h");
    expect(formatWindowLabel(45)).toBe("45m");
  });
});

describe("formatTableHeader", () => {
  it("labels the limit columns from the recorded windows rather than fixed text", () => {
    const [header] = formatTableHeader({ primaryWindowMinutes: 300, secondaryWindowMinutes: 10_080 });

    expect(header).toContain("5h");
    expect(header).toContain("7d");
  });

  it("never claims a five-hour or weekly quota when no window has been observed", () => {
    const [header] = formatTableHeader();

    expect(header).not.toContain("5 hour");
    expect(header).not.toContain("Week");
    expect(header).toContain("-");
  });

  it("returns the column line followed by a separator rule", () => {
    const lines = formatTableHeader();

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^-+$/u);
  });

  it("names every column the row writes", () => {
    const [header = ""] = formatTableHeader();

    for (const label of ["Time", "Status", "Prompt", "Input", "Cache", "Output", "Total", "Model"]) {
      expect(header).toContain(label);
    }
  });
});

describe("FULL_TABLE_WIDTH", () => {
  /**
   * The constant is derived from the column definitions rather than written
   * down, and this is what proves it: a column added or resized without the
   * constant following would leave the two disagreeing here.
   */
  it("is the width the header actually renders to", () => {
    const [header = ""] = formatTableHeader();

    expect(header).toHaveLength(FULL_TABLE_WIDTH);
  });

  it("is the width a row renders to as well", () => {
    const [header = ""] = formatTableHeader();
    const [row = ""] = formatTurnRow(turn());

    expect(row).toHaveLength(header.length);
  });
});

describe("formatTurnRow", () => {
  it("includes the turn number, thousands-separated counts and the model", () => {
    const [row = ""] = formatTurnRow(turn());

    expect(row).toContain("7");
    expect(row).toContain("117,483");
    expect(row).toContain("11,008");
    expect(row).toContain("128,496");
    expect(row).toContain("gpt-5.6-sol");
  });

  it("marks an aborted turn so it is not mistaken for completed work", () => {
    expect(formatTurnRow(turn({ status: "aborted" }))[0]).toContain("aborted");
    expect(formatTurnRow(turn({ status: "compacted" }))[0]).toContain("compacted");
  });

  it("adds a tool breakdown line only when tools were called", () => {
    expect(formatTurnRow(turn())).toHaveLength(1);

    const lines = formatTurnRow(turn({ toolCalls: { exec: 3, "github.search": 1 } }));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("exec=3");
    expect(lines[1]).toContain("github.search=1");
  });

  it("shows a dash for absent optional values instead of leaving a gap", () => {
    const [row = ""] = formatTurnRow(turn({ promptPreview: "", model: "", reasoningEffort: "" }));

    expect(row).toContain("-");
    expect(row).not.toContain("undefined");
  });

  it("renders duration in seconds and rate limits as percentages", () => {
    const [row = ""] = formatTurnRow(
      turn({ durationMs: 17_691, rateLimits: { primaryUsedPercent: 73 } }),
    );

    expect(row).toContain("17.7s");
    expect(row).toContain("73.0%");
  });

  it("truncates an over-long model name rather than breaking the column layout", () => {
    const [row = ""] = formatTurnRow(turn({ model: "a-very-long-model-identifier-indeed" }));

    expect(row).toContain("...");
    expect(row).not.toContain("a-very-long-model-identifier-indeed");
  });

  it("falls back to a dash when the timestamp cannot be parsed", () => {
    expect(formatTurnRow(turn({ at: "not a date" }))[0]).toContain("-");
  });

  it("keeps a row on a single line", () => {
    expect(formatTurnRow(turn())[0]).not.toContain("\n");
  });
});

describe("cost column", () => {
  it("shows the cost of the turn", () => {
    const [row] = formatTurnRow(turn({ costUsd: 0.038_044 }));
    expect(row).toContain("$0.0380");
  });

  it("shows a dash rather than a zero when the turn could not be priced", () => {
    const [row] = formatTurnRow(unpricedTurn());
    expect(row).toContain(ABSENT_CELL);
    expect(row).not.toContain("$0.0000");
  });

  it("labels the column in the header", () => {
    const [header] = formatTableHeader();
    expect(header).toContain("Cost");
  });

  it("keeps the header and a row the same width", () => {
    const [header] = formatTableHeader({ primaryWindowMinutes: 10_080 });
    const [row] = formatTurnRow(turn({ rateLimits: { primaryWindowMinutes: 10_080 } }));
    expect(row?.length).toBe(header?.length);
  });
});

describe("formatSessionListing", () => {
  function session(sessionId: string, sessionName: string): SessionRef {
    return {
      provider: "codex",
      path: `/sessions/${sessionId}.jsonl`,
      sessionId,
      sessionName,
      lastActivityMs: Date.UTC(2026, 6, 28, 0, 22, 51),
    };
  }

  const codexId = "2026/07/28/rollout-2026-07-28T00-22-51-019fa575-89b7-79a1-8214-52d50b4f7269";
  const claudeId = "d074574b-6322-42a0-a1d0-a8200c46a0a9";

  /**
   * The defect this exists for.
   *
   * The listing drew a 100-character rule and then printed rows of 106 and 145
   * characters under it. Any terminal narrower than the row wrapped it, which is
   * what garbled the first Windows run's output.
   */
  it("keeps every line inside the rule it draws", () => {
    const lines = formatSessionListing([
      session(codexId, "Hesapla 7x7"),
      session(claudeId, "a very long session name that will not fit in its column at all"),
    ]);

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(SESSION_LISTING_WIDTH);
  });

  it("numbers the rows from one, because that is what the user types", () => {
    const lines = formatSessionListing([session(claudeId, "first"), session(claudeId, "second")]);

    expect(lines.at(-2)).toMatch(/^\s+1\s/u);
    expect(lines.at(-1)).toMatch(/^\s+2\s/u);
  });

  it("keeps the identifying tail of a long session id", () => {
    const lines = formatSessionListing([session(codexId, "Hesapla 7x7")]);

    expect(lines.at(-1)).toContain("019fa575-89b7-79a1-8214-52d50b4f7269");
  });

  it("leaves a session id that already fits", () => {
    const lines = formatSessionListing([session(claudeId, "short")]);

    expect(lines.at(-1)).toContain(claudeId);
  });

  it("still shows the name and the time", () => {
    const lines = formatSessionListing([session(claudeId, "Hesapla 7x7")]);

    expect(lines.at(-1)).toContain("Hesapla 7x7");
    expect(lines.at(-1)).toContain("2026-07-28 00:22:51");
  });
});

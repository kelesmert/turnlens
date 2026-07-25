import { describe, expect, it } from "vitest";
import { formatTableHeader, formatTurnRow, formatWindowLabel } from "../src/ui/live-table.js";
import { emptyUsage } from "../src/core/usage.js";
import type { NormalizedTurn } from "../src/core/types.js";

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
    ...overrides,
  };
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

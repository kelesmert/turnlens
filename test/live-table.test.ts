import { describe, expect, it } from "vitest";
import { COLOUR } from "../src/ui/colour.js";
import {
  FULL_TABLE_WIDTH,
  MINIMUM_SESSION_LISTING_WIDTH,
  MINIMUM_TABLE_WIDTH,
  SESSION_LISTING_WIDTH,
  formatSessionListing,
  formatTableHeader,
  formatTurnRow,
  formatWindowLabel,
  selectLayout,
} from "../src/ui/live-table.js";
import { emptyUsage } from "../src/core/usage.js";
import type { ColumnId } from "../src/ui/live-table.js";
import type { NormalizedTurn, SessionRef } from "../src/core/types.js";

const fullLayout = selectLayout(undefined);

function idsAt(availableWidth: number): readonly ColumnId[] {
  return selectLayout(availableWidth).columns.map((column) => column.id);
}

function widthOf(availableWidth: number, id: ColumnId): number | undefined {
  return selectLayout(availableWidth).columns.find((column) => column.id === id)?.width;
}

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
    const [header] = formatTableHeader(fullLayout, { primaryWindowMinutes: 300, secondaryWindowMinutes: 10_080 });

    expect(header).toContain("5h");
    expect(header).toContain("7d");
  });

  it("never claims a five-hour or weekly quota when no window has been observed", () => {
    const [header] = formatTableHeader(fullLayout);

    expect(header).not.toContain("5 hour");
    expect(header).not.toContain("Week");
    expect(header).toContain("-");
  });

  it("returns the column line followed by a separator rule", () => {
    const lines = formatTableHeader(fullLayout);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^-+$/u);
  });

  it("names every column the row writes", () => {
    const [header = ""] = formatTableHeader(fullLayout);

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
    const [header = ""] = formatTableHeader(fullLayout);

    expect(header).toHaveLength(FULL_TABLE_WIDTH);
  });

  it("is the width a row renders to as well", () => {
    const [header = ""] = formatTableHeader(fullLayout);
    const [row = ""] = formatTurnRow(fullLayout, turn());

    expect(row).toHaveLength(header.length);
  });
});

describe("selectLayout", () => {
  const CORE: readonly ColumnId[] = ["time", "prompt", "input", "cache", "output", "total", "cost"];

  /**
   * No terminal means no window to fit. Output is going to a pipe or a file,
   * where a dropped column is data the reader cannot get back.
   */
  it("keeps every column when no width is known", () => {
    expect(fullLayout.columns).toHaveLength(16);
    expect(fullLayout.width).toBe(FULL_TABLE_WIDTH);
  });

  it("keeps every column when the terminal is wide enough", () => {
    expect(idsAt(FULL_TABLE_WIDTH)).toHaveLength(16);
    expect(idsAt(FULL_TABLE_WIDTH + 40)).toHaveLength(16);
  });

  it("keeps eleven columns at the width Windows Terminal opens to", () => {
    expect(idsAt(120)).toEqual([
      "index",
      "time",
      "prompt",
      "input",
      "cache",
      "output",
      "total",
      "cost",
      "tools",
      "model",
      "duration",
    ]);
  });

  it("keeps the core columns at the width most terminals open to", () => {
    expect(idsAt(80)).toEqual(CORE);
  });

  /**
   * Dropping has one order, so a narrower terminal can only ever show less.
   * Without this a column could reappear as the window shrank, which would read
   * as a bug in the tool rather than as a layout.
   */
  it("never shows a column at a narrow width that a wider one hides", () => {
    for (let width = 61; width <= 200; width += 1) {
      const wider = new Set(idsAt(width));
      for (const id of idsAt(width - 1)) expect(wider.has(id)).toBe(true);
    }
  });

  it("never shrinks a flexible column below its minimum or past its full width", () => {
    for (let width = 60; width <= 200; width += 1) {
      const prompt = widthOf(width, "prompt");
      expect(prompt).toBeGreaterThanOrEqual(12);
      expect(prompt).toBeLessThanOrEqual(20);

      const model = widthOf(width, "model");
      if (model !== undefined) {
        expect(model).toBeGreaterThanOrEqual(12);
        expect(model).toBeLessThanOrEqual(18);
      }
    }
  });

  // 18 rather than 19 because one column of the terminal is left unused; see
  // "never fills the last column of the terminal" below.
  it("returns leftover space to the prompt before the model", () => {
    expect(widthOf(120, "prompt")).toBe(18);
    expect(widthOf(120, "model")).toBe(12);
  });

  /**
   * The invariant the whole feature exists for. Every threshold test above is a
   * spot check of it; this is the statement itself.
   */
  it("never renders wider than the terminal, down to the floor", () => {
    for (let width = 60; width <= 200; width += 1) {
      const [header = ""] = formatTableHeader(selectLayout(width));

      expect(header.length).toBeLessThanOrEqual(Math.max(width, MINIMUM_TABLE_WIDTH));
    }
  });

  /**
   * A line that fills the last column leaves the cursor at the right margin,
   * and terminals record that line as continuing into the next one. Widening
   * the window afterwards re-flows the two together, which is how a rule was
   * seen running past the last column it belongs to. One spare character costs
   * nothing and removes the whole class.
   */
  it("never fills the last column of the terminal", () => {
    for (let width = 60; width <= 200; width += 1) {
      const [header = ""] = formatTableHeader(selectLayout(width));

      expect(header.length).toBeLessThanOrEqual(Math.max(width - 1, MINIMUM_TABLE_WIDTH));
    }
  });

  it("reports a floor no wider than the narrowest terminal it can serve", () => {
    const [header = ""] = formatTableHeader(selectLayout(MINIMUM_TABLE_WIDTH));

    expect(header).toHaveLength(MINIMUM_TABLE_WIDTH);
    expect(MINIMUM_TABLE_WIDTH).toBeLessThan(80);
  });
});

describe("a narrowed table", () => {
  it("keeps the header and its rows the same width", () => {
    for (const width of [80, 100, 120, 140]) {
      const layout = selectLayout(width);
      const [header = ""] = formatTableHeader(layout);
      const [row = ""] = formatTurnRow(layout, turn({ durationMs: 17_691 }));

      expect(row).toHaveLength(header.length);
    }
  });

  it("clips the tool breakdown to the width of the table", () => {
    const layout = selectLayout(80);
    const lines = formatTurnRow(
      layout,
      turn({ toolCalls: { "a-tool-with-a-long-name": 3, "another-long-tool-name": 4, third: 5 } }),
    );

    expect(lines[1]?.length).toBeLessThanOrEqual(layout.width);
  });

  /**
   * The breakdown is indented to sit under the first column of numbers. When
   * the turn number is dropped, an indent sized for it points at nothing.
   */
  it("indents the tool breakdown to match the columns that survived", () => {
    const wide = formatTurnRow(fullLayout, turn({ toolCalls: { exec: 1 } }));
    const narrow = formatTurnRow(selectLayout(80), turn({ toolCalls: { exec: 1 } }));

    expect(wide[1]?.startsWith("      Tool calls:")).toBe(true);
    expect(narrow[1]?.startsWith("  Tool calls:")).toBe(true);
  });
});

describe("formatTurnRow", () => {
  it("includes the turn number, thousands-separated counts and the model", () => {
    const [row = ""] = formatTurnRow(fullLayout, turn());

    expect(row).toContain("7");
    expect(row).toContain("117,483");
    expect(row).toContain("11,008");
    expect(row).toContain("128,496");
    expect(row).toContain("gpt-5.6-sol");
  });

  it("marks an aborted turn so it is not mistaken for completed work", () => {
    expect(formatTurnRow(fullLayout, turn({ status: "aborted" }))[0]).toContain("aborted");
    expect(formatTurnRow(fullLayout, turn({ status: "compacted" }))[0]).toContain("compacted");
  });

  it("adds a tool breakdown line only when tools were called", () => {
    expect(formatTurnRow(fullLayout, turn())).toHaveLength(1);

    const lines = formatTurnRow(fullLayout, turn({ toolCalls: { exec: 3, "github.search": 1 } }));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("exec=3");
    expect(lines[1]).toContain("github.search=1");
  });

  it("shows a dash for absent optional values instead of leaving a gap", () => {
    const [row = ""] = formatTurnRow(fullLayout, turn({ promptPreview: "", model: "", reasoningEffort: "" }));

    expect(row).toContain("-");
    expect(row).not.toContain("undefined");
  });

  it("renders duration in seconds and rate limits as percentages", () => {
    const [row = ""] = formatTurnRow(
      fullLayout,
      turn({ durationMs: 17_691, rateLimits: { primaryUsedPercent: 73 } }),
    );

    expect(row).toContain("17.7s");
    expect(row).toContain("73.0%");
  });

  it("truncates an over-long model name rather than breaking the column layout", () => {
    const [row = ""] = formatTurnRow(fullLayout, turn({ model: "a-very-long-model-identifier-indeed" }));

    expect(row).toContain("...");
    expect(row).not.toContain("a-very-long-model-identifier-indeed");
  });

  it("falls back to a dash when the timestamp cannot be parsed", () => {
    expect(formatTurnRow(fullLayout, turn({ at: "not a date" }))[0]).toContain("-");
  });

  it("keeps a row on a single line", () => {
    expect(formatTurnRow(fullLayout, turn())[0]).not.toContain("\n");
  });
});

describe("cost column", () => {
  it("shows the cost of the turn", () => {
    const [row] = formatTurnRow(fullLayout, turn({ costUsd: 0.038_044 }));
    expect(row).toContain("$0.0380");
  });

  it("shows a dash rather than a zero when the turn could not be priced", () => {
    const [row] = formatTurnRow(fullLayout, unpricedTurn());
    expect(row).toContain(ABSENT_CELL);
    expect(row).not.toContain("$0.0000");
  });

  it("labels the column in the header", () => {
    const [header] = formatTableHeader(fullLayout);
    expect(header).toContain("Cost");
  });

  it("keeps the header and a row the same width", () => {
    const [header] = formatTableHeader(fullLayout, { primaryWindowMinutes: 10_080 });
    const [row] = formatTurnRow(fullLayout, turn({ rateLimits: { primaryWindowMinutes: 10_080 } }));
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

  /**
   * The listing is the first thing TurnLens prints and the user has to read it
   * to type a number, so a wrapped row costs more here than in the table. The
   * date is the only column that can go: the heading already says the list is
   * most recent first, so recency survives its removal.
   */
  it("drops the date rather than wrap in a terminal that opens at eighty", () => {
    const lines = formatSessionListing([session(codexId, "Hesapla 7x7")], 80);

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(79);
    expect(lines.at(-1)).not.toContain("2026-07-28 00:22:51");
  });

  /**
   * The date is the column that goes, but it does not go at the first
   * character of pressure. Dropping 21 characters to recover one wastes the
   * rest of the terminal, so the name gives ground first and the date leaves
   * only once the name would stop being recognisable.
   */
  it("keeps the date while it costs the name little", () => {
    // Measured on the rule, not the row: a row ends where its id ends, and a
    // Claude Code id is three characters shorter than the column that holds it.
    const at100 = formatSessionListing([session(claudeId, "Hesapla 7x7")], 100);
    const at92 = formatSessionListing([session(claudeId, "Hesapla 7x7")], 92);

    expect(at100.at(-1)).toContain("2026-07-28 00:22:51");
    expect(at100[2]).toHaveLength(99);
    expect(at92.at(-1)).toContain("2026-07-28 00:22:51");
    expect(at92[2]).toHaveLength(91);
  });

  it("gives the date up once the name would stop being recognisable", () => {
    const row = formatSessionListing([session(claudeId, "Hesapla 7x7")], 91).at(-1) ?? "";

    expect(row).not.toContain("2026-07-28 00:22:51");
    expect(row).toContain(claudeId);
  });

  /**
   * What the user needs to choose with: the number they type, the name they
   * recognise, and the id that matches a CSV filename.
   */
  it("never gives up the number, the name or the id", () => {
    for (const width of [60, 70, 80, 90, 100]) {
      const lines = formatSessionListing([session(claudeId, "Hesapla 7x7")], width);
      const row = lines.at(-1) ?? "";

      expect(row).toMatch(/^\s*1\s/u);
      expect(row).toContain("Hesapla 7x7");
      expect(row).toContain(claudeId);
    }
  });

  it("keeps every line one short of the terminal, for the reason the table does", () => {
    for (let width = 58; width <= 140; width += 1) {
      const lines = formatSessionListing([session(codexId, "Hesapla 7x7")], width);

      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(Math.max(width - 1, MINIMUM_SESSION_LISTING_WIDTH));
      }
    }
  });

  it("prints the full listing when there is no terminal to fit", () => {
    const lines = formatSessionListing([session(claudeId, "Hesapla 7x7")], undefined);

    expect(lines.at(-1)).toContain("2026-07-28 00:22:51");
    expect(lines[2]).toHaveLength(SESSION_LISTING_WIDTH);
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

describe("the live table in colour", () => {
  const strip = (text: string): string => text.replaceAll(/\u001b\[[0-9;]*m/gu, "");

  /**
   * Colour repeats what the row already says. Strip it and the row is the row,
   * which is what makes turning it off safe rather than a degraded mode.
   */
  it("renders the same text coloured as plain", () => {
    const layout = selectLayout(200);
    const aborted = turn({ status: "aborted" });

    expect(formatTurnRow(layout, aborted, COLOUR).map(strip)).toEqual([
      ...formatTurnRow(layout, aborted),
    ]);
  });

  /**
   * An interrupted turn can be the most expensive one in a session, which is
   * exactly why it should not be missed. Attention rather than error: nothing
   * failed, the user pressed Ctrl+C.
   */
  it("marks an aborted turn for attention", () => {
    const layout = selectLayout(200);
    const [row] = formatTurnRow(layout, turn({ status: "aborted" }), COLOUR);

    expect(row).toMatch(/\u001b/u);
  });

  /**
   * Nine rows in ten. Colouring the ordinary case is how the exceptional one
   * stops standing out.
   */
  it("leaves a completed turn uncoloured", () => {
    const layout = selectLayout(200);
    const [row] = formatTurnRow(layout, turn({ status: "completed" }), COLOUR);

    expect(row).not.toMatch(/\u001b/u);
  });

  it("paints nothing at all when no paint is given", () => {
    const layout = selectLayout(200);

    for (const row of formatTurnRow(layout, turn({ status: "aborted" }))) {
      expect(row).not.toMatch(/\u001b/u);
    }
    for (const line of formatTableHeader(layout)) {
      expect(line).not.toMatch(/\u001b/u);
    }
  });

  it("keeps the header and its rule the same width once stripped", () => {
    const layout = selectLayout(200);
    const [header, underline] = formatTableHeader(layout, undefined, COLOUR).map(strip);

    expect(header?.length).toBe(underline?.length);
  });
});

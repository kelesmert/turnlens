import { describe, expect, it } from "vitest";
import { formatHistoryBlock } from "../src/ui/history.js";
import type { TokenUsage } from "../src/core/types.js";

const USAGE: TokenUsage = {
  inputUncached: 1_200,
  cacheRead: 34_000,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  output: 5_400,
  reasoning: 900,
  total: 40_600,
};

function text(lines: readonly string[]): string {
  return lines.join("\n");
}

describe("formatHistoryBlock", () => {
  /**
   * A session with nothing closed before the watch started has no history to
   * describe, and a block saying zero is noise above a table that is about to
   * fill with the real thing.
   */
  it("says nothing when the session has no closed turns", () => {
    expect(formatHistoryBlock({ turns: 0, usage: USAGE, unpricedTurns: 0 }, 80)).toEqual([]);
  });

  it("names the turn count, the tokens and the cost", () => {
    const lines = formatHistoryBlock(
      { turns: 48, usage: USAGE, costUsd: 4.82, unpricedTurns: 0 },
      80,
    );

    expect(text(lines)).toMatch(/48/u);
    expect(text(lines)).toMatch(/40,600/u);
    expect(text(lines)).toMatch(/\$4\.82/u);
  });

  it("says the figure is at today's rates, because a recorded row would not be", () => {
    const lines = formatHistoryBlock(
      { turns: 48, usage: USAGE, costUsd: 4.82, unpricedTurns: 0 },
      80,
    );

    expect(text(lines)).toMatch(/today's rates/u);
  });

  /**
   * The invariant, at the one place a reader sees it: an unpriced total is
   * absent, never a zero. A zero here would read as a free session.
   */
  it("prints no figure at all when nothing could be priced", () => {
    const lines = formatHistoryBlock({ turns: 2, usage: USAGE, unpricedTurns: 2 }, 80);

    expect(text(lines)).not.toMatch(/\$/u);
    expect(text(lines)).toMatch(/unavailable/u);
    expect(text(lines)).toMatch(/2 turns could not be priced/u);
  });

  it("says how many turns could not be priced when some could", () => {
    const lines = formatHistoryBlock(
      { turns: 48, usage: USAGE, costUsd: 4.82, unpricedTurns: 3 },
      80,
    );

    expect(text(lines)).toMatch(/\$4\.82/u);
    expect(text(lines)).toMatch(/3 turns could not be priced/u);
  });

  it("says nothing about pricing when every turn was priced", () => {
    const lines = formatHistoryBlock(
      { turns: 48, usage: USAGE, costUsd: 4.82, unpricedTurns: 0 },
      80,
    );

    expect(text(lines)).not.toMatch(/could not be priced/u);
  });

  it("fits the width it was given", () => {
    for (const line of formatHistoryBlock(
      { turns: 48, usage: USAGE, costUsd: 4.82, unpricedTurns: 3 },
      40,
    )) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("uses the singular for one unpriced turn", () => {
    const lines = formatHistoryBlock({ turns: 3, usage: USAGE, costUsd: 1, unpricedTurns: 1 }, 80);

    expect(text(lines)).toMatch(/1 turn could not be priced/u);
    expect(text(lines)).not.toMatch(/1 turns/u);
  });
});

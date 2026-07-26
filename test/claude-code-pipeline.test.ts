import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnAssembler } from "../src/core/turn-assembler.js";
import { emptyUsage } from "../src/core/usage.js";
import { computeTurnCost } from "../src/pricing/cost.js";
import { createPricingResolver } from "../src/pricing/resolver.js";
import { createClaudeCodeParser } from "../src/providers/claude-code/parser.js";
import type { AssembledTurn } from "../src/core/turn-assembler.js";

function assemble(fixture: string): readonly AssembledTurn[] {
  const parse = createClaudeCodeParser();
  const assembler = new TurnAssembler({ usageModel: "per-event", includePromptPreview: false });
  const turns: AssembledTurn[] = [];

  const contents = readFileSync(join("test", "fixtures", fixture), "utf8");
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    for (const event of parse(record)) {
      const turn = assembler.push(event);
      if (turn !== undefined) turns.push(turn);
    }
  }
  return turns;
}

describe("the Claude Code pipeline over a real session", () => {
  it("records one turn per prompt that spent tokens", () => {
    const turns = assemble("claude-code-session.jsonl");

    // The session holds eight prompts, but four of them are slash commands
    // answered by a local_command record and no API call at all. A prompt that
    // spends nothing produces no row rather than an empty one.
    expect(turns.map((turn) => [turn.status, turn.usage.total])).toEqual([
      ["completed", 82729],
      ["completed", 768234],
      ["completed", 745846],
      ["completed", 777417],
    ]);
    expect(new Set(turns.map((turn) => turn.model))).toEqual(new Set(["claude-opus-5"]));
    expect(turns.map((turn) => turn.reasoningEffort)).toEqual(["high", "high", "high", "low"]);
  });

  it("keeps the first turn on the figures measured before any code was written", () => {
    const [turn] = assemble("claude-code-session.jsonl");
    expect(turn?.usage).toEqual({
      inputUncached: 6,
      cacheRead: 73774,
      cacheCreation5m: 0,
      cacheCreation1h: 7936,
      output: 1013,
      reasoning: 0,
      total: 82729,
    });
  });

  it("counts the tokens ccusage counts, with the cache tiers kept apart", () => {
    const turns = assemble("claude-code-session.jsonl");
    const total = turns.reduce(
      (sum, turn) => ({
        inputUncached: sum.inputUncached + turn.usage.inputUncached,
        cacheRead: sum.cacheRead + turn.usage.cacheRead,
        cacheCreation5m: sum.cacheCreation5m + turn.usage.cacheCreation5m,
        cacheCreation1h: sum.cacheCreation1h + turn.usage.cacheCreation1h,
        output: sum.output + turn.usage.output,
        reasoning: sum.reasoning + turn.usage.reasoning,
        total: sum.total + turn.usage.total,
      }),
      emptyUsage(),
    );

    // `ccusage claude session --json` over the same source session, measured
    // against an isolated HOME so only these bytes were scanned:
    //   input 25, cache read 2,119,276, cache creation 245,078, output 9,847,
    //   total 2,374,226 tokens.
    expect(total).toEqual({
      inputUncached: 25,
      cacheRead: 2119276,
      cacheCreation5m: 0,
      cacheCreation1h: 245078,
      output: 9847,
      reasoning: 0,
      total: 2374226,
    });
  });

  it("prices the session at the figure ccusage reports for it", async () => {
    // Offline with a cache path that does not exist, so the embedded snapshot is
    // the only source and the expected figure cannot drift with the network.
    const pricing = await createPricingResolver({
      offline: true,
      cachePath: join("test", "fixtures", "no-such-pricing-cache.json"),
    });

    const turns = assemble("claude-code-session.jsonl");
    let amount = 0;
    for (const turn of turns) {
      const cost = computeTurnCost(turn.usage, pricing.lookup(turn.model).pricing);
      expect(cost.status).toBe("priced");
      amount += cost.amountUsd ?? 0;
    }

    // ccusage reports 3.7567180000000007 for this session. The figure is an
    // independent oracle: it is not derived from anything in this repository.
    expect(amount).toBeCloseTo(3.756718, 6);

    // And the first turn alone is the 0.141602 the session reported before it
    // was resumed, which is the figure the design was verified against.
    const first = turns[0];
    expect(
      computeTurnCost(
        first?.usage ?? emptyUsage(),
        pricing.lookup(first?.model ?? "").pricing,
      ).amountUsd,
    ).toBeCloseTo(0.141602, 6);
  });
});

describe("the Claude Code pipeline over the edge cases", () => {
  it("keeps an interrupted turn separate from the one after it", () => {
    const turns = assemble("claude-code-edge-cases.jsonl");
    expect(turns.map((turn) => turn.status)).toEqual(["aborted", "completed", "compacted"]);
  });

  it("bills a split response once and a replayed block not at all", () => {
    const turns = assemble("claude-code-edge-cases.jsonl");
    expect(turns.map((turn) => turn.usage.total)).toEqual([100, 1010, 10000]);
  });

  it("counts each tool call once", () => {
    const turns = assemble("claude-code-edge-cases.jsonl");
    expect(turns.map((turn) => turn.toolCalls)).toEqual([{ Bash: 1 }, { Read: 1 }, {}]);
  });

  it("carries the reasoning effort onto every turn", () => {
    const turns = assemble("claude-code-edge-cases.jsonl");
    expect(turns.map((turn) => turn.reasoningEffort)).toEqual(["high", "high", "high"]);
  });
});

describe("a turn interrupted in the middle of a tool call", () => {
  // Reproduces a defect found by live verification. Stopping the agent while a
  // WebSearch was running left its turn open, so the interrupted turn's 41,120
  // tokens and its WebSearch call were recorded against the next prompt.
  it("closes on the tool-use interruption marker instead of leaking into the next prompt", () => {
    const turns = assemble("claude-code-tool-interrupt.jsonl");
    expect(
      turns.map((turn) => [turn.status, turn.turnId, turn.usage.total, turn.toolCalls]),
    ).toEqual([
      ["aborted", "2b0f0fa8", 41120, { WebSearch: 1 }],
      ["completed", "1291a013", 82841, {}],
    ]);
  });
});

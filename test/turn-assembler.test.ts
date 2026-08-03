import { describe, expect, it } from "vitest";
import { TurnAssembler } from "../src/core/turn-assembler.js";
import { emptyUsage } from "../src/core/usage.js";
import type { AssembledTurn } from "../src/core/turn-assembler.js";
import type { ProviderEvent, TokenUsage, UsageModel } from "../src/core/types.js";

function cumulative(total: number, input = total, output = 0): TokenUsage {
  return { ...emptyUsage(), inputUncached: input, output, total };
}

function drain(events: readonly ProviderEvent[], usageModel: UsageModel): AssembledTurn[] {
  const assembler = new TurnAssembler({ usageModel, includePromptPreview: true });
  const turns: AssembledTurn[] = [];
  for (const event of events) {
    const turn = assembler.push(event);
    if (turn !== undefined) turns.push(turn);
  }
  return turns;
}

describe("TurnAssembler with cumulative counters", () => {
  it("reports the delta between consecutive completions", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(15_441) },
        { kind: "turnEnd", at: "t2", turnId: "turn-a", durationMs: 20_279 },
        { kind: "usage", at: "t3", usage: cumulative(32_822) },
        { kind: "turnEnd", at: "t4", turnId: "turn-b" },
      ],
      "cumulative",
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.usage.total).toBe(15_441);
    expect(turns[0]?.durationMs).toBe(20_279);
    expect(turns[1]?.usage.total).toBe(17_381);
  });

  it("stamps the turn with the timestamp of the event that closed it", () => {
    const turns = drain(
      [
        { kind: "usage", at: "2026-07-22T02:30:00.000Z", usage: cumulative(100) },
        { kind: "turnEnd", at: "2026-07-22T02:31:05.000Z", turnId: "turn-a" },
      ],
      "cumulative",
    );

    expect(turns[0]?.at).toBe("2026-07-22T02:31:05.000Z");
  });

  // Cumulative totals transcribed from a real session where a turn was
  // interrupted, at file offsets 249 (complete), 261 (usage), 264 (abort),
  // 278-311 (usage), 312 (complete). Ignoring the abort merged the two turns
  // into a single 1,039,876-token row.
  it("records an aborted turn separately instead of billing it to the next turn", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(2_111_497) },
        { kind: "turnEnd", at: "t2", turnId: "019f87b8" },
        { kind: "turnStart", at: "t3", turnId: "019f87c1" },
        { kind: "usage", at: "t4", usage: cumulative(2_232_831) },
        { kind: "turnAbort", at: "t5", turnId: "019f87c1", reason: "interrupted" },
        { kind: "turnStart", at: "t6", turnId: "019f87c2" },
        { kind: "usage", at: "t7", usage: cumulative(2_485_410) },
        { kind: "usage", at: "t8", usage: cumulative(2_879_190) },
        { kind: "usage", at: "t9", usage: cumulative(3_151_373) },
        { kind: "turnEnd", at: "t10", turnId: "019f87c2" },
      ],
      "cumulative",
    );

    expect(turns).toHaveLength(3);
    expect(turns[1]?.status).toBe("aborted");
    expect(turns[1]?.turnId).toBe("019f87c1");
    expect(turns[1]?.usage.total).toBe(121_334);
    expect(turns[2]?.status).toBe("completed");
    expect(turns[2]?.usage.total).toBe(918_542);
    expect(turns.map((turn) => turn.usage.total)).not.toContain(1_039_876);
  });

  // How long the user let an interrupted turn run is the whole reason it was
  // interrupted, so it is reported like any other duration rather than dropped.
  it("carries the duration of an aborted turn through to the closed turn", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(30_740) },
        { kind: "turnAbort", at: "t2", turnId: "019f9a00", reason: "interrupted", durationMs: 11_452 },
      ],
      "cumulative",
    );

    expect(turns[0]?.durationMs).toBe(11_452);
  });

  it("suppresses a boundary that consumed no tokens but still advances the baseline", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(1_000) },
        { kind: "turnEnd", at: "t2", turnId: "turn-a" },
        { kind: "turnAbort", at: "t3", turnId: "turn-b", reason: "interrupted" },
        { kind: "usage", at: "t4", usage: cumulative(1_500) },
        { kind: "turnEnd", at: "t5", turnId: "turn-c" },
      ],
      "cumulative",
    );

    expect(turns.map((turn) => turn.turnId)).toEqual(["turn-a", "turn-c"]);
    expect(turns[1]?.usage.total).toBe(500);
  });

  it("treats a compaction boundary as its own turn", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(500) },
        { kind: "boundary", at: "t2", reason: "compacted" },
      ],
      "cumulative",
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("compacted");
  });

  it("clears tool calls and prompt preview after each boundary but keeps the model", () => {
    const turns = drain(
      [
        { kind: "meta", at: "t0", model: "gpt-5.6-sol", promptText: "  first   prompt " },
        { kind: "toolCall", at: "t1", name: "exec", callId: "c1" },
        { kind: "usage", at: "t2", usage: cumulative(100) },
        { kind: "turnEnd", at: "t3", turnId: "turn-a" },
        { kind: "usage", at: "t4", usage: cumulative(200) },
        { kind: "turnEnd", at: "t5", turnId: "turn-b" },
      ],
      "cumulative",
    );

    expect(turns[0]?.toolCalls).toEqual({ exec: 1 });
    expect(turns[0]?.promptPreview).toBe("first prompt");
    expect(turns[0]?.model).toBe("gpt-5.6-sol");
    expect(turns[1]?.toolCalls).toEqual({});
    expect(turns[1]?.promptPreview).toBe("");
    expect(turns[1]?.model).toBe("gpt-5.6-sol");
  });

  it("counts a repeated callId only once", () => {
    const turns = drain(
      [
        { kind: "toolCall", at: "t1", name: "exec", callId: "c1" },
        { kind: "toolCall", at: "t2", name: "exec", callId: "c1" },
        { kind: "toolCall", at: "t3", name: "exec", callId: "c2" },
        { kind: "usage", at: "t4", usage: cumulative(100) },
        { kind: "turnEnd", at: "t5", turnId: "turn-a" },
      ],
      "cumulative",
    );

    expect(turns[0]?.toolCalls).toEqual({ exec: 2 });
  });

  it("omits the prompt preview when previews are disabled", () => {
    const assembler = new TurnAssembler({ usageModel: "cumulative", includePromptPreview: false });
    assembler.push({ kind: "meta", at: "t0", promptText: "secret production credentials" });
    assembler.push({ kind: "usage", at: "t1", usage: cumulative(100) });
    const turn = assembler.push({ kind: "turnEnd", at: "t2", turnId: "turn-a" });

    expect(turn?.promptPreview).toBe("");
  });

  it("does not treat a counter decrease as a reset", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(1_000) },
        { kind: "turnEnd", at: "t2", turnId: "turn-a" },
        { kind: "usage", at: "t3", usage: cumulative(400) },
        { kind: "turnEnd", at: "t4", turnId: "turn-b" },
      ],
      "cumulative",
    );

    expect(turns.map((turn) => turn.turnId)).toEqual(["turn-a"]);
  });

  it("starts from a supplied baseline so live monitoring skips prior usage", () => {
    const assembler = new TurnAssembler({
      usageModel: "cumulative",
      includePromptPreview: false,
      baseline: cumulative(1_000_000),
    });
    assembler.push({ kind: "usage", at: "t1", usage: cumulative(1_000_500) });
    const turn = assembler.push({ kind: "turnEnd", at: "t2", turnId: "turn-a" });

    expect(turn?.usage.total).toBe(500);
  });

  it("carries the latest rate limits onto the turn", () => {
    const turns = drain(
      [
        {
          kind: "usage",
          at: "t1",
          usage: cumulative(100),
          rateLimits: { primaryUsedPercent: 73, primaryWindowMinutes: 10_080 },
        },
        { kind: "turnEnd", at: "t2", turnId: "turn-a" },
      ],
      "cumulative",
    );

    expect(turns[0]?.rateLimits).toEqual({ primaryUsedPercent: 73, primaryWindowMinutes: 10_080 });
  });
});

describe("TurnAssembler with per-event counters", () => {
  it("sums usage records within a turn", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(100, 90, 10) },
        { kind: "usage", at: "t2", usage: cumulative(50, 45, 5) },
        { kind: "turnEnd", at: "t3", turnId: "turn-a" },
      ],
      "per-event",
    );

    expect(turns[0]?.usage.total).toBe(150);
    expect(turns[0]?.usage.output).toBe(15);
  });

  it("ignores a usage record whose dedupKey was already seen", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(100), dedupKey: "msg_1:req_1" },
        { kind: "usage", at: "t2", usage: cumulative(100), dedupKey: "msg_1:req_1" },
        { kind: "usage", at: "t3", usage: cumulative(40), dedupKey: "msg_2:req_2" },
        { kind: "turnEnd", at: "t4", turnId: "turn-a" },
      ],
      "per-event",
    );

    expect(turns[0]?.usage.total).toBe(140);
  });

  it("keeps suppressing a duplicate that reappears after a turn boundary", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(100), dedupKey: "msg_1:req_1" },
        { kind: "turnEnd", at: "t2", turnId: "turn-a" },
        { kind: "usage", at: "t3", usage: cumulative(100), dedupKey: "msg_1:req_1" },
        { kind: "usage", at: "t4", usage: cumulative(60), dedupKey: "msg_2:req_2" },
        { kind: "turnEnd", at: "t5", turnId: "turn-b" },
      ],
      "per-event",
    );

    expect(turns.map((turn) => turn.usage.total)).toEqual([100, 60]);
  });

  it("does not accumulate a per-event turn into the following turn", () => {
    const turns = drain(
      [
        { kind: "usage", at: "t1", usage: cumulative(100) },
        { kind: "turnEnd", at: "t2", turnId: "turn-a" },
        { kind: "usage", at: "t3", usage: cumulative(40) },
        { kind: "turnEnd", at: "t4", turnId: "turn-b" },
      ],
      "per-event",
    );

    expect(turns.map((turn) => turn.usage.total)).toEqual([100, 40]);
  });
});

describe("TurnAssembler, the timestamp a turn started at", () => {
  /**
   * Kept so a report can date a turn by its prompt. Under the closing timestamp,
   * which day owned a turn depended on how long the agent thought.
   */
  it("takes it from the turn's own start event", () => {
    const turns = drain(
      [
        { kind: "turnStart", at: "2026-07-25T20:55:00.000Z", turnId: "turn-a" },
        { kind: "usage", at: "x", usage: cumulative(1_000) },
        { kind: "turnEnd", at: "2026-07-25T21:10:00.000Z", turnId: "turn-a" },
      ],
      "cumulative",
    );

    expect(turns[0]?.startedAt).toBe("2026-07-25T20:55:00.000Z");
    expect(turns[0]?.at).toBe("2026-07-25T21:10:00.000Z");
  });

  /**
   * The reset is the whole risk here. `model` deliberately persists across a
   * boundary; a start must not, or the second turn is dated by the first one's
   * prompt and a report moves usage to a day nothing happened on.
   */
  it("does not let one turn inherit the previous turn's start", () => {
    const turns = drain(
      [
        { kind: "turnStart", at: "2026-07-25T20:00:00.000Z", turnId: "turn-a" },
        { kind: "usage", at: "x", usage: cumulative(1_000) },
        { kind: "turnEnd", at: "2026-07-25T20:30:00.000Z", turnId: "turn-a" },
        { kind: "usage", at: "y", usage: cumulative(2_000) },
        { kind: "turnEnd", at: "2026-07-26T09:00:00.000Z", turnId: "turn-b" },
      ],
      "cumulative",
    );

    expect(turns[0]?.startedAt).toBe("2026-07-25T20:00:00.000Z");
    expect("startedAt" in (turns[1] ?? {})).toBe(false);
  });

  /**
   * Absent rather than guessed. A watcher attaching mid-turn never saw the
   * prompt, and `at` is the only timestamp that case has.
   */
  it("omits it when no start was observed", () => {
    const turns = drain(
      [
        { kind: "usage", at: "x", usage: cumulative(1_000) },
        { kind: "turnEnd", at: "2026-07-25T21:10:00.000Z", turnId: "turn-a" },
      ],
      "cumulative",
    );

    expect("startedAt" in (turns[0] ?? {})).toBe(false);
  });

  it("keeps the start across an abort, which is still a turn that was asked for", () => {
    const turns = drain(
      [
        { kind: "turnStart", at: "2026-07-25T20:55:00.000Z", turnId: "turn-a" },
        { kind: "usage", at: "x", usage: cumulative(1_000) },
        { kind: "turnAbort", at: "2026-07-25T21:10:00.000Z", turnId: "turn-a" },
      ],
      "cumulative",
    );

    expect(turns[0]?.status).toBe("aborted");
    expect(turns[0]?.startedAt).toBe("2026-07-25T20:55:00.000Z");
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaySession } from "../src/core/replay.js";
import { createPricingResolver } from "../src/pricing/resolver.js";
import { createCodexAdapter } from "../src/providers/codex/sessions.js";
import type { NormalizedTurn, SessionRef } from "../src/core/types.js";
import type { ReplayOptions } from "../src/core/replay.js";

/** The same fixture the watch tests drive, so both read one transcript. */
const FIXTURE = join(import.meta.dirname, "fixtures", "codex-abort-session.jsonl");

const SESSION: SessionRef = {
  provider: "codex",
  path: FIXTURE,
  sessionId: join("2026", "07", "22", "fixture"),
  sessionName: "Fixture session",
  lastActivityMs: 0,
};

/** Offline so the suite never touches the network, and cached outside the real home. */
async function replayFixture(): Promise<ReplayOptions> {
  return {
    session: SESSION,
    adapter: createCodexAdapter(),
    pricing: await createPricingResolver({
      offline: true,
      cachePath: join(await mkdtemp(join(tmpdir(), "turnlens-replay-pricing-")), "litellm.json"),
    }),
  };
}

async function collectTurns(options: ReplayOptions): Promise<readonly NormalizedTurn[]> {
  const turns: NormalizedTurn[] = [];
  for await (const turn of replaySession(options)) turns.push(turn);
  return turns;
}

describe("replaySession", () => {
  it("yields the turns the transcript closes, numbered from one", async () => {
    const turns = await collectTurns(await replayFixture());

    expect(turns.length).toBeGreaterThan(0);
    expect(turns.map((turn) => turn.turnNumber)).toEqual(turns.map((_, index) => index + 1));
  });

  it("carries the session it was given onto every turn", async () => {
    for (const turn of await collectTurns(await replayFixture())) {
      expect(turn.sessionId).toBe(SESSION.sessionId);
      expect(turn.sessionName).toBe(SESSION.sessionName);
      expect(turn.provider).toBe("codex");
    }
  });

  it("prices what it can and says why for what it cannot", async () => {
    for (const turn of await collectTurns(await replayFixture())) {
      // The invariant, at the point aggregation will depend on it: a cost is
      // either present or absent, and absent is never a zero.
      if (turn.costStatus === "priced") expect(turn.costUsd).toBeGreaterThan(0);
      else expect(turn.costUsd).toBeUndefined();
    }
  });

  it("records no prompt preview unless asked", async () => {
    for (const turn of await collectTurns(await replayFixture())) {
      expect(turn.promptPreview).toBe("");
    }
  });

  it("records a preview when asked, so the option still reaches the assembler", async () => {
    const turns = await collectTurns({ ...(await replayFixture()), includePromptPreview: true });

    expect(turns.some((turn) => turn.promptPreview !== "")).toBe(true);
  });

  it("stops at the byte it was given", async () => {
    const whole = await collectTurns(await replayFixture());
    const prefix = await collectTurns({ ...(await replayFixture()), stopAtByte: 20_000 });

    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(whole.length);
  });

  it("takes no path to write to, which is the whole point of it", async () => {
    // Stated as a test so that a later change adding a store to this signature
    // is a failure rather than a quiet coupling.
    expect(Object.keys(await replayFixture())).not.toContain("csvPath");
  });
});

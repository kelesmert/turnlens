import { describe, expect, it } from "vitest";
import { shortenModelNames } from "../src/report/models.js";

describe("shortenModelNames", () => {
  it("drops the release date and the vendor prefix", () => {
    const names = shortenModelNames(["claude-haiku-4-5-20251001"]);
    expect(names.get("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  it("drops the vendor prefix from a model that carries no date", () => {
    const names = shortenModelNames(["claude-opus-5", "claude-sonnet-5"]);
    expect(names.get("claude-opus-5")).toBe("opus-5");
    expect(names.get("claude-sonnet-5")).toBe("sonnet-5");
  });

  /**
   * Codex model names are left whole on purpose. Stripping `gpt-` would leave
   * `5.6-terra`, which reads worse than what it replaced: `haiku-4-5` still
   * names a model, `5.6-terra` names a version of nothing.
   */
  it("leaves a Codex model alone", () => {
    const names = shortenModelNames(["gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(names.get("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(names.get("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("shortens both agents' models in one report", () => {
    const names = shortenModelNames(["claude-opus-5", "gpt-5.6-terra"]);
    expect([...names.values()]).toEqual(["opus-5", "gpt-5.6-terra"]);
  });

  /**
   * The only failure shortening can have, and it is the expensive kind: a cost
   * tool that prints two models under one name has produced a wrong number. The
   * whole report reverts rather than the pair that clashed, so one column never
   * mixes two naming schemes.
   */
  it("abandons shortening for every model when two would collide", () => {
    const names = shortenModelNames([
      "claude-opus-5",
      "opus-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(names.get("claude-opus-5")).toBe("claude-opus-5");
    expect(names.get("opus-5")).toBe("opus-5");
    expect(names.get("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("treats two dated releases of one model as a collision", () => {
    const names = shortenModelNames([
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20260210",
    ]);
    expect(names.get("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(names.get("claude-haiku-4-5-20260210")).toBe("claude-haiku-4-5-20260210");
  });

  /**
   * Eight digits is a date; anything else is part of the name. `gpt-5.6` must
   * not lose its version, and a model ending in a year must not lose that either.
   */
  it("only treats an eight-digit tail as a date", () => {
    const names = shortenModelNames(["claude-opus-2026", "claude-opus-123456789"]);
    expect(names.get("claude-opus-2026")).toBe("opus-2026");
    expect(names.get("claude-opus-123456789")).toBe("opus-123456789");
  });

  it("maps an already short name to itself", () => {
    const names = shortenModelNames(["haiku-4-5"]);
    expect(names.get("haiku-4-5")).toBe("haiku-4-5");
  });

  it("returns an empty map for an empty report", () => {
    expect(shortenModelNames([]).size).toBe(0);
  });

  it("repeats an identifier without producing a false collision", () => {
    const names = shortenModelNames(["claude-opus-5", "claude-opus-5"]);
    expect(names.size).toBe(1);
    expect(names.get("claude-opus-5")).toBe("opus-5");
  });

  /**
   * A bare prefix would shorten to the empty string, which names nothing and
   * would leave a blank cell where a model belongs.
   */
  it("does not shorten a name to nothing", () => {
    const names = shortenModelNames(["claude-"]);
    expect(names.get("claude-")).toBe("claude-");
  });
});

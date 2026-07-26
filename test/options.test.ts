import { describe, expect, it } from "vitest";
import { parseCliOptions } from "../src/options.js";

/** A terminal exists, so the CLI is allowed to ask a question. */
const TTY = { interactive: true } as const;
/** stdin is a pipe: asking would eat a line meant for the session selection. */
const PIPED = { interactive: false } as const;

describe("parseCliOptions", () => {
  it("defaults to codex, online, no refresh, and asking about previews", () => {
    expect(parseCliOptions([], TTY)).toEqual({
      providerId: "codex",
      previewChoice: "ask",
      offline: false,
      refreshPricing: false,
      help: false,
    });
  });

  it("accepts every supported provider", () => {
    expect(parseCliOptions(["--provider", "codex"], TTY).providerId).toBe("codex");
    expect(parseCliOptions(["--provider", "claude-code"], TTY).providerId).toBe("claude-code");
  });

  it("names the supported providers when given one it does not know", () => {
    expect(() => parseCliOptions(["--provider", "gemini"], TTY)).toThrow(
      /Unknown provider: gemini[\s\S]*codex, claude-code/u,
    );
  });

  /**
   * Both of these rejections happen before a session is listed, which is the
   * point of doing the parsing up front: a run that cannot start must fail
   * while the user is still at the prompt, not after they have chosen from a
   * list of sessions.
   */
  it("rejects --offline together with --refresh-pricing", () => {
    expect(() => parseCliOptions(["--offline", "--refresh-pricing"], TTY)).toThrow(
      "Both --offline and --refresh-pricing were given. Pass only one.",
    );
  });

  it("rejects both preview flags at once", () => {
    expect(() => parseCliOptions(["--prompt-preview", "--no-prompt-preview"], TTY)).toThrow(
      "Both --prompt-preview and --no-prompt-preview were given. Pass only one.",
    );
  });

  // Previews write part of a prompt to disk, so silence is never consent.
  it("never asks when stdin is piped, and leaves previews off", () => {
    expect(parseCliOptions([], PIPED).previewChoice).toBe("disabled");
  });

  it("honours an explicit preview flag whether or not a terminal exists", () => {
    expect(parseCliOptions(["--prompt-preview"], PIPED).previewChoice).toBe("enabled");
    expect(parseCliOptions(["--no-prompt-preview"], TTY).previewChoice).toBe("disabled");
  });

  it("reports --help without validating anything else", () => {
    expect(parseCliOptions(["--help"], TTY).help).toBe(true);
  });

  // A session id typed without its flag is a mistake worth naming, not one to
  // absorb silently and then monitor something the user did not ask for.
  it("refuses a positional argument rather than ignoring it", () => {
    expect(() => parseCliOptions(["some-session-id"], TTY)).toThrow();
  });
});

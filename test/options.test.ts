import { describe, expect, it } from "vitest";
import { chooseSession, parseCliOptions } from "../src/options.js";
import type { SessionRef } from "../src/core/types.js";

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

function session(sessionId: string): SessionRef {
  return {
    provider: "codex",
    path: `/tmp/${sessionId}.jsonl`,
    sessionId,
    sessionName: sessionId,
    lastActivityMs: 0,
  };
}

describe("chooseSession", () => {
  const sessions = [session("first"), session("second"), session("third")];

  it("selects by the number shown in the list, which starts at one", () => {
    expect(chooseSession(sessions, "1").sessionId).toBe("first");
    expect(chooseSession(sessions, "3").sessionId).toBe("third");
  });

  it("ignores surrounding whitespace, because a terminal answer carries it", () => {
    expect(chooseSession(sessions, "  2  ").sessionId).toBe("second");
  });

  /**
   * One behaviour with four inputs, and the reason this function is worth
   * separating. `toFiniteInt` yields its fallback for anything unparseable, so
   * an empty line, a word and a negative number all become 0 -- the same value
   * a user can type deliberately -- and 0 - 1 indexes nothing. All four have to
   * be refused the same visible way rather than reaching the watcher.
   */
  it("rejects zero, which is one below the first entry", () => {
    expect(() => chooseSession(sessions, "0")).toThrow("Enter a number from 1 to 3.");
  });

  it("rejects a number past the end of the list", () => {
    expect(() => chooseSession(sessions, "4")).toThrow("Enter a number from 1 to 3.");
  });

  it("rejects an answer that is not a number at all", () => {
    expect(() => chooseSession(sessions, "second")).toThrow("Enter a number from 1 to 3.");
    expect(() => chooseSession(sessions, "")).toThrow("Enter a number from 1 to 3.");
  });

  it("rejects a negative number", () => {
    expect(() => chooseSession(sessions, "-1")).toThrow("Enter a number from 1 to 3.");
  });
});

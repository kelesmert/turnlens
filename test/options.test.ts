import { describe, expect, it } from "vitest";
import { chooseSession, describeMissingSessions, parseCliOptions } from "../src/options.js";
import { resolveAgentName } from "../src/providers/registry.js";
import type { SessionRef } from "../src/core/types.js";

/** A terminal exists, so the CLI is allowed to ask a question. */
const TTY = { interactive: true } as const;
/** stdin is a pipe: asking would eat a line meant for the session selection. */
const PIPED = { interactive: false } as const;

describe("resolveAgentName", () => {
  it("maps the typed name to the internal id", () => {
    expect(resolveAgentName("claude")).toBe("claude-code");
    expect(resolveAgentName("codex")).toBe("codex");
  });

  it("still accepts the internal id, which appears in CSV filenames", () => {
    expect(resolveAgentName("claude-code")).toBe("claude-code");
  });

  it("rejects anything else", () => {
    expect(resolveAgentName("gemini")).toBeUndefined();
  });

  /**
   * Not merely equal ids: the whole options object must match, so that no code
   * downstream of the parser has anything to branch on. `claude` is what a
   * person types and `claude-code` is what the id has always been, and the two
   * become indistinguishable here or nowhere.
   */
  it("makes the two spellings indistinguishable after parsing", () => {
    expect(parseCliOptions(["claude", "report", "session"], TTY)).toEqual(
      parseCliOptions(["claude-code", "report", "session"], TTY),
    );
  });
});

describe("the positional grammar", () => {
  it("defaults to watching, with no agent chosen", () => {
    const options = parseCliOptions([], TTY);

    expect(options.mode).toBe("watch");
    expect(options.providerId).toBeUndefined();
  });

  it("reads an agent name as the agent to watch", () => {
    expect(parseCliOptions(["claude"], TTY)).toMatchObject({
      mode: "watch",
      providerId: "claude-code",
    });
    expect(parseCliOptions(["codex"], TTY)).toMatchObject({
      mode: "watch",
      providerId: "codex",
    });
  });

  it("reads report with no agent as every agent", () => {
    const options = parseCliOptions(["report"], TTY);

    expect(options).toMatchObject({ mode: "report", grouping: "daily" });
    // Absent rather than set to undefined, which is how every optional field in
    // this module is spelled, so a consumer's `in` check means what it says.
    expect("providerId" in options).toBe(false);
  });

  it("defaults report to daily", () => {
    expect(parseCliOptions(["claude", "report"], TTY).grouping).toBe("daily");
  });

  it("reads each grouping word", () => {
    for (const word of ["daily", "weekly", "monthly", "session"] as const) {
      expect(parseCliOptions(["claude", "report", word], TTY).grouping).toBe(word);
    }
  });

  it("reads a session breakdown", () => {
    expect(
      parseCliOptions(["claude", "report", "session", "--id", "a3f2", "daily"], TTY),
    ).toMatchObject({
      grouping: "session",
      sessionIdQuery: "a3f2",
      sessionBreakdown: "daily",
    });
  });

  it("accepts --id in watch mode", () => {
    expect(parseCliOptions(["claude", "--id", "a3f2"], TTY)).toMatchObject({
      mode: "watch",
      sessionIdQuery: "a3f2",
    });
  });

  it("rejects a grouping word without report", () => {
    expect(() => parseCliOptions(["claude", "daily"], TTY)).toThrow(/report/u);
  });

  it("rejects an unknown grouping word by naming the valid ones", () => {
    expect(() => parseCliOptions(["claude", "report", "dayly"], TTY)).toThrow(/weekly/u);
  });

  it("rejects --id in report mode without the word session", () => {
    expect(() => parseCliOptions(["report", "--id", "a3f2"], TTY)).toThrow(/session/u);
  });

  it("rejects an unfiltered two-word grouping by naming --id", () => {
    expect(() => parseCliOptions(["claude", "report", "session", "daily"], TTY)).toThrow(/--id/u);
  });

  it("rejects two grouping words that are not session and daily", () => {
    expect(() => parseCliOptions(["claude", "report", "weekly", "session"], TTY)).toThrow();
  });

  it("rejects an unknown agent", () => {
    expect(() => parseCliOptions(["gemini"], TTY)).toThrow(/claude/u);
  });

  it("rejects report-only flags in watch mode", () => {
    expect(() => parseCliOptions(["claude", "--json"], TTY)).toThrow(/report/u);
    expect(() => parseCliOptions(["claude", "--since", "2026-07-01"], TTY)).toThrow(/report/u);
    expect(() => parseCliOptions(["claude", "--compact"], TTY)).toThrow(/report/u);
  });

  it("normalises the window bounds, so the report never sees two spellings", () => {
    expect(parseCliOptions(["report", "--since", "20260701", "--until", "2026-07-31"], TTY)).toMatchObject(
      { since: "2026-07-01", until: "2026-07-31" },
    );
  });

  /**
   * Rejected here, before a session is listed, which is the rule this module
   * already follows: a run that cannot start must fail while the user is still
   * at the prompt.
   */
  it("rejects an unreadable window bound before anything is listed", () => {
    expect(() => parseCliOptions(["report", "--since", "last week"], TTY)).toThrow(/YYYY-MM-DD/u);
  });

  it("reports which help level was asked for", () => {
    expect(parseCliOptions(["--help"], TTY).helpLevel).toBe("root");
    expect(parseCliOptions(["claude", "--help"], TTY).helpLevel).toBe("agent");
    expect(parseCliOptions(["claude", "report", "--help"], TTY).helpLevel).toBe("report");
  });
});

describe("parseCliOptions", () => {
  it("defaults to online, no refresh, and asking about previews", () => {
    expect(parseCliOptions([], TTY)).toEqual({
      mode: "watch",
      grouping: "daily",
      json: false,
      compact: false,
      noColour: false,
      previewChoice: "ask",
      offline: false,
      refreshPricing: false,
      help: false,
      helpLevel: "root",
      version: false,
    });
  });

  /**
   * The flag was public from 30 July until this plan removed it, so its removal
   * is asserted rather than merely untested. The agent is a positional now.
   */
  it("no longer accepts --provider", () => {
    expect(() => parseCliOptions(["--provider", "codex"], TTY)).toThrow();
    expect(() => parseCliOptions(["--provider", "claude-code"], TTY)).toThrow();
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

  // A session id typed where an agent name belongs is a mistake worth naming,
  // not one to absorb silently and then monitor something nobody asked for.
  // Positionals are meaningful now, so the rejection comes from the grammar
  // rather than from refusing positionals outright.
  it("refuses a positional it cannot read rather than ignoring it", () => {
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

describe("describeMissingSessions", () => {
  const roots = ["/home/someone/.config/claude/projects", "/home/someone/.claude/projects"];

  it("keeps the sentence the message has always opened with", () => {
    expect(describeMissingSessions("claude-code", roots, {})).toMatch(
      /^No claude-code session files were found\./u,
    );
  });

  it("names every root it searched", () => {
    const message = describeMissingSessions("claude-code", roots, {});

    for (const root of roots) expect(message).toContain(root);
  });

  /**
   * An unset variable is as informative as a set one here. Someone diagnosing an
   * empty listing needs to know whether their configuration took effect, and
   * "not set" answers that as directly as a value does.
   */
  it("reports the variables that steer Claude Code, set or not", () => {
    const message = describeMissingSessions("claude-code", roots, {
      CLAUDE_CONFIG_DIR: "/somewhere/cc",
    });

    expect(message).toContain("CLAUDE_CONFIG_DIR=/somewhere/cc");
    expect(message).toContain("XDG_CONFIG_HOME is not set");
  });

  it("reports the variable that steers Codex", () => {
    const message = describeMissingSessions("codex", ["/home/someone/.codex/sessions"], {});

    expect(message).toContain("CODEX_HOME is not set");
    expect(message).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("says so plainly when a provider searched nowhere at all", () => {
    expect(describeMissingSessions("codex", [], {})).toContain("No directories were searched");
  });
});

describe("parseCliOptions, --no-color", () => {
  it("is off unless asked for", () => {
    expect(parseCliOptions(["codex", "report"], TTY).noColour).toBe(false);
  });

  it("is read in report mode", () => {
    expect(parseCliOptions(["codex", "report", "--no-color"], TTY).noColour).toBe(true);
  });

  /** Watching prints a table too, so the flag belongs to both modes. */
  it("is read in watch mode", () => {
    expect(parseCliOptions(["codex", "--no-color"], TTY).noColour).toBe(true);
  });
});

describe("--version", () => {
  it("is recognised, long and short", () => {
    expect(parseCliOptions(["--version"], TTY).version).toBe(true);
    expect(parseCliOptions(["-v"], TTY).version).toBe(true);
  });

  it("is false when not asked for", () => {
    expect(parseCliOptions(["codex"], TTY).version).toBe(false);
    expect(parseCliOptions(["--help"], TTY).version).toBe(false);
  });

  it("wins over everything else, so a bad flag still reports the version", () => {
    // Same reasoning as --help returning early: someone checking which version
    // they are running should not have to get the rest of the line right.
    expect(parseCliOptions(["--version", "codex", "report", "weekly"], TTY).version).toBe(true);
  });
});

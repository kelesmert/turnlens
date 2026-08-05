import { describe, expect, it } from "vitest";
import { formatHelp } from "../src/ui/help.js";
import { formatAgentListing } from "../src/ui/live-table.js";

describe("formatAgentListing", () => {
  it("numbers every agent and shows its session count", () => {
    const text = formatAgentListing(
      [
        { name: "claude", sessions: 23 },
        { name: "codex", sessions: 8 },
      ],
      80,
    ).join("\n");

    expect(text).toMatch(/1\s+claude\s+23/u);
    expect(text).toMatch(/2\s+codex\s+8/u);
  });

  /**
   * Listed and selectable. Selecting an agent with nothing to watch is what
   * produces the message naming the directories that were searched, and that
   * message is the only diagnosis available to somebody whose CLAUDE_CONFIG_DIR
   * points at the wrong place. Hiding the agent hides the diagnosis from the one
   * user who cannot do without it.
   */
  it("lists an agent with no sessions rather than hiding it", () => {
    const text = formatAgentListing(
      [
        { name: "claude", sessions: 0 },
        { name: "codex", sessions: 8 },
      ],
      80,
    ).join("\n");

    expect(text).toMatch(/claude/u);
    expect(text).toMatch(/none/u);
  });

  it("uses the singular for one session", () => {
    expect(formatAgentListing([{ name: "codex", sessions: 1 }], 80).join("\n")).toMatch(
      /1 session\b/u,
    );
  });

  it("fits the width it was given", () => {
    for (const line of formatAgentListing([{ name: "claude", sessions: 23 }], 30)) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("formatHelp", () => {
  it("lists the agents and the report command at the root", () => {
    const text = formatHelp("root");

    expect(text).toMatch(/claude/u);
    expect(text).toMatch(/codex/u);
    expect(text).toMatch(/report/u);
  });

  it("describes the watch flags at the agent level", () => {
    const text = formatHelp("agent");

    expect(text).toMatch(/--id/u);
    expect(text).toMatch(/--prompt-preview/u);
  });

  it("describes the groupings and the window at the report level", () => {
    const text = formatHelp("report");

    expect(text).toMatch(/daily/u);
    expect(text).toMatch(/weekly/u);
    expect(text).toMatch(/monthly/u);
    expect(text).toMatch(/session/u);
    expect(text).toMatch(/--since/u);
    expect(text).toMatch(/--json/u);
  });

  /**
   * The root level is the one that had it missing, and the one people type. A
   * bug report is asked for `turnlens --version`, so the level that answers
   * "what can I run" has to be a level that names it.
   */
  it("names --version at every level", () => {
    for (const level of ["root", "agent", "report"] as const) {
      expect(formatHelp(level)).toMatch(/--version/u);
    }
  });

  /** The flag was public from 30 July until this work removed it. */
  it("never mentions --provider, which no longer exists", () => {
    for (const level of ["root", "agent", "report"] as const) {
      expect(formatHelp(level)).not.toMatch(/--provider/u);
    }
  });

  it("ends with a newline at every level", () => {
    for (const level of ["root", "agent", "report"] as const) {
      expect(formatHelp(level).endsWith("\n")).toBe(true);
    }
  });

  /**
   * The one asymmetry in the surface, so it is the one thing help has to explain:
   * omitting the agent asks in watch mode and means every agent in report mode.
   */
  it("explains what omitting the agent does in each mode", () => {
    expect(formatHelp("root")).toMatch(/every agent/u);
  });
});

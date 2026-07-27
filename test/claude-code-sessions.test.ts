import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClaudeCodeAdapter,
  listAllSessionsNewestFirst,
  resolveClaudeCodePaths,
} from "../src/providers/claude-code/sessions.js";
import { PROVIDER_IDS, getAdapter, isProviderId } from "../src/providers/registry.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "turnlens-claude-"));
}

describe("resolveClaudeCodePaths", () => {
  it("falls back to both default roots, config first", () => {
    const { projectRoots } = resolveClaudeCodePaths({});
    expect(projectRoots).toHaveLength(2);
    expect(projectRoots[0]).toMatch(/[/\\]\.config[/\\]claude[/\\]projects$/u);
    expect(projectRoots[1]).toMatch(/[/\\]\.claude[/\\]projects$/u);
  });

  it("uses CLAUDE_CONFIG_DIR when it is set", () => {
    const { projectRoots } = resolveClaudeCodePaths({ CLAUDE_CONFIG_DIR: "/somewhere/cc" });
    expect(projectRoots).toEqual([join("/somewhere/cc", "projects")]);
  });

  it("accepts a comma-separated list, which the documented format allows", () => {
    const { projectRoots } = resolveClaudeCodePaths({
      CLAUDE_CONFIG_DIR: " /first/cc , /second/cc ,, ",
    });
    expect(projectRoots).toEqual([join("/first/cc", "projects"), join("/second/cc", "projects")]);
  });

  it("ignores an empty CLAUDE_CONFIG_DIR rather than resolving to projects/", () => {
    const { projectRoots } = resolveClaudeCodePaths({ CLAUDE_CONFIG_DIR: "   " });
    expect(projectRoots).toHaveLength(2);
  });

  /**
   * The first default root is the XDG configuration directory, not a fixed
   * `~/.config`. ccusage reads `XDG_CONFIG_HOME` and defaults to `~/.config`
   * only when it is unset; hardcoding the default loses every session belonging
   * to a user who moved their configuration.
   */
  it("puts the first root under XDG_CONFIG_HOME when it is set", () => {
    const { projectRoots } = resolveClaudeCodePaths({
      HOME: "/home/someone",
      XDG_CONFIG_HOME: "/config/elsewhere",
    });

    expect(projectRoots[0]).toBe(join("/config/elsewhere", "claude", "projects"));
  });

  it("falls back to .config in the home directory when XDG_CONFIG_HOME is unset", () => {
    const { projectRoots } = resolveClaudeCodePaths({ HOME: "/home/someone" });

    expect(projectRoots[0]).toBe(join("/home/someone", ".config", "claude", "projects"));
    expect(projectRoots[1]).toBe(join("/home/someone", ".claude", "projects"));
  });

  it("treats an empty XDG_CONFIG_HOME as unset", () => {
    const { projectRoots } = resolveClaudeCodePaths({ HOME: "/home/someone", XDG_CONFIG_HOME: "" });

    expect(projectRoots[0]).toBe(join("/home/someone", ".config", "claude", "projects"));
  });

  it("expands a tilde in CLAUDE_CONFIG_DIR, which a shell would have expanded", () => {
    const { projectRoots } = resolveClaudeCodePaths({
      HOME: "/home/someone",
      CLAUDE_CONFIG_DIR: "~/cc",
    });

    expect(projectRoots).toEqual([join("/home/someone", "cc", "projects")]);
  });

  it("lists a root named twice only once, so its sessions are not listed twice", () => {
    const { projectRoots } = resolveClaudeCodePaths({
      HOME: "/home/someone",
      CLAUDE_CONFIG_DIR: "/same/cc,/same/cc",
    });

    expect(projectRoots).toEqual([join("/same/cc", "projects")]);
  });

  it("resolves absolute roots even when HOME is set to nothing", () => {
    const { projectRoots } = resolveClaudeCodePaths({ HOME: "" });

    for (const root of projectRoots) expect(isAbsolute(root)).toBe(true);
  });

  /**
   * The roots have to leave the module for the failure to be diagnosable. A user
   * told only "no sessions were found" cannot tell a misconfigured
   * `CLAUDE_CONFIG_DIR` from an agent that has never run.
   */
  it("reports the roots it searches, so a failure can name them", () => {
    const paths = resolveClaudeCodePaths({ HOME: "/home/someone" });

    expect(createClaudeCodeAdapter(paths).roots).toEqual(paths.projectRoots);
  });
});

describe("listAllSessionsNewestFirst", () => {
  it("returns nothing when no root exists", async () => {
    expect(await listAllSessionsNewestFirst({ projectRoots: ["/no/such/place"] })).toEqual([]);
  });

  it("lists one session per transcript, newest activity first", async () => {
    const root = await makeRoot();
    const project = join(root, "projects", "-home-user-repo");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "older.jsonl"), "");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(project, "newer.jsonl"), "");

    const sessions = await listAllSessionsNewestFirst({
      projectRoots: [join(root, "projects")],
    });
    expect(sessions.map((session) => session.sessionId)).toEqual(["newer", "older"]);
    expect(sessions[0]?.provider).toBe("claude-code");
  });

  it("does not descend into subagents or tool-results", async () => {
    const root = await makeRoot();
    const nested = join(root, "projects", "-home-user-repo", "session-a", "subagents");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "agent-1.jsonl"), "");
    await writeFile(join(root, "projects", "-home-user-repo", "session-a.jsonl"), "");

    const sessions = await listAllSessionsNewestFirst({
      projectRoots: [join(root, "projects")],
    });
    expect(sessions.map((session) => session.sessionId)).toEqual(["session-a"]);
  });

  it("combines several roots", async () => {
    const first = await makeRoot();
    const second = await makeRoot();
    await mkdir(join(first, "projects", "-a"), { recursive: true });
    await mkdir(join(second, "projects", "-b"), { recursive: true });
    await writeFile(join(first, "projects", "-a", "one.jsonl"), "");
    await writeFile(join(second, "projects", "-b", "two.jsonl"), "");

    const sessions = await listAllSessionsNewestFirst({
      projectRoots: [join(first, "projects"), join(second, "projects")],
    });
    expect(sessions.map((session) => session.sessionId).sort()).toEqual(["one", "two"]);
  });
});

describe("session naming", () => {
  const titleRecords = [
    JSON.stringify({ type: "ai-title", aiTitle: "Install superpowers plugin", sessionId: "s" }),
    JSON.stringify({ type: "custom-title", customTitle: "Superpowers setup", sessionId: "s" }),
  ].join("\n");

  async function nameOf(contents: string): Promise<string | undefined> {
    const root = await makeRoot();
    const project = join(root, "projects", "-home-user-repo");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "s.jsonl"), contents);
    const sessions = await listAllSessionsNewestFirst({
      projectRoots: [join(root, "projects")],
    });
    return sessions[0]?.sessionName;
  }

  it("prefers a custom title over a generated one", async () => {
    expect(await nameOf(titleRecords)).toBe("Superpowers setup");
  });

  it("uses the last custom title, because the record is rewritten as it changes", async () => {
    const contents = [
      JSON.stringify({ type: "custom-title", customTitle: "First name", sessionId: "s" }),
      JSON.stringify({ type: "custom-title", customTitle: "Renamed", sessionId: "s" }),
    ].join("\n");
    expect(await nameOf(contents)).toBe("Renamed");
  });

  it("falls back to the generated title", async () => {
    const contents = JSON.stringify({
      type: "ai-title",
      aiTitle: "Only generated",
      sessionId: "s",
    });
    expect(await nameOf(contents)).toBe("Only generated");
  });

  it("reports an unnamed session rather than inventing a name", async () => {
    expect(await nameOf(JSON.stringify({ type: "mode", mode: "auto", sessionId: "s" }))).toBe(
      "(unnamed session)",
    );
  });

  it("survives malformed lines", async () => {
    const contents = ["not json at all", "", titleRecords].join("\n");
    expect(await nameOf(contents)).toBe("Superpowers setup");
  });
});

describe("createClaudeCodeAdapter", () => {
  it("declares the per-event usage model", () => {
    expect(createClaudeCodeAdapter({ projectRoots: [] }).usageModel).toBe("per-event");
  });

  it("gives each adapter its own parser state", () => {
    const record = {
      uuid: "a1",
      type: "assistant",
      timestamp: "t",
      requestId: "r1",
      message: {
        model: "claude-opus-5",
        id: "m1",
        stop_reason: "tool_use",
        content: [],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    };
    const first = createClaudeCodeAdapter({ projectRoots: [] });
    const second = createClaudeCodeAdapter({ projectRoots: [] });
    expect(first.parseRecord(record)).toHaveLength(2);
    expect(first.parseRecord(record)).toEqual([]);
    expect(second.parseRecord(record)).toHaveLength(2);
  });
});

describe("the provider registry", () => {
  it("knows both providers", () => {
    expect([...PROVIDER_IDS]).toEqual(["codex", "claude-code"]);
    expect(isProviderId("claude-code")).toBe(true);
    expect(isProviderId("gemini")).toBe(false);
  });

  it("builds the Claude Code adapter", () => {
    expect(getAdapter("claude-code").id).toBe("claude-code");
  });
});

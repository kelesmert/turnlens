import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexAdapter,
  listAllSessionsNewestFirst,
  loadSessionNames,
  resolveCodexPaths,
} from "../src/providers/codex/sessions.js";
import { getAdapter, isProviderId } from "../src/providers/registry.js";

async function fakeCodexHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "turnlens-codex-"));
}

describe("resolveCodexPaths", () => {
  it("honours CODEX_HOME when set", () => {
    const paths = resolveCodexPaths({ CODEX_HOME: "/custom/codex" });

    expect(paths.sessionsRoot).toBe(join("/custom/codex", "sessions"));
    expect(paths.sessionIndexFile).toBe(join("/custom/codex", "session_index.jsonl"));
  });

  it("falls back to a .codex directory under the home directory", () => {
    const paths = resolveCodexPaths({});

    expect(paths.sessionsRoot.endsWith(join(".codex", "sessions"))).toBe(true);
    expect(paths.sessionIndexFile.endsWith(join(".codex", "session_index.jsonl"))).toBe(true);
  });

  it("expands a tilde in CODEX_HOME, which a shell would have expanded", () => {
    const paths = resolveCodexPaths({ HOME: "/home/someone", CODEX_HOME: "~/codex" });

    expect(paths.sessionsRoot).toBe(join("/home/someone", "codex", "sessions"));
  });

  /**
   * ccusage splits `CODEX_HOME` on commas so it can aggregate across several
   * homes in one report. Codex documents a single directory and no comma form,
   * and TurnLens watches one session, so splitting here would ship behaviour no
   * observed agent has. A comma is an ordinary character in a directory name.
   */
  it("treats a comma as part of the path rather than as a separator", () => {
    const paths = resolveCodexPaths({ CODEX_HOME: "/a,/b" });

    expect(paths.sessionsRoot).toBe(join("/a,/b", "sessions"));
  });

  it("ignores an empty CODEX_HOME rather than resolving to sessions/", () => {
    const paths = resolveCodexPaths({ HOME: "/home/someone", CODEX_HOME: "   " });

    expect(paths.sessionsRoot).toBe(join("/home/someone", ".codex", "sessions"));
  });

  it("resolves an absolute sessions root even when HOME is set to nothing", () => {
    expect(isAbsolute(resolveCodexPaths({ HOME: "" }).sessionsRoot)).toBe(true);
  });

  it("reports the root it searches, so a failure can name it", () => {
    const paths = resolveCodexPaths({ CODEX_HOME: "/custom/codex" });

    expect(createCodexAdapter(paths).roots).toEqual([paths.sessionsRoot]);
  });
});

describe("loadSessionNames", () => {
  it("maps lowercased session uuids to their latest name and skips malformed lines", async () => {
    const home = await fakeCodexHome();
    const indexFile = join(home, "session_index.jsonl");
    await writeFile(
      indexFile,
      [
        '{"id":"019F87A7-6FB6-7571-96FE-D9842E2F7F80","thread_name":"Old name"}',
        "not json at all",
        '{"id":"019f87a7-6fb6-7571-96fe-d9842e2f7f80","thread_name":"Belgeleme durumunu incele"}',
        '{"thread_name":"orphan with no id"}',
      ].join("\n"),
      "utf8",
    );

    const names = await loadSessionNames(indexFile);

    expect(names.get("019f87a7-6fb6-7571-96fe-d9842e2f7f80")).toBe("Belgeleme durumunu incele");
    expect(names.size).toBe(1);
  });

  it("accepts thread_id and session_id as alternative identifier fields", async () => {
    const home = await fakeCodexHome();
    const indexFile = join(home, "session_index.jsonl");
    await writeFile(
      indexFile,
      [
        '{"thread_id":"aaaaaaaa-0000-0000-0000-000000000000","name":"From thread_id"}',
        '{"session_id":"bbbbbbbb-0000-0000-0000-000000000000","title":"From session_id"}',
      ].join("\n"),
      "utf8",
    );

    const names = await loadSessionNames(indexFile);

    expect(names.get("aaaaaaaa-0000-0000-0000-000000000000")).toBe("From thread_id");
    expect(names.get("bbbbbbbb-0000-0000-0000-000000000000")).toBe("From session_id");
  });

  it("collapses whitespace in a recorded name so it stays one CSV field", async () => {
    const home = await fakeCodexHome();
    const indexFile = join(home, "session_index.jsonl");
    await writeFile(
      indexFile,
      '{"id":"cccccccc-0000-0000-0000-000000000000","thread_name":"a\\n  multi   line"}\n',
      "utf8",
    );

    const names = await loadSessionNames(indexFile);

    expect(names.get("cccccccc-0000-0000-0000-000000000000")).toBe("a multi line");
  });

  it("returns an empty map when the index file is missing", async () => {
    const home = await fakeCodexHome();

    expect((await loadSessionNames(join(home, "missing.jsonl"))).size).toBe(0);
  });
});

describe("listAllSessionsNewestFirst", () => {
  it("orders sessions by last activity and resolves names and ids", async () => {
    const home = await fakeCodexHome();
    const dayDir = join(home, "sessions", "2026", "07", "22");
    await mkdir(dayDir, { recursive: true });

    const older = join(
      dayDir,
      "rollout-2026-07-22T05-28-45-019f87a7-6fb6-7571-96fe-d9842e2f7f80.jsonl",
    );
    const newer = join(
      dayDir,
      "rollout-2026-07-22T09-00-00-019f9999-0000-0000-0000-000000000000.jsonl",
    );
    await writeFile(older, "", "utf8");
    await writeFile(newer, "", "utf8");
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    await utimes(newer, new Date(2_000_000), new Date(2_000_000));

    await writeFile(
      join(home, "session_index.jsonl"),
      '{"id":"019f87a7-6fb6-7571-96fe-d9842e2f7f80","thread_name":"Named session"}\n',
      "utf8",
    );

    const sessions = await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: home }));

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.path).toBe(newer);
    expect(sessions[1]?.sessionName).toBe("Named session");
    expect(sessions[1]?.sessionId).toBe(
      "rollout-2026-07-22T05-28-45-019f87a7-6fb6-7571-96fe-d9842e2f7f80",
    );
    expect(sessions[0]?.sessionName).toBe("(unnamed session)");
  });

  it("identifies a session by its filename, so the directories above it cannot change its id", async () => {
    // Codex nests live sessions by date and keeps archived ones flat. Deriving
    // the id from the path would give one transcript two ids, and the CSV
    // filename follows the id, so the same session would be recorded twice.
    const filename = "rollout-2026-07-22T05-28-45-019f87a7-6fb6-7571-96fe-d9842e2f7f80.jsonl";

    const nestedHome = await fakeCodexHome();
    const dayDir = join(nestedHome, "sessions", "2026", "07", "22");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, filename), "", "utf8");

    const flatHome = await fakeCodexHome();
    await mkdir(join(flatHome, "sessions"), { recursive: true });
    await writeFile(join(flatHome, "sessions", filename), "", "utf8");

    const nested = await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: nestedHome }));
    const flat = await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: flatHome }));

    expect(nested[0]?.sessionId).toBe(flat[0]?.sessionId);
    expect(nested[0]?.sessionId).toBe(
      "rollout-2026-07-22T05-28-45-019f87a7-6fb6-7571-96fe-d9842e2f7f80",
    );
  });

  it("finds sessions nested at any depth and ignores non-jsonl files", async () => {
    const home = await fakeCodexHome();
    const dayDir = join(home, "sessions", "2026", "07", "23");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, "rollout-x-dddddddd-0000-0000-0000-000000000000.jsonl"), "", "utf8");
    await writeFile(join(dayDir, "notes.txt"), "ignore me", "utf8");
    await writeFile(join(home, "sessions", "stray.jsonl"), "", "utf8");

    const sessions = await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: home }));

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.path.endsWith(".jsonl"))).toBe(true);
  });

  it("labels a session whose filename carries no uuid rather than guessing", async () => {
    const home = await fakeCodexHome();
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "no-uuid-here.jsonl"), "", "utf8");

    const sessions = await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: home }));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionName).toBe("(name unavailable)");
  });

  it("reports the provider and last activity on every session", async () => {
    const home = await fakeCodexHome();
    await mkdir(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", "rollout-eeeeeeee-0000-0000-0000-000000000000.jsonl");
    const modifiedAt = new Date(5_000_000);
    await writeFile(path, "", "utf8");
    await utimes(path, modifiedAt, modifiedAt);

    const [session] = await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: home }));

    expect(session?.provider).toBe("codex");
    expect(session?.lastActivityMs).toBe(modifiedAt.getTime());
  });

  it("returns an empty list when the sessions directory does not exist", async () => {
    const home = await fakeCodexHome();

    expect(await listAllSessionsNewestFirst(resolveCodexPaths({ CODEX_HOME: home }))).toEqual([]);
  });
});

describe("createCodexAdapter", () => {
  it("declares the cumulative usage model and delegates parsing", async () => {
    const home = await fakeCodexHome();
    const adapter = createCodexAdapter(resolveCodexPaths({ CODEX_HOME: home }));

    expect(adapter.id).toBe("codex");
    expect(adapter.usageModel).toBe("cumulative");
    expect(await adapter.listSessions()).toEqual([]);
    expect(
      adapter.parseRecord({
        type: "event_msg",
        timestamp: "t",
        payload: { type: "turn_aborted", reason: "interrupted" },
      }),
    ).toEqual([{ kind: "turnAbort", at: "t", reason: "interrupted" }]);
  });
});

describe("provider registry", () => {
  it("recognises codex and rejects anything else", () => {
    expect(isProviderId("codex")).toBe(true);
    // "claude-code" was the unsupported example here until Plan 3 shipped it;
    // test/claude-code-sessions.test.ts now asserts that it is recognised.
    expect(isProviderId("gemini")).toBe(false);
    expect(isProviderId("")).toBe(false);
  });

  it("returns the codex adapter", () => {
    expect(getAdapter("codex").id).toBe("codex");
  });
});

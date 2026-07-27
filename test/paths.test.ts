import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHome } from "../src/core/home.js";
import {
  resolveSessionCsvPath,
  resolveSessionLockDir,
  resolveTurnlensHome,
} from "../src/core/paths.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("resolveTurnlensHome", () => {
  it("puts TurnLens's own state under the user's home directory", () => {
    expect(resolveTurnlensHome({ HOME: "/home/someone" })).toBe(join("/home/someone", ".turnlens"));
  });

  // Tests and unusual setups must never touch the real home directory.
  it("honours TURNLENS_HOME over the home directory", () => {
    expect(resolveTurnlensHome({ TURNLENS_HOME: "/tmp/ts", HOME: "/home/someone" })).toBe("/tmp/ts");
  });

  /**
   * A relative state directory is the lock defect wearing a different hat.
   *
   * An empty `HOME` used to survive `??` and produce `.turnlens`, so locks and
   * the pricing cache landed beside whatever directory the command ran in --
   * exactly what moving them out of `process.cwd()` was meant to stop.
   */
  it("stays absolute when HOME is set to nothing", () => {
    const home = resolveTurnlensHome({ HOME: "" });

    expect(isAbsolute(home)).toBe(true);
    expect(home).toBe(join(homedir(), ".turnlens"));
  });

  it("resolves the same home the providers do", () => {
    expect(resolveTurnlensHome({ HOME: "" })).toBe(join(resolveHome({ HOME: "" }), ".turnlens"));
  });
});

describe("resolveSessionLockDir", () => {
  it("is a fixed directory under TurnLens's home", () => {
    expect(resolveSessionLockDir({ HOME: "/home/someone" })).toBe(
      join("/home/someone", ".turnlens", "locks"),
    );
  });

  /**
   * The regression this module exists for.
   *
   * Locks used to live in `process.cwd()`, so two watchers started from two
   * directories never saw each other's lock file and both monitored the same
   * session. The lock is per session, so its location must be too.
   */
  it("does not move when the working directory does", async () => {
    const env = { HOME: "/home/someone" };
    const a = await mkdtemp(join(tmpdir(), "turnlens-cwd-a-"));
    const b = await mkdtemp(join(tmpdir(), "turnlens-cwd-b-"));

    process.chdir(a);
    const fromA = resolveSessionLockDir(env);
    process.chdir(b);
    const fromB = resolveSessionLockDir(env);

    expect(fromA).toBe(fromB);
    expect(fromA).not.toContain(a);
  });
});

describe("resolveSessionCsvPath", () => {
  it("files a session's CSV under its provider", () => {
    expect(resolveSessionCsvPath("/work/repo", "claude-code", "79c14101-4f5d")).toBe(
      join("/work/repo", "turnlens-usage", "claude-code", "79c14101-4f5d.csv"),
    );
    expect(resolveSessionCsvPath("/work/repo", "codex", "rollout-2026-07-25T13-10-20")).toBe(
      join("/work/repo", "turnlens-usage", "codex", "rollout-2026-07-25T13-10-20.csv"),
    );
  });

  it("replaces characters a filename cannot carry on every platform", () => {
    expect(resolveSessionCsvPath("/work/repo", "codex", "a/b\\c:d*e?f")).toBe(
      join("/work/repo", "turnlens-usage", "codex", "a_b_c_d_e_f.csv"),
    );
  });

  it("sanitises the provider segment too, so an id can never escape the directory", () => {
    // The slashes are what make traversal possible, and they are gone.
    expect(resolveSessionCsvPath("/work/repo", "../../etc", "s")).toBe(
      join("/work/repo", "turnlens-usage", ".._.._etc", "s.csv"),
    );
  });

  it("refuses a segment that is only dots, which names a directory rather than a file", () => {
    // Left alone, ".." resolves one level above the output directory.
    expect(resolveSessionCsvPath("/work/repo", "..", "s")).toBe(
      join("/work/repo", "turnlens-usage", "__", "s.csv"),
    );
    expect(resolveSessionCsvPath("/work/repo", "codex", ".")).toBe(
      join("/work/repo", "turnlens-usage", "codex", "_.csv"),
    );
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionLockDir, resolveTurnscopeHome } from "../src/core/paths.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("resolveTurnscopeHome", () => {
  it("puts TurnScope's own state under the user's home directory", () => {
    expect(resolveTurnscopeHome({ HOME: "/home/someone" })).toBe(join("/home/someone", ".turnscope"));
  });

  // Tests and unusual setups must never touch the real home directory.
  it("honours TURNSCOPE_HOME over the home directory", () => {
    expect(resolveTurnscopeHome({ TURNSCOPE_HOME: "/tmp/ts", HOME: "/home/someone" })).toBe("/tmp/ts");
  });
});

describe("resolveSessionLockDir", () => {
  it("is a fixed directory under TurnScope's home", () => {
    expect(resolveSessionLockDir({ HOME: "/home/someone" })).toBe(
      join("/home/someone", ".turnscope", "locks"),
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
    const a = await mkdtemp(join(tmpdir(), "turnscope-cwd-a-"));
    const b = await mkdtemp(join(tmpdir(), "turnscope-cwd-b-"));

    process.chdir(a);
    const fromA = resolveSessionLockDir(env);
    process.chdir(b);
    const fromB = resolveSessionLockDir(env);

    expect(fromA).toBe(fromB);
    expect(fromA).not.toContain(a);
  });
});

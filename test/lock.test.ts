import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSessionLock } from "../src/core/lock.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "turnscope-lock-"));
}

describe("acquireSessionLock", () => {
  it("rejects a second acquisition for the same session path", async () => {
    const dir = await tempDir();
    const first = await acquireSessionLock(dir, "/home/user/.codex/sessions/a.jsonl");

    await expect(acquireSessionLock(dir, "/home/user/.codex/sessions/a.jsonl")).rejects.toThrow(
      /already being monitored/u,
    );

    await first.release();
  });

  it("allows different sessions to be locked at the same time", async () => {
    const dir = await tempDir();
    const a = await acquireSessionLock(dir, "/sessions/a.jsonl");
    const b = await acquireSessionLock(dir, "/sessions/b.jsonl");

    expect(a.path).not.toBe(b.path);

    await a.release();
    await b.release();
  });

  it("removes the lock file on release so the directory does not accumulate files", async () => {
    const dir = await tempDir();
    const lock = await acquireSessionLock(dir, "/sessions/a.jsonl");
    expect(await readdir(dir)).toHaveLength(1);

    await lock.release();

    expect(await readdir(dir)).toEqual([]);
  });

  it("can be re-acquired after release", async () => {
    const dir = await tempDir();
    await (await acquireSessionLock(dir, "/sessions/a.jsonl")).release();

    const again = await acquireSessionLock(dir, "/sessions/a.jsonl");

    expect(again.path).toBeTruthy();
    await again.release();
  });

  it("creates the lock directory when it does not exist", async () => {
    const dir = join(await tempDir(), "nested", "locks");
    const lock = await acquireSessionLock(dir, "/sessions/a.jsonl");

    expect(await readdir(dir)).toHaveLength(1);
    await lock.release();
  });

  it("records the owning process so a stale lock can be diagnosed", async () => {
    const dir = await tempDir();
    const lock = await acquireSessionLock(dir, "/sessions/a.jsonl");

    const contents = await readFile(lock.path, "utf8");

    expect(contents).toContain(`pid=${process.pid}`);
    expect(contents).toContain("/sessions/a.jsonl");
    await lock.release();
  });

  it("names the conflicting session and lock file in the error", async () => {
    const dir = await tempDir();
    const lock = await acquireSessionLock(dir, "/sessions/a.jsonl");

    await expect(acquireSessionLock(dir, "/sessions/a.jsonl")).rejects.toThrow(/\/sessions\/a\.jsonl/u);

    await lock.release();
  });

  it("tolerates release being called more than once", async () => {
    const dir = await tempDir();
    const lock = await acquireSessionLock(dir, "/sessions/a.jsonl");

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

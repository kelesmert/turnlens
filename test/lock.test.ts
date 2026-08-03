import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSessionLock } from "../src/core/lock.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "turnlens-lock-"));
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

/**
 * A lock is removed on release and, best effort, on exit. A process killed
 * outright never gets there, so a lock from a dead process can outlive it and
 * block the session forever. One was found on the development machine four days
 * after the process that wrote it had gone.
 */
describe("a lock left behind by a process that is gone", () => {
  const SESSION = "/sessions/a.jsonl";

  /** A pid that has certainly exited, and is unlikely to have been reused. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    return child.pid ?? 0;
  }

  async function writeLock(dir: string, contents: string): Promise<string> {
    const lock = await acquireSessionLock(dir, SESSION);
    await lock.release();
    await writeFile(lock.path, contents, "utf8");
    return lock.path;
  }

  it("is reclaimed, so a dead watcher cannot block a session forever", async () => {
    const dir = await tempDir();
    const path = await writeLock(
      dir,
      `pid=${await deadPid()} started=2026-07-30T12:14:47.484Z session=${SESSION}\n`,
    );

    const lock = await acquireSessionLock(dir, SESSION);

    expect(lock.path).toBe(path);
    expect(await readFile(path, "utf8")).toContain(`pid=${process.pid}`);
    await lock.release();
  });

  /**
   * The direction that matters. Reclaiming a live lock would put two watchers on
   * one session and duplicate rows in one CSV, so a pid that answers is always
   * treated as running, even when it is not ours to signal.
   */
  it("is not reclaimed while the process that wrote it is alive", async () => {
    const dir = await tempDir();
    await writeLock(dir, `pid=${process.pid} started=2026-08-03T00:00:00.000Z session=${SESSION}\n`);

    await expect(acquireSessionLock(dir, SESSION)).rejects.toThrow(/already being monitored/u);
  });

  it("says the lock was reclaimed rather than doing it silently", async () => {
    const dir = await tempDir();
    await writeLock(dir, `pid=${await deadPid()} started=2026-07-30T12:14:47.484Z session=${SESSION}\n`);

    const notices: string[] = [];
    const lock = await acquireSessionLock(dir, SESSION, { notify: (line) => notices.push(line) });

    expect(notices.join("\n")).toMatch(/reclaimed/iu);
    await lock.release();
  });

  /**
   * A lock with no readable pid cannot be shown to be dead, and the only way to
   * produce one is a crash between creating the file and writing to it, which is
   * a window of microseconds. Refusing keeps the never-steal-a-live-lock property
   * absolute; the message says what to do.
   */
  it("is refused when it carries no pid to check", async () => {
    const dir = await tempDir();
    await writeLock(dir, "");

    await expect(acquireSessionLock(dir, SESSION)).rejects.toThrow(/could not be read/iu);
  });

  it("is refused when it names a different session, which should be impossible", async () => {
    const dir = await tempDir();
    await writeLock(dir, `pid=${await deadPid()} started=2026-07-30T12:14:47.484Z session=/other.jsonl\n`);

    await expect(acquireSessionLock(dir, SESSION)).rejects.toThrow();
  });
});

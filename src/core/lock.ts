import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

export interface SessionLock {
  /** Path of the lock file held by this process. */
  readonly path: string;
  /** Releases the lock and removes the file. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Takes an exclusive lock for one session so two watchers cannot write the same CSV.
 *
 * Uses an atomic create-or-fail open, which behaves identically on Linux, macOS
 * and Windows. The Python implementation used `fcntl.flock`, which does not exist
 * on Windows, and never closed the handle or removed the file, so lock files
 * accumulated indefinitely.
 *
 * The lock name is derived from the session path rather than the path itself, so
 * a long or awkward path cannot produce an invalid filename.
 */
export async function acquireSessionLock(
  lockDir: string,
  sessionPath: string,
): Promise<SessionLock> {
  await mkdir(lockDir, { recursive: true });

  const digest = createHash("sha256").update(sessionPath).digest("hex").slice(0, 24);
  const path = join(lockDir, `${digest}.lock`);

  let handle;
  try {
    handle = await open(path, "wx");
  } catch {
    throw new Error(
      [
        "This session is already being monitored by another process.",
        "",
        `Session:\n${sessionPath}`,
        "",
        `Lock file:\n${path}`,
        "",
        "If no watcher is running, delete the lock file and try again.",
      ].join("\n"),
    );
  }

  try {
    await handle.writeFile(
      `pid=${process.pid} started=${new Date().toISOString()} session=${sessionPath}\n`,
      "utf8",
    );
  } finally {
    await handle.close();
  }

  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    process.off("exit", onExit);
    await rm(path, { force: true });
  };

  // Best effort on abrupt termination: 'exit' cannot await, so the removal is
  // scheduled rather than guaranteed. A leftover lock file is diagnosable from
  // the pid it records.
  function onExit(): void {
    void release();
  }

  process.once("exit", onExit);
  return { path, release };
}

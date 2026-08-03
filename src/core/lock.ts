import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface SessionLock {
  /** Path of the lock file held by this process. */
  readonly path: string;
  /** Releases the lock and removes the file. Safe to call more than once. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** Told when a lock left by a dead process was reclaimed. */
  readonly notify?: (line: string) => void;
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
  options: LockOptions = {},
): Promise<SessionLock> {
  await mkdir(lockDir, { recursive: true });

  const digest = createHash("sha256").update(sessionPath).digest("hex").slice(0, 24);
  const path = join(lockDir, `${digest}.lock`);

  let handle;
  try {
    handle = await open(path, "wx");
  } catch {
    // The file exists. Whether that means anything depends on whether the
    // process it names is still running, which is the whole of the check below.
    await reclaimIfDead(path, sessionPath, options);
    // Atomic again, deliberately: two processes can both find the same lock
    // stale, and only one of them can win this create. The loser is told the
    // session is taken, which by then it is.
    handle = await open(path, "wx").catch(() => {
      throw takenBy(path, sessionPath);
    });
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

/**
 * Removes a lock whose owning process is gone, or explains why it stays.
 *
 * A lock is removed on release and, best effort, on exit; a process killed
 * outright reaches neither, so its lock outlives it. Before this, that lock
 * blocked the session permanently and the only cure was deleting a file by hand.
 * One was found on the development machine four days after its process had gone.
 *
 * **Never steals a live lock.** Two watchers on one session write duplicate rows
 * into one CSV, so anything short of proof that the owner is gone leaves the lock
 * alone. Proof is `ESRCH` from signal 0. `EPERM` means the process exists and
 * belongs to somebody else, which is still existing.
 *
 * A pid can be reused, and a reused pid reads as alive. That fails towards
 * refusing a lock that could have been taken, which is the harmless direction.
 */
async function reclaimIfDead(
  path: string,
  sessionPath: string,
  options: LockOptions,
): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw unreadable(path, sessionPath);
  }

  const pid = Number(/\bpid=(\d+)/u.exec(contents)?.[1]);
  const session = /\bsession=(.*)$/mu.exec(contents)?.[1]?.trim();

  // No pid means the file was created but never written, which takes a crash
  // inside a window of microseconds. It cannot be shown to be dead, so it is not
  // treated as dead.
  if (!Number.isInteger(pid) || pid <= 0) throw unreadable(path, sessionPath);

  // The filename is a digest of the session path, so a mismatch should be
  // impossible. If one ever happens, something is wrong in a way this function
  // should not paper over.
  if (session !== undefined && session !== sessionPath) throw takenBy(path, sessionPath);

  if (isRunning(pid)) throw takenBy(path, sessionPath);

  await rm(path, { force: true });
  options.notify?.(
    `Reclaimed a lock left by process ${pid}, which is no longer running.`,
  );
}

/** Whether a process exists, without signalling it. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is not ours to signal, which is still running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function takenBy(path: string, sessionPath: string): Error {
  return new Error(
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

function unreadable(path: string, sessionPath: string): Error {
  return new Error(
    [
      "A lock file for this session exists and could not be read.",
      "",
      `Session:\n${sessionPath}`,
      "",
      `Lock file:\n${path}`,
      "",
      "Without a process id in it there is no way to tell whether a watcher is",
      "running, and taking the lock anyway could put two watchers on one session.",
      "Delete the lock file if you are sure none is running.",
    ].join("\n"),
  );
}

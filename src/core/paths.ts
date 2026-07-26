import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where TurnLens keeps its own state.
 *
 * This is deliberately not the working directory. Two kinds of file exist and
 * they belong in different places: output the user owns — the CSV — is written
 * next to wherever they ran the command, while TurnLens's internal state is
 * per user and per machine, not per directory.
 *
 * `TURNLENS_HOME` wins so tests and unusual setups never touch the real home.
 */
export function resolveTurnlensHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["TURNLENS_HOME"] ?? join(env["HOME"] ?? homedir(), ".turnlens");
}

/**
 * Where session lock files live.
 *
 * A lock covers one session file, so it has to be visible to every watcher on
 * the machine. Keeping it in `process.cwd()` meant two watchers launched from
 * two directories never saw each other and both monitored the same session,
 * which contradicted the one-watcher-per-session guarantee.
 */
export function resolveSessionLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveTurnlensHome(env), "locks");
}

/** The directory name for recorded turns, relative to where the command ran. */
export const CSV_DIR_NAME = "turnlens-usage";

/**
 * Where one session's recorded turns are written.
 *
 * Grouped by provider. Session ids never collide across agents -- Codex writes
 * `rollout-<timestamp>-<uuid>` and Claude Code writes a bare uuid -- and every
 * row already carries a `provider` column, so this buys no correctness. It buys
 * a directory a person can read: after months of use, "which of these is Codex"
 * should not require opening the files.
 *
 * Both segments are sanitised. The provider id is internal today, but a path
 * built from an identifier is a path that can escape its directory, and a
 * one-line guard is cheaper than trusting that it never will.
 */
export function resolveSessionCsvPath(cwd: string, provider: string, sessionId: string): string {
  return join(cwd, CSV_DIR_NAME, toPathSegment(provider), `${toPathSegment(sessionId)}.csv`);
}

/**
 * Reduces a value to one safe path segment.
 *
 * Windows rejects `\ / : * ? " < > |` outright, so the allowlist is narrower
 * than any one platform requires and identical on all of them.
 *
 * Dots survive, because real session ids contain them. A segment made only of
 * dots does not: `.` and `..` are directory references rather than names, and
 * `..` alone would resolve one level above the output directory.
 */
function toPathSegment(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9._-]/gu, "_");
  return /^\.+$/u.test(safe) ? safe.replaceAll(".", "_") : safe;
}

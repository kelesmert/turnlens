import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where TurnScope keeps its own state.
 *
 * This is deliberately not the working directory. Two kinds of file exist and
 * they belong in different places: output the user owns — the CSV — is written
 * next to wherever they ran the command, while TurnScope's internal state is
 * per user and per machine, not per directory.
 *
 * `TURNSCOPE_HOME` wins so tests and unusual setups never touch the real home.
 */
export function resolveTurnscopeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["TURNSCOPE_HOME"] ?? join(env["HOME"] ?? homedir(), ".turnscope");
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
  return join(resolveTurnscopeHome(env), "locks");
}

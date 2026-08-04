import { fetchLatestVersion } from "./registry.js";
import { isDue, readUpdateState, resolveUpdateStatePath, writeUpdateState } from "./state.js";
import { isNewer } from "./version.js";

export interface UpdateCheckOptions {
  /** The version this build reports. See `resolveSelfVersion` for where from. */
  readonly currentVersion: string;
  readonly offline: boolean;
  readonly env: NodeJS.ProcessEnv;
  /** Whether the stream the notice would be printed to is a terminal. */
  readonly isTty: boolean;
  readonly now?: Date;
  /** Injected so a test never reaches the registry. */
  readonly fetchLatest?: () => Promise<string | undefined>;
}

/**
 * The newest published version when it is worth mentioning, or nothing.
 *
 * Called once, from the same moment pricing resolves, and concurrently with it.
 * Nothing here runs after a watch or a report has started.
 *
 * **Every failure is silence.** An unreachable registry, an unreadable state
 * file, a version that cannot be parsed: all return `undefined`. A notice is a
 * convenience, and no convenience may delay or interrupt a run.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | undefined> {
  if (!wanted(options)) return undefined;

  const now = options.now ?? new Date();
  const path = resolveUpdateStatePath(options.env);

  try {
    const state = await readUpdateState(path);

    // Inside the interval the recorded answer is reused. Without this a run that
    // found an update would go quiet for the rest of the day it found it.
    if (!isDue(state, now)) {
      return state !== undefined && isNewer(state.latest, options.currentVersion)
        ? state.latest
        : undefined;
    }

    const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
    const latest = await fetchLatest();
    // Not recorded on failure, so the next run tries rather than waiting a day.
    if (latest === undefined) return undefined;

    await writeUpdateState(path, { checkedAt: now.toISOString(), latest });
    return isNewer(latest, options.currentVersion) ? latest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The four ways a run declines to ask.
 *
 * `offline` is first and is checked before anything is read from disk: the flag
 * is a promise about the network, and keeping it must not depend on the state of
 * a file. `NO_UPDATE_NOTIFIER` is tested for presence rather than truthiness,
 * because the convention is that any value means off and an empty string is the
 * case a truthiness check gets wrong.
 */
function wanted(options: UpdateCheckOptions): boolean {
  if (options.offline) return false;
  if (options.env["NO_UPDATE_NOTIFIER"] !== undefined) return false;
  if (options.env["CI"] !== undefined) return false;
  return options.isTty;
}

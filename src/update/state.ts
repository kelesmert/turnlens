import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTurnlensHome } from "../core/paths.js";
import { collapseWhitespace } from "../core/text.js";

/**
 * What the last check found, and when.
 *
 * `latest` is kept so a run inside the interval can still print a notice
 * without asking the network again. Without it the check would be silent for
 * the rest of the day it first found something.
 */
export interface UpdateState {
  readonly checkedAt: string;
  readonly latest: string;
}

/** Once a day, the interval `update-notifier` has used as its default. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Beside `pricing/`, because `TURNLENS_HOME` already names where state lives. */
export function resolveUpdateStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveTurnlensHome(env), "update-check.json");
}

/**
 * Reads the record of the last check, or returns nothing.
 *
 * Every failure degrades to "never checked", the rule `readPricingCache`
 * follows: this file is an optimisation, and an optimisation must not be able
 * to stop a run.
 */
export async function readUpdateState(path: string): Promise<UpdateState | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  const checkedAt = collapseWhitespace(record["checkedAt"]);
  const latest = collapseWhitespace(record["latest"]);
  if (checkedAt === "" || latest === "") return undefined;

  return { checkedAt, latest };
}

/** Temporary file then rename, so a killed run cannot leave a half-written one. */
export async function writeUpdateState(path: string, state: UpdateState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * Whether the registry should be asked again.
 *
 * A timestamp that cannot be read, and one in the future, both count as due. The
 * alternative is a corrupt or clock-skewed file that suppresses the check
 * forever, which is the one failure mode that cannot correct itself.
 */
export function isDue(state: UpdateState | undefined, now: Date): boolean {
  if (state === undefined) return true;
  const checkedAt = Date.parse(state.checkedAt);
  if (!Number.isFinite(checkedAt)) return true;
  const elapsed = now.getTime() - checkedAt;
  return elapsed < 0 || elapsed >= INTERVAL_MS;
}

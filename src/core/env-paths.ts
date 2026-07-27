import { join, normalize, parse } from "node:path";
import { resolveHome } from "./home.js";

/**
 * Reduces a path to one spelling, so two names for a directory compare equal.
 *
 * Deduplication has to compare directories rather than strings. `~/a` expands
 * through `join` and comes back with the platform separator, while a path the
 * user typed keeps whatever they typed, so on Windows `~/a` and `C:/Users/me/a`
 * survived as two roots naming one directory -- and every session in it was
 * listed twice. `normalize` settles separators, `.` segments and doubled
 * slashes; the trailing separator is removed here because `normalize` keeps it,
 * except on a root, where removing it would leave `C:` or nothing.
 */
function canonicalise(value: string): string {
  const normalized = normalize(value);
  if (normalized === parse(normalized).root) return normalized;
  return normalized.replace(/[\\/]+$/u, "");
}

/**
 * Replaces a leading `~` with the user's home directory.
 *
 * A user typing a path into an environment variable types the path they would
 * type into a shell, and a shell expands this. Node does not, so
 * `CLAUDE_CONFIG_DIR=~/work` would otherwise look for a directory literally
 * named `~`.
 *
 * `~other` is deliberately left alone. Resolving another user's home requires a
 * platform-specific account lookup, and nothing else in TurnLens branches on the
 * operating system. Returning the value unchanged fails visibly, by not finding
 * the directory, rather than silently resolving to the wrong home.
 */
export function expandTilde(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value === "~") return resolveHome(env);
  if (value.startsWith("~/")) return join(resolveHome(env), value.slice(2));
  return value;
}

/**
 * Reads an environment variable that holds a comma-separated list of paths.
 *
 * Entries are trimmed, blanks dropped, tildes expanded and duplicates removed
 * with the first occurrence keeping its position -- order is the search order,
 * so it carries meaning.
 *
 * An unset variable and one holding only separators both yield an empty list, so
 * a caller tells "not configured" from "configured to nothing" by length alone
 * and never has to re-examine the raw string.
 *
 * Deduplication happens after expansion, because `~/a` and `/home/me/a` are the
 * same directory and listing it twice would list every session in it twice.
 */
export function pathListFromEnv(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (value === undefined) return [];

  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    seen.add(canonicalise(expandTilde(trimmed, env)));
  }

  return [...seen];
}

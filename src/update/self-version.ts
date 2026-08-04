import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version this build is.
 *
 * Read from `package.json` at run time rather than baked in by a generator. A
 * generated constant would be a second place recording the version, and the
 * failure mode is silent: `npm version` updates one of them, a notice then
 * compares the registry against a number that is no longer true.
 *
 * npm puts `package.json` in the tarball whatever `files` says, so it is
 * present in a global install. From `dist/update/self-version.js` the package
 * root is two directories up.
 *
 * Returns nothing rather than throwing. A missing or malformed file means no
 * notice, which is the same outcome as every other failure on this path.
 */
export function resolveSelfVersion(path: string = defaultPath()): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>)["version"];
    return typeof version === "string" && version !== "" ? version : undefined;
  } catch {
    return undefined;
  }
}

function defaultPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
}

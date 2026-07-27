import { homedir } from "node:os";

/**
 * The user's home directory, resolved the same way everywhere in TurnLens.
 *
 * `HOME` wins so a user can redirect TurnLens deliberately, which is also how
 * ccusage resolves it. `os.homedir()` covers what remains: on Windows it reads
 * `USERPROFILE`, verified there with `HOME` unset.
 *
 * The emptiness check is the point. `env.HOME ?? homedir()` keeps an empty
 * string, because `??` rejects only null and undefined, and every path built on
 * it is then *relative* -- which put TurnLens's locks and pricing cache in
 * whatever directory the command ran in, the same failure the lock directory was
 * moved out of `process.cwd()` to prevent.
 *
 * Blankness decides presence; it does not rewrite the value. A path is returned
 * exactly as it was given, because leading or trailing spaces are legal in a
 * directory name on the platforms TurnLens targets.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["HOME"];
  return configured !== undefined && configured.trim() !== "" ? configured : homedir();
}

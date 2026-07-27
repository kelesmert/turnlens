import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { expandTilde } from "../../core/env-paths.js";
import { resolveHome } from "../../core/home.js";
import { collapseWhitespace } from "../../core/text.js";
import { CODEX_USAGE_MODEL, parseCodexRecord } from "./parser.js";
import type { ProviderAdapter, SessionRef } from "../../core/types.js";

export interface CodexPaths {
  readonly sessionsRoot: string;
  readonly sessionIndexFile: string;
}

const SESSION_UUID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

const UNNAMED_SESSION = "(unnamed session)";
const UNIDENTIFIABLE_SESSION = "(name unavailable)";

/**
 * Resolves where Codex keeps its transcripts.
 *
 * `CODEX_HOME` names **one** directory. ccusage splits it on commas so it can
 * aggregate several homes into a single report; Codex documents no comma form,
 * and TurnLens watches one session at a time, so splitting here would ship
 * behaviour no observed agent has. A comma stays part of the path.
 *
 * The fallback home comes from `resolveHome` so this module, its Claude Code
 * sibling and `core/paths.ts` all agree on where the user lives.
 */
export function resolveCodexPaths(env: NodeJS.ProcessEnv = process.env): CodexPaths {
  const configured = env["CODEX_HOME"];
  const home =
    configured !== undefined && configured.trim() !== ""
      ? expandTilde(configured, env)
      : join(resolveHome(env), ".codex");

  return {
    sessionsRoot: join(home, "sessions"),
    sessionIndexFile: join(home, "session_index.jsonl"),
  };
}

/**
 * Maps lowercased session uuid to the most recently recorded display name.
 *
 * The index is append-only, so a later entry for the same uuid supersedes an
 * earlier one. A missing or malformed file yields an empty map: a session with
 * no known name is still worth monitoring.
 */
export async function loadSessionNames(
  sessionIndexFile: string,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();

  let contents: string;
  try {
    contents = await readFile(sessionIndexFile, "utf8");
  } catch {
    return names;
  }

  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

    const entry = parsed as Readonly<Record<string, unknown>>;
    const uuid = collapseWhitespace(entry["id"] ?? entry["thread_id"] ?? entry["session_id"]);
    const name = collapseWhitespace(entry["thread_name"] ?? entry["name"] ?? entry["title"]);
    if (uuid !== "" && name !== "") names.set(uuid.toLowerCase(), name);
  }

  return names;
}

/**
 * Lists every Codex session file under `sessionsRoot`, newest activity first.
 *
 * The name says "all" deliberately. Codex exposes no reliable liveness marker,
 * so this includes sessions that can no longer produce turns; modification time
 * is the only honest ordering signal. The previous Python implementation claimed
 * to list only active sessions while doing exactly this.
 */
export async function listAllSessionsNewestFirst(
  paths: CodexPaths,
): Promise<readonly SessionRef[]> {
  const names = await loadSessionNames(paths.sessionIndexFile);
  const files = await collectJsonlFiles(paths.sessionsRoot);
  const refs: SessionRef[] = [];

  for (const path of files) {
    let lastActivityMs: number;
    try {
      lastActivityMs = (await stat(path)).mtimeMs;
    } catch {
      // The file disappeared between listing and stat; skip rather than fail.
      continue;
    }

    const sessionId = relative(paths.sessionsRoot, path).replace(/\.jsonl$/u, "");
    const uuid = SESSION_UUID_PATTERN.exec(basename(sessionId))?.[1]?.toLowerCase();

    refs.push({
      provider: "codex",
      path,
      sessionId,
      sessionName: resolveSessionName(uuid, names),
      lastActivityMs,
    });
  }

  return refs.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

export function createCodexAdapter(paths: CodexPaths = resolveCodexPaths()): ProviderAdapter {
  return {
    id: "codex",
    usageModel: CODEX_USAGE_MODEL,
    listSessions: () => listAllSessionsNewestFirst(paths),
    parseRecord: parseCodexRecord,
  };
}

/** Distinguishes "no uuid in the filename" from "uuid present but unnamed". */
function resolveSessionName(
  uuid: string | undefined,
  names: ReadonlyMap<string, string>,
): string {
  if (uuid === undefined) return UNIDENTIFIABLE_SESSION;
  return names.get(uuid) ?? UNNAMED_SESSION;
}

async function collectJsonlFiles(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJsonlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }

  return found;
}

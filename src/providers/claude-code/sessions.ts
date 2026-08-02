import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathListFromEnv } from "../../core/env-paths.js";
import { resolveHome } from "../../core/home.js";
import { collapseWhitespace } from "../../core/text.js";
import { CLAUDE_CODE_USAGE_MODEL, createClaudeCodeParser } from "./parser.js";
import type { ProviderAdapter, SessionRef } from "../../core/types.js";

export interface ClaudeCodePaths {
  readonly projectRoots: readonly string[];
}

const UNNAMED_SESSION = "(unnamed session)";

/**
 * How much of a transcript's end is read to find its name.
 *
 * A transcript reaches tens of megabytes, and listing sessions must not stall
 * on reading all of them. Claude Code rewrites the title records as the session
 * runs -- one real 25 MB session carries 212 of them -- so the last window is
 * where the current name is.
 */
const NAME_TAIL_BYTES = 256 * 1024;

/**
 * Resolves where Claude Code keeps its transcripts.
 *
 * `CLAUDE_CONFIG_DIR` replaces the defaults rather than adding to them, and its
 * documented form allows a comma-separated list.
 *
 * Both defaults are current, and they are two different conventions rather than
 * one superseding the other: the first is the XDG configuration directory, the
 * second the dotfile in the home directory. An earlier comment here said Claude
 * Code "has used both over time", which named history as the reason and was
 * wrong -- the real reason is that `XDG_CONFIG_HOME` may move the first one
 * anywhere, which is why it is read rather than assumed to be `~/.config`.
 */
export function resolveClaudeCodePaths(env: NodeJS.ProcessEnv = process.env): ClaudeCodePaths {
  const configured = pathListFromEnv(env["CLAUDE_CONFIG_DIR"], env);
  if (configured.length > 0) {
    return { projectRoots: dedupe(configured.map((root) => join(root, "projects"))) };
  }

  const home = resolveHome(env);
  const xdgBase = env["XDG_CONFIG_HOME"];
  const xdg = xdgBase !== undefined && xdgBase.trim() !== "" ? xdgBase : join(home, ".config");

  return {
    projectRoots: dedupe([
      join(xdg, "claude", "projects"),
      join(home, ".claude", "projects"),
    ]),
  };
}

/** Keeps the first occurrence of each root, because order is search order. */
function dedupe(roots: readonly string[]): readonly string[] {
  return [...new Set(roots)];
}

/**
 * Lists every Claude Code transcript, newest activity first.
 *
 * The scan stops at depth one on purpose. A session directory beside the
 * transcript holds `subagents/` and `tool-results/`; recursing would list
 * subagent transcripts as if they were sessions, and subagent cost is
 * deliberately out of scope.
 *
 * As with Codex, "all" is literal. Claude Code exposes no liveness marker, so
 * modification time is the only honest ordering signal.
 */
export async function listAllSessionsNewestFirst(
  paths: ClaudeCodePaths,
): Promise<readonly SessionRef[]> {
  const refs: SessionRef[] = [];

  for (const root of paths.projectRoots) {
    for (const project of await listDirectories(root)) {
      for (const file of await listTranscripts(project)) {
        let lastActivityMs: number;
        try {
          lastActivityMs = (await stat(file)).mtimeMs;
        } catch {
          // Gone between listing and stat; skip rather than fail the listing.
          continue;
        }

        refs.push({
          provider: "claude-code",
          path: file,
          sessionId: basename(file, ".jsonl"),
          sessionName: await readSessionName(file),
          lastActivityMs,
        });
      }
    }
  }

  return refs.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

export function createClaudeCodeAdapter(
  paths: ClaudeCodePaths = resolveClaudeCodePaths(),
): ProviderAdapter {
  // One parser per adapter, because the parser holds this run's dedup state.
  const parseRecord = createClaudeCodeParser();
  return {
    id: "claude-code",
    usageModel: CLAUDE_CODE_USAGE_MODEL,
    roots: paths.projectRoots,
    listSessions: () => listAllSessionsNewestFirst(paths),
    // The same call, deliberately. Claude Code archives a conversation without
    // moving its transcript, so an archived session is already in this listing
    // and already in every total. The only marker lives in the desktop client's
    // own store, behind an undocumented schema and a `cliSessionId` join, and
    // nothing in the report needs it: the total counts archived work either way,
    // and the coverage line does not itemise it.
    listSessionsForReport: () => listAllSessionsNewestFirst(paths),
    parseRecord,
  };
}

async function listDirectories(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function listTranscripts(project: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(project, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(project, entry.name));
}

/**
 * Reads a session's display name out of the end of its transcript.
 *
 * A name the user set wins over one Claude Code generated, and the last of
 * either wins over earlier ones, because renaming appends a new record rather
 * than rewriting the old one. These records carry no timestamp, so "last" means
 * last in the file.
 */
async function readSessionName(path: string): Promise<string> {
  let custom = "";
  let generated = "";

  for (const line of (await readTail(path, NAME_TAIL_BYTES)).split("\n")) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const type = collapseWhitespace(parsed["type"]);
    if (type === "custom-title") custom = collapseWhitespace(parsed["customTitle"]) || custom;
    if (type === "ai-title") generated = collapseWhitespace(parsed["aiTitle"]) || generated;
  }

  return custom !== "" ? custom : generated !== "" ? generated : UNNAMED_SESSION;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads at most the last `maxBytes` of a file, dropping a leading partial line.
 *
 * Opened read-only. A failure returns "" so a listing never fails over a name.
 */
async function readTail(path: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    const text = buffer.toString("utf8");
    // A window that starts mid-file almost certainly starts mid-line, and a
    // half line is not parseable JSON.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  } finally {
    await handle.close();
  }
}

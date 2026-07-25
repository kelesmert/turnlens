#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acquireSessionLock } from "./core/lock.js";
import { toFiniteInt } from "./core/numbers.js";
import { truncate } from "./core/text.js";
import { PROVIDER_IDS, getAdapter, isProviderId } from "./providers/registry.js";
import { summariseCsv } from "./ui/summary.js";
import { runWatch } from "./watch.js";
import type { SessionRef } from "./core/types.js";

const LOG_DIR = "turnscope-usage";
const LOCK_DIR = ".turnscope-locks";
const SESSION_LIST_LIMIT = 25;
const RULE_WIDTH = 100;

const HELP = [
  "turnscope - per-turn token monitoring for AI coding agents",
  "",
  "Usage: turnscope [--provider <id>] [--prompt-preview]",
  "",
  `  --provider <id>   Agent to monitor. One of: ${PROVIDER_IDS.join(", ")}. Default: codex`,
  "  --prompt-preview  Record a 20-character preview of each prompt.",
  "                    This writes part of your prompt to disk. Off by default.",
  "  --help            Show this message",
  "",
  "Session files are only ever read, never modified. Stop monitoring with Ctrl+C;",
  "a session summary is printed on exit.",
  "",
].join("\n");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "codex" },
      "prompt-preview": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return;
  }

  const providerId = values.provider ?? "codex";
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}\nKnown providers: ${PROVIDER_IDS.join(", ")}`);
  }

  const adapter = getAdapter(providerId);
  const sessions = (await adapter.listSessions()).slice(0, SESSION_LIST_LIMIT);
  if (sessions.length === 0) throw new Error(`No ${providerId} session files were found.`);

  const selected = await selectSession(sessions);
  const includePromptPreview = values["prompt-preview"] === true;
  const csvPath = join(process.cwd(), LOG_DIR, `${toFileStem(selected.sessionId)}.csv`);

  // Held for the whole run so two watchers cannot append to one CSV.
  const lock = await acquireSessionLock(join(process.cwd(), LOCK_DIR), selected.path);

  // No terminal is spawned: the CLI runs in the terminal that invoked it, which
  // is why Ctrl+C simply stops monitoring (known-bugs.md P2-3).
  //
  // Every signal that means "stop" aborts rather than killing the process, so the
  // summary still prints and the lock is released. Left unhandled, SIGTERM and
  // SIGHUP skip the cleanup and strand the lock file, which is what made lock
  // files accumulate in the Python implementation (known-bugs.md P3-3).
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => controller.abort());
  }

  write([
    "",
    "=".repeat(RULE_WIDTH),
    `Session name    : ${selected.sessionName}`,
    `Session file    : ${selected.path}`,
    `CSV file        : ${csvPath}`,
    `Prompt previews : ${includePromptPreview ? "enabled" : "disabled"}`,
    "Stop monitoring : Ctrl+C",
    "=".repeat(RULE_WIDTH),
    "",
  ]);

  try {
    await runWatch({
      session: selected,
      adapter,
      csvPath,
      includePromptPreview,
      signal: controller.signal,
    });
  } finally {
    write(await summariseCsv(csvPath));
    await lock.release();
  }
}

async function selectSession(sessions: readonly SessionRef[]): Promise<SessionRef> {
  write(["", `Available sessions, most recent first`, "=".repeat(RULE_WIDTH)]);
  sessions.forEach((session, index) => {
    const when = new Date(session.lastActivityMs).toISOString().slice(0, 19).replace("T", " ");
    const name = truncate(session.sessionName, 42).padEnd(42);
    write([`${String(index + 1).padStart(3)}  ${when}  ${name}  ${session.sessionId}`]);
  });

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await readline.question("\nSelect a session number: ");
  } finally {
    readline.close();
  }

  const selected = sessions[toFiniteInt(answer.trim(), 0) - 1];
  if (selected === undefined) throw new Error(`Enter a number from 1 to ${sessions.length}.`);
  return selected;
}

/** Turns a session id into one safe filename component on every platform. */
function toFileStem(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9._-]/gu, "_");
}

function write(lines: readonly string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

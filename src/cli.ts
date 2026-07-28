#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { acquireSessionLock } from "./core/lock.js";
import { resolveSessionCsvPath, resolveSessionLockDir } from "./core/paths.js";
import { chooseSession, describeMissingSessions, parseCliOptions } from "./options.js";
import { resolvePricingCachePath } from "./pricing/cache.js";
import { createPricingResolver, refreshPricing } from "./pricing/resolver.js";
import { PROVIDER_IDS, getAdapter } from "./providers/registry.js";
import { formatSessionBanner } from "./ui/banner.js";
import { formatSessionListing } from "./ui/live-table.js";
import { terminalWidth } from "./ui/terminal.js";
import { confirmYesNo } from "./ui/prompts.js";
import { summariseCsv } from "./ui/summary.js";
import { runWatch } from "./watch.js";
import type { SessionRef } from "./core/types.js";

const SESSION_LIST_LIMIT = 25;

const HELP = [
  "turnlens - per-turn token monitoring for AI coding agents",
  "",
  "Usage: turnlens [--provider <id>] [--prompt-preview | --no-prompt-preview]",
  "                [--offline] [--refresh-pricing]",
  "",
  `  --provider <id>      Agent to monitor. One of: ${PROVIDER_IDS.join(", ")}. Default: codex`,
  "  --prompt-preview     Record a 20-character preview of each prompt.",
  "                       This writes part of your prompt to disk.",
  "  --no-prompt-preview  Never record prompt previews.",
  "  --offline            Price from local data only. Never access the network.",
  "  --refresh-pricing    Download the pricing list now, even if it looks current.",
  "  --help               Show this message",
  "",
  "With neither preview flag, you are asked once at startup and the answer",
  "defaults to no. Piped input is never asked, and previews stay off.",
  "",
  "Before monitoring starts, TurnLens asks LiteLLM whether its published price",
  "list has changed and downloads it only if so; the result is kept under",
  "~/.turnlens/pricing/. If the network is unreachable it falls back to that",
  "file, then to the list shipped with TurnLens, and carries on. Use --offline",
  "to skip the check. Nothing is fetched while a session is being watched, and a",
  "turn whose model cannot be priced records no cost rather than zero.",
  "",
  "Session files are only ever read, never modified. Stop monitoring with Ctrl+C;",
  "a session summary is printed on exit.",
  "",
].join("\n");

async function main(): Promise<void> {
  // Every flag is validated here, before a session is listed, so a run that
  // cannot start fails while the user is still at the prompt.
  const options = parseCliOptions(process.argv.slice(2), {
    interactive: process.stdin.isTTY === true,
  });

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const { providerId, previewChoice, offline } = options;
  // Named `refreshRequested`, not `refreshPricing`: that identifier is the
  // imported function, and shadowing it here would be a compile error.
  const refreshRequested = options.refreshPricing;

  const cachePath = resolvePricingCachePath();
  if (refreshRequested) {
    const refreshed = await refreshPricing({ offline: false, cachePath });
    write([
      refreshed === undefined
        ? "Pricing refresh failed. Continuing with the pricing data already available."
        : `Pricing refreshed: ${refreshed.modelCount} models, ${refreshed.version}`,
    ]);
  }

  // Built before monitoring starts, so every network moment in a run happens
  // here and `lookup` stays synchronous inside the tailing loop.
  const pricing = await createPricingResolver({
    offline,
    cachePath,
    notify: (line) => write([line]),
  });

  const adapter = getAdapter(providerId);
  const sessions = (await adapter.listSessions()).slice(0, SESSION_LIST_LIMIT);
  if (sessions.length === 0) throw new Error(describeMissingSessions(providerId, adapter.roots));

  const selected = await selectSession(sessions);
  const includePromptPreview =
    previewChoice === "ask"
      ? await confirmYesNo(
          "\nStore a 20-character preview of each prompt in the CSV?\nThis writes part of your prompt to disk.",
        )
      : previewChoice === "enabled";
  const csvPath = resolveSessionCsvPath(process.cwd(), selected.provider, selected.sessionId);

  // Held for the whole run so one session is never watched twice. The lock lives
  // under the user's home, not the working directory: it covers a session file,
  // which is machine-wide, so a per-directory lock would not be seen by a
  // watcher started elsewhere.
  const lock = await acquireSessionLock(resolveSessionLockDir(), selected.path);

  // No terminal is spawned: the CLI runs in the terminal that invoked it, which
  // is why Ctrl+C simply stops monitoring.
  //
  // Every signal that means "stop" aborts rather than killing the process, so the
  // summary still prints and the lock is released. Left unhandled, SIGTERM and
  // SIGHUP skip the cleanup and strand the lock file, which is what made lock
  // files accumulate in the Python implementation.
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => controller.abort());
  }

  write(
    formatSessionBanner(
      {
        sessionName: selected.sessionName,
        sessionPath: selected.path,
        csvPath,
        promptPreviews: includePromptPreview,
        pricing: pricing.version,
        offline,
      },
      terminalWidth(process.stdout),
    ),
  );

  try {
    await runWatch({
      session: selected,
      adapter,
      csvPath,
      includePromptPreview,
      pricing,
      signal: controller.signal,
    });
  } finally {
    write(await summariseCsv(csvPath));
    await lock.release();
  }
}

async function selectSession(sessions: readonly SessionRef[]): Promise<SessionRef> {
  write(formatSessionListing(sessions, terminalWidth(process.stdout)));

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await readline.question("\nSelect a session number: ");
  } finally {
    readline.close();
  }

  return chooseSession(sessions, answer);
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

#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { acquireSessionLock } from "./core/lock.js";
import { resolveSessionCsvPath, resolveSessionLockDir } from "./core/paths.js";
import { chooseSession, describeMissingSessions, parseCliOptions } from "./options.js";
import { resolvePricingCachePath } from "./pricing/cache.js";
import { createPricingResolver, refreshPricing } from "./pricing/resolver.js";
import { AGENT_NAMES, countSessions, getAdapter, resolveAgentName } from "./providers/registry.js";
import { resolveTimeZone } from "./report/buckets.js";
import {
  collect,
  describeCandidate,
  describeMatch,
  matchSessions,
  noSessionMatches,
  tooManySessionsMatch,
} from "./report/collect.js";
import { formatReportJson } from "./report/json.js";
import { formatReport } from "./report/table.js";
import { formatSessionBanner } from "./ui/banner.js";
import { formatHelp } from "./ui/help.js";
import { formatAgentListing, formatSessionListing } from "./ui/live-table.js";
import { selectPaint } from "./ui/colour.js";
import { terminalWidth } from "./ui/terminal.js";
import { confirmYesNo } from "./ui/prompts.js";
import { summariseCsv } from "./ui/summary.js";
import { runWatch } from "./watch.js";
import type { CliOptions } from "./options.js";
import type { ProviderAdapter, SessionRef } from "./core/types.js";
import type { SessionMatch } from "./report/collect.js";
import type { ProviderId } from "./providers/registry.js";
import type { PricingResolver } from "./pricing/types.js";

const SESSION_LIST_LIMIT = 25;

async function main(): Promise<void> {
  // Every flag is validated here, before a session is listed, so a run that
  // cannot start fails while the user is still at the prompt.
  const options = parseCliOptions(process.argv.slice(2), {
    interactive: process.stdin.isTTY === true,
  });

  if (options.help) {
    process.stdout.write(formatHelp(options.helpLevel));
    return;
  }

  const pricing = await preparePricing(options);

  if (options.mode === "report") await report(options, pricing);
  else await watch(options, pricing);
}

/**
 * Resolves pricing once, before either mode starts.
 *
 * Every network moment in a run happens here, which is what lets `lookup` stay
 * synchronous inside the tailing loop and inside a replay of hundreds of
 * transcripts.
 */
async function preparePricing(options: CliOptions): Promise<PricingResolver> {
  const cachePath = resolvePricingCachePath();

  if (options.refreshPricing) {
    const refreshed = await refreshPricing({ offline: false, cachePath });
    write([
      refreshed === undefined
        ? "Pricing refresh failed. Continuing with the pricing data already available."
        : `Pricing refreshed: ${refreshed.modelCount} models, ${refreshed.version}`,
    ]);
  }

  return await createPricingResolver({
    offline: options.offline,
    cachePath,
    notify: (line) => write([line]),
  });
}

/**
 * Counts what has already been spent, and stops.
 *
 * No lock and no CSV. The lock exists so one session is not watched twice; a
 * report writes nothing and blocks nobody. No signal handling either: there is no
 * tail to interrupt and nothing to clean up.
 */
async function report(options: CliOptions, pricing: PricingResolver): Promise<void> {
  const agents = scopedAgents(options.providerId);
  const data = await collect({
    agents,
    pricing,
    grouping: options.grouping,
    window: {
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.until === undefined ? {} : { until: options.until }),
    },
    timeZone: resolveTimeZone(),
    ...(options.sessionIdQuery === undefined ? {} : { sessionIdQuery: options.sessionIdQuery }),
    ...(options.sessionBreakdown === undefined ? {} : { sessionBreakdown: options.sessionBreakdown }),
  });

  if (options.json) {
    process.stdout.write(formatReportJson(data));
    return;
  }

  write(
    formatReport(data, {
      width: terminalWidth(process.stdout),
      compact: options.compact,
      // Nesting is for a report that spans agents. With one agent named, the
      // column would repeat the same word down the whole table.
      nested: agents.length > 1,
      // The shape the rows actually took, not the word the user typed. With a
      // breakdown asked for, `report session --id X daily` produces days, so the
      // table is headed Date and has no session id to show.
      grouping: options.sessionBreakdown ?? options.grouping,
      // Decided once, here, so the renderer never asks whether colour is on and
      // a width assertion measures what a reader sees.
      paint: selectPaint(process.stdout, process.env, options.noColour),
    }),
  );
}

/**
 * Which agents a report covers.
 *
 * Naming none means every agent, which is the whole difference from watching: a
 * report does not have to choose, so it is not asked to.
 */
function scopedAgents(providerId: ProviderId | undefined): readonly ProviderAdapter[] {
  if (providerId !== undefined) return [getAdapter(providerId)];
  return AGENT_NAMES.map((name) => getAdapter(resolveAgentNameOrThrow(name)));
}

/** Unreachable for a name from `AGENT_NAMES`; named so a typo there is not silent. */
function resolveAgentNameOrThrow(name: string): ProviderId {
  const resolved = resolveAgentName(name);
  if (resolved === undefined) throw new Error(`Unknown agent name in the registry: ${name}`);
  return resolved;
}

/** Follows one session forward, recording each turn as it closes. */
async function watch(options: CliOptions, pricing: PricingResolver): Promise<void> {
  const { session: selected, adapter } = await chooseWatchTarget(options);

  const includePromptPreview =
    options.previewChoice === "ask"
      ? await confirmYesNo(
          "\nStore a 20-character preview of each prompt in the CSV?\nThis writes part of your prompt to disk.",
        )
      : options.previewChoice === "enabled";
  const csvPath = resolveSessionCsvPath(process.cwd(), selected.provider, selected.sessionId);

  // Held for the whole run so one session is never watched twice. The lock lives
  // under the user's home, not the working directory: it covers a session file,
  // which is machine-wide, so a per-directory lock would not be seen by a
  // watcher started elsewhere.
  const lock = await acquireSessionLock(resolveSessionLockDir(), selected.path, {
    notify: (line) => write([line]),
  });

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
        offline: options.offline,
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
      paint: selectPaint(process.stdout, process.env, options.noColour),
    });
  } finally {
    write(await summariseCsv(csvPath, terminalWidth(process.stdout)));
    await lock.release();
  }
}

/** A session to follow, and the adapter that parses it. */
interface WatchTarget {
  readonly session: SessionRef;
  readonly adapter: ProviderAdapter;
}

/**
 * The session to follow: the one named, or the one chosen from the list.
 *
 * **An id names its own agent.** Given `--id` and no agent, every agent is
 * searched and the one holding the session is the one used, so nobody is asked a
 * question the id already answers. Asking and then searching only the chosen
 * agent was the earlier behaviour, and it told a user that an existing session
 * did not exist whenever they picked the other agent.
 */
async function chooseWatchTarget(options: CliOptions): Promise<WatchTarget> {
  const scoped = scopedAgents(options.providerId);

  if (options.sessionIdQuery !== undefined) {
    const match = await pickMatch(options.sessionIdQuery, scoped);
    return { session: await describeMatch(match), adapter: match.adapter };
  }

  const providerId = options.providerId ?? (await askWhichAgent());
  const adapter = getAdapter(providerId);
  const sessions = (await adapter.listSessions()).slice(0, SESSION_LIST_LIMIT);
  if (sessions.length === 0) throw new Error(describeMissingSessions(providerId, adapter.roots));

  return { session: await selectSession(sessions), adapter };
}

/**
 * The one session an id names, asking when more than one answers to it.
 *
 * Watching is already a conversation, so ambiguity is a question rather than a
 * failure. Two sessions under different agents sharing an id is close to
 * impossible; a short prefix matching several under one agent is ordinary, and
 * this covers both.
 *
 * Piped input cannot be asked, so it gets the same error the report gets.
 */
async function pickMatch(
  query: string,
  agents: readonly ProviderAdapter[],
): Promise<SessionMatch> {
  const matches = await matchSessions(query, agents);

  const only = matches[0];
  if (only === undefined) throw noSessionMatches(query, agents);
  if (matches.length === 1) return only;
  if (process.stdin.isTTY !== true) throw tooManySessionsMatch(query, matches);

  write([
    "",
    `${matches.length} sessions match ${query}:`,
    ...matches.map((match, index) => `${String(index + 1).padStart(3)}${describeCandidate(match)}`),
  ]);

  const answer = await ask(`\nSelect a session number, 1 to ${matches.length}: `);
  const chosen = matches[Number.parseInt(answer.trim(), 10) - 1];
  if (chosen === undefined) throw new Error(`Enter a number from 1 to ${matches.length}.`);

  return chosen;
}

/**
 * Asks which agent to watch, listing each with how much it has.
 *
 * Only watch mode asks. An agent with no sessions is still offered, because
 * choosing it is what prints the directories that were searched, and that is the
 * only diagnosis available to somebody whose configuration points elsewhere.
 *
 * Nothing is remembered between runs. Remembering would save a keystroke and cost
 * a file, a staleness rule, and a user wondering why the tool chose for them.
 */
async function askWhichAgent(): Promise<ProviderId> {
  const entries = await Promise.all(
    AGENT_NAMES.map(async (name) => ({
      name,
      sessions: await countSessions(resolveAgentNameOrThrow(name)),
    })),
  );

  write(formatAgentListing(entries, terminalWidth(process.stdout)));

  const answer = await ask(`\nSelect an agent number, 1 to ${entries.length}: `);
  const chosen = entries[Number.parseInt(answer.trim(), 10) - 1];
  if (chosen === undefined) throw new Error(`Enter a number from 1 to ${entries.length}.`);

  return resolveAgentNameOrThrow(chosen.name);
}

async function selectSession(sessions: readonly SessionRef[]): Promise<SessionRef> {
  write(formatSessionListing(sessions, terminalWidth(process.stdout)));

  return chooseSession(sessions, await ask("\nSelect a session number: "));
}

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
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

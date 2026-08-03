import { basename } from "node:path";
import { replaySession } from "../core/replay.js";
import { addTurn, emptyBucket } from "./aggregate.js";
import { bucketLabel, localDate } from "./buckets.js";
import { withinWindow } from "./window.js";
import type { NormalizedTurn, ProviderAdapter, SessionRef } from "../core/types.js";
import type { Grouping } from "../options.js";
import type { PricingResolver } from "../pricing/types.js";
import type { Bucket } from "./aggregate.js";
import type { PeriodGrouping } from "./buckets.js";
import type { Window } from "./window.js";

/**
 * What a report covered, so its figures can be read for what they are.
 *
 * This carries all the honesty a `--no-archived` flag would otherwise have
 * carried. Nothing is excluded from a total, so the line's job is to say what
 * went in: how much was read, over what window, in which timezone, and that
 * every figure was priced today rather than when the turn closed.
 *
 * Archived sessions are counted and deliberately not itemised. Codex keeps them
 * in their own directory, so counting them is counting files, but Claude Code
 * archives without moving anything and the only marker is in the desktop
 * client's store, behind an undocumented schema. Reporting the count for one
 * agent only would put two meanings in one number.
 */
export interface Coverage {
  readonly sessions: number;
  /** Absent when no turn survived the window. */
  readonly oldestDay?: string;
  readonly newestDay?: string;
  readonly timeZone: string;
  readonly unpricedTurns: number;
  readonly pricingVersion: string;
}

export interface ReportData {
  readonly buckets: readonly Bucket[];
  readonly coverage: Coverage;
}

export interface CollectOptions {
  readonly agents: readonly ProviderAdapter[];
  readonly pricing: PricingResolver;
  readonly grouping: Grouping;
  readonly window: Window;
  readonly timeZone: string;
  /** Restricts to one session. A full id or a unique prefix. */
  readonly sessionIdQuery?: string;
  /** Breaks the one named session into its days. Only valid with a query. */
  readonly sessionBreakdown?: "daily";
}

/**
 * Reads every session in scope and folds its turns into buckets.
 *
 * The scope is every agent given, and for each of them every session a total has
 * to account for. With `sessionIdQuery` set it is one session, resolved by path
 * before anything is read.
 *
 * Each transcript is replayed and folded as it goes rather than collected first,
 * because one session here is 25 MB and there may be hundreds of them.
 */
export async function collect(options: CollectOptions): Promise<ReportData> {
  const buckets = new Map<string, Bucket>();
  let sessions = 0;
  let unpricedTurns = 0;
  let oldestDay: string | undefined;
  let newestDay: string | undefined;

  for (const { adapter, session } of await resolveScope(options)) {
    sessions += 1;

    for await (const turn of replaySession({
      session,
      adapter,
      pricing: options.pricing,
      // Reporting never wants prompt text. It is not displayed, and reading a
      // transcript is not a reason to carry part of a prompt around.
      includePromptPreview: false,
    })) {
      const day = localDate(turn.at, options.timeZone);
      if (!withinWindow(day, options.window)) continue;

      if (oldestDay === undefined || day < oldestDay) oldestDay = day;
      if (newestDay === undefined || day > newestDay) newestDay = day;
      if (turn.costUsd === undefined) unpricedTurns += 1;

      const key = keyFor(turn, session, options);
      const existing = buckets.get(key.label) ?? seed(key);
      buckets.set(key.label, addTurn(existing, turn));
    }
  }

  return {
    buckets: sort([...buckets.values()], options),
    coverage: {
      sessions,
      ...(oldestDay === undefined ? {} : { oldestDay }),
      ...(newestDay === undefined ? {} : { newestDay }),
      timeZone: options.timeZone,
      unpricedTurns,
      // Taken from the resolver rather than from a turn, so the line reads the
      // same when nothing could be priced.
      pricingVersion: options.pricing.version,
    },
  };
}

/**
 * Finds the one session an id or prefix names, across every agent given.
 *
 * **A path match, not a listing.** A session's id is its filename, so this walks
 * directories and opens nothing. Only the one session that matched is described,
 * which is where its name comes from. Building a listing instead would read the
 * last 256 KB of every Claude Code transcript to recover titles nobody asked for.
 *
 * Ambiguity is never resolved silently. Two matches is a question for the user,
 * and each candidate is named with its agent, because the same prefix can match
 * under more than one.
 */
export async function resolveSessionQuery(
  query: string,
  agents: readonly ProviderAdapter[],
): Promise<SessionRef> {
  const matches: { readonly adapter: ProviderAdapter; readonly path: string }[] = [];

  for (const adapter of agents) {
    for (const path of await adapter.listSessionPaths()) {
      if (basename(path, ".jsonl").includes(query)) matches.push({ adapter, path });
    }
  }

  const only = matches[0];
  if (only === undefined) {
    throw new Error(
      `No session matches ${query}.\n` +
        `Searched ${agents.map((agent) => agent.id).join(" and ")}. ` +
        "Run the report grouped by session to see the ids there are.",
    );
  }

  if (matches.length > 1) {
    const candidates = matches
      .slice(0, 10)
      .map((match) => `  ${match.adapter.id}  ${basename(match.path, ".jsonl")}`);
    throw new Error(
      `${matches.length} sessions match ${query}. Name one of them:\n${candidates.join("\n")}` +
        (matches.length > candidates.length ? "\n  ..." : ""),
    );
  }

  return await only.adapter.describeSession(only.path);
}

/** Which sessions to read, and which adapter parses each. */
interface ScopedSession {
  readonly adapter: ProviderAdapter;
  readonly session: SessionRef;
}

async function resolveScope(options: CollectOptions): Promise<readonly ScopedSession[]> {
  if (options.sessionIdQuery !== undefined) {
    const session = await resolveSessionQuery(options.sessionIdQuery, options.agents);
    const adapter = options.agents.find((candidate) => candidate.id === session.provider);
    // Unreachable: the ref came from one of these adapters. Named rather than
    // asserted, so a future caller passing a mismatched pair sees why.
    if (adapter === undefined) throw new Error(`No adapter for ${session.provider}`);
    return [{ adapter, session }];
  }

  const scoped: ScopedSession[] = [];
  for (const adapter of options.agents) {
    for (const session of await adapter.listSessionsForReport()) scoped.push({ adapter, session });
  }
  return scoped;
}

/** The bucket a turn belongs in, and what an empty one of it looks like. */
interface BucketKey {
  readonly label: string;
  readonly provider?: string;
}

function keyFor(turn: NormalizedTurn, session: SessionRef, options: CollectOptions): BucketKey {
  const perAgent = options.agents.length > 1 ? { provider: turn.provider } : {};

  // One session broken into days: the grouping word says session, but the rows
  // are days, because the filter has already reduced it to one session.
  if (options.grouping === "session" && options.sessionBreakdown === "daily") {
    return { label: bucketLabel(turn.at, "daily", options.timeZone), ...perAgent };
  }

  if (options.grouping === "session") {
    return { label: describeSessionLabel(session), ...perAgent };
  }

  return {
    label: bucketLabel(turn.at, options.grouping satisfies Grouping as PeriodGrouping, options.timeZone),
    ...perAgent,
  };
}

/**
 * How a session reads in the label column: its name, then part of its id.
 *
 * ccusage prints the raw uuid because it has no name to print. TurnLens resolves
 * one, so the name is what a person recognises the row by, and the id fragment is
 * what they copy into `--id`, which takes a prefix.
 */
function describeSessionLabel(session: SessionRef): string {
  const uuid = /([0-9a-f]{8})/iu.exec(session.sessionId)?.[1] ?? session.sessionId.slice(0, 8);
  return `${session.sessionName}  ${uuid}`;
}

function seed(key: BucketKey): Bucket {
  return { ...emptyBucket(key.label), ...(key.provider === undefined ? {} : { provider: key.provider }) };
}

/**
 * Newest period first, or most expensive session first.
 *
 * The two orderings answer the two questions being asked. A period report is read
 * as a recent history, so the latest belongs at the top. A session report is
 * scanned for what cost the most, so cost is the order, and a session that could
 * not be priced sorts last rather than as free.
 */
function sort(buckets: readonly Bucket[], options: CollectOptions): readonly Bucket[] {
  if (options.grouping === "session" && options.sessionBreakdown === undefined) {
    return [...buckets].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));
  }
  return [...buckets].sort((a, b) => (a.label < b.label ? 1 : a.label > b.label ? -1 : 0));
}

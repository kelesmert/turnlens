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
/**
 * One agent's contribution to a report's scope.
 *
 * Carried rather than derived from the buckets, because an agent with sessions
 * and no priceable turns still belongs in the answer to "what did this cover".
 * A reader who sees no Codex row wants to know whether Codex was searched.
 */
export interface AgentCoverage {
  readonly provider: string;
  readonly sessions: number;
}

export interface Coverage {
  readonly sessions: number;
  /** Every agent searched, in registry order, whether or not it produced a row. */
  readonly agents: readonly AgentCoverage[];
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

  const scope = await resolveScope(options);
  const perAgent = new Map<string, number>(options.agents.map((agent) => [agent.id, 0]));
  // Computed once over every session in scope, because a prefix that is unique
  // among these rows is the thing a reader copies into `--id`.
  const prefixLength = uniquePrefixLength(scope.map((scoped) => scoped.session));

  for (const { adapter, session } of scope) {
    sessions += 1;
    perAgent.set(adapter.id, (perAgent.get(adapter.id) ?? 0) + 1);

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

      const key = keyFor(turn, session, options, prefixLength);
      // Keyed by id as well as label, because a label is not unique. Two sessions
      // on this machine are both named "(unnamed session)", and keying by the
      // label alone would sum them into one row.
      const slot = `${key.label}\u0000${key.id ?? ""}\u0000${key.provider ?? ""}`;
      buckets.set(slot, addTurn(buckets.get(slot) ?? seed(key), turn));
    }
  }

  return {
    buckets: sort([...buckets.values()], options),
    coverage: {
      sessions,
      agents: [...perAgent].map(([provider, count]) => ({ provider, sessions: count })),
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
  const matches = await matchSessions(query, agents);

  const only = matches[0];
  if (only === undefined) throw noSessionMatches(query, agents);
  if (matches.length > 1) throw tooManySessionsMatch(query, matches);

  return await describeMatch(only);
}

/** One transcript an id or prefix matched, and the agent that owns it. */
export interface SessionMatch {
  readonly adapter: ProviderAdapter;
  readonly path: string;
  /** The id as it appears in a report and in an error, which is the filename. */
  readonly sessionId: string;
}

/**
 * Every session an id or prefix matches, across every agent given.
 *
 * Exposed alongside `resolveSessionQuery` because the two modes want different
 * things from ambiguity. A report cannot ask, since its output is piped, so it
 * takes the error. Watching is already a conversation, so it can list the
 * candidates and let the user pick, which is what `resolveSessionQuery` cannot do
 * without dragging a prompt into a module that has no business owning one.
 *
 * Cheap by construction: this reads directory entries and opens nothing. Only the
 * chosen match is described, which is where a name comes from.
 */
export async function matchSessions(
  query: string,
  agents: readonly ProviderAdapter[],
): Promise<readonly SessionMatch[]> {
  const matches: SessionMatch[] = [];

  for (const adapter of agents) {
    for (const path of await adapter.listSessionPaths()) {
      const sessionId = basename(path, ".jsonl");
      if (sessionId.includes(query)) matches.push({ adapter, path, sessionId });
    }
  }

  return matches;
}

export async function describeMatch(match: SessionMatch): Promise<SessionRef> {
  return await match.adapter.describeSession(match.path);
}

export function noSessionMatches(query: string, agents: readonly ProviderAdapter[]): Error {
  return new Error(
    `No session matches ${query}.\n` +
      `Searched ${agents.map((agent) => agent.id).join(" and ")}. ` +
      "Run the report grouped by session to see the ids there are.",
  );
}

export function tooManySessionsMatch(
  query: string,
  matches: readonly SessionMatch[],
): Error {
  const candidates = matches.slice(0, 10).map((match) => describeCandidate(match));
  return new Error(
    `${matches.length} sessions match ${query}. Name one of them:\n${candidates.join("\n")}` +
      (matches.length > candidates.length ? "\n  ..." : ""),
  );
}

/** How a candidate reads in a list: its agent, then its id. */
export function describeCandidate(match: SessionMatch): string {
  return `  ${match.adapter.id}  ${match.sessionId}`;
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
  readonly id?: string;
  readonly provider?: string;
}

function keyFor(
  turn: NormalizedTurn,
  session: SessionRef,
  options: CollectOptions,
  prefixLength: number,
): BucketKey {
  const perAgent = options.agents.length > 1 ? { provider: turn.provider } : {};

  // One session broken into days: the grouping word says session, but the rows
  // are days, because the filter has already reduced it to one session.
  if (options.grouping === "session" && options.sessionBreakdown === "daily") {
    return { label: bucketLabel(turn.at, "daily", options.timeZone), ...perAgent };
  }

  if (options.grouping === "session") {
    return {
      label: session.sessionName,
      id: identity(session).slice(0, prefixLength),
      ...perAgent,
    };
  }

  return {
    label: bucketLabel(turn.at, options.grouping satisfies Grouping as PeriodGrouping, options.timeZone),
    ...perAgent,
  };
}

/** The shortest id prefix that is unique in this report, floor 8 characters. */
const MINIMUM_ID_PREFIX = 8;

/**
 * The part of an id worth showing, which is the uuid where there is one.
 *
 * A Codex id is `rollout-<date>-<uuid>`, and the date is already in the row. A
 * Claude Code id is the uuid alone.
 */
function identity(session: SessionRef): string {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(
    session.sessionId,
  )?.[1] ?? session.sessionId;
}

/**
 * The shortest prefix length at which every session here is distinguishable.
 *
 * Floors at eight, so a report of one session still shows something worth
 * copying, and grows only as far as the collisions require.
 */
export function uniquePrefixLength(sessions: readonly SessionRef[]): number {
  const ids = sessions.map((session) => identity(session));
  const longest = Math.max(MINIMUM_ID_PREFIX, ...ids.map((id) => id.length));

  for (let length = MINIMUM_ID_PREFIX; length < longest; length += 1) {
    const prefixes = new Set(ids.map((id) => id.slice(0, length)));
    if (prefixes.size === ids.length) return length;
  }

  return longest;
}

function seed(key: BucketKey): Bucket {
  return {
    ...emptyBucket(key.label),
    ...(key.id === undefined ? {} : { id: key.id }),
    ...(key.provider === undefined ? {} : { provider: key.provider }),
  };
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

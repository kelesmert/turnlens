import { copyFile, mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect, resolveSessionQuery, uniquePrefixLength } from "../src/report/collect.js";
import { createPricingResolver } from "../src/pricing/resolver.js";
import { createCodexAdapter, resolveCodexPaths } from "../src/providers/codex/sessions.js";
import type { CollectOptions } from "../src/report/collect.js";
import type { ProviderAdapter, SessionRef } from "../src/core/types.js";
import type { PricingResolver } from "../src/pricing/types.js";

/**
 * The same Codex fixture the watch tests drive, copied twice.
 *
 * Measured rather than assumed: it closes 45 turns, 44 of them on 2026-07-22 and
 * one on 2026-07-24, every one priced, totalling $36.997827 under a single model.
 * Two copies double each of those.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "codex-abort-session.jsonl");
const TURNS_PER_COPY = 45;
const COST_PER_COPY = 36.997827;

const LIVE = "rollout-2026-07-22T02-29-08-aaaaaaaa-0000-0000-0000-000000000001.jsonl";
const ARCHIVED = "rollout-2026-07-22T02-29-08-bbbbbbbb-0000-0000-0000-000000000002.jsonl";

async function offlineResolver(): Promise<PricingResolver> {
  return await createPricingResolver({
    offline: true,
    cachePath: join(await mkdtemp(join(tmpdir(), "turnlens-collect-pricing-")), "litellm.json"),
  });
}

/**
 * One Codex home holding two sessions, one live and one archived.
 *
 * Archived on purpose: a total has to account for it, so a fixture that only
 * held live sessions would pass whether or not the report reads them.
 */
async function twoSessionAdapter(): Promise<ProviderAdapter> {
  const home = await mkdtemp(join(tmpdir(), "turnlens-collect-"));
  const dayDir = join(home, "sessions", "2026", "07", "22");
  const archivedDir = join(home, "archived_sessions");
  await mkdir(dayDir, { recursive: true });
  await mkdir(archivedDir, { recursive: true });

  await copyFile(FIXTURE, join(dayDir, LIVE));
  await copyFile(FIXTURE, join(archivedDir, ARCHIVED));
  await utimes(join(dayDir, LIVE), new Date(2_000_000), new Date(2_000_000));
  await utimes(join(archivedDir, ARCHIVED), new Date(1_000_000), new Date(1_000_000));

  return createCodexAdapter(resolveCodexPaths({ CODEX_HOME: home }));
}

/** UTC so a bucket label does not depend on where the suite is run. */
async function fixture(overrides: Partial<CollectOptions> = {}): Promise<CollectOptions> {
  return {
    agents: [await twoSessionAdapter()],
    pricing: await offlineResolver(),
    grouping: "daily",
    window: {},
    timeZone: "UTC",
    ...overrides,
  };
}

describe("collect, grouped by day", () => {
  it("groups turns from every session, newest period first", async () => {
    const data = await collect(await fixture());

    expect(data.buckets.map((bucket) => bucket.label)).toEqual(["2026-07-24", "2026-07-22"]);
    expect(data.buckets[1]?.turns).toBe(88);
    expect(data.buckets[0]?.turns).toBe(2);
  });

  it("counts the archived session, because its tokens were spent", async () => {
    const data = await collect(await fixture());

    expect(data.coverage.sessions).toBe(2);
    expect(data.buckets.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(TURNS_PER_COPY * 2);
  });

  it("totals the same money the pipeline priced, twice over", async () => {
    const data = await collect(await fixture());
    const total = data.buckets.reduce((sum, bucket) => sum + (bucket.costUsd ?? 0), 0);

    expect(total).toBeCloseTo(COST_PER_COPY * 2, 4);
  });

  it("reports the window it actually found, not the one asked for", async () => {
    const data = await collect(await fixture());

    expect(data.coverage.oldestDay).toBe("2026-07-22");
    expect(data.coverage.newestDay).toBe("2026-07-24");
    expect(data.coverage.timeZone).toBe("UTC");
    expect(data.coverage.pricingVersion.length).toBeGreaterThan(0);
  });

  it("says nothing could not be priced when everything could", async () => {
    const data = await collect(await fixture());

    expect(data.coverage.unpricedTurns).toBe(0);
  });
});

describe("collect, with a window", () => {
  it("drops turns outside it and narrows the coverage with them", async () => {
    const data = await collect(await fixture({ window: { since: "2026-07-24" } }));

    expect(data.buckets.map((bucket) => bucket.label)).toEqual(["2026-07-24"]);
    expect(data.coverage.oldestDay).toBe("2026-07-24");
  });

  it("returns no buckets at all for a window holding nothing", async () => {
    const data = await collect(await fixture({ window: { since: "2027-01-01" } }));

    expect(data.buckets).toEqual([]);
    expect(data.coverage.oldestDay).toBeUndefined();
    // The sessions were still read, and the coverage still says so, which is what
    // distinguishes an empty window from an empty machine.
    expect(data.coverage.sessions).toBe(2);
  });
});

describe("collect, grouped by session", () => {
  it("puts one row per session", async () => {
    const data = await collect(await fixture({ grouping: "session" }));

    expect(data.buckets).toHaveLength(2);
    expect(data.buckets.every((bucket) => bucket.turns === TURNS_PER_COPY)).toBe(true);
  });

  it("orders sessions by cost, which is what somebody scanning is looking for", async () => {
    const data = await collect(await fixture({ grouping: "session" }));
    const costs = data.buckets.map((bucket) => bucket.costUsd ?? 0);

    expect([...costs]).toEqual([...costs].sort((a, b) => b - a));
  });

  it("labels a row by the session, not by a date", async () => {
    const data = await collect(await fixture({ grouping: "session" }));

    for (const bucket of data.buckets) expect(bucket.label).not.toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});

describe("collect, one session broken into days", () => {
  it("reads only the session named and labels its days", async () => {
    const data = await collect(
      await fixture({ grouping: "session", sessionIdQuery: "aaaaaaaa", sessionBreakdown: "daily" }),
    );

    expect(data.buckets.map((bucket) => bucket.label)).toEqual(["2026-07-24", "2026-07-22"]);
    expect(data.coverage.sessions).toBe(1);
    expect(data.buckets.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(TURNS_PER_COPY);
  });

  it("narrows to one row when no breakdown is asked for", async () => {
    const data = await collect(await fixture({ grouping: "session", sessionIdQuery: "aaaaaaaa" }));

    expect(data.buckets).toHaveLength(1);
    expect(data.buckets[0]?.turns).toBe(TURNS_PER_COPY);
  });
});

/**
 * Found by running the report against real Codex data. Eight characters was the
 * first answer and it does not hold: a Codex id is a uuid v7, which begins with a
 * timestamp, so two sessions started close together share their opening. Two on
 * the development machine share all eight. A fragment that cannot be pasted into
 * `--id` is not doing the job the fragment exists for.
 */
describe("the id fragment in a session label", () => {
  it("lengthens the fragment until every session in the report is distinguishable", () => {
    const shared = "019f838c-9333-7501-899d-e0813b703e2e";
    const twin = "019f838c-a92d-7af2-8474-7d413b8771d7";

    expect(uniquePrefixLength([session(shared), session(twin)])).toBeGreaterThan(8);
  });

  it("stays at eight when eight is enough", () => {
    expect(
      uniquePrefixLength([
        session("aaaaaaaa-0000-0000-0000-000000000001"),
        session("bbbbbbbb-0000-0000-0000-000000000002"),
      ]),
    ).toBe(8);
  });

  it("stays at eight for a single session, which collides with nothing", () => {
    expect(uniquePrefixLength([session("aaaaaaaa-0000-0000-0000-000000000001")])).toBe(8);
  });

  it("reads the uuid out of a Codex filename, where the date is already a column", () => {
    const codex = session("rollout-2026-07-21T10-20-55-019f838c-9333-7501-899d-e0813b703e2e");
    const twin = session("rollout-2026-07-21T10-21-01-019f838c-a92d-7af2-8474-7d413b8771d7");

    // Identical up to the uuid, so a prefix of the whole filename would never
    // separate them however long it grew. Taken from the uuid, these two part
    // company at the tenth character.
    expect(uniquePrefixLength([codex, twin])).toBe(10);
  });
});

function session(sessionId: string): SessionRef {
  return {
    provider: "codex",
    path: `/tmp/${sessionId}.jsonl`,
    sessionId,
    sessionName: "a session",
    lastActivityMs: 0,
  };
}

describe("resolveSessionQuery", () => {
  it("resolves a full id", async () => {
    const agents = [await twoSessionAdapter()];
    const ref = await resolveSessionQuery(LIVE.replace(".jsonl", ""), agents);

    expect(ref.sessionId).toBe(LIVE.replace(".jsonl", ""));
  });

  it("resolves a unique prefix, because nobody types a uuid in full", async () => {
    const agents = [await twoSessionAdapter()];

    expect((await resolveSessionQuery("aaaaaaaa", agents)).sessionId).toContain("aaaaaaaa");
    expect((await resolveSessionQuery("bbbbbbbb", agents)).sessionId).toContain("bbbbbbbb");
  });

  it("finds an archived session, which is where an old id will live", async () => {
    const agents = [await twoSessionAdapter()];

    expect((await resolveSessionQuery("bbbbbbbb", agents)).path).toContain("archived_sessions");
  });

  /**
   * Never resolved silently. Two sessions matching one prefix is a question for
   * the user, and the candidates are named with their agent because the same
   * prefix can match in more than one.
   */
  it("refuses an ambiguous query and names the candidates", async () => {
    const agents = [await twoSessionAdapter()];

    await expect(resolveSessionQuery("rollout", agents)).rejects.toThrow(/codex/u);
    await expect(resolveSessionQuery("rollout", agents)).rejects.toThrow(/aaaaaaaa/u);
  });

  it("refuses a query that matches nothing, naming what it searched", async () => {
    const agents = [await twoSessionAdapter()];

    await expect(resolveSessionQuery("zzzzzzzz", agents)).rejects.toThrow(/zzzzzzzz/u);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPricingResolver, refreshPricing } from "../src/pricing/resolver.js";
import type { FetchDocument } from "../src/pricing/resolver.js";
import { readPricingCache } from "../src/pricing/cache.js";
import type { PricingFetchResult } from "../src/pricing/fetch.js";
import { SNAPSHOT_VERSION } from "../src/pricing/snapshot.generated.js";

async function cachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "turnlens-resolver-")), "litellm.json");
}

const FETCHED_DOCUMENT = JSON.stringify({
  "future-model-1": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  "gpt-5.6-sol": { input_cost_per_token: 9.99, output_cost_per_token: 9.99 },
});

/** Records every call so tests can assert both the count and the ETag sent. */
function recorder(result: PricingFetchResult): {
  readonly fetchDocument: FetchDocument;
  readonly calls: { url: string; etag: string | undefined }[];
} {
  const calls: { url: string; etag: string | undefined }[] = [];
  return {
    calls,
    fetchDocument: async (url, etag) => {
      calls.push({ url, etag });
      return result;
    },
  };
}

/** Seeds a cache file the way a previous online run would have left it. */
async function seedCache(path: string, etag?: string): Promise<void> {
  await refreshPricing({
    offline: false,
    cachePath: path,
    fetchDocument: async () => ({
      kind: "fetched",
      body: FETCHED_DOCUMENT,
      ...(etag === undefined ? {} : { etag }),
    }),
  });
}

describe("createPricingResolver", () => {
  it("prices a known model from the embedded snapshot when offline", async () => {
    const { fetchDocument, calls } = recorder({ kind: "unchanged" });
    const resolver = await createPricingResolver({
      offline: true,
      cachePath: await cachePath(),
      fetchDocument,
    });

    const lookup = resolver.lookup("gpt-5.6-sol");
    expect(lookup.pricing?.inputPerToken).toBe(5e-6);
    expect(lookup.version).toBe(SNAPSHOT_VERSION);
    expect(calls).toHaveLength(0);
  });

  // The online default: one check, before monitoring, and the newer rates win.
  it("checks upstream on startup and prices from what it downloaded", async () => {
    const { fetchDocument, calls } = recorder({ kind: "fetched", body: FETCHED_DOCUMENT });
    const resolver = await createPricingResolver({
      offline: false,
      cachePath: await cachePath(),
      fetchDocument,
    });

    expect(calls).toHaveLength(1);
    expect(resolver.lookup("gpt-5.6-sol").pricing?.inputPerToken).toBe(9.99);
    expect(resolver.lookup("future-model-1").pricing?.inputPerToken).toBe(1e-6);
    expect(resolver.version).toMatch(/^litellm@sha256:[0-9a-f]{12}$/u);
  });

  it("sends the cached ETag so an unchanged list transfers nothing", async () => {
    const path = await cachePath();
    await seedCache(path, '"abc123"');

    const { fetchDocument, calls } = recorder({ kind: "unchanged" });
    const resolver = await createPricingResolver({ offline: false, cachePath: path, fetchDocument });

    expect(calls[0]?.etag).toBe('"abc123"');
    // Still priced, from the cache that was already on disk.
    expect(resolver.lookup("future-model-1").pricing?.inputPerToken).toBe(1e-6);
  });

  it("sends no ETag when there is no cache yet", async () => {
    const { fetchDocument, calls } = recorder({ kind: "fetched", body: FETCHED_DOCUMENT });
    await createPricingResolver({ offline: false, cachePath: await cachePath(), fetchDocument });

    expect(calls[0]?.etag).toBeUndefined();
  });

  it("never touches the network when offline", async () => {
    const path = await cachePath();
    await seedCache(path);

    const { fetchDocument, calls } = recorder({ kind: "fetched", body: FETCHED_DOCUMENT });
    const resolver = await createPricingResolver({ offline: true, cachePath: path, fetchDocument });

    expect(calls).toHaveLength(0);
    expect(resolver.lookup("future-model-1").pricing?.inputPerToken).toBe(1e-6);
  });

  // Starting a watch on a train must work.
  it("survives an unreachable network, keeps pricing, and says so once", async () => {
    const notices: string[] = [];
    const resolver = await createPricingResolver({
      offline: false,
      cachePath: await cachePath(),
      fetchDocument: async () => ({ kind: "failed" }),
      notify: (line) => notices.push(line),
    });

    expect(resolver.lookup("gpt-5.6-sol").pricing?.inputPerToken).toBe(5e-6);
    expect(resolver.version).toBe(SNAPSHOT_VERSION);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(SNAPSHOT_VERSION);
  });

  it("says nothing when the list simply has not changed", async () => {
    const path = await cachePath();
    await seedCache(path, '"abc123"');

    const notices: string[] = [];
    await createPricingResolver({
      offline: false,
      cachePath: path,
      fetchDocument: async () => ({ kind: "unchanged" }),
      notify: (line) => notices.push(line),
    });

    expect(notices).toHaveLength(0);
  });

  it("writes what it downloaded, so a later offline run prices the same model", async () => {
    const path = await cachePath();
    await createPricingResolver({
      offline: false,
      cachePath: path,
      fetchDocument: async () => ({ kind: "fetched", body: FETCHED_DOCUMENT, etag: '"abc123"' }),
    });

    const stored = await readPricingCache(path);
    expect(stored?.models["future-model-1"]).toBeDefined();
    expect(stored?.etag).toBe('"abc123"');

    const { fetchDocument, calls } = recorder({ kind: "unchanged" });
    const later = await createPricingResolver({ offline: true, cachePath: path, fetchDocument });

    expect(later.lookup("future-model-1").pricing?.inputPerToken).toBe(1e-6);
    expect(calls).toHaveLength(0);
  });

  // A cached document is newer than the shipped snapshot, so it wins and the
  // version says which one paid for the row.
  it("prefers a cached rate over the snapshot and reports the cached version", async () => {
    const path = await cachePath();
    await seedCache(path);

    const resolver = await createPricingResolver({ offline: true, cachePath: path });
    const lookup = resolver.lookup("gpt-5.6-sol");

    expect(lookup.pricing?.inputPerToken).toBe(9.99);
    expect(lookup.version).not.toBe(SNAPSHOT_VERSION);
    expect(lookup.version).toMatch(/^litellm@sha256:[0-9a-f]{12}$/u);
  });

  it("keeps the local layers when the download has no usable entries", async () => {
    const notices: string[] = [];
    const resolver = await createPricingResolver({
      offline: false,
      cachePath: await cachePath(),
      fetchDocument: async () => ({
        kind: "fetched",
        body: '{"broken":{"input_cost_per_token":"free"}}',
      }),
      notify: (line) => notices.push(line),
    });

    expect(resolver.lookup("gpt-5.6-sol").pricing?.inputPerToken).toBe(5e-6);
    expect(resolver.version).toBe(SNAPSHOT_VERSION);
    expect(notices).toHaveLength(1);
  });

  it("resolves a date-suffixed alias through the candidate list", async () => {
    const resolver = await createPricingResolver({
      offline: false,
      cachePath: await cachePath(),
      fetchDocument: async () => ({
        kind: "fetched",
        body: JSON.stringify({
          "claude-opus-9": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
        }),
      }),
    });

    expect(resolver.lookup("claude-opus-9-20260101").pricing?.inputPerToken).toBe(1e-6);
  });

  it("reports an empty model name as unknown", async () => {
    const resolver = await createPricingResolver({ offline: true, cachePath: await cachePath() });
    expect(resolver.lookup("").pricing).toBeUndefined();
  });

  it("reports an unknown model as unknown rather than as free", async () => {
    const resolver = await createPricingResolver({ offline: true, cachePath: await cachePath() });
    expect(resolver.lookup("no-such-model-anywhere").pricing).toBeUndefined();
  });
});

describe("refreshPricing", () => {
  it("fetches and stores the document, reporting what it stored", async () => {
    const path = await cachePath();
    const result = await refreshPricing({
      offline: false,
      cachePath: path,
      fetchDocument: async () => ({ kind: "fetched", body: FETCHED_DOCUMENT }),
    });

    expect(result?.modelCount).toBe(2);
    expect(result?.version).toMatch(/^litellm@sha256:[0-9a-f]{12}$/u);
    expect((await readPricingCache(path))?.models["gpt-5.6-sol"]).toBeDefined();
  });

  // --refresh-pricing means "download it now", typically before going offline,
  // so it must not be short-circuited by a 304.
  it("ignores any stored ETag and downloads unconditionally", async () => {
    const path = await cachePath();
    await seedCache(path, '"abc123"');

    const { fetchDocument, calls } = recorder({ kind: "fetched", body: FETCHED_DOCUMENT });
    await refreshPricing({ offline: false, cachePath: path, fetchDocument });

    expect(calls[0]?.etag).toBeUndefined();
  });

  it("reports nothing when the fetch fails and leaves no cache behind", async () => {
    const path = await cachePath();
    expect(
      await refreshPricing({
        offline: false,
        cachePath: path,
        fetchDocument: async () => ({ kind: "failed" }),
      }),
    ).toBeUndefined();
    expect(await readPricingCache(path)).toBeUndefined();
  });

  it("reports nothing when the document has no usable entries", async () => {
    const path = await cachePath();
    expect(
      await refreshPricing({
        offline: false,
        cachePath: path,
        fetchDocument: async () => ({
          kind: "fetched",
          body: '{"broken":{"input_cost_per_token":"free"}}',
        }),
      }),
    ).toBeUndefined();
  });
});

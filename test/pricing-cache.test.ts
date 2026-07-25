import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashDocument,
  readPricingCache,
  resolvePricingCachePath,
  writePricingCache,
} from "../src/pricing/cache.js";
import type { PricingCache } from "../src/pricing/cache.js";

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "turnscope-pricing-"));
}

function cache(overrides: Partial<PricingCache> = {}): PricingCache {
  return {
    fetchedAt: "2026-07-25T18:00:00.000Z",
    sourceUrl: "https://example.invalid/pricing.json",
    contentHash: "sha256:0123456789ab",
    models: { "gpt-5.6-sol": { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 } },
    ...overrides,
  };
}

describe("resolvePricingCachePath", () => {
  it("puts the cache under the user's home directory", () => {
    const path = resolvePricingCachePath({ HOME: "/home/someone" });
    expect(path).toBe(join("/home/someone", ".turnscope", "pricing", "litellm.json"));
  });

  // Tests must never touch the real home directory, and a user may want the
  // cache somewhere else.
  it("honours TURNSCOPE_HOME over the home directory", () => {
    const path = resolvePricingCachePath({ TURNSCOPE_HOME: "/tmp/ts", HOME: "/home/someone" });
    expect(path).toBe(join("/tmp/ts", "pricing", "litellm.json"));
  });
});

describe("writePricingCache and readPricingCache", () => {
  it("round-trips a cache file", async () => {
    const path = join(await tempHome(), "pricing", "litellm.json");
    await writePricingCache(path, cache());

    const loaded = await readPricingCache(path);
    expect(loaded).toEqual(cache());
  });

  it("creates the directory it needs", async () => {
    const home = await tempHome();
    const path = join(home, "nested", "deeper", "litellm.json");
    await writePricingCache(path, cache());
    expect(await readFile(path, "utf8")).toContain("gpt-5.6-sol");
  });

  it("leaves no temporary file behind", async () => {
    const dir = await tempHome();
    const path = join(dir, "litellm.json");
    await writePricingCache(path, cache());
    expect(await readdir(dir)).toEqual(["litellm.json"]);
  });

  it("overwrites an existing cache", async () => {
    const path = join(await tempHome(), "litellm.json");
    await writePricingCache(path, cache());
    await writePricingCache(path, cache({ contentHash: "sha256:ffffffffffff" }));

    expect((await readPricingCache(path))?.contentHash).toBe("sha256:ffffffffffff");
  });

  // The ETag is what makes the next online run cost nothing when the upstream
  // list has not moved, so it has to survive the round trip.
  it("round-trips the ETag when the server supplied one", async () => {
    const path = join(await tempHome(), "litellm.json");
    await writePricingCache(path, cache({ etag: '"34ea6a10ed5f"' }));
    expect((await readPricingCache(path))?.etag).toBe('"34ea6a10ed5f"');
  });

  // A cache without an ETag is still a usable cache; the next run just has to
  // download unconditionally. `exactOptionalPropertyTypes` means the property is
  // absent, never present-and-undefined.
  it("omits the ETag rather than storing undefined when there is none", async () => {
    const path = join(await tempHome(), "litellm.json");
    await writePricingCache(path, cache());

    const loaded = await readPricingCache(path);
    expect(loaded?.etag).toBeUndefined();
    expect(Object.hasOwn(loaded ?? {}, "etag")).toBe(false);
  });

  it("ignores an ETag that is not a usable string", async () => {
    const path = join(await tempHome(), "bad-etag.json");
    await writeFile(path, JSON.stringify({ ...cache(), etag: 42 }), "utf8");

    const loaded = await readPricingCache(path);
    expect(loaded?.models["gpt-5.6-sol"]).toBeDefined();
    expect(loaded?.etag).toBeUndefined();
  });

  it("returns nothing for a missing file", async () => {
    const path = join(await tempHome(), "absent.json");
    expect(await readPricingCache(path)).toBeUndefined();
  });

  // A corrupt cache must degrade to "no cache", never to a crash on startup.
  it("returns nothing for a file that is not usable", async () => {
    const dir = await tempHome();
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ not json", "utf8");
    expect(await readPricingCache(broken)).toBeUndefined();

    const wrongShape = join(dir, "wrong.json");
    await writeFile(wrongShape, JSON.stringify({ models: "not an object" }), "utf8");
    expect(await readPricingCache(wrongShape)).toBeUndefined();

    const emptyModels = join(dir, "empty.json");
    await writeFile(emptyModels, JSON.stringify({ ...cache(), models: {} }), "utf8");
    expect(await readPricingCache(emptyModels)).toBeUndefined();
  });

  it("drops entries whose rates are not numbers rather than failing the whole file", async () => {
    const path = join(await tempHome(), "mixed.json");
    await writeFile(
      path,
      JSON.stringify({
        ...cache(),
        models: {
          "gpt-5.6-sol": { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
          "bad-model": { input_cost_per_token: "free" },
        },
      }),
      "utf8",
    );

    const loaded = await readPricingCache(path);
    expect(Object.keys(loaded?.models ?? {})).toEqual(["gpt-5.6-sol"]);
  });
});

describe("hashDocument", () => {
  it("produces the same short digest format as the snapshot", () => {
    expect(hashDocument("{}")).toMatch(/^sha256:[0-9a-f]{12}$/u);
    expect(hashDocument("a")).not.toBe(hashDocument("b"));
    expect(hashDocument("a")).toBe(hashDocument("a"));
  });
});

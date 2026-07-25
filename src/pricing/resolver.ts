import { hashDocument, readPricingCache, writePricingCache } from "./cache.js";
import { fetchPricingDocument, LITELLM_PRICING_URL } from "./fetch.js";
import type { PricingFetchResult } from "./fetch.js";
import { parseLiteLlmDocument } from "./litellm.js";
import { modelNameCandidates } from "./model-names.js";
import { PRICING_SNAPSHOT, SNAPSHOT_VERSION } from "./snapshot.generated.js";
import type { ModelPricing, PricingLookup, PricingResolver, RawPricingEntry } from "./types.js";

/** Positional ETag: see the note in this task's Interfaces section. */
export type FetchDocument = (url: string, etag: string | undefined) => Promise<PricingFetchResult>;

export interface PricingResolverOptions {
  /** When true, no network access happens for any reason. */
  readonly offline: boolean;
  readonly cachePath: string;
  readonly sourceUrl?: string;
  /** Injectable for tests; defaults to the real conditional fetcher. */
  readonly fetchDocument?: FetchDocument;
  readonly notify?: (line: string) => void;
}

interface PricedEntry {
  readonly pricing: ModelPricing;
  readonly version: string;
}

const defaultFetch: FetchDocument = async (url, etag) =>
  await fetchPricingDocument(url, etag === undefined ? {} : { etag });

/**
 * Builds the pricing resolver for one run, doing all of its I/O up front.
 *
 * Layers, oldest first, each overwriting the last: the embedded snapshot, the
 * on-disk cache from the previous online run, then -- unless `offline` -- one
 * conditional request to the source. The request carries the cache's `ETag`, so
 * the usual answer is `304` and nothing is transferred.
 *
 * Nothing after this function touches the network, which is why `lookup` is
 * synchronous: pricing a turn must never stall the reader that is tailing a
 * session file.
 *
 * Every failure is survivable. An unreachable source, a malformed document, a
 * corrupt cache -- each falls through to the layer beneath. A model that stays
 * unknown is reported as unknown; nothing here invents a rate or substitutes
 * zero.
 */
export async function createPricingResolver(
  options: PricingResolverOptions,
): Promise<PricingResolver> {
  const sourceUrl = options.sourceUrl ?? LITELLM_PRICING_URL;
  const fetchDocument = options.fetchDocument ?? defaultFetch;

  const entries = new Map<string, PricedEntry>();
  addDocument(entries, PRICING_SNAPSHOT, SNAPSHOT_VERSION);

  let version = SNAPSHOT_VERSION;
  const cached = await readPricingCache(options.cachePath);
  if (cached !== undefined) {
    version = toVersion(cached.contentHash);
    addDocument(entries, cached.models, version);
  }

  if (!options.offline) {
    const result = await fetchDocument(sourceUrl, cached?.etag);

    if (result.kind === "failed") {
      // One line, not a warning per turn. The run is still fully functional.
      options.notify?.(`Could not reach ${sourceUrl}. Pricing from ${version}.`);
    } else if (result.kind === "fetched") {
      const models = readRawDocument(result.body);
      if (Object.keys(models).length === 0) {
        options.notify?.(`No usable pricing entries at ${sourceUrl}. Pricing from ${version}.`);
      } else {
        const contentHash = hashDocument(result.body);
        version = toVersion(contentHash);
        addDocument(entries, models, version);
        await writePricingCache(options.cachePath, {
          fetchedAt: new Date().toISOString(),
          sourceUrl,
          contentHash,
          models,
          ...(result.etag === undefined ? {} : { etag: result.etag }),
        });
      }
    }
    // `unchanged` is deliberately silent: it is the ordinary outcome.
  }

  return {
    version,

    lookup(model: string): PricingLookup {
      for (const candidate of modelNameCandidates(model)) {
        const found = entries.get(candidate);
        if (found !== undefined) return { pricing: found.pricing, version: found.version };
      }
      return { version };
    },
  };
}

/**
 * Downloads the pricing document unconditionally and replaces the cache with it.
 *
 * This is what `--refresh-pricing` calls. It deliberately sends no `ETag`: the
 * user asking for a refresh -- typically to stock the cache before working
 * offline -- must not be answered with `304 Not Modified` and an untouched file.
 */
export async function refreshPricing(
  options: PricingResolverOptions,
): Promise<{ readonly version: string; readonly modelCount: number } | undefined> {
  const sourceUrl = options.sourceUrl ?? LITELLM_PRICING_URL;
  const fetchDocument = options.fetchDocument ?? defaultFetch;

  const result = await fetchDocument(sourceUrl, undefined);
  if (result.kind !== "fetched") return undefined;

  const models = readRawDocument(result.body);
  const modelCount = Object.keys(models).length;
  if (modelCount === 0) return undefined;

  const contentHash = hashDocument(result.body);
  await writePricingCache(options.cachePath, {
    fetchedAt: new Date().toISOString(),
    sourceUrl,
    contentHash,
    models,
    ...(result.etag === undefined ? {} : { etag: result.etag }),
  });

  return { version: toVersion(contentHash), modelCount };
}

/**
 * Keeps only priceable entries, in their raw field names.
 *
 * Storing raw names means the cache and the embedded snapshot are the same shape
 * and go through the same parser, so a cached document can never be interpreted
 * by different rules than a fresh one.
 */
function readRawDocument(body: string): Readonly<Record<string, RawPricingEntry>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const priceable = parseLiteLlmDocument(parsed);
  if (priceable.size === 0) return {};

  const models: Record<string, RawPricingEntry> = {};
  for (const model of priceable.keys()) {
    const entry = parsed[model];
    if (!isRecord(entry)) continue;

    const rates: Record<string, number> = {};
    for (const [field, value] of Object.entries(entry)) {
      if (typeof value === "number" && Number.isFinite(value)) rates[field] = value;
    }
    models[model] = rates;
  }
  return models;
}

function addDocument(
  entries: Map<string, PricedEntry>,
  document: Readonly<Record<string, RawPricingEntry>>,
  version: string,
): void {
  for (const [model, pricing] of parseLiteLlmDocument(document)) {
    entries.set(model, { pricing, version });
  }
}

function toVersion(contentHash: string): string {
  return `litellm@${contentHash}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

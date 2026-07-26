import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTurnlensHome } from "../core/paths.js";
import { collapseWhitespace } from "../core/text.js";
import type { RawPricingEntry } from "./types.js";

export interface PricingCache {
  /** ISO timestamp of the fetch that produced this file. */
  readonly fetchedAt: string;
  readonly sourceUrl: string;
  /** Digest of the fetched document, in the snapshot's `sha256:<12 hex>` format. */
  readonly contentHash: string;
  /**
   * `ETag` exactly as the server sent it, replayed as `If-None-Match` next run.
   * Absent when the server sent none; then the next run downloads in full.
   */
  readonly etag?: string;
  readonly models: Readonly<Record<string, RawPricingEntry>>;
}

/** Home resolution lives in one place; see `src/core/paths.ts` for why. */
export function resolvePricingCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveTurnlensHome(env), "pricing", "litellm.json");
}

/** Digest used as a pricing version. Same format as the embedded snapshot's. */
export function hashDocument(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;
}

/**
 * Reads the cache, or returns nothing.
 *
 * Every failure -- missing file, unreadable file, invalid JSON, unexpected
 * shape, no usable entries -- degrades to "no cache". A pricing cache is an
 * optimisation, so it must never be able to stop a watch from starting.
 */
export async function readPricingCache(path: string): Promise<PricingCache | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const fetchedAt = collapseWhitespace(parsed["fetchedAt"]);
  const sourceUrl = collapseWhitespace(parsed["sourceUrl"]);
  const contentHash = collapseWhitespace(parsed["contentHash"]);
  const rawModels = parsed["models"];
  if (fetchedAt === "" || sourceUrl === "" || contentHash === "" || !isRecord(rawModels)) {
    return undefined;
  }

  const models: Record<string, RawPricingEntry> = {};
  for (const [model, entry] of Object.entries(rawModels)) {
    if (!isRecord(entry)) continue;
    const rates: Record<string, number> = {};
    for (const [field, value] of Object.entries(entry)) {
      if (typeof value === "number" && Number.isFinite(value)) rates[field] = value;
    }
    if (Object.keys(rates).length > 0) models[model] = rates;
  }
  if (Object.keys(models).length === 0) return undefined;

  // Spread-or-omit, never `etag: undefined`: `exactOptionalPropertyTypes` treats
  // an explicit undefined as a distinct, disallowed value.
  const etag = collapseWhitespace(parsed["etag"]);
  return { fetchedAt, sourceUrl, contentHash, models, ...(etag === "" ? {} : { etag }) };
}

/**
 * Writes the cache atomically.
 *
 * A temporary file in the same directory is renamed into place, so a crash or a
 * second process can never leave a half-written document for the next run to
 * read. Same reason the CSV store appends whole lines only.
 */
export async function writePricingCache(path: string, cache: PricingCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(cache, undefined, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

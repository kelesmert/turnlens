export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Three distinct outcomes, because the caller treats them differently.
 *
 * `unchanged` is the expected result of a routine online run and is silent.
 * `failed` means the local layers are in use and the user is told once.
 */
export type PricingFetchResult =
  | { readonly kind: "fetched"; readonly body: string; readonly etag?: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failed" };

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Sent as `If-None-Match`. Omit to force a full download. */
  readonly etag?: string;
}

/** Startup must not stall behind a slow network; five seconds then fall through. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** The real document is about 1.7 MB; this leaves room to grow and still bounds memory. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Asks the source whether it has a newer pricing document, and downloads it only
 * if so.
 *
 * Never throws and never retries. Every failure mode -- bad status, timeout,
 * unreachable host, oversized body -- collapses into `failed`, because the
 * caller's fallback is the on-disk cache and then the embedded snapshot, and an
 * unpriced turn is a supported outcome. Retrying would only delay startup.
 */
export async function fetchPricingDocument(
  url: string,
  options: FetchOptions = {},
): Promise<PricingFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: {
        accept: "application/json",
        ...(options.etag === undefined ? {} : { "if-none-match": options.etag }),
      },
    });

    // Checked before `response.ok`, which is false for 304.
    if (response.status === 304) return { kind: "unchanged" };
    if (!response.ok) return { kind: "failed" };

    const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { kind: "failed" };

    const body = await response.text();
    if (body.length > maxBytes) return { kind: "failed" };

    const etag = response.headers.get("etag");
    return { kind: "fetched", body, ...(etag === null || etag === "" ? {} : { etag }) };
  } catch {
    return { kind: "failed" };
  }
}

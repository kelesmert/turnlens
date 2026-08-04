const RELEASE = /^\d+\.\d+\.\d+$/u;

/**
 * The smallest answer the registry can give to "what is published".
 *
 * `{"latest":"0.2.0"}`, eighteen bytes. The full packument at
 * `registry.npmjs.org/turnlens` is 28 KB and carries every version's metadata,
 * none of which is read here.
 */
export const DIST_TAGS_URL = "https://registry.npmjs.org/-/package/turnlens/dist-tags";

/**
 * Two seconds. Shorter than pricing's five, because pricing has an on-disk
 * fallback worth waiting for and this has nothing to fall back to: a notice
 * that does not arrive costs the user nothing.
 */
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * The newest published version, or nothing.
 *
 * Never throws and never retries, following `fetchPricingDocument`. Every
 * failure -- bad status, timeout, unreachable host, unparseable body, a
 * `latest` that is not a release number -- collapses into `undefined`, which
 * the caller reads as "say nothing".
 *
 * **The pattern check is a security boundary, not tidiness.** This value comes
 * from the network and is printed to a terminal, so a string carrying escape
 * sequences would be a way for the registry to write whatever it liked onto the
 * user's screen. Three groups of digits cannot.
 */
export async function fetchLatestVersion(
  url: string = DIST_TAGS_URL,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;

    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const latest = (parsed as Record<string, unknown>)["latest"];
    if (typeof latest !== "string" || !RELEASE.test(latest)) return undefined;
    return latest;
  } catch {
    return undefined;
  }
}

import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPricingDocument, LITELLM_PRICING_URL } from "../src/pricing/fetch.js";

let server: Server | undefined;

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly etag?: string;
  readonly delayMs?: number;
}

/** Records every request so the tests can assert on the headers that were sent. */
const received: IncomingMessage[] = [];

async function serve(handler: (request: IncomingMessage) => Reply): Promise<string> {
  // Held in a local first: the module-level `server` is optional, so calling
  // .address() on it directly would not type-check under strict null checks.
  const created = createServer((request, response) => {
    received.push(request);
    const result = handler(request);
    const send = (): void => {
      response.writeHead(result.status, {
        "content-type": "application/json",
        ...(result.etag === undefined ? {} : { etag: result.etag }),
      });
      response.end(result.status === 304 ? undefined : result.body);
    };
    if (result.delayMs === undefined) send();
    else setTimeout(send, result.delayMs);
  });
  server = created;

  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const address = created.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  received.length = 0;
  await new Promise<void>((resolve) => {
    if (server === undefined) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

describe("fetchPricingDocument", () => {
  it("returns the body and the ETag of a successful response", async () => {
    const base = await serve(() => ({ status: 200, body: '{"gpt-5.6-sol":{}}', etag: '"abc123"' }));

    expect(await fetchPricingDocument(`${base}/pricing.json`)).toEqual({
      kind: "fetched",
      body: '{"gpt-5.6-sol":{}}',
      etag: '"abc123"',
    });
  });

  // exactOptionalPropertyTypes: absent, not present-and-undefined.
  it("omits the ETag when the server sent none", async () => {
    const base = await serve(() => ({ status: 200, body: "{}" }));

    const result = await fetchPricingDocument(`${base}/pricing.json`);
    expect(result).toEqual({ kind: "fetched", body: "{}" });
    expect(Object.hasOwn(result, "etag")).toBe(false);
  });

  // The whole point of the online default: an unchanged list transfers nothing.
  it("reports an unchanged document when the server answers 304", async () => {
    const base = await serve(() => ({ status: 304, body: "" }));

    expect(await fetchPricingDocument(`${base}/pricing.json`, { etag: '"abc123"' })).toEqual({
      kind: "unchanged",
    });
  });

  it("sends the supplied ETag as If-None-Match", async () => {
    const base = await serve(() => ({ status: 304, body: "" }));
    await fetchPricingDocument(`${base}/pricing.json`, { etag: '"abc123"' });

    expect(received[0]?.headers["if-none-match"]).toBe('"abc123"');
  });

  it("sends no If-None-Match when there is no stored ETag", async () => {
    const base = await serve(() => ({ status: 200, body: "{}" }));
    await fetchPricingDocument(`${base}/pricing.json`);

    expect(received[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("fails on an error status", async () => {
    const base = await serve(() => ({ status: 404, body: "not found" }));
    expect(await fetchPricingDocument(`${base}/missing.json`)).toEqual({ kind: "failed" });
  });

  it("fails when the response exceeds the byte cap", async () => {
    const base = await serve(() => ({ status: 200, body: "x".repeat(5_000) }));
    expect(await fetchPricingDocument(`${base}/big.json`, { maxBytes: 1_000 })).toEqual({
      kind: "failed",
    });
  });

  it("fails when the request outlives its timeout", async () => {
    const base = await serve(() => ({ status: 200, body: "{}", delayMs: 300 }));
    expect(await fetchPricingDocument(`${base}/slow.json`, { timeoutMs: 50 })).toEqual({
      kind: "failed",
    });
  });

  // A watch must not die because a network is unreachable.
  it("fails instead of throwing when the host does not resolve", async () => {
    expect(
      await fetchPricingDocument("http://does-not-resolve.invalid/pricing.json", { timeoutMs: 500 }),
    ).toEqual({ kind: "failed" });
  });

  it("names the LiteLLM document as its default source", () => {
    expect(LITELLM_PRICING_URL).toBe(
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    );
  });
});

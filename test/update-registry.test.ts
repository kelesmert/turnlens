import { afterEach, describe, expect, it, vi } from "vitest";
import { DIST_TAGS_URL, fetchLatestVersion } from "../src/update/registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stands in for one `fetch` call. The live registry is never contacted. */
function respond(body: string, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("DIST_TAGS_URL", () => {
  it("points at the 18-byte endpoint rather than the full packument", () => {
    expect(DIST_TAGS_URL).toBe("https://registry.npmjs.org/-/package/turnlens/dist-tags");
  });
});

describe("fetchLatestVersion", () => {
  it("returns the published version", async () => {
    respond(JSON.stringify({ latest: "0.2.0" }));
    expect(await fetchLatestVersion()).toBe("0.2.0");
  });

  it("ignores other dist-tags", async () => {
    respond(JSON.stringify({ latest: "0.2.0", next: "0.3.0-beta.1" }));
    expect(await fetchLatestVersion()).toBe("0.2.0");
  });

  it("returns nothing for a status that is not ok", async () => {
    respond(JSON.stringify({ latest: "0.2.0" }), 404);
    expect(await fetchLatestVersion()).toBeUndefined();
  });

  it("returns nothing when the request throws, including on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await fetchLatestVersion()).toBeUndefined();
  });

  it("returns nothing for a body it cannot read", async () => {
    respond("not json at all");
    expect(await fetchLatestVersion()).toBeUndefined();

    respond(JSON.stringify(["0.2.0"]));
    expect(await fetchLatestVersion()).toBeUndefined();

    respond(JSON.stringify({ beta: "0.3.0" }));
    expect(await fetchLatestVersion()).toBeUndefined();
  });

  it("rejects a version that is not three numbers, so nothing unvalidated is printed", async () => {
    // The registry is the network. What it sends reaches a terminal, so it is
    // checked before it is believed.
    respond(JSON.stringify({ latest: "0.2.0[31m; rm -rf /" }));
    expect(await fetchLatestVersion()).toBeUndefined();

    respond(JSON.stringify({ latest: "v0.2.0" }));
    expect(await fetchLatestVersion()).toBeUndefined();

    respond(JSON.stringify({ latest: 2 }));
    expect(await fetchLatestVersion()).toBeUndefined();
  });

  it("asks for json and gives up quickly", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ latest: "0.2.0" })));
    vi.stubGlobal("fetch", spy);
    await fetchLatestVersion();

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["accept"]).toContain("json");
    expect(init.signal).toBeDefined();
  });
});

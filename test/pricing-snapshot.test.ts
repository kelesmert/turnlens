import { describe, expect, it } from "vitest";
import {
  PRICING_FIELD_NAMES,
  parseLiteLlmDocument,
  parseLiteLlmEntry,
} from "../src/pricing/litellm.js";
import {
  PRICING_SNAPSHOT,
  SNAPSHOT_CONTENT_HASH,
  SNAPSHOT_MODEL_COUNT,
  SNAPSHOT_VERSION,
} from "../src/pricing/snapshot.generated.js";

describe("the embedded pricing snapshot", () => {
  it("carries the models real sessions record", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "claude-opus-5"]) {
      expect(PRICING_SNAPSHOT[model], model).toBeDefined();
    }
  });

  it("prices a known Codex model at the rate the provider publishes", () => {
    const pricing = parseLiteLlmEntry(PRICING_SNAPSHOT["gpt-5.6-sol"]);
    expect(pricing?.inputPerToken).toBe(5e-6);
    expect(pricing?.outputPerToken).toBe(3e-5);
    expect(pricing?.cacheReadPerToken).toBe(5e-7);
  });

  // Every entry must survive the parser, or the snapshot is shipping dead weight.
  it("contains only entries the parser accepts", () => {
    const parsed = parseLiteLlmDocument(PRICING_SNAPSHOT);
    expect(parsed.size).toBe(Object.keys(PRICING_SNAPSHOT).length);
    expect(parsed.size).toBe(SNAPSHOT_MODEL_COUNT);
  });

  it("stays small enough to ship", () => {
    expect(JSON.stringify(PRICING_SNAPSHOT).length).toBeLessThan(64 * 1024);
  });

  it("exposes a version string that identifies the source document", () => {
    expect(SNAPSHOT_CONTENT_HASH).toMatch(/^sha256:[0-9a-f]{12}$/u);
    expect(SNAPSHOT_VERSION).toBe(`litellm@${SNAPSHOT_CONTENT_HASH}`);
  });

  // Context-size tiers (above_128k, above_272k...), priority, flex and batch
  // rates are deliberately absent; see the plan's Context section. An allowlist
  // rather than a denylist, so a variant nobody anticipated cannot slip through.
  //
  // `cache_creation_input_token_cost_above_1hr` is not one of those variants and
  // is kept on purpose: it is Anthropic's one-hour cache write tier, which a
  // session file does distinguish.
  it("carries no field the parser does not read", () => {
    const allowed = new Set<string>(PRICING_FIELD_NAMES);
    for (const [model, rates] of Object.entries(PRICING_SNAPSHOT)) {
      for (const field of Object.keys(rates)) {
        expect(allowed.has(field), `${model}.${field}`).toBe(true);
      }
    }
  });
});

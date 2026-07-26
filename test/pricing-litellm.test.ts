import { describe, expect, it } from "vitest";
import { parseLiteLlmDocument, parseLiteLlmEntry } from "../src/pricing/litellm.js";

describe("parseLiteLlmEntry", () => {
  // Transcribed from the real LiteLLM entry for the model Codex records.
  it("reads the rates for a Codex model", () => {
    expect(
      parseLiteLlmEntry({
        input_cost_per_token: 5e-6,
        output_cost_per_token: 3e-5,
        cache_read_input_token_cost: 5e-7,
        cache_creation_input_token_cost: 6.25e-6,
        litellm_provider: "openai",
        mode: "chat",
        max_input_tokens: 1_050_000,
      }),
    ).toEqual({
      inputPerToken: 5e-6,
      outputPerToken: 3e-5,
      cacheReadPerToken: 5e-7,
      cacheCreationPerToken: 6.25e-6,
    });
  });

  // Transcribed from the real LiteLLM entry for the model Claude Code records.
  it("reads the one-hour cache tier when the provider has one", () => {
    expect(
      parseLiteLlmEntry({
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_read_input_token_cost: 5e-7,
        cache_creation_input_token_cost: 6.25e-6,
        cache_creation_input_token_cost_above_1hr: 1e-5,
      }),
    ).toEqual({
      inputPerToken: 5e-6,
      outputPerToken: 2.5e-5,
      cacheReadPerToken: 5e-7,
      cacheCreationPerToken: 6.25e-6,
      cacheCreation1hPerToken: 1e-5,
    });
  });

  it("omits cache rates entirely when the model has none", () => {
    expect(parseLiteLlmEntry({ input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 })).toEqual({
      inputPerToken: 1e-6,
      outputPerToken: 2e-6,
    });
  });

  it("rejects an entry without both an input and an output rate", () => {
    expect(parseLiteLlmEntry({ input_cost_per_token: 1e-6 })).toBeUndefined();
    expect(parseLiteLlmEntry({ output_cost_per_token: 1e-6 })).toBeUndefined();
    expect(parseLiteLlmEntry({ mode: "embedding" })).toBeUndefined();
  });

  it("rejects values that are not usable numbers instead of coercing them", () => {
    expect(
      parseLiteLlmEntry({ input_cost_per_token: true, output_cost_per_token: 1e-6 }),
    ).toBeUndefined();
    expect(
      parseLiteLlmEntry({ input_cost_per_token: null, output_cost_per_token: 1e-6 }),
    ).toBeUndefined();
    expect(parseLiteLlmEntry("not an object")).toBeUndefined();
    expect(parseLiteLlmEntry(null)).toBeUndefined();
  });

  // A negative rate would pay the user for tokens. It is a corrupt document,
  // not a discount.
  it("rejects a negative rate", () => {
    expect(
      parseLiteLlmEntry({ input_cost_per_token: -1e-6, output_cost_per_token: 1e-6 }),
    ).toBeUndefined();
  });

  // A free model is real (some providers list 0), so zero is kept.
  it("keeps a zero rate", () => {
    expect(parseLiteLlmEntry({ input_cost_per_token: 0, output_cost_per_token: 0 })).toEqual({
      inputPerToken: 0,
      outputPerToken: 0,
    });
  });

  // Ignored on purpose: TurnLens cannot tell which request tier was used, and
  // a turn total is not one request's context size. See the plan's Context.
  it("ignores tier variants such as the above-272k and priority rates", () => {
    expect(
      parseLiteLlmEntry({
        input_cost_per_token: 5e-6,
        output_cost_per_token: 3e-5,
        input_cost_per_token_above_272k_tokens: 1e-5,
        output_cost_per_token_above_272k_tokens: 4.5e-5,
        input_cost_per_token_priority: 1e-5,
        input_cost_per_token_batches: 2.5e-6,
      }),
    ).toEqual({ inputPerToken: 5e-6, outputPerToken: 3e-5 });
  });
});

describe("parseLiteLlmDocument", () => {
  it("keeps entries it can price and drops the rest", () => {
    const models = parseLiteLlmDocument({
      "gpt-5.6-sol": { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
      "text-embedding-3-small": { input_cost_per_token: 2e-8, mode: "embedding" },
      sample_spec: { input_cost_per_token: "0.0", output_cost_per_token: "0.0" },
      broken: null,
    });

    expect([...models.keys()]).toEqual(["gpt-5.6-sol"]);
    expect(models.get("gpt-5.6-sol")?.outputPerToken).toBe(3e-5);
  });

  it("returns an empty map for a document that is not an object", () => {
    expect(parseLiteLlmDocument(null).size).toBe(0);
    expect(parseLiteLlmDocument([]).size).toBe(0);
    expect(parseLiteLlmDocument("{}").size).toBe(0);
  });
});

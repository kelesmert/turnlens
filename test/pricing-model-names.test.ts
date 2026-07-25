import { describe, expect, it } from "vitest";
import { modelNameCandidates } from "../src/pricing/model-names.js";

describe("modelNameCandidates", () => {
  it("offers the recorded name first", () => {
    expect(modelNameCandidates("gpt-5.6-sol")[0]).toBe("gpt-5.6-sol");
  });

  it("offers the name without an eight-digit date suffix", () => {
    expect(modelNameCandidates("claude-opus-4-5-20251101")).toEqual([
      "claude-opus-4-5-20251101",
      "claude-opus-4-5",
    ]);
  });

  // A version number is not a date. Stripping it would price gpt-5.6 with
  // gpt-5's rates.
  it("does not strip numeric suffixes that are not dates", () => {
    expect(modelNameCandidates("gpt-5.6")).toEqual(["gpt-5.6"]);
    expect(modelNameCandidates("claude-opus-5")).toEqual(["claude-opus-5"]);
    expect(modelNameCandidates("model-1234567")).toEqual(["model-1234567"]);
  });

  it("offers the name without a single provider prefix", () => {
    expect(modelNameCandidates("openai/gpt-5.6-sol")).toEqual(["openai/gpt-5.6-sol", "gpt-5.6-sol"]);
  });

  it("combines prefix and date stripping without duplicates", () => {
    expect(modelNameCandidates("anthropic/claude-opus-4-5-20251101")).toEqual([
      "anthropic/claude-opus-4-5-20251101",
      "claude-opus-4-5-20251101",
      "anthropic/claude-opus-4-5",
      "claude-opus-4-5",
    ]);
  });

  it("returns nothing usable for an empty or whitespace-only name", () => {
    expect(modelNameCandidates("")).toEqual([]);
    expect(modelNameCandidates("   ")).toEqual([]);
  });

  it("never invents a shorter name by cutting at a hyphen", () => {
    expect(modelNameCandidates("gpt-5.6-sol")).not.toContain("gpt-5.6");
    expect(modelNameCandidates("gpt-5.6-sol")).not.toContain("gpt");
  });
});

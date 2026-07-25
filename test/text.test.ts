import { describe, expect, it } from "vitest";
import { collapseWhitespace, makePromptPreview, truncate } from "../src/core/text.js";

describe("collapseWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(collapseWhitespace("  a\n\n  b\tc  ")).toBe("a b c");
  });

  it("returns an empty string for non-string input", () => {
    expect(collapseWhitespace(null)).toBe("");
    expect(collapseWhitespace(42)).toBe("");
    expect(collapseWhitespace(undefined)).toBe("");
  });
});

describe("truncate", () => {
  it("leaves text at or under the width untouched", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("replaces the tail with an ellipsis so the result fits the width", () => {
    expect(truncate("abcdefgh", 5)).toBe("ab...");
    expect(truncate("abcdefgh", 5)).toHaveLength(5);
  });

  it("hard-cuts without an ellipsis when the width cannot hold one", () => {
    expect(truncate("abcdefgh", 3)).toBe("abc");
    expect(truncate("abcdefgh", 0)).toBe("");
  });
});

describe("makePromptPreview", () => {
  it("collapses whitespace and caps the result at 20 characters", () => {
    const preview = makePromptPreview("please   summarise\nthe entire repository");
    expect(preview).toBe("please summarise ...");
    expect(preview).toHaveLength(20);
  });

  it("leaves short prompts intact", () => {
    expect(makePromptPreview("  sadece a yaz ")).toBe("sadece a yaz");
  });
});

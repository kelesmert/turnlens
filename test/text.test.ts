import { describe, expect, it } from "vitest";
import { collapseWhitespace, makePromptPreview, truncate, truncateEnd } from "../src/core/text.js";

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

describe("truncateEnd", () => {
  it("leaves text that already fits", () => {
    expect(truncateEnd("short", 10)).toBe("short");
  });

  /**
   * Keeps the tail rather than the head, which is the opposite of `truncate`.
   *
   * A Codex session id is `2026/07/28/rollout-<timestamp>-<uuid>`, and the uuid
   * is the identifying part. Cutting from the right would leave the date, which
   * the listing already shows in its own column.
   */
  it("keeps the end and marks the cut", () => {
    expect(truncateEnd("2026/07/28/rollout-abc-def", 12)).toBe("...t-abc-def");
  });

  it("never returns more than the width it was given", () => {
    for (const width of [1, 2, 3, 4, 12, 40]) {
      expect(truncateEnd("a".repeat(80), width).length).toBe(width);
    }
  });

  it("returns nothing for a width of zero or less", () => {
    expect(truncateEnd("anything", 0)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { decidePromptPreview } from "../src/ui/prompts.js";

describe("decidePromptPreview", () => {
  it("asks when the user gave no flag and there is a terminal to ask in", () => {
    expect(decidePromptPreview({ enable: false, disable: false, interactive: true })).toBe("ask");
  });

  /**
   * Asking would consume a line of piped input that belongs to the session
   * selection, so a non-interactive run gets the safe answer without a question.
   */
  it("stays off without asking when stdin is not a terminal", () => {
    expect(decidePromptPreview({ enable: false, disable: false, interactive: false })).toBe(
      "disabled",
    );
  });

  it("honours an explicit flag instead of asking", () => {
    expect(decidePromptPreview({ enable: true, disable: false, interactive: true })).toBe("enabled");
    expect(decidePromptPreview({ enable: false, disable: true, interactive: true })).toBe(
      "disabled",
    );
  });

  it("still honours an explicit flag with no terminal present", () => {
    expect(decidePromptPreview({ enable: true, disable: false, interactive: false })).toBe(
      "enabled",
    );
  });

  // Guessing which flag the user meant could write prompt text to disk against
  // their intent, so contradicting flags are refused rather than resolved.
  it("refuses to guess when both flags are given", () => {
    expect(() => decidePromptPreview({ enable: true, disable: true, interactive: true })).toThrow(
      /both/iu,
    );
  });
});

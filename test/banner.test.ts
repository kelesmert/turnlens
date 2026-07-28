import { describe, expect, it } from "vitest";
import { formatSessionBanner } from "../src/ui/banner.js";
import type { SessionBanner } from "../src/ui/banner.js";

const LONG_PATH =
  "/home/someone/.claude/projects/-home-someone-Desktop-projects-turnlens/" +
  "e291f0eb-7b99-4825-9c15-87f6ef3b9036.jsonl";

function banner(overrides: Partial<SessionBanner> = {}): SessionBanner {
  return {
    sessionName: "Selam",
    sessionPath: LONG_PATH,
    csvPath: "/home/someone/turnlens-usage/claude-code/e291f0eb.csv",
    promptPreviews: true,
    pricing: "litellm@sha256:4c6858bb791b",
    offline: false,
    ...overrides,
  };
}

/** The rules are the first and last lines; everything between them is content. */
function rules(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => /^=+$/u.test(line));
}

describe("formatSessionBanner", () => {
  /**
   * The defect this exists for. The rule was a fixed 100 while a session path
   * ran to 125, so the block drew a box that its own contents broke out of --
   * the same defect the session listing had, in the block printed beside it.
   */
  it("draws its rule to the longest line it actually printed", () => {
    const lines = formatSessionBanner(banner(), undefined);
    const longest = Math.max(...lines.map((line) => line.length));

    for (const rule of rules(lines)) expect(rule).toHaveLength(longest);
  });

  it("never draws a rule wider than the terminal", () => {
    for (let width = 40; width <= 200; width += 1) {
      for (const rule of rules(formatSessionBanner(banner(), width))) {
        expect(rule.length).toBeLessThanOrEqual(width - 1);
      }
    }
  });

  /**
   * A path is what the user opens or greps for, so it is never shortened. It
   * may wrap in a narrow terminal, and a wrapped path is still copyable, which
   * a wrapped table row is not.
   */
  it("prints both paths in full however narrow the terminal", () => {
    for (const width of [40, 80, 120]) {
      const text = formatSessionBanner(banner(), width).join("\n");

      expect(text).toContain(LONG_PATH);
      expect(text).toContain("/home/someone/turnlens-usage/claude-code/e291f0eb.csv");
    }
  });

  it("reports what was decided about previews and pricing", () => {
    const on = formatSessionBanner(banner(), undefined).join("\n");
    const off = formatSessionBanner(banner({ promptPreviews: false, offline: true }), undefined);

    expect(on).toContain("enabled");
    expect(on).toContain("litellm@sha256:4c6858bb791b");
    expect(off.join("\n")).toContain("disabled");
    expect(off.join("\n")).toContain("(offline)");
  });

  it("tells the user how to stop", () => {
    expect(formatSessionBanner(banner(), undefined).join("\n")).toContain("Ctrl+C");
  });
});

import { describe, expect, it } from "vitest";
import { selectWidth, terminalWidth } from "../src/ui/terminal.js";

/** The two properties of a stream this module reads, and nothing else. */
function stream(options: { isTTY?: boolean; columns?: number }): NodeJS.WriteStream {
  return options as unknown as NodeJS.WriteStream;
}

describe("selectWidth", () => {
  /**
   * COLUMNS is how a user overrides a measurement that is right about the
   * window and wrong about what they want, so it has to outrank it.
   */
  it("prefers COLUMNS over the detected width", () => {
    expect(selectWidth("80", 174)).toBe(80);
  });

  it("falls back to the detected width when COLUMNS is unset", () => {
    expect(selectWidth(undefined, 174)).toBe(174);
  });

  it("ignores a COLUMNS that is not a number", () => {
    expect(selectWidth("wide", 174)).toBe(174);
  });

  /**
   * A zero arrives from a stream that has no window to report, and treating it
   * as a width would collapse the table to nothing.
   */
  it("ignores zero and negative widths from either source", () => {
    expect(selectWidth("0", 174)).toBe(174);
    expect(selectWidth("-20", 174)).toBe(174);
    expect(selectWidth(undefined, 0)).toBeUndefined();
    expect(selectWidth(undefined, -20)).toBeUndefined();
  });

  it("reports no width when neither source has one", () => {
    expect(selectWidth(undefined, undefined)).toBeUndefined();
  });

  it("truncates a fractional COLUMNS rather than rejecting it", () => {
    expect(selectWidth("100.7", 174)).toBe(100);
  });
});

describe("terminalWidth", () => {
  it("reports the width of a terminal", () => {
    expect(terminalWidth(stream({ isTTY: true, columns: 120 }), {})).toBe(120);
  });

  it("lets COLUMNS override the terminal's own width", () => {
    expect(terminalWidth(stream({ isTTY: true, columns: 120 }), { COLUMNS: "80" })).toBe(80);
  });

  /**
   * Output that is not going to a terminal is going to a pipe or a file, where
   * there is no width to fit and dropping columns would be silent data loss.
   */
  it("reports no width for a stream that is not a terminal", () => {
    expect(terminalWidth(stream({ isTTY: false, columns: 120 }), { COLUMNS: "80" })).toBeUndefined();
  });

  it("reports no width when a terminal reports none", () => {
    expect(terminalWidth(stream({ isTTY: true }), {})).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { COLOUR, PLAIN, selectPaint } from "../src/ui/colour.js";

const TTY = { isTTY: true } as NodeJS.WriteStream;
const PIPE = { isTTY: false } as NodeJS.WriteStream;

describe("selectPaint", () => {
  it("colours a terminal", () => {
    expect(selectPaint(TTY, {}, false)).toBe(COLOUR);
  });

  /**
   * A redirect writes into a file and a pipe hands text to another program.
   * Neither has anything to interpret an escape sequence.
   */
  it("does not colour a pipe or a redirect", () => {
    expect(selectPaint(PIPE, {}, false)).toBe(PLAIN);
  });

  /**
   * The convention is that any value means off, including an empty one, which is
   * what `NO_COLOR=` in a profile means. Testing for truthiness would colour for
   * exactly the users who asked not to be.
   */
  it("obeys NO_COLOR whatever it is set to", () => {
    for (const value of ["", "0", "false", "1"]) {
      expect(selectPaint(TTY, { NO_COLOR: value }, false), value).toBe(PLAIN);
    }
  });

  it("obeys the flag over everything else", () => {
    expect(selectPaint(TTY, {}, true)).toBe(PLAIN);
  });
});

describe("the palette", () => {
  /** Colour repeats what the text says. Stripping it must lose nothing. */
  it("leaves the text intact under every role", () => {
    const strip = (text: string): string => text.replaceAll(/\[[0-9;]*m/gu, "");

    for (const [role, paint] of Object.entries(COLOUR)) {
      expect(strip(paint("2026-08-03")), role).toBe("2026-08-03");
    }
  });

  /**
   * A wrapped empty string is not empty, and a table pads with empty cells. One
   * escape pair per blank cell is invisible until the output is pasted somewhere
   * that keeps it.
   */
  it("leaves an empty string empty rather than wrapping it", () => {
    for (const [role, paint] of Object.entries(COLOUR)) {
      expect(paint(""), role).toBe("");
    }
  });

  /** Only the basic eight and bold, so a light theme stays readable. */
  it("uses no colour outside the basic set", () => {
    const codes = Object.values(COLOUR).flatMap((paint) =>
      [...paint("x").matchAll(/\[([0-9;]*)m/gu)].map((match) => match[1]),
    );

    for (const code of codes) {
      expect(["0", "1", "2", "36", "33"], `unexpected code ${code}`).toContain(code);
    }
  });

  it("does nothing at all under PLAIN", () => {
    for (const paint of Object.values(PLAIN)) {
      expect(paint("2026-08-03")).toBe("2026-08-03");
    }
  });
});

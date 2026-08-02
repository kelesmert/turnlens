import { describe, expect, it } from "vitest";
import { parseBound, withinWindow } from "../src/report/window.js";

describe("parseBound", () => {
  it("accepts the hyphenated form TurnLens prints everywhere", () => {
    expect(parseBound("2026-07-01", "--since")).toBe("2026-07-01");
  });

  /**
   * Accepted because it is the spelling ccusage takes, and stripping hyphens is
   * one operation. Muscle memory carries over for no cost.
   */
  it("accepts the compact form ccusage takes", () => {
    expect(parseBound("20260701", "--since")).toBe("2026-07-01");
  });

  /**
   * Refused for now. A relative form is a second parser followed by a small
   * language: if 7d exists then 2w is expected, 1m has to decide where a month
   * starts, and "last week" has to decide which week.
   */
  it("refuses a relative form, naming the format it wants", () => {
    expect(() => parseBound("7d", "--since")).toThrow(/YYYY-MM-DD/u);
    expect(() => parseBound("2w", "--until")).toThrow(/YYYY-MM-DD/u);
  });

  it("refuses a date that does not exist", () => {
    expect(() => parseBound("2026-02-30", "--since")).toThrow();
    expect(() => parseBound("2026-13-01", "--since")).toThrow();
    expect(() => parseBound("2026-00-10", "--since")).toThrow();
  });

  it("accepts a leap day in a leap year and refuses it otherwise", () => {
    expect(parseBound("2028-02-29", "--since")).toBe("2028-02-29");
    expect(() => parseBound("2026-02-29", "--since")).toThrow();
  });

  it("refuses a partial date rather than guessing the rest of it", () => {
    expect(() => parseBound("2026", "--since")).toThrow();
    expect(() => parseBound("2026-07", "--since")).toThrow();
  });

  it("names the flag that was wrong, so the message points at the argument", () => {
    expect(() => parseBound("nope", "--until")).toThrow(/--until/u);
    expect(() => parseBound("nope", "--since")).toThrow(/--since/u);
  });
});

describe("withinWindow", () => {
  it("includes both bounds", () => {
    const window = { since: "2026-07-01", until: "2026-07-31" };

    expect(withinWindow("2026-07-01", window)).toBe(true);
    expect(withinWindow("2026-07-31", window)).toBe(true);
    expect(withinWindow("2026-06-30", window)).toBe(false);
    expect(withinWindow("2026-08-01", window)).toBe(false);
  });

  it("accepts everything when neither bound is given", () => {
    expect(withinWindow("1999-01-01", {})).toBe(true);
  });

  it("accepts an open-ended window at either end", () => {
    expect(withinWindow("2026-08-02", { since: "2026-07-01" })).toBe(true);
    expect(withinWindow("2026-06-02", { since: "2026-07-01" })).toBe(false);
    expect(withinWindow("2026-06-02", { until: "2026-07-01" })).toBe(true);
    expect(withinWindow("2026-08-02", { until: "2026-07-01" })).toBe(false);
  });

  it("holds a single day when both bounds name it", () => {
    const window = { since: "2026-07-15", until: "2026-07-15" };

    expect(withinWindow("2026-07-15", window)).toBe(true);
    expect(withinWindow("2026-07-14", window)).toBe(false);
    expect(withinWindow("2026-07-16", window)).toBe(false);
  });

  it("excludes everything when the bounds are the wrong way round", () => {
    // Not an error: it is a window with nothing in it, and a report over nothing
    // is a report whose coverage line says so.
    expect(withinWindow("2026-07-15", { since: "2026-08-01", until: "2026-07-01" })).toBe(false);
  });
});

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHome } from "../src/core/home.js";

describe("resolveHome", () => {
  it("uses HOME when it names somewhere", () => {
    expect(resolveHome({ HOME: "/home/someone" })).toBe("/home/someone");
  });

  it("falls back to the operating system when HOME is unset", () => {
    expect(resolveHome({})).toBe(homedir());
  });

  /**
   * The defect this module exists for.
   *
   * `HOME ?? homedir()` keeps an empty string, because `??` only rejects null
   * and undefined. Everything built on it then becomes relative, so TurnLens's
   * state lands in whatever directory the command happened to run in.
   */
  it("treats an empty HOME as unset rather than as a home directory", () => {
    expect(resolveHome({ HOME: "" })).toBe(homedir());
  });

  it("treats a whitespace-only HOME as unset", () => {
    expect(resolveHome({ HOME: "   " })).toBe(homedir());
  });

  it("always returns an absolute path", () => {
    expect(isAbsolute(resolveHome({ HOME: "" }))).toBe(true);
    expect(isAbsolute(resolveHome({}))).toBe(true);
  });
});

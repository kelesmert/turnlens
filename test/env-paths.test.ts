import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandTilde, pathListFromEnv } from "../src/core/env-paths.js";

const env = { HOME: "/home/someone" };

describe("expandTilde", () => {
  it("expands a bare tilde to the home directory", () => {
    expect(expandTilde("~", env)).toBe("/home/someone");
  });

  it("expands a tilde prefix", () => {
    expect(expandTilde("~/projects/work", env)).toBe(join("/home/someone", "projects/work"));
  });

  /**
   * Resolving another user's home needs a platform-specific account lookup, and
   * this design has no operating-system branch anywhere. Leaving the value alone
   * fails visibly -- the directory will not be found -- rather than silently
   * resolving to the wrong person's home.
   */
  it("leaves another user's tilde alone", () => {
    expect(expandTilde("~other/projects", env)).toBe("~other/projects");
  });

  it("leaves an absolute path alone", () => {
    expect(expandTilde("/var/data", env)).toBe("/var/data");
  });

  it("leaves a relative path alone", () => {
    expect(expandTilde("projects/work", env)).toBe("projects/work");
  });
});

describe("pathListFromEnv", () => {
  it("reports an unset variable as no paths at all", () => {
    expect(pathListFromEnv(undefined, env)).toEqual([]);
  });

  /**
   * Callers distinguish "not configured" from "configured to nothing" by length,
   * so a variable holding only separators has to arrive as empty rather than as
   * a list of blanks.
   */
  it("reports a variable of only whitespace or commas as no paths", () => {
    expect(pathListFromEnv("   ", env)).toEqual([]);
    expect(pathListFromEnv(",,,", env)).toEqual([]);
  });

  it("splits on commas and trims each entry", () => {
    expect(pathListFromEnv(" /a , /b ", env)).toEqual(["/a", "/b"]);
  });

  it("drops empty entries between separators", () => {
    expect(pathListFromEnv("/a,,/b", env)).toEqual(["/a", "/b"]);
  });

  it("collapses duplicates, keeping the first occurrence in place", () => {
    expect(pathListFromEnv("/b,/a,/b", env)).toEqual(["/b", "/a"]);
  });

  it("expands a tilde in every entry", () => {
    expect(pathListFromEnv("~/a,~/b", env)).toEqual([
      join("/home/someone", "a"),
      join("/home/someone", "b"),
    ]);
  });

  it("collapses entries that differ only before expansion", () => {
    expect(pathListFromEnv("~/a,/home/someone/a", env)).toEqual([join("/home/someone", "a")]);
  });

  /**
   * Deduplication compares directories, not spellings.
   *
   * Found on Windows, where the first assertion above failed: `~/a` expands
   * through `join` and comes back with backslashes, while a path the user typed
   * with forward slashes does not, so two names for one directory survived as
   * two roots. A doubled separator is the same defect in a form Linux can see.
   */
  it("collapses two spellings of one directory", () => {
    expect(pathListFromEnv("/home/someone//a,/home/someone/a", env)).toEqual([
      join("/home/someone", "a"),
    ]);
    expect(pathListFromEnv("/home/someone/b/,/home/someone/./b", env)).toEqual([
      join("/home/someone", "b"),
    ]);
  });
});

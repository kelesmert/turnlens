import { describe, expect, it } from "vitest";
import { isNewer } from "../src/update/version.js";

describe("isNewer", () => {
  it("recognises a greater patch, minor and major", () => {
    expect(isNewer("0.1.2", "0.1.1")).toBe(true);
    expect(isNewer("0.2.0", "0.1.1")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });

  it("is false for the same version", () => {
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  });

  it("is false for an older version, so a downgrade is never announced", () => {
    expect(isNewer("0.1.1", "0.2.0")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(false);
  });

  it("compares numerically, not as text", () => {
    // The case a string comparison gets wrong: "0.10.0" < "0.9.0" as text.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.100.0")).toBe(true);
  });

  it("ignores anything that is not exactly three numbers", () => {
    // Unrecognised means no notice, which is what keeps this free of a semver
    // dependency: the shapes it cannot judge, it declines to judge.
    expect(isNewer("v0.2.0", "0.1.1")).toBe(false);
    expect(isNewer("0.2.0-beta.1", "0.1.1")).toBe(false);
    expect(isNewer("0.2.0.1", "0.1.1")).toBe(false);
    expect(isNewer("0.2", "0.1.1")).toBe(false);
    expect(isNewer("", "0.1.1")).toBe(false);
    expect(isNewer("latest", "0.1.1")).toBe(false);
  });

  it("declines when the running version is the unreadable one", () => {
    expect(isNewer("0.2.0", "not-a-version")).toBe(false);
    expect(isNewer("0.2.0", "")).toBe(false);
  });

  it("rejects leading zeroes and whitespace rather than guessing", () => {
    expect(isNewer(" 0.2.0", "0.1.1")).toBe(false);
    expect(isNewer("0.2.0 ", "0.1.1")).toBe(false);
  });
});

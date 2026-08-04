import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSelfVersion } from "../src/update/self-version.js";

describe("resolveSelfVersion", () => {
  it("reports what package.json says, so a bump cannot be forgotten", () => {
    const declared = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
      .version;
    expect(resolveSelfVersion()).toBe(declared);
  });

  it("returns nothing rather than throwing when the file cannot be found", () => {
    expect(resolveSelfVersion("/nowhere/at/all/package.json")).toBeUndefined();
  });

  it("returns nothing when the file has no usable version", () => {
    expect(resolveSelfVersion("tsconfig.json")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs tests under strict ESM with node types available", () => {
    expect(typeof process.versions.node).toBe("string");
    expect(Number.parseInt(process.versions.node, 10)).toBeGreaterThanOrEqual(20);
  });
});

import { describe, expect, it } from "vitest";
import { toFiniteFloat, toFiniteInt } from "../src/core/numbers.js";

describe("toFiniteInt", () => {
  it("returns the fallback for values that are not finite numbers", () => {
    expect(toFiniteInt(null, 0)).toBe(0);
    expect(toFiniteInt(undefined, 7)).toBe(7);
    expect(toFiniteInt("nope", 0)).toBe(0);
    expect(toFiniteInt(Number.NaN, 3)).toBe(3);
    expect(toFiniteInt(Number.POSITIVE_INFINITY, 3)).toBe(3);
  });

  it("rejects booleans instead of coercing them to 0 or 1", () => {
    expect(toFiniteInt(true, 5)).toBe(5);
    expect(toFiniteInt(false, 5)).toBe(5);
  });

  it("accepts numeric strings and truncates fractions toward zero", () => {
    expect(toFiniteInt("42", 0)).toBe(42);
    expect(toFiniteInt(9.7, 0)).toBe(9);
    expect(toFiniteInt(-9.7, 0)).toBe(-9);
  });

  it("returns undefined when no fallback is given", () => {
    expect(toFiniteInt("nope")).toBeUndefined();
    expect(toFiniteInt(12)).toBe(12);
  });
});

describe("toFiniteFloat", () => {
  it("returns undefined for unusable values and the number otherwise", () => {
    expect(toFiniteFloat(null)).toBeUndefined();
    expect(toFiniteFloat(true)).toBeUndefined();
    expect(toFiniteFloat("73.0")).toBe(73);
    expect(toFiniteFloat(0.5)).toBe(0.5);
  });

  it("ignores whitespace-only strings rather than reading them as zero", () => {
    expect(toFiniteFloat("")).toBeUndefined();
    expect(toFiniteFloat("   ")).toBeUndefined();
  });
});

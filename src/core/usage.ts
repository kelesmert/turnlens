import type { TokenUsage } from "./types.js";

const USAGE_FIELDS = [
  "inputUncached",
  "cacheRead",
  "cacheCreation5m",
  "cacheCreation1h",
  "output",
  "reasoning",
  "total",
] as const satisfies readonly (keyof TokenUsage)[];

export function emptyUsage(): TokenUsage {
  return {
    inputUncached: 0,
    cacheRead: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return mapFields((field) => a[field] + b[field]);
}

/**
 * Field-by-field difference with each field clamped at zero independently.
 *
 * Clamping per field matters because a provider may revise one counter downward
 * while others grow; a single negative field must not corrupt the rest.
 */
export function subtractUsageClamped(current: TokenUsage, baseline: TokenUsage): TokenUsage {
  return mapFields((field) => Math.max(current[field] - baseline[field], 0));
}

/** Fails loudly when a discriminated union gains a variant nobody handled. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function mapFields(compute: (field: keyof TokenUsage) => number): TokenUsage {
  const result = emptyUsage() as { -readonly [K in keyof TokenUsage]: number };
  for (const field of USAGE_FIELDS) result[field] = compute(field);
  return result;
}

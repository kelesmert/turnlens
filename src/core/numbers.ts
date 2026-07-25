/**
 * Converts an untrusted value to a finite integer, truncating toward zero.
 *
 * Session records are parsed JSON, so any field may hold a type the schema did
 * not promise. Returns the fallback when the value cannot be read as a number.
 */
export function toFiniteInt(value: unknown, fallback: number): number;
export function toFiniteInt(value: unknown): number | undefined;
export function toFiniteInt(value: unknown, fallback?: number): number | undefined {
  const parsed = toFiniteFloat(value);
  return parsed === undefined ? fallback : Math.trunc(parsed);
}

/**
 * Converts an untrusted value to a finite number.
 *
 * Booleans are rejected rather than coerced, because a payload carrying `true`
 * where a count belongs would otherwise be recorded as the fabricated value 1.
 */
export function toFiniteFloat(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

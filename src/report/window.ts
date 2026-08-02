/** An inclusive range of local days. An absent bound is open ended. */
export interface Window {
  readonly since?: string;
  readonly until?: string;
}

const COMPACT_LENGTH = "YYYYMMDD".length;

/**
 * Normalises a bound to `YYYY-MM-DD`, or throws naming the flag and the format.
 *
 * Two spellings are accepted, the hyphenated one TurnLens prints everywhere and
 * the compact one ccusage takes. Relative forms such as `7d` are refused: they
 * are a second parser followed by a small language, since `7d` implies `2w`, and
 * `1m` has to decide where a month begins. A date format is settled once and
 * relative forms can be built on top of it later.
 */
export function parseBound(value: string, flag: "--since" | "--until"): string {
  const digits = value.trim().replaceAll("-", "");

  if (!/^\d{8}$/u.test(digits)) throw badBound(value, flag);

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));

  // Round-tripped rather than range-checked, so 31 February is refused by the
  // calendar instead of by a table of month lengths that has to know about leap
  // years.
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTripped =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!roundTripped) throw badBound(value, flag);

  return date.toISOString().slice(0, "YYYY-MM-DD".length);
}

/**
 * Whether a local day falls inside the window. Both bounds are inclusive.
 *
 * Compared as text, which is chronological for `YYYY-MM-DD` and needs no clock.
 * Bounds the wrong way round hold nothing rather than erroring: an empty window
 * is a report whose coverage line says it found nothing, which is a truthful
 * answer to a question nobody meant to ask.
 */
export function withinWindow(localDay: string, window: Window): boolean {
  if (window.since !== undefined && localDay < window.since) return false;
  if (window.until !== undefined && localDay > window.until) return false;
  return true;
}

function badBound(value: string, flag: "--since" | "--until"): Error {
  return new Error(
    `${flag} takes a date: ${value} is not one.\n` +
      `Write it as YYYY-MM-DD, for example ${flag} 2026-07-01. ` +
      `${COMPACT_LENGTH} digits without hyphens also work.`,
  );
}

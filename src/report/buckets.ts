import type { Grouping } from "../options.js";

/** Grouping words that put a turn in a period. `session` is not one of them. */
export type PeriodGrouping = Exclude<Grouping, "session">;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Which timezone every bucket is computed in.
 *
 * Local, not UTC. A user asking what they spent today means their own today, and
 * bucketing by UTC moves an evening's work onto the next day. The cost accepted
 * is that two machines in different zones produce different tables from the same
 * transcripts; `TZ` is what makes either available, and the report prints the
 * zone it used so the difference is never a mystery.
 *
 * `env` is a parameter rather than a read of `process.env` so a test can ask for
 * a zone the test machine is not in. That is the rule `src/options.ts` follows.
 */
export function resolveTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["TZ"];
  if (configured !== undefined && configured.trim() !== "") return configured.trim();

  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The local calendar date of an instant, as `YYYY-MM-DD`.
 *
 * Built from `formatToParts` rather than arithmetic on the epoch, because the
 * offset to apply is a property of the zone at that instant and not a constant.
 * Not `toLocaleDateString`, whose output order depends on a locale.
 */
export function localDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The label a turn falls under, for a grouping that is a period.
 *
 * Every label sorts chronologically as plain text, which is why a week is
 * labelled by its Monday's date rather than by a week number. ISO week numbers
 * disagree with the calendar year at both ends of it, so `2027-W01` can contain
 * days in 2026 and cannot be ordered against `2026-12`.
 */
export function bucketLabel(at: string, grouping: PeriodGrouping, timeZone: string): string {
  const day = localDate(at, timeZone);

  switch (grouping) {
    case "daily":
      return day;
    case "weekly":
      return mondayOf(day);
    case "monthly":
      return day.slice(0, "YYYY-MM".length);
  }
}

/**
 * The Monday of the week containing a local `YYYY-MM-DD`.
 *
 * Weeks start on Monday, ISO 8601, and there is no flag for it. ccusage defaults
 * to Sunday and offers `--start-of-week`; the difference is deliberate. A second
 * source of machine-dependent output was not worth the option, given the
 * timezone is already one.
 *
 * Arithmetic on `Date.UTC` is safe here because `day` is already a set of
 * calendar parts with no zone left to apply. Shifting it by whole days cannot
 * cross an offset change, which is the trap this would fall into if it operated
 * on the original instant.
 */
function mondayOf(day: string): string {
  const midnightUtc = Date.parse(`${day}T00:00:00.000Z`);
  // getUTCDay: 0 is Sunday, so Sunday is six days after its Monday.
  const weekday = new Date(midnightUtc).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;

  return new Date(midnightUtc - daysSinceMonday * MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, "YYYY-MM-DD".length);
}

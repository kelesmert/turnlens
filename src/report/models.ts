/**
 * Display names for the models a report covers.
 *
 * A report's `Models` column is the widest thing in the table that is not a
 * number, and the identifiers it prints carry two parts a reader does not need:
 * the vendor that is already implied by the agent column, and the release date
 * that only distinguishes models nobody is comparing. `claude-haiku-4-5-20251001`
 * is twenty-five characters to say `haiku-4-5`.
 *
 * Shortening is a display concern and lives here rather than in the pipeline.
 * `formatReportJson` serialises `ReportData` directly, so a name shortened at
 * render time leaves the full identifier in the JSON, which is where a consumer
 * that cares about the exact release will look.
 */

/** Anthropic's prefix, dropped because the agent column already says whose it is. */
const VENDOR_PREFIX = "claude-";

/**
 * A trailing release date, exactly eight digits behind a hyphen.
 *
 * Anchored and counted rather than "digits at the end": `claude-opus-2026` ends
 * in digits that are part of the name, and cutting them would rename the model.
 */
const RELEASE_DATE = /-\d{8}$/u;

/**
 * Display names keyed by full identifier, for every model in one report.
 *
 * **Shortening is abandoned for the whole report if any two identifiers would
 * shorten alike.** This is the only way shortening can be wrong, and it is the
 * expensive way: a cost tool that prints two models under one name has produced
 * a figure nobody can check. Reverting the report rather than the clashing pair
 * keeps one column to one naming scheme, so a reader never has to work out why
 * two rows are spelled differently.
 *
 * Takes every identifier at once rather than one at a time, because a collision
 * is a property of the set and cannot be seen from a single name.
 */
export function shortenModelNames(ids: Iterable<string>): ReadonlyMap<string, string> {
  const full = [...new Set(ids)];
  const shortened = new Map(full.map((id) => [id, shorten(id)]));

  return collides(shortened) ? new Map(full.map((id) => [id, id])) : shortened;
}

/** Whether two identifiers share a display name, which makes the column a lie. */
function collides(names: ReadonlyMap<string, string>): boolean {
  return new Set(names.values()).size !== names.size;
}

/**
 * One identifier's display name.
 *
 * Codex identifiers are returned whole. Stripping their `gpt-` would leave
 * `5.6-terra`, which reads worse than what it replaced: `haiku-4-5` still names
 * a model, `5.6-terra` names a version of nothing. The asymmetry is deliberate
 * and it is the readable choice rather than the consistent one.
 */
function shorten(id: string): string {
  const undated = id.replace(RELEASE_DATE, "");
  const named = undated.startsWith(VENDOR_PREFIX)
    ? undated.slice(VENDOR_PREFIX.length)
    : undated;

  // A name that shortened away is not a name. `claude-` alone would leave an
  // empty cell where a model belongs, which reads as missing data rather than
  // as a short name.
  return named === "" ? id : named;
}

import { collapseWhitespace } from "../core/text.js";

/** Anthropic aliases carry a YYYYMMDD suffix; other digits are version numbers. */
const DATE_SUFFIX_PATTERN = /-\d{8}$/u;

/**
 * Names to try, in order, when looking up rates for a recorded model.
 *
 * Only two transformations are applied, both reversible and both observed in
 * real model identifiers: dropping an eight-digit date suffix, and dropping one
 * leading `provider/` segment. Nothing here shortens a name at a hyphen: that
 * would turn `gpt-5.6-sol` into `gpt-5.6`, which is a different model at a
 * different price, and the resulting row would look perfectly normal.
 */
export function modelNameCandidates(model: string): readonly string[] {
  const recorded = collapseWhitespace(model);
  if (recorded === "") return [];

  const withoutPrefix = stripSingleProviderPrefix(recorded);
  const bases = withoutPrefix === recorded ? [recorded] : [recorded, withoutPrefix];

  const candidates: string[] = [];
  for (const base of bases) push(candidates, base);
  for (const base of bases) push(candidates, base.replace(DATE_SUFFIX_PATTERN, ""));
  return candidates;
}

function stripSingleProviderPrefix(model: string): string {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return model;
  return model.slice(separator + 1);
}

function push(candidates: string[], candidate: string): void {
  if (candidate !== "" && !candidates.includes(candidate)) candidates.push(candidate);
}

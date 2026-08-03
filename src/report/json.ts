import type { ReportData } from "./collect.js";

/**
 * The report as machine-readable output.
 *
 * The shape mirrors the types rather than inventing a wire format, because the
 * two would drift and only one of them is checked by the compiler.
 *
 * **A bucket with no cost omits `costUsd`.** `JSON.stringify` already drops an
 * absent property, so the requirement is only that nothing on the way here sets
 * one to `null`. This is the same rule the CSV follows and for the same reason: a
 * consumer summing the field must not read a missing price as free, and `null`
 * invites exactly that. A cost that is genuinely zero is a different fact and is
 * kept.
 *
 * Two-space indentation and a trailing newline, so the output reads in a terminal
 * as well as it parses, and a shell prompt lands on its own line.
 */
export function formatReportJson(data: ReportData): string {
  return `${JSON.stringify(data, undefined, 2)}\n`;
}

/** What the startup block reports about the run that is beginning. */
export interface SessionBanner {
  readonly sessionName: string;
  readonly sessionPath: string;
  readonly csvPath: string;
  readonly promptPreviews: boolean;
  readonly pricing: string;
  readonly offline: boolean;
}

const LABEL_WIDTH = 16;

/**
 * Renders the block printed once a session has been chosen.
 *
 * The rule is drawn to the longest line the block actually contains, never to a
 * fixed width. It used to be 100 characters while a session path ran to 125, so
 * the block drew a box its own contents broke out of -- the same defect the
 * session listing had, in the block printed beside it.
 *
 * Nothing here is shortened to fit. A path is what the user opens or greps for,
 * and a truncated one is useless; in a terminal too narrow for it the line
 * wraps, and a wrapped path can still be copied, which a wrapped table row
 * cannot. Only the rule answers to the terminal, because a rule that runs past
 * the window is the thing that reads as damage.
 */
export function formatSessionBanner(
  banner: SessionBanner,
  availableWidth: number | undefined,
): readonly string[] {
  const content = [
    entry("Session name", banner.sessionName),
    entry("Session file", banner.sessionPath),
    entry("CSV file", banner.csvPath),
    entry("Prompt previews", banner.promptPreviews ? "enabled" : "disabled"),
    entry("Pricing", `${banner.pricing}${banner.offline ? " (offline)" : ""}`),
    entry("Stop monitoring", "Ctrl+C"),
  ];

  const longest = Math.max(...content.map((line) => line.length));
  const ceiling =
    availableWidth === undefined ? Number.POSITIVE_INFINITY : availableWidth - RULE_RESERVE;
  const rule = "=".repeat(Math.max(Math.min(longest, ceiling), 1));

  return ["", rule, ...content, rule, ""];
}

/**
 * One column of the terminal is left unused, for the reason the table leaves
 * one: a line filling the last column is recorded as continuing into the next,
 * and widening the window afterwards re-flows the two together.
 */
const RULE_RESERVE = 1;

function entry(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}: ${value}`;
}

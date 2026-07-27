/** Prompt previews are capped hard because they are written to disk. */
export const PROMPT_PREVIEW_MAX_CHARS = 20;

/** Collapses all whitespace runs to single spaces and trims. Non-strings become "". */
export function collapseWhitespace(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(/\s+/u)
    .filter((part) => part !== "")
    .join(" ");
}

/** Shortens text to at most `width` characters, using a trailing "..." when it fits. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

/**
 * Shortens from the front, keeping the end.
 *
 * The opposite of `truncate`, and it exists for identifiers. A Codex session id
 * is `<year>/<month>/<day>/rollout-<timestamp>-<uuid>`; the uuid identifies it
 * and the date is already shown in its own column, so cutting from the right
 * would discard the only part worth reading.
 */
export function truncateEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(text.length - width);
  return `...${text.slice(text.length - (width - 3))}`;
}

/**
 * Builds the stored form of a user prompt.
 *
 * Collapsing newlines keeps a CSV row on one line; the length cap limits how
 * much of a potentially sensitive prompt reaches disk.
 */
export function makePromptPreview(text: string): string {
  return truncate(collapseWhitespace(text), PROMPT_PREVIEW_MAX_CHARS);
}

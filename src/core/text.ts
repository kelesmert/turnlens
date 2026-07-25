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
 * Builds the stored form of a user prompt.
 *
 * Collapsing newlines keeps a CSV row on one line; the length cap limits how
 * much of a potentially sensitive prompt reaches disk.
 */
export function makePromptPreview(text: string): string {
  return truncate(collapseWhitespace(text), PROMPT_PREVIEW_MAX_CHARS);
}

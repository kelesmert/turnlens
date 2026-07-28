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
  if (width <= 3) return headFitting(text, width);
  return `${headFitting(text, width - 3)}...`;
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
  if (width <= 3) return tailFitting(text, width);
  return `...${tailFitting(text, width - 3)}`;
}

/**
 * Breaks a line at spaces so it fits a width.
 *
 * Returned as lines rather than one string carrying newlines, because every
 * caller writes a line at a time and a "line" containing a newline is what the
 * table format is careful never to produce. A single word longer than the width
 * is emitted whole rather than cut: these are tool names and model identifiers,
 * and a broken one is worse than a long one.
 */
export function wrapWords(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);

  return lines;
}

/**
 * Splits text the way a reader sees it, not the way it is stored.
 *
 * A width is counted in UTF-16 code units, and a character need not be one of
 * them: an emoji is two, a family emoji is eight, and a letter carrying a
 * combining accent is two. Cutting at an arbitrary count lands between the
 * halves of one character, and the half that survives is not a character at
 * all -- terminals draw a replacement glyph, and with previews enabled the
 * broken half reaches the CSV.
 *
 * So the cut moves to the nearest boundary below the budget. The result can
 * therefore be shorter than the width asked for, which is the correct trade:
 * the column has a character of slack, rather than a character of rubble.
 *
 * `Intl.Segmenter` is built into Node and implements the Unicode boundary
 * rules, so no dependency is added and no table is maintained here.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The longest whole-character prefix that fits the budget. */
function headFitting(text: string, budget: number): string {
  let taken = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (taken + segment.length > budget) break;
    taken += segment.length;
  }
  return text.slice(0, taken);
}

/** The longest whole-character suffix that fits the budget. */
function tailFitting(text: string, budget: number): string {
  const segments = [...GRAPHEMES.segment(text)];

  let taken = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const length = segments[index]?.segment.length ?? 0;
    if (taken + length > budget) break;
    taken += length;
  }
  return text.slice(text.length - taken);
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

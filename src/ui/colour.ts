/**
 * Colour, as four roles rather than a palette.
 *
 * A caller asks for `attention` and never for yellow, so the one place that
 * decides what yellow means is here. The rule the roles enforce is that **colour
 * only ever repeats something the text already says**: strip every escape and no
 * information is lost, which is what makes turning it off safe rather than a
 * degraded mode.
 *
 * Applied to whole lines or to already-padded cells, never to a value before it
 * is fitted. An escape sequence lengthens a string without occupying a terminal
 * cell, so measuring a coloured string is how a table comes out ragged.
 */
export interface Paint {
  /** Column headings. What the table is, rather than what it says. */
  readonly heading: (text: string) => string;
  /** Rules and borders. Present, and meant to recede behind the figures. */
  readonly chrome: (text: string) => string;
  /** Something the reader should not miss: an unpriced turn, an aborted one. */
  readonly attention: (text: string) => string;
  /** A total, or the line naming the report. */
  readonly emphasis: (text: string) => string;
}

/** Every role a no-op. The default everywhere, so plain output is never a branch. */
export const PLAIN: Paint = {
  heading: (text) => text,
  chrome: (text) => text,
  attention: (text) => text,
  emphasis: (text) => text,
};

/**
 * The eight-colour set, and nothing beyond it.
 *
 * 256-colour and true-colour palettes let a theme be chosen precisely and then
 * washed out by the reader's own background: a mid grey picked against black is
 * unreadable on white. The basic eight are remapped by the terminal to whatever
 * its theme uses, so they stay legible in both directions.
 *
 * Bold is an attribute rather than a colour, so it survives a terminal that has
 * none.
 */
const RESET = "[0m";

function wrap(code: string): (text: string) => string {
  return (text) => (text === "" ? text : `${code}${text}${RESET}`);
}

export const COLOUR: Paint = {
  heading: wrap("[36m"),
  chrome: wrap("[2m"),
  attention: wrap("[33m"),
  emphasis: wrap("[1m"),
};

/**
 * Whether to colour at all.
 *
 * Three answers, in this order, and the first that applies wins.
 *
 * `--no-color` is the user saying so about this run. `NO_COLOR` is the
 * cross-tool convention: **any value at all, including an empty one, means
 * off**, which is what the specification says and what a `NO_COLOR=` in a
 * profile means. A stream that is not a terminal has nothing to interpret an
 * escape, so a redirect writes plain text into the file and a pipe hands plain
 * text to the next program.
 */
export function selectPaint(
  stream: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv,
  disabled: boolean,
): Paint {
  if (disabled) return PLAIN;
  if (env["NO_COLOR"] !== undefined) return PLAIN;
  return stream.isTTY === true ? COLOUR : PLAIN;
}

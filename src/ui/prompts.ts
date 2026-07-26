import { createInterface } from "node:readline/promises";

export type PromptPreviewChoice = "enabled" | "disabled" | "ask";

export interface PromptPreviewFlags {
  /** `--prompt-preview` was given. */
  readonly enable: boolean;
  /** `--no-prompt-preview` was given. */
  readonly disable: boolean;
  /** Whether there is a terminal to ask a question in. */
  readonly interactive: boolean;
}

/**
 * Decides whether prompt previews are on, off, or still to be asked about.
 *
 * Previews write part of the user's prompt to disk, so every path that is not an
 * explicit yes resolves to off. Only `stdin` decides whether asking is possible:
 * a piped stdin is feeding the session selection, and a question would eat a
 * line meant for it. Checking `stdout` as well is what made the Python version
 * misbehave under a pipe.
 */
export function decidePromptPreview(flags: PromptPreviewFlags): PromptPreviewChoice {
  if (flags.enable && flags.disable) {
    throw new Error(
      "Both --prompt-preview and --no-prompt-preview were given. Pass only one.",
    );
  }

  if (flags.enable) return "enabled";
  if (flags.disable) return "disabled";
  return flags.interactive ? "ask" : "disabled";
}

/**
 * Asks a yes-or-no question, defaulting to no.
 *
 * Anything other than `y` or `yes` is a no, including an empty line and an
 * unrecognised answer, so a mistyped response never turns a privacy-affecting
 * option on.
 */
export async function confirmYesNo(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N]: `);
    const normalised = answer.trim().toLowerCase();
    return normalised === "y" || normalised === "yes";
  } finally {
    readline.close();
  }
}

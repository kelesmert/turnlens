import { parseArgs } from "node:util";
import { toFiniteInt } from "./core/numbers.js";
import { PROVIDER_IDS, isProviderId } from "./providers/registry.js";
import { decidePromptPreview } from "./ui/prompts.js";
import type { SessionRef } from "./core/types.js";
import type { ProviderId } from "./providers/registry.js";
import type { PromptPreviewChoice } from "./ui/prompts.js";

/** Everything the CLI decides before it touches a session file. */
export interface CliOptions {
  readonly providerId: ProviderId;
  readonly previewChoice: PromptPreviewChoice;
  readonly offline: boolean;
  readonly refreshPricing: boolean;
  readonly help: boolean;
}

/** Whether there is a terminal to ask a question in. */
export interface CliEnvironment {
  readonly interactive: boolean;
}

/**
 * Turns raw arguments into a validated set of options.
 *
 * Pure by construction, and deliberately so. `argv` is a parameter rather than a
 * read of `process.argv`, and whether a terminal exists is a parameter rather
 * than a read of `process.stdin.isTTY`. Without the second one the piped-stdin
 * branch would be unreachable from a test, because a test process has no
 * terminal and could only ever exercise one side of that decision -- and that
 * branch is the one that keeps previews off when nobody can be asked.
 *
 * Every rejection happens here, before any session is listed. A run that cannot
 * start must fail while the user is still at the prompt, not after they have
 * chosen a session from a list.
 */
export function parseCliOptions(argv: readonly string[], env: CliEnvironment): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: "string", default: "codex" },
      // No defaults: an absent flag must stay distinguishable from an explicit
      // one, because absent means "ask" while explicit means "do not ask".
      "prompt-preview": { type: "boolean" },
      "no-prompt-preview": { type: "boolean" },
      offline: { type: "boolean", default: false },
      "refresh-pricing": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  // Returned before the other checks, so `--help` still explains the flags when
  // one of them is what the user got wrong. The remaining fields are the
  // defaults and are never read: the caller prints the help text and stops.
  if (values.help === true) {
    return {
      providerId: "codex",
      previewChoice: "disabled",
      offline: false,
      refreshPricing: false,
      help: true,
    };
  }

  const providerId = values.provider ?? "codex";
  if (!isProviderId(providerId)) {
    throw new Error(`Unknown provider: ${providerId}\nKnown providers: ${PROVIDER_IDS.join(", ")}`);
  }

  // Owns the both-preview-flags rejection, so that check is not repeated here.
  const previewChoice = decidePromptPreview({
    enable: values["prompt-preview"] === true,
    disable: values["no-prompt-preview"] === true,
    interactive: env.interactive,
  });

  const offline = values.offline === true;
  const refreshPricing = values["refresh-pricing"] === true;
  if (offline && refreshPricing) {
    throw new Error("Both --offline and --refresh-pricing were given. Pass only one.");
  }

  return { providerId, previewChoice, offline, refreshPricing, help: false };
}

/**
 * Resolves a typed answer to the session it names.
 *
 * Separated from the prompt because reading a line needs a terminal and
 * converting one does not, and the conversion is the half that can be wrong.
 *
 * `toFiniteInt` yields its fallback for anything it cannot parse, so an empty
 * line, a word and a negative number all arrive as 0 -- indistinguishable from a
 * deliberately typed 0 -- and 0 - 1 indexes nothing. Every one of them is
 * refused identically rather than starting a watch on something the user did not
 * choose. The message names the range instead of repeating the list, which is
 * still on screen directly above it.
 */
export function chooseSession(sessions: readonly SessionRef[], answer: string): SessionRef {
  const selected = sessions[toFiniteInt(answer.trim(), 0) - 1];
  if (selected === undefined) throw new Error(`Enter a number from 1 to ${sessions.length}.`);
  return selected;
}

/**
 * Which environment variables steer each provider's search.
 *
 * Listed here rather than on the adapter because they are message content: the
 * only reason TurnLens names them is to help someone reading a failure, and
 * nothing in the pipeline reads this.
 */
const SEARCH_VARIABLES: Readonly<Record<ProviderId, readonly string[]>> = {
  codex: ["CODEX_HOME"],
  "claude-code": ["CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"],
};

/**
 * Explains an empty session listing by naming where TurnLens looked.
 *
 * An empty listing has two causes that look identical from the outside: the
 * agent has never run on this machine, or it writes somewhere TurnLens is not
 * searching. The old message -- one sentence, no paths -- left a user unable to
 * tell those apart, and on a machine where a configuration variable is set to
 * the wrong place that is the whole diagnosis.
 *
 * An unset variable is reported as deliberately as a set one. "Not set" is what
 * tells someone their export never reached this process.
 */
export function describeMissingSessions(
  providerId: ProviderId,
  roots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const searched =
    roots.length === 0
      ? ["No directories were searched."]
      : ["Searched:", ...roots.map((root) => `  ${root}`)];

  const variables = SEARCH_VARIABLES[providerId].map((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "" ? `${name} is not set` : `${name}=${value}`;
  });

  return [`No ${providerId} session files were found.`, "", ...searched, "", ...variables].join(
    "\n",
  );
}

import { parseArgs } from "node:util";
import { toFiniteInt } from "./core/numbers.js";
import { AGENT_NAMES, resolveAgentName } from "./providers/registry.js";
import { decidePromptPreview } from "./ui/prompts.js";
import type { SessionRef } from "./core/types.js";
import type { ProviderId } from "./providers/registry.js";
import type { PromptPreviewChoice } from "./ui/prompts.js";

/**
 * How report rows are grouped, in the order `--help` lists them.
 *
 * Words rather than a `--by` flag. They read as what they are, a request for a
 * shape of report, and they compose: `session` followed by `daily` is one
 * session broken into its days.
 */
export const GROUPINGS = ["daily", "weekly", "monthly", "session"] as const;

export type Grouping = (typeof GROUPINGS)[number];

/** Which mode the command names. `report` means stop watching and count. */
export type CliMode = "watch" | "report";

/** Which of the three help texts the user asked for. */
export type HelpLevel = "root" | "agent" | "report";

/** Everything the CLI decides before it touches a session file. */
export interface CliOptions {
  readonly mode: CliMode;
  /**
   * Absent when the user named no agent.
   *
   * Watching then asks, because two sessions cannot be followed at once.
   * Reporting does not ask: it sums every agent.
   */
  readonly providerId?: ProviderId;
  readonly grouping: Grouping;
  /** One session and no other. A full id or a unique prefix. */
  readonly sessionIdQuery?: string;
  /** Set only for `session --id <id> daily`, the one two-word grouping built. */
  readonly sessionBreakdown?: "daily";
  readonly since?: string;
  readonly until?: string;
  readonly json: boolean;
  readonly compact: boolean;
  readonly previewChoice: PromptPreviewChoice;
  readonly offline: boolean;
  readonly refreshPricing: boolean;
  readonly help: boolean;
  readonly helpLevel: HelpLevel;
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
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      id: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean", default: false },
      compact: { type: "boolean", default: false },
      // No defaults: an absent flag must stay distinguishable from an explicit
      // one, because absent means "ask" while explicit means "do not ask".
      "prompt-preview": { type: "boolean" },
      "no-prompt-preview": { type: "boolean" },
      offline: { type: "boolean", default: false },
      "refresh-pricing": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const grammar = readPositionals(positionals, values.id !== undefined);

  // Returned before the other checks, so `--help` still explains the flags when
  // one of them is what the user got wrong. The remaining fields are the
  // defaults and are never read: the caller prints the help text and stops.
  // The level is not a default, though: it decides which text is printed, and
  // the positionals that name it are read above.
  if (values.help === true) {
    return {
      mode: grammar.mode,
      grouping: grammar.grouping,
      json: false,
      compact: false,
      previewChoice: "disabled",
      offline: false,
      refreshPricing: false,
      help: true,
      helpLevel: grammar.helpLevel,
    };
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

  // Named here rather than in `readPositionals` because these are flags, not
  // positionals, and the message a user needs says which mode they belong to.
  if (grammar.mode === "watch") {
    for (const [flag, given] of [
      ["--json", values.json === true],
      ["--compact", values.compact === true],
      ["--since", values.since !== undefined],
      ["--until", values.until !== undefined],
    ] as const) {
      if (given) throw new Error(`${flag} belongs to report mode. Try: turnlens claude report`);
    }
  }

  return {
    mode: grammar.mode,
    ...(grammar.providerId === undefined ? {} : { providerId: grammar.providerId }),
    grouping: grammar.grouping,
    ...(values.id === undefined ? {} : { sessionIdQuery: values.id }),
    ...(grammar.sessionBreakdown === undefined ? {} : { sessionBreakdown: grammar.sessionBreakdown }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(values.until === undefined ? {} : { until: values.until }),
    json: values.json === true,
    compact: values.compact === true,
    previewChoice,
    offline,
    refreshPricing,
    help: false,
    helpLevel: grammar.helpLevel,
  };
}

/** What the positional words said, before any flag is considered. */
interface Grammar {
  readonly mode: CliMode;
  readonly providerId?: ProviderId;
  readonly grouping: Grouping;
  readonly sessionBreakdown?: "daily";
  readonly helpLevel: HelpLevel;
}

/**
 * Reads the positional words: an optional agent, an optional `report`, then
 * grouping words.
 *
 * Separate from the flags because the two fail differently. A bad flag is a
 * spelling mistake; a bad word is a misunderstanding of the grammar, so every
 * rejection here names what was valid at that position rather than only what
 * was wrong.
 *
 * `hasId` is a parameter rather than a second read of the flags, because two of
 * these rules depend on it: `--id` requires the word `session`, and the two-word
 * grouping is only built filtered.
 */
function readPositionals(positionals: readonly string[], hasId: boolean): Grammar {
  const words = [...positionals];

  let providerId: ProviderId | undefined;
  const first = words[0];
  if (first !== undefined) {
    const resolved = resolveAgentName(first);
    if (resolved !== undefined) {
      providerId = resolved;
      words.shift();
    }
  }

  const mode: CliMode = words[0] === "report" ? "report" : "watch";
  if (mode === "report") words.shift();

  // A word left over in watch mode is either an unknown agent, when nothing was
  // consumed at all, or a grouping asked for without `report`. Those are
  // different mistakes and deserve different sentences.
  if (mode === "watch" && words.length > 0) {
    const remaining = String(words[0]);
    if (providerId === undefined) {
      throw new Error(
        `Unknown agent: ${remaining}\nKnown agents: ${AGENT_NAMES.join(", ")}\n` +
          `Did you mean a report? Try: turnlens ${AGENT_NAMES[0]} report ${remaining}`,
      );
    }
    throw new Error(
      `${remaining} groups a report, so it needs the word report before it.\n` +
        `Try: turnlens ${first} report ${remaining}`,
    );
  }

  const helpLevel: HelpLevel =
    mode === "report" ? "report" : providerId === undefined ? "root" : "agent";
  const base = { mode, ...(providerId === undefined ? {} : { providerId }), helpLevel } as const;

  if (words.length === 0) {
    requireSessionWord(mode, hasId, "daily");
    return { ...base, grouping: "daily" };
  }

  const grouping = readGrouping(words[0]);
  if (words.length === 1) {
    requireSessionWord(mode, hasId, grouping);
    return { ...base, grouping };
  }

  // Only one composition is built. Unfiltered, every session broken into days is
  // an indented tree with no bound on its rows, so it is refused by naming the
  // flag that makes it a flat table of one session's days.
  if (words.length === 2 && grouping === "session" && words[1] === "daily") {
    if (!hasId) {
      throw new Error(
        "report session daily needs --id, because unfiltered it is every session " +
          "broken into days.\nTry: turnlens claude report session --id <id> daily",
      );
    }
    return { ...base, grouping, sessionBreakdown: "daily" };
  }

  throw new Error(
    `Cannot group by ${words.join(" then ")}.\n` +
      "One grouping word, or session then daily with --id.",
  );
}

/**
 * Refuses `--id` in a report that is not grouped by session.
 *
 * `--id` always travels with the word `session`, so one spelling carries one
 * meaning: the word says which table is being asked for and the flag says which
 * of its rows to keep. Without the rule, an id would have to imply a grouping,
 * and `report --id <id>` would silently mean something the user never wrote.
 *
 * Watch mode is exempt. There is no table there, and `--id` is a selection.
 */
function requireSessionWord(mode: CliMode, hasId: boolean, grouping: Grouping): void {
  if (mode !== "report" || !hasId || grouping === "session") return;

  throw new Error(
    "--id names one session, so it goes with the word session.\n" +
      "Try: turnlens claude report session --id <id>",
  );
}

function readGrouping(word: string | undefined): Grouping {
  const grouping = GROUPINGS.find((candidate) => candidate === word);
  if (grouping === undefined) {
    throw new Error(`Unknown grouping: ${String(word)}\nKnown groupings: ${GROUPINGS.join(", ")}`);
  }
  return grouping;
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

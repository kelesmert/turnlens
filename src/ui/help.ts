import { GROUPINGS } from "../options.js";
import { AGENT_NAMES } from "../providers/registry.js";
import type { HelpLevel } from "../options.js";

/**
 * The help text for the level the user asked at.
 *
 * Three texts rather than one, because the surface has three levels and a single
 * page listing every flag makes the reader find their own. `turnlens --help`
 * answers which agents and commands exist, `turnlens claude --help` answers what
 * watching takes, and `turnlens claude report --help` answers what a report takes.
 *
 * A pure function of the level, so every text is reachable from a test. The
 * alternative, a constant read at the point of printing, is how a help page ends
 * up describing a flag that was removed.
 */
export function formatHelp(level: HelpLevel): string {
  switch (level) {
    case "root":
      return `${ROOT.join("\n")}\n`;
    case "agent":
      return `${AGENT.join("\n")}\n`;
    case "report":
      return `${REPORT.join("\n")}\n`;
  }
}

const AGENTS = AGENT_NAMES.join(" | ");

const ROOT = [
  "turnlens - per-turn token and cost monitoring for AI coding agents",
  "",
  `Usage: turnlens [${AGENTS}] [report [${GROUPINGS.join(" | ")}]] [options]`,
  "",
  "Two modes.",
  "",
  "  turnlens claude            watch a session as it runs",
  "  turnlens claude report     count what has already been spent",
  "",
  "Naming no agent means different things in the two modes, deliberately.",
  "Watching asks which agent, because two sessions cannot be followed at once.",
  "A report does not ask: it covers every agent.",
  "",
  "  turnlens                   ask which agent, then list its sessions",
  "  turnlens report            every agent, grouped by day",
  "",
  `Agents: ${AGENTS}. \`claude-code\` is accepted for \`claude\`; they are the`,
  "same agent and reach the same place.",
  "",
  "  turnlens claude --help          what watching takes",
  "  turnlens claude report --help   what a report takes",
  "",
];

const AGENT = [
  "turnlens <agent> - watch one session as it runs",
  "",
  `Usage: turnlens [${AGENTS}] [--id <session>] [options]`,
  "",
  "Lists the agent's sessions, asks which one, then follows it. Each turn is",
  "priced as it closes and appended to a CSV in the working directory.",
  "",
  "  --id <session>       Skip the list. A full session id or a unique prefix.",
  "  --prompt-preview     Record a 20-character preview of each prompt.",
  "                       This writes part of your prompt to disk.",
  "  --no-prompt-preview  Never record prompt previews.",
  "  --offline            Price from local data only. Never access the network.",
  "  --refresh-pricing    Download the pricing list now, even if it looks current.",
  "  --help               Show this message",
  "",
  "With neither preview flag, you are asked once at startup and the answer",
  "defaults to no. Piped input is never asked, and previews stay off.",
  "",
  "On selection the turns the session already closed are priced once and shown",
  "as a summary above the table, at today's rates. The table itself fills only",
  "with turns that close while you watch, each carrying the rate in force when",
  "it closed.",
  "",
  "Session files are only ever read, never modified. Stop with Ctrl+C; a session",
  "summary is printed on exit.",
  "",
];

const REPORT = [
  "turnlens report - count what has already been spent",
  "",
  `Usage: turnlens [${AGENTS}] report [${GROUPINGS.join(" | ")}] [options]`,
  "",
  "Reads the agents' own transcripts, prices every turn at today's rates, and",
  "prints a total. Nothing is written and no session is followed.",
  "",
  "Groupings, one word after `report`:",
  "",
  "  daily      one row per day (the default)",
  "  weekly     one row per week, beginning Monday",
  "  monthly    one row per month",
  "  session    one row per session",
  "",
  "  --id <session>       One session only. A full id or a unique prefix.",
  "                       Goes with the word `session`.",
  "  --since <date>       Earliest day to include, YYYY-MM-DD. Inclusive.",
  "  --until <date>       Latest day to include, YYYY-MM-DD. Inclusive.",
  "  --json               Machine-readable output on stdout.",
  "  --compact            Fewer columns, whatever the terminal's width.",
  "  --offline            Price from local data only. Never access the network.",
  "  --refresh-pricing    Download the pricing list now, even if it looks current.",
  "  --help               Show this message",
  "",
  "  turnlens claude report session --id a3f2         that session's total",
  "  turnlens claude report session --id a3f2 daily   that session, day by day",
  "",
  "Days are your local days, and the report says which timezone it used. Every",
  "figure is priced at today's rates, so a report and a CSV recorded months ago",
  "can disagree: the CSV keeps the rate that was in force when each turn closed.",
  "",
  "Archived sessions are always counted. Their tokens were spent, and there is",
  "no option to leave them out of a total.",
  "",
];

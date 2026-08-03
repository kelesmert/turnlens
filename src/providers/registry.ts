import { createClaudeCodeAdapter } from "./claude-code/sessions.js";
import { createCodexAdapter } from "./codex/sessions.js";
import type { ProviderAdapter } from "../core/types.js";

export const PROVIDER_IDS = ["codex", "claude-code"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * The agent names a user types, in listing order.
 *
 * Deliberately not `PROVIDER_IDS`. An id is what the rest of the program calls
 * a provider and what reaches CSV filenames and lock paths; a name is what
 * somebody types at a prompt, and `claude` is shorter than `claude-code` for no
 * loss of meaning.
 */
export const AGENT_NAMES = ["claude", "codex"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/**
 * Every spelling accepted for an agent, and the one id each resolves to.
 *
 * `claude-code` is accepted alongside `claude` because it is the spelling that
 * appears in CSV filenames, in lock paths and in every message that names a
 * provider, so a user who has seen it will type it. The two are the same agent
 * and must reach the same place.
 */
const AGENT_SPELLINGS: Readonly<Record<string, ProviderId>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
};

/**
 * Resolves a typed agent name to the internal provider id.
 *
 * **This is the only place the two spellings differ.** After this call nothing
 * can tell which one was typed, and nothing downstream should be given the
 * chance to: no code past the parser branches on the name.
 */
export function resolveAgentName(value: string): ProviderId | undefined {
  return AGENT_SPELLINGS[value];
}

/** Narrows an untrusted CLI argument to a supported provider id. */
export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * How many sessions an agent has, opening none of them.
 *
 * A count, not a listing. Building a Claude Code listing reads the last 256 KB of
 * every transcript to recover its title, which is the wrong order of magnitude for
 * a number printed beside a prompt at startup. `listSessionPaths` walks
 * directories and stops there.
 */
export async function countSessions(id: ProviderId): Promise<number> {
  return (await getAdapter(id).listSessionPaths()).length;
}

export function getAdapter(id: ProviderId): ProviderAdapter {
  switch (id) {
    case "codex":
      return createCodexAdapter();
    case "claude-code":
      return createClaudeCodeAdapter();
    default: {
      // Exhaustiveness guard: adding a provider id without a case fails to compile.
      const unhandled: never = id;
      throw new Error(`Unknown provider: ${String(unhandled)}`);
    }
  }
}

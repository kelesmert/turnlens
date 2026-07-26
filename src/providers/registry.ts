import { createClaudeCodeAdapter } from "./claude-code/sessions.js";
import { createCodexAdapter } from "./codex/sessions.js";
import type { ProviderAdapter } from "../core/types.js";

export const PROVIDER_IDS = ["codex", "claude-code"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Narrows an untrusted CLI argument to a supported provider id. */
export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
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

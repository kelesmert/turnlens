// Type-only, and src/pricing/types.ts imports nothing of its own, so naming the
// status here does not couple the core pipeline to pricing behaviour.
import type { CostStatus } from "../pricing/types.js";

/**
 * Normalised token counts for one turn or one model step.
 *
 * The field set is the union of what supported providers report, so a provider
 * without a given concept reports 0 rather than omitting the field. `reasoning`
 * is a subset of `output` and is never added into `total` separately.
 */
export interface TokenUsage {
  readonly inputUncached: number;
  readonly cacheRead: number;
  /** Anthropic 5-minute ephemeral cache writes. Always 0 for Codex. */
  readonly cacheCreation5m: number;
  /** Anthropic 1-hour ephemeral cache writes, priced above the 5-minute tier. */
  readonly cacheCreation1h: number;
  /** Output tokens including reasoning. */
  readonly output: number;
  /** Reasoning tokens, a subset of `output`. */
  readonly reasoning: number;
  readonly total: number;
}

/**
 * Raw rate-limit values as reported by the agent.
 *
 * Informational only. TurnLens makes no claim about what quota these map to,
 * and window labels are derived from the reported minutes rather than assumed.
 */
export interface RateLimits {
  readonly primaryUsedPercent?: number;
  readonly primaryWindowMinutes?: number;
  readonly secondaryUsedPercent?: number;
  readonly secondaryWindowMinutes?: number;
}

/**
 * One meaningful thing that happened in a session, normalised across providers.
 *
 * Discriminated on `kind` so the assembler switches exhaustively: adding a
 * variant becomes a compile error rather than silently dropped data.
 */
export type ProviderEvent =
  | { readonly kind: "turnStart"; readonly at: string; readonly turnId?: string }
  | {
      readonly kind: "turnEnd";
      readonly at: string;
      readonly turnId?: string;
      readonly durationMs?: number;
    }
  | {
      readonly kind: "turnAbort";
      readonly at: string;
      readonly turnId?: string;
      readonly reason?: string;
      /** How long the turn ran before it was interrupted, when the provider says. */
      readonly durationMs?: number;
    }
  | {
      readonly kind: "usage";
      readonly at: string;
      readonly usage: TokenUsage;
      /** Set by per-event providers to suppress records the agent logged twice. */
      readonly dedupKey?: string;
      readonly rateLimits?: RateLimits;
    }
  | { readonly kind: "toolCall"; readonly at: string; readonly name: string; readonly callId?: string }
  | {
      readonly kind: "meta";
      readonly at: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
      readonly promptText?: string;
    }
  | { readonly kind: "boundary"; readonly at: string; readonly reason: "compacted" };

/**
 * How a turn ended.
 *
 * `aborted` exists because an interrupted turn still consumed tokens. Folding it
 * into the next turn bills work the user stopped to the question they asked
 * afterwards, which is the defect this distinction exists to prevent.
 */
export type TurnStatus = "completed" | "aborted" | "compacted";

/**
 * Whether a provider's counters are session-cumulative or per-event.
 *
 * Codex reports cumulative totals, so a turn is a delta. Claude Code reports
 * each message's own usage, so a turn is a sum.
 */
export type UsageModel = "cumulative" | "per-event";

export interface NormalizedTurn {
  readonly provider: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly turnNumber: number;
  readonly turnId: string;
  readonly status: TurnStatus;
  readonly at: string;
  readonly usage: TokenUsage;
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly promptPreview: string;
  /** Omitted unless `costStatus` is `priced`. Absent never means free. */
  readonly costUsd?: number;
  readonly costStatus: CostStatus;
  /** Which pricing document produced `costUsd`, so an old row stays explainable. */
  readonly pricingVersion: string;
  readonly durationMs?: number;
  readonly rateLimits?: RateLimits;
}

export interface SessionRef {
  readonly provider: string;
  /** Absolute path to the session file. Opened read-only and never modified. */
  readonly path: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly lastActivityMs: number;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly usageModel: UsageModel;
  /**
   * The directories `listSessions` searches.
   *
   * Reported so a failure can name them. An empty listing has two very
   * different causes -- the agent has never run, or it was configured to write
   * somewhere TurnLens is not looking -- and without these the message cannot
   * tell a user which one they have.
   */
  readonly roots: readonly string[];
  /** Sessions a user may choose to follow. Archived work is excluded. */
  listSessions(): Promise<readonly SessionRef[]>;
  /**
   * Every session a total must account for, archived work included.
   *
   * Two methods rather than one flag on the interface, because the two answers
   * are different facts rather than one fact filtered. A listing offered for
   * selection must contain only sessions that can still be followed; a total
   * that leaves out spent money is wrong. Codex archives by moving a file, so
   * these differ there. Claude Code archives without moving anything, so they
   * are the same call.
   */
  listSessionsForReport(): Promise<readonly SessionRef[]>;
  /**
   * Converts one raw session record into zero or more events.
   *
   * `record` is untrusted input. An unrecognised or malformed shape must return
   * an empty array so a provider format change degrades to missing data rather
   * than a crash or an invented number.
   */
  parseRecord(record: unknown): readonly ProviderEvent[];
}

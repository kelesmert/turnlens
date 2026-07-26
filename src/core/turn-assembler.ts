import { makePromptPreview } from "./text.js";
import { addUsage, assertNever, emptyUsage, subtractUsageClamped } from "./usage.js";
import type { ProviderEvent, RateLimits, TokenUsage, TurnStatus, UsageModel } from "./types.js";

export interface AssemblerOptions {
  readonly usageModel: UsageModel;
  readonly includePromptPreview: boolean;
  /** Cumulative usage already consumed before monitoring started. */
  readonly baseline?: TokenUsage;
}

export interface AssembledTurn {
  readonly status: TurnStatus;
  readonly turnId?: string;
  /** Timestamp of the event that closed the turn. */
  readonly at: string;
  readonly usage: TokenUsage;
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly promptPreview: string;
  readonly durationMs?: number;
  readonly rateLimits?: RateLimits;
}

interface CloseRequest {
  readonly status: TurnStatus;
  readonly at: string;
  readonly turnId?: string;
  readonly durationMs?: number;
}

/**
 * Converts a provider's event stream into completed turns.
 *
 * Pure and synchronous: no file access and no clock, so a recorded event
 * sequence always assembles into the same turns and the arithmetic can be
 * tested against literal numbers taken from real sessions.
 *
 * `turnAbort` and `boundary` are turn boundaries, not ignorable noise. Treating
 * an abort as noise once billed an interrupted turn's 121,334 tokens to the
 * next completed turn, measured in a real session.
 *
 * A boundary that consumed no tokens produces no turn but still advances the
 * baseline, so an empty turn is dropped without shifting later arithmetic.
 */
export class TurnAssembler {
  readonly #usageModel: UsageModel;
  readonly #includePromptPreview: boolean;

  #baseline: TokenUsage;
  #latest: TokenUsage;
  #pending: TokenUsage = emptyUsage();
  #rateLimits: RateLimits | undefined;
  #seenDedupKeys = new Set<string>();
  #seenCallKeys = new Set<string>();
  #toolCalls = new Map<string, number>();
  #turnId: string | undefined;
  #promptPreview = "";
  #model = "";
  #reasoningEffort = "";

  constructor(options: AssemblerOptions) {
    this.#usageModel = options.usageModel;
    this.#includePromptPreview = options.includePromptPreview;
    this.#baseline = options.baseline ?? emptyUsage();
    this.#latest = this.#baseline;
  }

  /** Cumulative usage consumed by all turns closed so far. */
  get baseline(): TokenUsage {
    return this.#baseline;
  }

  /** Feeds one event in. Returns a turn only when a boundary closed a non-empty one. */
  push(event: ProviderEvent): AssembledTurn | undefined {
    switch (event.kind) {
      case "turnStart":
        if (event.turnId !== undefined) this.#turnId = event.turnId;
        return undefined;

      case "meta":
        this.#applyMeta(event.model, event.reasoningEffort, event.promptText);
        return undefined;

      case "toolCall":
        this.#countToolCall(event.name, event.callId ?? `${event.at}|${event.name}`);
        return undefined;

      case "usage":
        this.#applyUsage(event.usage, event.dedupKey, event.rateLimits);
        return undefined;

      case "turnEnd":
        return this.#close({
          status: "completed",
          at: event.at,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        });

      case "turnAbort":
        return this.#close({
          status: "aborted",
          at: event.at,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        });

      case "boundary":
        return this.#close({ status: "compacted", at: event.at });

      default:
        return assertNever(event);
    }
  }

  #applyMeta(model?: string, reasoningEffort?: string, promptText?: string): void {
    if (model !== undefined && model !== "") this.#model = model;
    if (reasoningEffort !== undefined && reasoningEffort !== "") {
      this.#reasoningEffort = reasoningEffort;
    }
    if (this.#includePromptPreview && promptText !== undefined) {
      const preview = makePromptPreview(promptText);
      if (preview !== "") this.#promptPreview = preview;
    }
  }

  #countToolCall(name: string, callKey: string): void {
    if (this.#seenCallKeys.has(callKey)) return;
    this.#seenCallKeys.add(callKey);
    this.#toolCalls.set(name, (this.#toolCalls.get(name) ?? 0) + 1);
  }

  #applyUsage(usage: TokenUsage, dedupKey?: string, rateLimits?: RateLimits): void {
    if (dedupKey !== undefined) {
      if (this.#seenDedupKeys.has(dedupKey)) return;
      this.#seenDedupKeys.add(dedupKey);
    }

    if (this.#usageModel === "cumulative") this.#latest = usage;
    else this.#pending = addUsage(this.#pending, usage);

    if (rateLimits !== undefined) this.#rateLimits = rateLimits;
  }

  #close(request: CloseRequest): AssembledTurn | undefined {
    if (request.turnId !== undefined) this.#turnId = request.turnId;

    const usage =
      this.#usageModel === "cumulative"
        ? subtractUsageClamped(this.#latest, this.#baseline)
        : this.#pending;

    const turnId = this.#turnId;
    const rateLimits = this.#rateLimits;
    const toolCalls = Object.fromEntries(this.#toolCalls);
    const model = this.#model;
    const reasoningEffort = this.#reasoningEffort;
    const promptPreview = this.#promptPreview;

    this.#resetTurnState();

    if (usage.total <= 0) return undefined;

    return {
      status: request.status,
      at: request.at,
      usage,
      toolCalls,
      model,
      reasoningEffort,
      promptPreview,
      ...(turnId === undefined ? {} : { turnId }),
      ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
      ...(rateLimits === undefined ? {} : { rateLimits }),
    };
  }

  /**
   * Clears per-turn state and advances the cumulative baseline.
   *
   * `model` and `reasoningEffort` deliberately persist: Codex emits them once
   * per turn context, and a turn without a fresh value is still running the
   * same model. Dedup keys also persist, because a provider that logs a record
   * twice may repeat it across a boundary.
   */
  #resetTurnState(): void {
    this.#baseline = this.#latest;
    this.#pending = emptyUsage();
    this.#seenCallKeys.clear();
    this.#toolCalls = new Map();
    this.#turnId = undefined;
    this.#promptPreview = "";
    this.#rateLimits = undefined;
  }
}

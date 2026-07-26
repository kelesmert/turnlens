/**
 * Per-token rates in US dollars for one model.
 *
 * Only the rates TurnLens can attribute from a session file are modelled.
 * Priority, flex, batch, regional and long-context tier variants exist in the
 * source document and are deliberately absent: nothing in a session file says
 * which tier a request used, and a turn's token total is not one request's
 * context size, so choosing a tier would be a guess dressed as a number.
 */
export interface ModelPricing {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
  readonly cacheReadPerToken?: number;
  readonly cacheCreationPerToken?: number;
  /** Anthropic's one-hour ephemeral cache write tier, priced above the five-minute one. */
  readonly cacheCreation1hPerToken?: number;
}

/**
 * Why a turn has, or does not have, a cost.
 *
 * `model_unknown`: no pricing entry for the recorded model name.
 * `no_pricing_data`: an entry exists but lacks a rate for a component that has
 * non-zero usage, so any total would understate the truth.
 */
export type CostStatus = "priced" | "model_unknown" | "no_pricing_data";

export interface TurnCost {
  readonly status: CostStatus;
  /** Present only when `status` is `priced`. Never `0` as a stand-in for unknown. */
  readonly amountUsd?: number;
}

export interface PricingLookup {
  /** Omitted when the model is unknown to every layer. */
  readonly pricing?: ModelPricing;
  /** Provenance of this answer, recorded on every priced row. */
  readonly version: string;
}

export interface PricingResolver {
  /** Version of the newest layer in effect, for the run header. */
  readonly version: string;
  /**
   * Synchronous on purpose. Every layer is loaded before monitoring starts, so
   * pricing a turn is a map lookup and the watch loop never awaits the network.
   */
  lookup(model: string): PricingLookup;
}

/** One model's rates exactly as the source document spells them. */
export type RawPricingEntry = Readonly<Record<string, number>>;

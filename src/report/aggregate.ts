import { addUsage, emptyUsage } from "../core/usage.js";
import type { NormalizedTurn, TokenUsage } from "../core/types.js";

/** One row of a report: everything that fell under one label, summed. */
export interface Bucket {
  readonly label: string;
  /**
   * The identity a reader copies to name this row again, when it has one.
   *
   * Kept apart from the label because the label is truncatable and this is not. A
   * name cut short is still a recognisable name; an id cut short is a string that
   * resolves to nothing.
   */
  readonly id?: string;
  /** Set only when a report spans more than one agent, which turns on nesting. */
  readonly provider?: string;
  readonly turns: number;
  readonly usage: TokenUsage;
  /** Sorted and deduplicated, so the rendered cell is stable between runs. */
  readonly models: readonly string[];
  /**
   * Absent when no turn here could be priced. Absent never means free.
   *
   * A zero would join a spreadsheet sum and could not be told from a period that
   * genuinely cost nothing, which is why a turn that could not be priced is not
   * folded in as zero. A turn priced at zero is a different fact and is counted.
   */
  readonly costUsd?: number;
  readonly unpricedTurns: number;
  /** The latest turn timestamp here. Empty until a turn arrives. */
  readonly lastActivity: string;
}

export function emptyBucket(label: string): Bucket {
  return {
    label,
    turns: 0,
    usage: emptyUsage(),
    models: [],
    unpricedTurns: 0,
    lastActivity: "",
  };
}

/**
 * Folds one turn into a bucket, returning a new one.
 *
 * Pure: nothing here mutates its argument, so a caller can keep a running total
 * beside a per-agent one without the two interfering.
 */
export function addTurn(bucket: Bucket, turn: NormalizedTurn): Bucket {
  const priced = turn.costUsd !== undefined;

  return {
    ...bucket,
    turns: bucket.turns + 1,
    usage: addUsage(bucket.usage, turn.usage),
    models: withModel(bucket.models, turn.model),
    unpricedTurns: bucket.unpricedTurns + (priced ? 0 : 1),
    lastActivity: turn.at > bucket.lastActivity ? turn.at : bucket.lastActivity,
    ...sumCost(bucket.costUsd, turn.costUsd),
  };
}

/**
 * Combines buckets into one row under a new label.
 *
 * Used for the total row a nested report prints above its per-agent rows. It adds
 * up what the buckets already hold and reprices nothing, which is what keeps a
 * total consistent with the rows beneath it.
 */
export function mergeBuckets(buckets: readonly Bucket[], label: string): Bucket {
  return buckets.reduce<Bucket>(
    (total, bucket) => ({
      ...total,
      turns: total.turns + bucket.turns,
      usage: addUsage(total.usage, bucket.usage),
      models: bucket.models.reduce(withModel, total.models),
      unpricedTurns: total.unpricedTurns + bucket.unpricedTurns,
      lastActivity: bucket.lastActivity > total.lastActivity ? bucket.lastActivity : total.lastActivity,
      ...sumCost(total.costUsd, bucket.costUsd),
    }),
    emptyBucket(label),
  );
}

/**
 * Adds two costs, keeping absent distinct from zero.
 *
 * Returns an object to spread rather than a number, because the field has to
 * stay missing when neither side had a figure. `{ costUsd: undefined }` would
 * satisfy the type and defeat the point: a consumer checking `in` would see a
 * key, and `JSON.stringify` would be the only thing still telling the truth.
 */
function sumCost(
  left: number | undefined,
  right: number | undefined,
): { readonly costUsd?: number } {
  if (left === undefined && right === undefined) return {};
  return { costUsd: (left ?? 0) + (right ?? 0) };
}

function withModel(models: readonly string[], model: string): readonly string[] {
  if (model === "" || models.includes(model)) return models;
  return [...models, model].sort();
}

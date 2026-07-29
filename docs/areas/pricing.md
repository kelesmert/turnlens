---
purpose: How a closed turn becomes a dollar figure, and which rates are deliberately unused.
update-when: A pricing layer, a cost field, or the set of excluded rate tiers changes.
---

# Pricing

**Sections:** What it does · Invariants · Traps · Where the code lives · Decisions

## What it does

Every closed turn is priced in US dollars from LiteLLM's published rates. Three
layers apply in order, each overwriting the one before because each is newer:

1. the **embedded snapshot** (`src/pricing/snapshot.generated.ts`), 113 models
   filtered from the upstream document and shipped in the package, so a fresh
   install with no network still prices;
2. the **on-disk cache** at `~/.turnlens/pricing/`, whatever the last online run
   downloaded;
3. the **startup check**, skipped by `--offline`, which sends the cache's `ETag`
   as `If-None-Match` and normally learns that nothing changed.

## Invariants

- **All resolution happens before monitoring starts.** The resolver is built
  once, then `lookup` is synchronous, so pricing a turn is a map lookup and the
  loop tailing the session file never awaits the network. Nothing is fetched
  while a session is being watched.
- **Every failure falls through.** An unreachable source, a malformed document, a
  corrupt cache -- each drops to the layer beneath, bounded by a five-second
  timeout, with one informational line. A watch always starts.
- **`estimated_cost_usd` is empty, never `0`, when a turn cannot be priced**, and
  `cost_status` records why (`model_unknown` or `no_pricing_data`).
- **A closed turn is never repriced.** TurnLens writes a cost into the CSV when a
  turn closes and never revisits it.
- `pricing_version` is a **column**, not a run-level fact.
- `snapshot.generated.ts` is generated. Regenerate with `npm run pricing:snapshot`.

## Traps

- **Do not turn an unpriced cost into `0`.** An empty cell stays out of a
  spreadsheet sum; a zero silently joins it and is indistinguishable from a
  genuinely free turn. This looks like an omission and is a decision.
- **Do not make `pricing_version` a run-level field.** ccusage recomputes all
  history on every invocation, so a stale rate self-corrects there. TurnLens does
  not recompute, so the rate that paid for a row has to travel on that row.
- **Do not add an `await` inside the pricing path.** The synchronous `lookup` is
  what keeps the tail loop off the network. No test would catch this.
- **Long-context tier rates are deliberately unused.** A turn's input total is the
  sum over many requests, not one request's context size, so testing it against
  the 272,000-token threshold would misprice systematically. Priority, flex, batch
  and regional variants are excluded because nothing in a session file says which
  tier a request used.
- **Reasoning tokens must not be added to output again.** They are a subset of
  it. A regression test proves it by watching the fixture cost move from 0.038044
  to 0.041704 when they are.

## Where the code lives

```
src/pricing/resolver.ts            the three layers, built once
src/pricing/cost.ts                turn tokens -> dollars
src/pricing/fetch.ts               ETag / If-None-Match, five-second bound
src/pricing/cache.ts               ~/.turnlens/pricing/
src/pricing/litellm.ts             upstream document shape
src/pricing/model-names.ts         model id normalisation
src/pricing/snapshot.generated.ts  generated; do not edit
scripts/build-pricing-snapshot.mjs the generator
scripts/verify-costs.mjs           cross-check against ccusage
```

## Decisions

- Long-context, priority, flex, batch and regional tiers unused -- `DECISIONS.md`
- `models.dev` as a second pricing source rejected -- `DECISIONS.md`
- Empty rather than zero for an unpriced turn -- `DECISIONS.md`
- Cross-check results and the residual difference against ccusage -- `../VALIDATION.md`

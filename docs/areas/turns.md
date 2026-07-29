---
purpose: What a turn is, when it closes, and what carries on it.
update-when: Turn boundaries, turn status values, or usage accumulation change.
---

# Turns

**Sections:** What it does · Invariants · Traps · Where the code lives · Decisions

## What it does

`TurnAssembler` converts an event stream into turns. It is pure: no I/O, no
clock. Both usage models -- Codex's cumulative counter and Claude Code's
per-message absolute figures -- are implemented here rather than in an adapter,
so a provider only has to say which one applies.

A turn answers the question the session files do not: what did this single prompt
and its response cost.

## Invariants

- **A turn closes on `turnEnd`, `turnAbort` or `boundary`.** All three close it.
  An abort is not ignorable noise.
- Each closed turn carries a `status` of `completed`, `aborted` or `compacted`,
  so the distinction survives into the CSV.
- A turn that consumed nothing is dropped rather than recorded, while still
  advancing the baseline.
- Usage is guarded by `dedupKey` and tool calls by `callId`, so a record seen
  twice is counted once.
- **Turn-level tokens are never divided among tools by estimation.** Absent
  attribution stays absent.
- Reasoning tokens are a subset of output and are never billed twice.

## Traps

- **Treating an abort as noise is the worst confirmed defect of the Python
  prototype.** An interrupted turn's 121,334 tokens were billed to the next
  completed turn. The prototype's own write-up is kept locally under
  `docs/archive/` and is not part of the repository; the figure above is the part
  worth carrying.
- **Claude Code has no record type for an abort.** The signal is a marker written
  as user text, and there are **two** of them, differing only after the word
  "user":

  ```
  [Request interrupted by user]                 stopped while the agent replied
  [Request interrupted by user for tool use]    stopped mid tool call
  ```

  Matching the first as a complete bracketed string misses the second. That is
  what shipped: a turn interrupted during a WebSearch stayed open, and its 41,120
  tokens plus the WebSearch call were recorded against the next prompt. **The
  totals still agreed with ccusage**, so no arithmetic check could have found it
  -- only the question "which prompt cost this" was wrong. The marker is matched
  unterminated for this reason; do not tighten it.
- **Do not use `toolDenialKind` as the abort signal.** It was measured locally
  with three values: `user-rejected`, `permission-rule` and `automode-unavailable`.
  Only the first means the user stopped the agent; the other two are tools refused
  while the turn kept running, so treating the field as an abort would split turns
  that never ended.
- **Do not sum `message.usage.iterations`.** The array is present on every
  assistant record, always length one, always mirroring the record's own usage.
  Summing it would double every number.

## Where the code lives

```
src/core/turn-assembler.ts   the state machine, both usage models
src/core/usage.ts            token accumulation
src/core/types.ts            ProviderEvent, NormalizedTurn, status values
```

## Decisions

- Per-tool token attribution not carried over from the Python implementation --
  `DECISIONS.md`
- Advisor usage inside `iterations` deferred -- `DECISIONS.md`, `FUTURE.md` section 3
- Turn numbering after a resume -- `FUTURE.md` section 2

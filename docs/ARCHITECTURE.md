---
purpose: What TurnLens is for, what it must never do, and how the program is divided.
update-when: A quality goal, a constraint, or a structural boundary changes.
---

# TurnLens Architecture

**Sections:** Quality goals · Constraints · Solution strategy · Building blocks

TurnLens answers one question that agent session files do not answer directly:
**what did this single prompt and its response cost?**

This document holds the reasoning that spans the whole program. Anything specific
to one stage lives in `areas/`, every deliberate omission lives in `DECISIONS.md`,
and every figure lives in `VALIDATION.md`.

## Quality goals

In order. Where two conflict, the earlier one wins.

1. **Never damage what it reads.** Session files are opened read-only and never
   modified, moved or deleted. A test asserts the source file is byte-identical
   after a full run.
2. **Never invent a number.** An unpriced turn is empty rather than zero, absent
   tool attribution stays absent, rate-limit values are reported raw, and an
   unrecognised record produces no events rather than a guess. The failure
   direction is always undercounting, never invention.
3. **Attribute cost to the right prompt.** This is the product. A total that
   agrees with another tool while the per-turn split is wrong is still wrong, and
   no arithmetic check can find it.
4. **Always start.** Every pricing failure falls through to the layer beneath. A
   watch begins even with no network, a corrupt cache and a malformed document.
5. **Stay out of the way.** Two locations are written: the user's CSV under the
   working directory, and `~/.turnlens/` for locks and the pricing cache.

## Constraints

- **Zero runtime dependencies.** Development needs `typescript`, `vitest` and
  `@types/node`, nothing else. There is consequently no bundler: a bundler exists
  to collapse a dependency tree into one file, and there is no tree. `tsc` output
  ships as it is emitted.
- **TypeScript, ESM, and the Node floor set in `package.json`.**
- **No branching on the operating system.** Paths are built with `join`, widths
  come from `process.stdout.columns`, and the same code runs on all three
  platforms. Where a platform difference is real it is recorded in
  `VALIDATION.md` rather than coded around.
- **Nothing is fetched while a session is being watched.** All I/O that can block
  happens before monitoring starts.
- **Untrusted input everywhere.** `parseRecord` receives `unknown` and narrows
  with type guards. No `as` assertion is used to silence the compiler.

Two compiler settings look like exceptions and are not. `tsconfig.test.json`
exists so tests are type-checked too -- `npm run typecheck` points at it, while
the build config stays at `include: ["src"]` so `dist/` holds only shipped code.
`skipLibCheck: true` is set because Vite's shipped type declarations are
incompatible with `exactOptionalPropertyTypes` and importing `vitest` pulls them
in transitively; it suppresses checking of third-party `.d.ts` files only, and
project sources are never relaxed to silence an error.

## Solution strategy

```
session file  ->  tail  ->  adapter.parseRecord  ->  TurnAssembler  ->  store
                (bytes)         (events)              (turns)         (CSV)
```

**One direction, no revisiting.** A turn is priced when it closes and written
once. Nothing recomputes history, which is why the pricing version travels on the
row rather than on the run.

**An adapter layer is necessary, not decorative.** The two agents record usage in
fundamentally incompatible ways -- cumulative versus per-message absolute
counters, different turn boundaries, different cache categories, duplicate records
in one and none in the other. This was verified against real session files rather
than assumed. `ProviderAdapter.usageModel` names which behaviour applies and
`TurnAssembler` implements both, so **no turn logic lives in an adapter**.

**A trust boundary at the parser.** Every line of a session file is untrusted
input, and a format change by Codex or Anthropic must degrade to missing data
rather than a crash or a fabricated number.

**Pricing resolves once, then is a map lookup.** Three layers -- embedded
snapshot, on-disk cache, startup ETag check -- each overwriting the one before
because each is newer, all of it before the tail loop starts.

**CSV because one session is one file.** Adequate for what v1 does; cross-session
reporting may want something queryable, which is an open question rather than a
settled one.

## Building blocks

Five stages, each reasonable about without opening the others. That is the only
test the split has to pass.

| Area | Holds | Document |
| --- | --- | --- |
| Providers | Session discovery, record parsing, the two agents' differences | `areas/providers.md` |
| Turns | Turn boundaries, status, usage accumulation | `areas/turns.md` |
| Pricing | Rate resolution, cost, excluded tiers | `areas/pricing.md` |
| Output | CSV schema, terminal rendering, width fitting | `areas/output.md` |
| Runtime | Home resolution, `~/.turnlens/`, the lock, tailing | `areas/runtime.md` |

Module responsibilities, which cut across those areas:

| Module | Responsibility |
| --- | --- |
| `core/tail.ts` | Yield only newline-terminated lines. Detect truncation and re-open. Never write. |
| `providers/*/parser.ts` | Convert one untrusted record into zero or more `ProviderEvent`s. |
| `core/turn-assembler.ts` | Convert an event stream into turns. Pure: no I/O, no clock. |
| `core/store/csv.ts` | Append durable rows. Never rewrite an existing valid file. |
| `ui/*` | Format. No logic that affects recorded numbers. |
| `pricing/*` | Resolve model rates and turn tokens into a cost. All I/O happens once, before monitoring. |

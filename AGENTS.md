# TurnLens

Per-turn token and cost monitoring for AI coding agents. It answers one question
that agent session files do not answer directly: what did this single prompt and
its response cost?

TypeScript, ESM, zero runtime dependencies. This file holds what is worth knowing
in every task; everything else is routed to below.

## Commands

```
npm test                  vitest
npm run typecheck         includes test/
npm run build             tsc, cleans dist/ first
npm run pricing:snapshot  regenerates src/pricing/snapshot.generated.ts
npm run verify:costs      cross-checks pricing against ccusage
```

The user-facing surface is `turnlens --help`. It is not copied here, because a
copy is right until the next flag is added.

## Skills

- `live-verification` — checking TurnLens against live agent data, or taking any
  figure that will be treated as evidence.
- `design-doc` — designing work that this session will also implement.
- `typescript-best-practices` — writing, reviewing or refactoring `.ts`.

## Always

- **The home directory is resolved by `core/home.ts`.** Do not call
  `os.homedir()` anywhere else. Two modules resolving it separately is two homes
  in one program.
- **An unpriced turn is empty, never `0`.** `cost_status` says why. A zero joins
  a spreadsheet sum and cannot be told from a genuinely free turn.
- **A closed turn is never repriced.** `pricing_version` is a column for this
  reason; the rate that paid for a row travels on that row.
- **Nothing is fetched while a session is being watched.** Pricing resolves once,
  before the tail loop, and `lookup` is synchronous. Adding an `await` to that
  path breaks a guarantee no test covers.
- **Long-context, priority, flex, batch and regional rates are deliberately
  unused.** They look like an omission and are not.
- **`message.usage.iterations` is not summed.** It mirrors the record's own
  usage; summing it doubles every number.
- **`importHistory` is deliberately unreachable from the CLI.** A
  `--import-history` flag was considered and rejected.
- **Display width is deliberately counted in code units.** A half-built Unicode
  table that is wrong in a new way is worse than an honest note.
- **A change is not finished until the document its `update-when` names is
  edited.** Follow `docs/CONVENTIONS.md` when writing one.

## Documents

Read the area document before changing code in that area.

| Read | When |
| --- | --- |
| `docs/CONVENTIONS.md` | Before writing or editing any document |
| `docs/areas/providers.md` | Session discovery, transcript parsing, adding a provider |
| `docs/areas/turns.md` | Turn boundaries, abort handling, usage accumulation |
| `docs/areas/pricing.md` | Rate resolution, cost fields, model ids that do not resolve |
| `docs/areas/output.md` | CSV schema, terminal rendering, anything with a width |
| `docs/areas/runtime.md` | Paths, `~/.turnlens/`, the lock, tailing |
| `docs/ARCHITECTURE.md` | Planning a change that crosses areas, or asking what must never break |
| `docs/DECISIONS.md` | Something looks like an omission, a defect, or a missing feature |
| `docs/VALIDATION.md` | A figure, a platform claim, or what has not been measured |
| `docs/ROADMAP.md` | What is planned, and which questions are still open |
| `docs/FUTURE.md` | A candidate feature and the evidence behind it |

Documents are for navigation and for what the code cannot state. Read the code
for what is true right now.

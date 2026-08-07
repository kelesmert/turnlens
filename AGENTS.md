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

- `live-verification`: checking TurnLens against live agent data, or taking any
  figure that will be treated as evidence.
- `design-doc`: designing work that this session will also implement.
- `typescript-best-practices`: writing, reviewing or refactoring `.ts`.

## Always

- **The home directory is resolved by `core/home.ts`.** Do not call
  `os.homedir()` anywhere else. Two modules resolving it separately is two homes
  in one program.
- **An unpriced turn is empty, never `0`.** `cost_status` says why. A zero joins
  a spreadsheet sum and cannot be told from a genuinely free turn.
- **A closed turn is never repriced.** `pricing_version` is a column for this
  reason; the rate that paid for a row travels on that row.
- **A report dates a turn by `startedAt`, its prompt; everything else uses `at`,
  its close.** The CSV, the live table and `lastActivity` answer "when did this
  finish". A report answers "what did I spend that day", and under the closing
  timestamp that day depended on how long the agent thought. `at` is the fallback
  when no start was seen. `#resetTurnState` must keep clearing `#startedAt`:
  `model` deliberately persists across a boundary and a start must not.
- **Nothing is fetched while a session is being watched, or while a report is
  being built.** Pricing resolves once, before either loop, and `lookup` is
  synchronous. Adding an `await` to that path breaks a guarantee no test covers,
  and a report replays every transcript on the machine through it.
- **The update check shares that one moment and adds no other.** It is issued
  with `Promise.all` beside the pricing request in `cli.ts`, so it costs the
  slower of the two rather than the sum. It must never become a background task:
  `update-notifier` spawns an unref'ed child that outlives the process, which is
  precisely the fetch-while-watching this codebase forbids. Every failure on that
  path is silence, and a version from the registry is checked against
  `^\d+\.\d+\.\d+$` before it reaches a terminal.
- **A token count of zero is printed; a cost that could not be computed is
  blank.** The two look alike and mean opposite things. A count is never unknown,
  so blanking a zero would make a known figure look unknowable; a cost of `0`
  would read as free.
- **Long-context, priority, flex, batch and regional rates are deliberately
  unused.** They look like an omission and are not.
- **`message.usage.iterations` is not summed.** It mirrors the record's own
  usage; summing it doubles every number.
- **`replaySession` in `core/replay.ts` is the batch path: one file in, priced
  turns out, and nowhere for them to go.** The watcher, the report and
  `importHistory` all sit on it. Anything that reads a whole transcript belongs
  there rather than beside it.
- **`importHistory` is still deliberately unreachable from the CLI.** A
  `--import-history` flag was considered and rejected. What it owns now is only
  the CSV: deduping and appending. It stopped renumbering when a row's number
  became the turn's place in the transcript.
- **The CSV is written, not read.** A row's number is the turn's position in the
  session and the exit summary is folded from the session's turns, so neither
  depends on a file that lands wherever the command was run. `readRecordedKeys`
  is the one read left and `importHistory` is its only caller, because merging a
  replay into an existing file means knowing what that file holds. Adding a
  second read puts program state back into an output.
- **Display width is deliberately counted in code units.** A half-built Unicode
  table that is wrong in a new way is worse than an honest note.
- **Colour is a `Paint` passed in, applied after fitting, and never nested.**
  A renderer never asks whether colour is on: the default is `PLAIN`, which is
  why every width test measures what a reader sees. An escape lengthens a string
  without occupying a column, so painting a value on its way into `fit` makes the
  cell short by its own escapes. And escapes do not nest, so cells and rules are
  painted separately: an inner reset ends the outer colour and the rest of the
  row comes out plain. Stripping every escape must leave the output unchanged.
- **A change is not finished until the document its `update-when` names is
  edited**, where such a document exists. See below.

## Documents

**If a `docs/` directory is present, read `docs/README.md` first.** It indexes
the working documents and says which to open for which task: one per pipeline
area, plus the architecture, the decisions, the measurements and the roadmap.

That directory is not part of this repository. It is gitignored and stays on the
machines that develop TurnLens, so a clone will not have it, and this section is
written to be true either way. Working from a clone, the code and its comments
are the whole record: read those, and do not conclude a decision was never made
merely because you cannot find a file recording it.

**A document tells you where to look and what was already decided. Before
changing code, stating what is true now, or refusing a change because it was
decided against, open the source it names.** A record knows why a decision was
made; it does not know what would break today.

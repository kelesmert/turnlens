---
purpose: Every deliberate choice that looks like an omission, with the reasoning that produced it.
update-when: A decision recorded here is superseded, or a new choice is made that a reader would otherwise mistake for a defect.
---

# Decisions

**Sections:** How to read this · Discovery · Pricing · Turns · Output · Scope

Entries are not edited once accepted. A decision that changes is superseded by a
new entry that links back and says why; the old entry stays and is marked. The
chain is the value, not any single record.

`Status` is one of **Accepted**, **Deferred** or **Superseded**. Deferred means
the choice was made deliberately and can be revisited; it does not mean forgotten.

**A `Deferred` entry is not an answer to "should we do this now".** It records why
the choice was made, on the day it was made, and the code has moved since. Before
proposing one of these again -- or refusing it -- open the files the area document
names under **Where the code lives**. What would break today is in the code, not
here.

---

## Discovery

### `HOMEDRIVE` + `HOMEPATH` is not a fallback

**Context.** ccusage carries three ways to find a Windows home. TurnLens carries
two: `HOME` when set, `os.homedir()` otherwise.

**Decision.** The third is deliberately absent.

**Consequences.** It was observed on no machine here, and a branch that has never
seen an input is the thing this project avoids everywhere else. Measured on
Windows: PowerShell leaves `HOME` unset so `os.homedir()` decides, Git for
Windows sets `HOME` to `%USERPROFILE%`, and both resolve to `C:\Users\<user>`.

**Status.** Accepted.

### `CODEX_HOME` is not split on commas

**Context.** `CLAUDE_CONFIG_DIR` is documented as a comma-separated list.
ccusage also splits `CODEX_HOME` on commas so it can aggregate several homes into
one report.

**Decision.** `CODEX_HOME` names a single directory. A comma stays part of the
path.

**Consequences.** Codex documents no comma form, and TurnLens watches one
session rather than aggregating. The asymmetry with `CLAUDE_CONFIG_DIR` is a real
difference between the two agents and should not be smoothed over.

**Status.** Accepted.

### `~/.codex/archived_sessions/` is not read

**Context.** It holds `rollout-*.jsonl` files in the same format as `sessions/`,
on both Linux and Windows, so it is ordinary Codex behaviour rather than a local
quirk. Measured on the development machine: 5 archived against 20 live.

**Decision.** Not listed.

**Consequences.** Correct for watching -- an archived session has ended and
cannot be followed. It is an undercount for anything that aggregates across all
history, so a fifth of that history is outside what the watcher can see. That
belongs with the reporting work in `ROADMAP.md`.

**Status.** Accepted for watching; open for reporting.

### A project's `memory/` subdirectory is skipped

**Context.** A Claude Code project directory may contain `memory/` beside its
transcripts.

**Decision.** The depth-one scan does not descend into it.

**Consequences.** Measured to contain no `.jsonl` file, so skipping it loses
nothing.

**Status.** Accepted.

### The desktop client's `isArchived` marker is not joined

**Context.** Claude Code leaves an archived transcript where it is, so archived
conversations keep appearing in the session list. A marker does exist, in the
desktop client's own store -- a different tree from both the transcripts and
`~/.claude`. Each file carries `isArchived` alongside `title`, `cwd`, `model`,
`effort`, `completedTurns` and around twenty more keys.

**Decision.** Not read.

**Consequences.** `local_<client-id>.json` is named after the client's own id,
which is *not* the transcript's: of five files measured, four had a filename
matching no transcript at all. The transcript uuid is a field inside,
`cliSessionId`. Using this would mean opening every file in a second tree and
reading a schema nobody documents, to hide rows the user can still write to.

This is a judgement about coupling, not an absence of options. The transcript
format is what TurnLens already depends on and what every provider writes; a
specific client's session list is narrower, undocumented, and covers only one of
the ways Claude Code runs. For reporting the calculation may come out
differently, because there the flag would change a total rather than a list.

Worth recording because the answer moved twice: first "no signal exists", then "a
signal exists on Windows", then this. **Absence of a signal where one looked is
not absence of a signal.**

**Note, 29 July 2026.** Re-measuring the same store found a second marker this
entry did not account for. `deleted_<uuid>` entries are named after the
*transcript's* uuid rather than the client's, so joining them needs no schema and
no second read -- the opposite of the cost that decided this entry. Four of the
eight point at transcripts still on disk, which TurnLens therefore lists after
the user deleted them in the desktop client. The reasoning above still holds for
`isArchived`; it does not carry to deletion, and that has not been decided.
Figures in `VALIDATION.md`, question in `ROADMAP.md`.

**Status.** Accepted for watching; open for reporting; the deletion marker is a
separate question and is open.

---

## Pricing

### Long-context, priority, flex, batch and regional rates are unused

**Context.** LiteLLM publishes `_above_200k_tokens` and `_above_272k_tokens`
tiers, and several service-class variants.

**Decision.** None are applied.

**Consequences.** A turn's input total is the sum over many requests, not one
request's context size, so testing that sum against the 272,000-token threshold
would misprice systematically. The per-request figure exists
(`last_token_usage.input_tokens`, largest observed 235,115) but summing it
disagrees with the cumulative delta in 49 of 388 turns, so it is not yet a
trustworthy basis. The service-class variants are out for a simpler reason:
nothing in a session file says which tier a request used.

**Status.** Deferred.

### `models.dev` is not a second pricing source

**Context.** Plan 2 shipped LiteLLM only, behind an interface that admits a
second source.

**Decision.** Not implemented.

**Consequences.** Every model Codex and Claude Code emit is already an exact
LiteLLM key, so a second source would add a merge policy and a second failure
mode to solve a problem that does not currently exist. ccusage carries three
sources because it must price anybody's model across fifteen agents.

Three things in the current code would have to give, all verified in `src/`
rather than assumed:

- **`RawPricingEntry` is `Readonly<Record<string, number>>`** -- one model's rates
  *exactly as the source document spells them*. It is a LiteLLM shape, not a
  neutral one.
- **The snapshot, the cache and a fresh download go through one parser.**
  `resolver.ts` calls `addDocument` for all three and `addDocument` calls
  `parseLiteLlmDocument`. A cached document can therefore never be interpreted by
  different rules than a fresh one -- a property a second source removes unless
  each source gets its own parser and converts to `ModelPricing` itself.
- **`pricing_version` is one string per row**, and `scripts/verify-costs.mjs`
  reports a row whose version it cannot match as *unverifiable* rather than as a
  mismatch. Merged rates would have to say which source paid for each row.
  `PricedEntry` already carries a version per entry, so `lookup` can return the
  right one; only the naming changes.

Priority is the load-bearing constraint, not a detail: a second source must
supplement models LiteLLM lacks and never overwrite one it has. ccusage reads
LiteLLM too, so overwriting would break the parity claim in `VALIDATION.md`,
which is what the arithmetic rests on.

**Unverified, and to be checked before any of this is written:** that models.dev
publishes per-million rather than per-token rates, nests entries by provider, and
carries no equivalent of `cache_creation_input_token_cost_above_1hr`. If the last
is true, a turn with cache creation priced from that source yields
`no_pricing_data` -- an honest gap rather than a wrong number, but a gap.

**Status.** Deferred.

### An unpriced turn is empty, not zero

**Context.** A turn whose model has no rate has to record something.

**Decision.** `estimated_cost_usd` is left empty and `cost_status` says why
(`model_unknown` or `no_pricing_data`).

**Consequences.** An empty cell stays out of a spreadsheet sum. A zero silently
joins it and is indistinguishable from a genuinely free turn. This is the entry
most likely to be mistaken for a bug.

**Status.** Accepted.

### A closed turn is never repriced

**Context.** ccusage recomputes all history on every invocation, so a stale rate
self-corrects there.

**Decision.** TurnLens writes a cost when a turn closes and never revisits it.

**Consequences.** `pricing_version` has to be a **column** rather than a
run-level fact: the rate that paid for a row travels on that row.

**Status.** Accepted.

---

## Turns

### `message.usage.iterations` is not summed

**Context.** The array is present on every assistant record, always length one,
always mirroring the record's own usage.

**Decision.** Ignored.

**Consequences.** Summing it would double every number. A second type,
`advisor_message`, is genuinely additional usage under a *different* model, but
zero instances exist locally, so it is deferred rather than written blind. The
failure direction while waiting is undercounting, never invention. Written up in
`FUTURE.md` section 3.

**Status.** Deferred.

### Per-tool token attribution is not carried over

**Context.** The Python implementation wrote a `tool_token_usage_json` column fed
by `last_token_usage`, which is the usage of the model step that *requested* a
tool, not the tool's own cost.

**Decision.** The column is not carried over.

**Consequences.** If it returns it must be named for what it measures.

**Status.** Accepted.

### Subagent cost attribution is out of scope

**Context.** Claude Code writes subagent transcripts to
`projects/<project>/<session>/subagents/`, not inline in the parent file.

**Decision.** Nothing is recorded for them.

**Consequences.** Taking them into scope is not additive: a subagent file replays
the parent's messages with the same `message.id` but a different `requestId`, so
the deduplication key would have to change for every Claude Code session,
including the single-file case that is already verified exactly. No session on
this machine has ever run a subagent, so there is no fixture. Written up in
`FUTURE.md` section 4.

**Status.** Deferred.

---

## Output

### Display width is counted in code units

**Context.** `fit` in `ui/live-table.ts` pads with `padEnd` and `padStart`, and
both count UTF-16 code units. A terminal allocates cells, and the two are equal
only for the Latin range -- Turkish included, which is why nothing in daily use
trips it.

**Decision.** Deferred deliberately, with no date on it.

**Consequences.** They part company in both directions. `日本語で書いてください` is
11 code units and 22 cells, so the column is drawn 11 cells too wide. A family
emoji is 8 code units and 2 cells, so the same column comes out too narrow.

Closing it needs a `displayWidth` in `core/text.ts` -- East Asian Wide and
Fullwidth counted as 2, combining marks as 0, the rest as 1 -- and `fit` padding
by that. Two things argue for leaving it: TurnLens does not claim CJK support and
is not planned to, and terminals disagree with each other about emoji width, so
the fix would be exact for CJK and approximate for emoji however carefully it is
written. **A half-built Unicode table that is wrong in a new way is worse than an
honest note.**

The related defect that did have to be fixed is separate: cutting a character in
half is data corruption rather than a display flaw, and it reached the CSV.
`truncate` and `truncateEnd` now cut on grapheme boundaries via `Intl.Segmenter`.

**Status.** Deferred.

### The provider segment in the CSV path buys readability, not correctness

**Context.** Output lands at `turnlens-usage/<provider>/<session-id>.csv`.

**Decision.** The provider segment stays even though it is not needed for
uniqueness.

**Consequences.** Session ids do not collide across agents (Codex writes
`rollout-<timestamp>-<uuid>`, Claude Code a bare uuid) and every row carries a
`provider` column. It buys a directory a person can read after months of use.

**Status.** Accepted.

### CSV is the store format

**Context.** One session per file, appended as turns close.

**Decision.** CSV.

**Consequences.** Adequate for one session. Cross-session reporting may want
something queryable, which is an open question in `ROADMAP.md` rather than a
decision made here.

**Status.** Accepted for v1.

---

## Scope

### `importHistory` is not reachable from the CLI

**Context.** It is built and tested, but nothing in `src/` calls it. `src/cli.ts`
calls only `runWatch`, whose one prefix read (`readBaseline`) exists to seed the
cumulative counter and returns immediately for per-event providers.

**Decision.** It stays internal. Wiring it to a `--import-history` flag was
considered and rejected.

**Consequences.** Backfilled turns would be priced at today's rates, which is
exactly the property that makes a recorded row worth more than a reconstructed
one -- so those rows would offer nothing over what reporting can produce from the
transcript, in exchange for a flag, a wait and a second scan.

It stays because it is the batch path through the pipeline, and because the
arithmetic lock is built on it: the turn counts taken by hand, the tool-call
attribution, the byte-identical guarantee and the snapshot pricing tests all
drive it. It is deliberately internal, not forgotten.

**Note.** An earlier version of this entry said `runWatch` duplicated part of it
and that merging the two reads was deferred. That was wrong twice over: the merge
never happened, and there is no duplicate read to remove. Corrected rather than
deleted, because the wrong version is why the entry existed.

**Status.** Accepted.

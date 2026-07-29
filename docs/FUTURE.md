---
purpose: Candidate features that are deliberately not built yet, with the evidence behind each.
update-when: A candidate is raised, implemented, or dropped.
---

# Future feature notes

**Sections:** 1. Rate-limit windows · 2. Turn numbering on resume · 3. Advisor usage · 4. Subagent cost · 5. Session recency in words

Ideas worth building that are deliberately not built yet, with the evidence that
motivated them. Each entry records what was observed, why it was deferred, and
what would have to be decided before implementing it.

This file is for candidate features. Delivery sequencing belongs in `ROADMAP.md`;
a choice already made belongs in `DECISIONS.md`.

---

## 1. Rate-limit windows as a first-class, per-provider concept

**Noted:** 2026-07-25, after the first live Codex monitoring run.
**Status:** deferred, no code change made.

### What the data actually contains

Every Codex `token_count` record carries a `rate_limits` object. Observed shape,
transcribed from a real session on 2026-07-25:

```json
{
  "primary":   { "used_percent": 95.0, "window_minutes": 10080, "resets_at": 1785266064 },
  "secondary": null,
  "limit_id": "codex",
  "limit_name": null,
  "plan_type": "plus",
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
  "individual_limit": null,
  "spend_control_reached": null,
  "rate_limit_reached_type": null
}
```

`window_minutes: 10080` is seven days. `secondary` is `null` for this account,
so there is exactly one window.

### What `used_percent` means

It is consumption, not headroom. Confirmed by the account owner against the
Codex web usage page on 2026-07-25: the session reported `used_percent: 95.0`
and the web page showed 5 percent of the weekly allowance remaining. So
remaining equals `100 - used_percent`, and TurnLens currently displays the
`used` direction.

### Why this is a feature and not a formatting detail

The number of windows and their lengths are provider-specific:

- Codex exposes one weekly window and no shorter one.
- Claude Code has both a five-hour window and a weekly one.

So `primary` and `secondary` are Codex's own field names, not a general model.
A provider that reports three windows, or one that names them, cannot be
represented by two fixed columns. Any real feature here starts by letting a
provider adapter declare its windows rather than mapping them onto a pair.

### Current behaviour, and its one rough edge

`runWatch` prints the table header once at startup, before any `token_count`
record has been read, so the two limit headings render as `-` and stay that way
for the whole run. The window length becomes known about a second later, with
the first turn. The result is a column showing `95.0%` under a heading of `-`:
the percentage is correct but its window is unlabelled.

This is the honest failure direction. The Python implementation hardcoded the
headings `5 hour` and `Week` regardless of what the session reported, which is
`known-bugs.md` P3-5. Printing `-` until the real value is known is strictly
better than printing a guess. It is just less useful than it could be.

### Decisions to make before implementing

1. **When to render the heading.** Printing the header immediately before the
   first row, using that row's window data, gives a correct label from the start
   at the cost of an empty screen until the first turn closes. The CLI already
   prints a startup banner with the session name, session file and CSV path, so
   there is other evidence that monitoring began. The alternative is to reprint
   the header whenever the labels change, which shows two headers in one screen.
2. **Whether to show used or remaining.** Remaining is what a user wants to
   know, but it is a derived claim about an allowance TurnLens does not own.
   The project constraint is that rate-limit fields stay raw informational
   values with no quota claims and no alerts. Showing `5% left` edges toward a
   claim; showing `95.0% used of 7d` does not.
3. **How a provider declares its windows.** Probably a list on the adapter, with
   each window carrying an optional provider-supplied name, so the table builds
   its columns from that list instead of from two hardcoded fields. This changes
   the `RateLimits` type and the CSV schema, so it wants to land with a schema
   version, not as a silent column change.
4. **Whether `resets_at` belongs in the output.** It is a unix timestamp and it
   is currently discarded. It would make the window concrete without asserting
   anything about the allowance.

### Related but out of scope here

`plan_type`, `credits` and `rate_limit_reached_type` are parsed by nothing today.
`plan_type` and `credits` are inputs to cost estimation and belong with the
native pricing work rather than with the table layout.

---

## 2. Announce that turn numbering is resuming

**Noted:** 2026-07-26, during the live pricing verification of Plan 2.
**Status:** deferred, no code change made. Not a defect: the numbering is
correct, only unexplained.

### What was observed

A session was watched, two turns were recorded, monitoring was stopped. On
re-attaching to the **same** session, the table opened like this:

```
   # Time     Status    Prompt      ...
   3 00:18:39 completed -           ...
```

Starting at `3` with an empty screen above it reads like a bug. It is not: the
CSV already held turns 1 and 2, and `openCsv` reports `maxTurnNumber` so the run
continues from there rather than overwriting.

### Why the current numbering is right

- **The CSV is per session.** `src/cli.ts` derives the filename from
  `sessionId`, so every *new* session already starts at 1. Continuation happens
  only when re-attaching to a session that was watched before, which is exactly
  when a continuous sequence is wanted.
- **Resetting would break the column.** One file would contain
  `1,2,3,1,2,1,2,3...`, so `turn_number` would stop being an identifier and stop
  being sortable. Cross-session reporting (Plan 5) is meant to build on it.
- **It is not load-bearing for correctness.** `turnRowKey` keys on
  `turnId + status + at`, never on the number, so resetting would not corrupt
  dedup -- it would only make the column meaningless. That is why this is a
  presentation question and not a data question.

### Two fixes that were considered and rejected

1. **Reset the number every run.** Rejected for the reasons above. The terminal
   is ephemeral and the CSV is the product; trading the durable artefact's
   integrity for the transient view is the wrong direction.
2. **Keep the CSV continuous but reset the table's `#`.** Rejected because the
   two would then disagree. Reading a cost off the screen and checking it against
   the CSV row is a real workflow -- it is how the Plan 2 arithmetic was verified
   by hand -- and "turn 1 on screen is turn 3 in the file" is a worse confusion
   than the one being fixed.

### The proposed fix

Say it out loud. When the CSV already contains rows, add one line to the startup
banner, next to `Session file` and `CSV file`:

```
Resuming        : 2 turns already recorded, continuing from turn 3
```

Nothing about the numbering changes; the surprise disappears.

### Decisions to make before implementing

1. **Where the count comes from.** `openCsv` already returns `maxTurnNumber` and
   `recordedKeys`, but it is currently called inside `createRecorder`, which
   `runWatch` reaches *after* the banner is printed. Either call it earlier in
   `src/cli.ts` and pass the state down, or add a lighter read that only counts
   rows. Calling `openCsv` twice would work and is harmless, but it re-reads and
   re-validates the whole file for a cosmetic line.
2. **Whether to say anything when the file is new.** A `Resuming` line that
   appears only sometimes is arguably less predictable than one that always
   appears and reads `Resuming: no, new file`. Silence when there is nothing to
   resume is probably right, but it is a choice.
3. **Whether the same line belongs in the exit summary.** The summary already
   reports `Recorded turns`, which counts the whole file rather than this run.
   With three turns in the file and one recorded this run, `Recorded turns: 3` is
   accurate about the file but does not say what this run contributed. If the
   banner starts distinguishing the two, the summary probably should too.

---

## 3. Advisor usage nested in `message.usage.iterations`

**Noted:** 2026-07-26, while researching Plan 3 against real Claude Code
sessions and reading how ccusage parses the same files.
**Status:** deferred, no code change made. Deferred **knowingly**: the field is
read and understood, and the reason for not acting on it is the absence of data,
not the absence of awareness.

### What the data actually contains

Every Claude Code assistant record carries a `message.usage` object, and inside
it an `iterations` array. Measured over a frozen copy of all three session files
on this machine -- 7,451 lines, 3,702 assistant records:

| Observation | Count |
|---|---|
| Assistant records carrying `usage.iterations` | 3,693 |
| Arrays with more than one element | 0 |
| Iterations of type `message` | 3,693 |
| Iterations of type `advisor_message` | **0** |
| Single iterations whose tokens exactly mirror the parent `usage` | 3,693 |

The nine assistant records without `iterations` are the ones with
`stop_reason: null`, which is a response still being written.

A transcribed element, unmodified:

```json
{
  "input_tokens": 2,
  "output_tokens": 125,
  "cache_read_input_tokens": 19524,
  "cache_creation_input_tokens": 7492,
  "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 7492 },
  "type": "message"
}
```

Note that it repeats the record's own usage exactly. **Summing `iterations` on
top of `message.usage` would double every number in the file.** That is the
first reason this field is dangerous to touch casually.

### What the field is for

`iterations` is not only a mirror. ccusage's Claude adapter reads one other
type, `advisor_message`, and treats it as genuinely additional usage:

- the iteration carries **its own `model`**, which differs from the record's;
- ccusage lifts it into a synthetic entry keyed `{message_id}:advisor:{index}`,
  so it survives deduplication as a distinct row;
- it is priced under its own model's rates, and it never carries a precomputed
  cost, so it is always calculated from tokens;
- every other iteration type is explicitly not added again.

So the shape of the correct behaviour is known: read `iterations`, keep only
`type == "advisor_message"`, price each under `iteration.model`, add nothing
else.

### Why it is deferred rather than implemented

Not one `advisor_message` iteration exists in any session on this machine. The
project's standing rule is that behaviour is written against observed data, and
every defect in `known-bugs.md` was found only in real sessions. Implementing
this now would mean writing, and shipping, a priced code path that has never
seen an input -- exactly the kind of code that looks correct and silently is not.

The exposure from waiting is bounded and knowable: turns that used an advisor
would be **undercounted**, never overcounted, and never wrong in a way that
invents money. That is the safe direction, and it matches how TurnLens already
treats everything it cannot attribute.

### Decisions to make before implementing

1. **Whether an advisor iteration is a separate turn or part of its parent.**
   ccusage answers a different question -- it aggregates by day, project and
   session, so a synthetic row is free. TurnLens's unit is the turn, and a turn
   has one `model` column. An advisor running a different model inside a turn
   either splits the row, adds a column, or is folded into the parent under the
   parent's name, which would misprice it. This is the real design question and
   it should not be answered until there is a session to answer it against.
2. **How to obtain a fixture.** The feature has to be triggered deliberately in
   a real Claude Code session, then anonymized through `scripts/make-fixture.mjs`
   like the Codex fixture was. Until that exists, nothing here is testable.
3. **Whether the guard is worth adding first.** A cheap, provably safe step is
   available now, independent of the rest: assert in the parser that the only
   iteration types seen are ones TurnLens deliberately ignores, and record an
   unrecognised type rather than silently dropping it. That turns a future
   `advisor_message` from invisible into visible without pricing it.

### Related

The same `usage` object also carries `server_tool_use`, `service_tier` and
`speed`. `server_tool_use` is zero or absent in every record measured here, so
it is not deferred so much as unobserved. `speed` is used by ccusage only as a
tiebreak when two duplicate records are otherwise identical.

---

## 4. Subagent cost attribution

**Noted:** 2026-07-26, while scoping Plan 3.
**Status:** deliberately out of scope for Plan 3. Decided, not overlooked.

### Where subagent transcripts actually live

The roadmap assumed subagent traffic appears inline in the parent session file,
marked `isSidechain: true`. It does not. Claude Code writes subagent
conversations to a separate directory:

```
projects/<project>/<session>/subagents/
```

So a subagent's tokens are absent from the parent session file entirely. Across
all three sessions on this machine -- 7,451 lines -- there is **not one record
with `isSidechain: true`**, which is consistent with that directory never having
been created here, because no subagent has been run in this project.

### Why this is more than "read one more directory"

ccusage documents a trap in its own Claude adapter, and it was a real defect
there ([ccusage#913](https://github.com/ccusage/ccusage/issues/913)): a subagent
file **replays the parent conversation's messages**, carrying the same
`message.id` but a **different `requestId`**, including the parent's cache-read
usage. Under the deduplication key Plan 3 would otherwise use --
`message.id` plus `requestId` -- those replays are distinct keys and get counted
a second time.

ccusage's fix is a two-level key: match on `message.id` plus `requestId` first,
and fall back to `message.id` alone when a sidechain record is involved, keeping
the non-sidechain copy. It then breaks remaining ties by larger token total, and
finally by whether `speed` is present.

The consequence for TurnLens is that taking subagents into scope is not an
additive change. It changes the deduplication rule for **all** Claude Code
sessions, including the single-file case that is otherwise fully measured and
verified. That is a correctness change to the common path in exchange for a
feature with no local test data.

### Why the single-file scope is defensible on its own

The one-file model was verified byte-for-byte before any code was written. On a
frozen copy of these sessions, applying the intended parsing and pricing rules
reproduces ccusage's totals exactly: 14,047 input, 136,323,205 cache read,
3,375,268 cache creation, 718,140 output, `$118.867966` -- identical in every
figure. A session with subagents would simply record less than was spent, which
is the same honest failure direction TurnLens takes everywhere else.

### Decisions to make before implementing

1. **Whether a subagent is part of the parent turn or its own unit.** The
   product's claim is per-turn cost, so folding subagent spend into the turn that
   launched it is the answer that serves the claim. That requires correlating the
   parent's `Agent` tool call with the subagent transcript, which nothing in the
   parent file obviously supports yet -- it needs measuring, not guessing.
2. **How to watch more than one file.** Everything today assumes one session
   file, one lock and one CSV. Subagent transcripts appear during a run, so this
   is directory watching, not file tailing.
3. **What the deduplication key becomes.** See above. Whatever is chosen has to
   keep the single-file result exactly as it is now, which means the frozen
   comparison above becomes a regression test before the key changes.
4. **Where the fixture comes from.** A subagent has to be run deliberately to
   create `subagents/` at all.

---

## 5. Say how long ago a session was active, in words

**Noted:** 2026-07-28, while explaining why the session list cannot mark a
session as live.
**Status:** deferred, no code change made. Not a defect.

### What is true today

Neither Codex nor Claude Code writes a liveness marker, so TurnLens cannot tell
a session that will produce turns from one that has ended. It does not need to:
watching seeks to the end of the file and waits, which is correct either way. A
finished session simply produces no rows.

The only honest signal is the last modification time, and the listing already
shows it as an absolute timestamp:

```
  1  2026-07-28 00:22:51  Hesapla 7x7
  2  2026-07-21 09:09:20  An older piece of work
```

### The change, if it is ever made

Render that column as elapsed time -- "10 seconds ago", "7 days ago". It asserts
nothing new; the same fact is easier to read. A row from a week ago stops looking
like a candidate.

### Why it is deferred

It changes what a user sees for no change in what TurnLens knows, and v0.1.0 has
enough surface already. The absolute timestamp is also the form that matches a
CSV row, which is worth something while the two are read side by side.

### Decision to make before implementing

Whether both are shown or one replaces the other. "3 minutes ago" is easier to
scan; `2026-07-28 00:22:51` is what the CSV carries. Showing both costs width in
a listing that was just made to fit its rule.

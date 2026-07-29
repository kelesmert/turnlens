---
purpose: How session files are found and turned into provider events, and how the two agents differ.
update-when: A provider is added, a transcript format changes, or session discovery changes.
---

# Providers

**Sections:** What it does · Invariants · Traps · Where the code lives · Decisions

## What it does

A provider answers two questions. Where does this agent keep its transcripts,
and what does one line of one transcript mean. Discovery produces a list of
session files; `parseRecord` converts one untrusted record into zero or more
`ProviderEvent`s. Nothing beyond that: no turn logic lives in an adapter.

The two agents record usage in fundamentally incompatible ways, which is why the
layer exists at all. Verified against real session files rather than assumed.

| | Codex | Claude Code |
| --- | --- | --- |
| Counter semantics | Cumulative, so a **delta** is required | Per-message absolute, so a **sum** is required |
| Turn boundary | `event_msg` / `task_complete` | `promptId` on user records |
| Cache categories | `cached_input_tokens` only | `cache_read` plus `cache_creation` split 5m / 1h, priced differently |
| Duplicate records | none | yes, of two kinds |
| Sub-agents | not applicable | separate transcripts, out of scope |

`ProviderAdapter.usageModel` names which of the two behaviours applies, and
`TurnAssembler` implements both.

### Where sessions are found

Claude Code has **two roots and the first one moves**:

```
$XDG_CONFIG_HOME/claude/projects     default: ~/.config/claude/projects
~/.claude/projects
```

These are two live conventions, not one superseding the other. `CLAUDE_CONFIG_DIR`
replaces both defaults rather than adding to them, and its documented form is a
comma-separated list.

Codex has **one root**, `$CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`,
with `~/.codex/session_index.jsonl` supplying display names. A session missing
from that index is reported as `(unnamed session)`.

Values read from the environment are expanded and deduplicated before use. A
leading `~` becomes the home directory, because a user types the path they would
type into a shell and Node does not expand it. Duplicates collapse after
expansion, because `~/a` and `/home/me/a` are one directory and listing it twice
lists every session in it twice.

### The two agents archive differently

Codex moves the transcript, so TurnLens stops listing an archived session without
being told anything. Claude Code leaves the transcript where it is, so an archived
conversation keeps appearing in the session list, and nothing under `~/.claude`
marks it. Deleting a Claude Code session leaves the transcript too. Both are
deliberate on TurnLens's side -- see Decisions.

### Transcripts do not live forever

Claude Code deletes transcripts after **30 days** by default, configurable through
`cleanupPeriodDays` in `settings.json`. Nothing TurnLens reads is permanent, which
bounds any claim a report can make about history. A CSV row, once written, is not
affected: it is TurnLens's own file.

## Invariants

- Every line of a session file is untrusted input. `parseRecord` receives
  `unknown` and narrows with type guards. There are no `as` assertions used to
  silence the compiler.
- An unrecognised or malformed record yields an empty event array, so a format
  change by Codex or Anthropic degrades to missing data rather than a crash or a
  fabricated number.
- No turn logic lives in an adapter.
- The home directory comes from `core/home.ts`. No module calls `os.homedir()`
  directly.
- Environment paths are expanded and deduplicated in one place, `core/env-paths.ts`.
- When a listing comes back empty, the failure names every root it searched and
  every variable that steers the search, set or unset. The agent having never run
  here and the agent writing somewhere else are otherwise indistinguishable to
  the person reading the error.

## Traps

- **`CLAUDE_CONFIG_DIR` is a comma-separated list; `CODEX_HOME` is not.** The
  asymmetry is a real difference between the two agents, not an oversight. See
  Decisions.
- **Do not hardcode `~/.config/claude`.** `XDG_CONFIG_HOME` relocates that root,
  and hardcoding it loses every session belonging to a user who moved their
  configuration. An earlier comment explained the pair as history -- that Claude
  Code "has used both over time" -- which is not the reason, and the wrong reason
  is what made the hardcoded path look finished.
- **Claude Code needs two deduplications and neither alone is correct.** A record
  whose `uuid` was already seen is history a compaction re-appended. Separately,
  one API response is written as several records, one per content block, each
  carrying the full usage; those share `message.id` and `requestId`, so usage is
  counted once per pair. `uuid` alone bills a three-block response three times;
  the pair alone leaves phantom turn starts in place, turning a real 59-turn
  session into 87. Measured 5.75x token inflation without deduplication.
- **The `uuid` filter looks removable and is not.** Disabling it fails the
  parser's unit tests and no pipeline test, because `TurnAssembler` drops a turn
  that consumed nothing and already guards usage by `dedupKey` and tool calls by
  `callId`. It is kept because it is the only thing that bounds replayed prompt
  text and phantom turn starts at the source.
- **`~other` is left alone.** Resolving another user's home needs a
  platform-specific account lookup, and nothing in TurnLens branches on the
  operating system.

## Where the code lives

```
src/providers/registry.ts               adapter lookup
src/providers/codex/parser.ts           record -> events
src/providers/codex/sessions.ts         discovery, session_index.jsonl
src/providers/claude-code/parser.ts     record -> events, both deduplications
src/providers/claude-code/sessions.ts   discovery, two roots
src/core/env-paths.ts                   tilde expansion, list splitting, dedup
src/core/home.ts                        the single home resolver
```

## Decisions

- `HOMEDRIVE` + `HOMEPATH` deliberately absent -- `DECISIONS.md`
- `CODEX_HOME` not split on commas -- `DECISIONS.md`
- `archived_sessions/` not read -- `DECISIONS.md`
- The desktop client's `isArchived` marker not joined -- `DECISIONS.md`
- Subagent transcripts out of scope -- `DECISIONS.md`, `FUTURE.md` section 4

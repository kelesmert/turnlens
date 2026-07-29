---
purpose: Where TurnLens keeps its own state, how the home directory is resolved, and how one watcher per session is enforced.
update-when: Path resolution, the lock, or anything under ~/.turnlens changes.
---

# Runtime

**Sections:** What it does · Invariants · Traps · Where the code lives · Decisions

## What it does

Two kinds of file, two locations, and the split is deliberate.

| Kind | Location | Why |
| --- | --- | --- |
| The CSV a run produces | `turnlens-usage/<provider>/<session-id>.csv` under `process.cwd()` | It is the user's output. Running from the desktop should leave it on the desktop. |
| TurnLens's own state (locks, pricing cache) | `~/.turnlens/`, overridable with `TURNLENS_HOME` | It is per user and per machine, not per directory. |

Program code itself is whatever npm chose -- a global `node_modules` or the
`npx` cache -- and is never written to at runtime.

`core/home.ts` is the single answer to "where does the user live": `HOME` when it
is set to something, `os.homedir()` otherwise. Preferring `HOME` is what lets a
user redirect TurnLens deliberately, and it is also ccusage's order.
`os.homedir()` covers Windows, where it reads `USERPROFILE`.

## Invariants

- **Session files are opened read-only and never modified, moved or deleted.**
  A test asserts the source file is byte-identical after a full run.
- The only paths TurnLens writes to are the CSV output directory and
  `~/.turnlens/`. Nothing else on disk is touched.
- **`~/.turnlens/` is absolute under every environment.** A blank `HOME` counts
  as absent.
- **One watcher per session**, enforced by an atomic lock file removed on exit.
  The lock lives in `~/.turnlens/locks/`, keyed by a digest of the **session
  path**, and is plain text: `pid=`, `started=`, `session=`.
- `core/paths.ts` is the single place both rows of the table above are decided.

## Traps

- **Do not call `os.homedir()` directly.** `core/home.ts` decides this for the
  whole program. Two modules resolving the home separately is not a wrong home;
  it is two homes in one program, and TurnLens would then look for sessions under
  one and write its lock and pricing cache under another. This was a real defect,
  found on Windows and since fixed -- see `../VALIDATION.md`.
- **`??` does not reject an empty string.** `env.HOME ?? homedir()` kept `""`,
  because `??` rejects only `null` and `undefined`, so `HOME=` produced the
  *relative* `.turnlens` and put locks and the pricing cache in whatever directory
  the command ran in.
- **The lock must be keyed by the session path, not the working directory.** It
  was originally written under `process.cwd()`, which quietly reduced the
  guarantee to one watcher per *directory*: two watchers launched from two places
  never saw each other's lock and both monitored the same session.
- **Windows lets a writing process decide whether anyone else may read.** An
  agent that opened its transcript without sharing would make tailing impossible.
  Measured: both agents share, and turns were recorded live on Windows. Linux has
  no equivalent restriction, so this cannot be discovered there.
- **The exit handler covers `SIGTERM` and `SIGHUP`, neither of which exists on
  Windows.** Ctrl+C still prints the summary there, but the reason is not obvious
  from the code.

## Where the code lives

```
src/core/home.ts       the single home resolver
src/core/paths.ts      ~/.turnlens, TURNLENS_HOME, CSV path
src/core/env-paths.ts  tilde expansion, list splitting, deduplication
src/core/lock.ts       atomic lock, sha256 of the session path
src/core/tail.ts       newline-terminated reads, truncation detection, re-open
```

## Decisions

- `HOMEDRIVE` + `HOMEPATH` deliberately absent -- `DECISIONS.md`
- Platform measurements, and what remains unmeasured -- `../VALIDATION.md`

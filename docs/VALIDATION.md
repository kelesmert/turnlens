---
purpose: What has been measured against real data and on which platforms, with the figures.
update-when: A measurement is taken, a platform is covered, or a recorded figure is found wrong.
---

# Validation

**Sections:** How to read this · Codex against a real session · Claude Code against ccusage · Windows, 27 July 2026 · Windows, 28 July 2026 · Still unmeasured

Entries are appended, not edited. A figure later found wrong is corrected by a new
entry, because the original figure is itself part of the record.

**Live verification never uses the session doing the work.** A file being written
grows while it is read, so a figure taken from it measures the growth, not the
program. This produced one false result, recorded below. A static file is copied
first and the copy is measured, so the bytes cannot change between two tools
reading them.

---

## Codex against a real session

The pipeline was run over a 2098-line real Codex session and every count checked
against the same figure taken from the file by hand:

| Measured | Figure |
| --- | --- |
| Tool calls | 350 |
| Completed turns | 40 |
| Compactions | 4 |
| Aborts producing a row | 1 of 3 |

The other two aborts consumed no tokens, so they close a turn without recording
one while still advancing the baseline.

`test/fixtures/codex-abort-session.jsonl` is an anonymized slice of that session,
produced by `scripts/make-fixture.mjs`, which redacts by allowlist: only fields
the parser reads are copied, so a field Codex adds later cannot leak by default.

Real data matters here because **every defect found in the Python prototype was
discoverable only in real data.**

## Claude Code against ccusage

Verified against `ccusage claude session --json` before the provider was written,
on a frozen copy of the local sessions. The intended rules reproduce ccusage
exactly, with no difference in any figure:

| Figure | Value |
| --- | --- |
| Input | 14,047 |
| Cache read | 136,323,205 |
| Cache creation | 3,375,268 |
| Output | 718,140 |
| Cost | $118.867966 |

**The copy is why the figures agree.** A first attempt compared a live file
against a tool run taken minutes later and produced a 0.33 percent difference
that was reported as a token-attribution difference. It was entirely the file
growing during measurement. This is the origin of the rule at the top of this
document.

Measuring also required an isolated `HOME`. Pointing `CLAUDE_CONFIG_DIR` at a
frozen copy does not exclude the default roots: ccusage scanned both,
deduplicated across them, and split one session's usage between two report
entries. Under `HOME=<frozen>` the figures are unambiguous.

`test/fixtures/claude-code-session.jsonl` is one anonymized session from the same
machine, produced by `scripts/make-claude-code-fixture.mjs`. It assembles into
four turns totalling 2,374,226 tokens and $3.756718, against ccusage's 2,374,226
and 3.7567180000000007 for the same source; its first turn alone is 82,729 tokens
and $0.141602. `test/claude-code-pipeline.test.ts` asserts all three.

## Pricing arithmetic against ccusage

Cross-checked against `ccusage codex session --json` over a real 45-turn session:
applying TurnLens's rates to ccusage's own token counts reproduces ccusage's total
to the cent. The rate arithmetic is therefore identical, and the residual 0.62%
difference is token attribution alone.

Fall-through was measured rather than assumed: against an unroutable address the
resolver falls through in 5.0 seconds and prices correctly from cache.

## Windows, 27 July 2026

Everything before this was measured on Linux, which for two providers and a path
layer is a claim about one third of the target platforms. The same questions were
put to a Windows 10 machine (build 10.0.19045, Node 24.18.0) running Codex and
Claude Code under a Pro account.

Two rounds, and the distinction matters. **First a throwaway probe rather than the
product**: two scripts that read directories, count files and classify line
endings, run under **both PowerShell and Git Bash** because the two shells
disagree about the environment. Their output was cross-checked against two live
agent sessions, each asked to name its own transcript path -- so every location
below has two independent witnesses, the filesystem and the agent that wrote to
it. **Then TurnLens itself**, cloned from the public repository, built, and run
against real sessions of both agents.

| Claim | Measured |
| --- | --- |
| `os.homedir()` | `C:\Users\<user>`, identical under both shells |
| `path.sep` | `\`, and every path in the codebase is built with `join` |
| Codex transcripts | `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`, same nesting as Linux |
| Codex session names | `~/.codex/session_index.jsonl` present, so names resolve |
| Claude Code transcripts | `~/.claude/projects/<project>/<session-id>.jsonl` |
| Line endings | **LF**, not CRLF, in transcripts written by both agents |
| Lock exclusivity | `open(path, "wx")` succeeds once and fails the second time, under both shells |

Results:

- The test suite ran on Windows for the first time.
- Both providers listed their real sessions.
- **Turns were recorded live while the agent was writing.** Two from Claude Code
  and one from Codex, each priced, each appearing within a second or two of the
  answer completing. This was the highest risk in the whole exercise and no test
  could have retired it: Windows lets a writing process decide whether anyone else
  may read, so an agent that opened its transcript without sharing would have made
  tailing impossible.
- The lock was taken under the user's home, refused a second watcher, and was
  removed on exit. Ctrl+C printed the summary first, which is not obvious there:
  the handler covers `SIGTERM` and `SIGHUP` as well, and neither exists on
  Windows.
- The CSV landed under the working directory, parsed as 27 well-formed columns,
  and used LF line endings.
- The empty-listing diagnostic printed its searched root and both variables.

**No code change was required to make session discovery work.**

### Three things settled

**The `resolveTurnlensHome` soft spot did not reproduce.** The concern was that
Git Bash sets `HOME` somewhere other than the Windows profile, moving the lock
directory with it. Both shells resolve to `C:\Users\<user>`.

**A smaller and real defect surfaced instead.** `core/paths.ts` read `HOME` before
falling back to `os.homedir()`, while both provider modules called `os.homedir()`
directly. On any setup where the two disagree -- MSYS2 with a Unix-style `HOME`,
Cygwin, or a user who sets the variable by hand -- TurnLens would look for
sessions under one home and write its lock and pricing cache under another. Not a
wrong home; two homes in one program, and a defect independent of any platform.
**Since fixed**: every module now resolves through `core/home.ts`.

**Claude Code's desktop application writes to the standard location.** Its
documentation states that the desktop app, the web version and the VS Code
extension each keep their own session history, which left open whether the desktop
build used a different root. It does not.

**Neither agent keeps transcripts under `%APPDATA%` or `%LOCALAPPDATA%`.** Both
`claude` directories are absent there. Codex has a directory under each, holding
`Logs/` and `web/` respectively -- neither is session data.

### The desktop marker, and MSIX redirection

The marker lives in the desktop client's own store:

```
~/.config/Claude/claude-code-sessions/<a>/<b>/local_<client-id>.json                     Linux
%LocalAppData%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude-code-sessions\    Windows
```

Both were measured. `anthropics/claude-code#24534` reports `%AppData%\Claude\`,
and that is not wrong so much as inside-out: the desktop client installs as an
MSIX package, and Windows redirects a packaged application's `%AppData%` and
`%LocalAppData%` writes into its own container. The application writes the path
the issue names; from outside the container that path does not exist.

**That redirection does not touch what TurnLens reads, and not by luck.** MSIX
virtualises `%AppData%` and `%LocalAppData%`; it does not virtualise the user
profile root, and `~/.claude` and `~/.codex` sit at the profile root. A future
provider whose files live under `%AppData%` would not be so lucky.

## Windows, 28 July 2026

The run above asked where session files live. This one asked how the table looks
once it is printed, and it exists because the first run could not have found the
defect: it measured paths, line endings and locks, none of which have a width.

Reported as the `Tools` heading splitting into `Too` and `ls` under PowerShell
while the same session read cleanly under GNOME Terminal. The live table was 174
characters wide and nothing measured the terminal.

| Run | Measured width | Result |
| --- | --- | --- |
| Half-width window | **134 columns** | 13 of 16 columns, notice printed, nothing wrapped |
| Same window maximised | above 174 | full table, no notice |
| Freshly opened maximised terminal | above 174 | full table, no notice |

The 134 is worth recording. It had already been *derived* from where the reported
break fell -- `Tools` occupies positions 132 to 136, so a split after `Too` is a
break at 134 -- and written down as an inference. The terminal then reported 134
independently. `selectLayout(134)` produces exactly what was seen.

Default launch widths, for reference: 80 columns for GNOME Terminal,
Terminal.app and cmd.exe; 120 for Windows Terminal and the PowerShell shortcut.
Windows Terminal opens at 120 whatever the screen size unless `launchMode` is
`maximized`. On Linux the window is habitually maximised, roughly 190 to 210
columns at 1080p. **That difference in habit, not any difference in the platforms,
is why one machine showed a clean table and the other did not.** A 1366x768 laptop
maximised reaches roughly 130 to 150 on all three.

The width is read through `ioctl(TIOCGWINSZ)` on Linux and macOS and
`GetConsoleScreenBufferInfo` on Windows. Node reaches both through libuv's
`uv_tty_get_winsize`, whose Windows implementation returns the **visible window**
width rather than the console screen buffer width. Legacy conhost can hold a
buffer wider than its window, so reading the buffer would have reported a width
the user cannot see.

Re-measured after the fix: the notice is correct in a small window, and the rule
ends where it should once the window is maximised. The re-flow no longer happens,
which also confirms the diagnosis -- an exactly full-width line was the cause, and
one reserved column was sufficient.

The session listing was verified on Windows and on Ubuntu. Its 100 characters do
not fit the 80 that GNOME Terminal, Terminal.app and cmd.exe all open to, so it
wrapped by default on two of the three platforms. It now survives to 92 columns
with the date, and below that the name returns to full width.

## The desktop store, re-measured 29 July 2026

The earlier reading of `~/.config/Claude/claude-code-sessions/` counted five
files and found that four of their names matched no transcript. Counted again on
the same machine, with more of them present:

| Measured | Figure |
| --- | --- |
| Transcripts under `~/.claude/projects/` | 18 |
| `local_<client-id>.json` records | 9 |
| of those, `isArchived: true` | 1 |
| `deleted_<uuid>` entries | 8 |
| of those, whose transcript is still on disk | 4 |

**Half the sessions on this machine have no desktop record of any kind.** The
transcript is written by the CLI; the record only exists for sessions the desktop
client opened. Anything built on that store is therefore partial by construction,
and its default has to be *visible* -- a terminal-only user has no records at all
and must not end up with an empty listing.

Two corrections to what was recorded before.

**`deleted_<uuid>` entries are files, not directories.** Thirteen bytes each,
holding a millisecond timestamp and nothing else -- `1785265698128` in the one
opened.

**Their uuid is the transcript's, not the client's.** This is the opposite of
`local_<client-id>.json`, whose name is the client's own id and whose join key
(`cliSessionId`) is a field inside. Four of the eight resolve directly to a file
under `~/.claude/projects/`.

So the store carries two markers with different costs. Archival needs every file
in the tree opened and an undocumented schema read; deletion is a filename
match. The decision not to join the first was made on the cost of the first, and
does not carry to the second. That the four deleted sessions are still listed by
TurnLens is a fact about today, not a defect that has been ruled on -- it is
raised as an open question in `ROADMAP.md` rather than settled here.

Measured live rather than on a frozen copy, which is acceptable because the
question is the shape of an external store and not a figure TurnLens produces.

## Archived and deleted sessions resume from the CLI, 29 July 2026

Two throwaway sessions were opened in the desktop client under
`~/Desktop/projects/turnlens-docs`, each given one message so a transcript
existed. One was then archived, the other deleted, and both were resumed from a
terminal with `claude --resume <id>` and asked a question.

**Test 1, archived** (`2b8c11ec`):

| Step | Flag | Transcript |
| --- | --- | --- |
| Before archiving | `isArchived: false` | 41 KB, 18:07:46 |
| After archiving | `isArchived: true` | 41 KB, 18:09:57 |
| After `--resume` and one message | **`isArchived: true`** | **48 KB, 18:15:04** |
| After unarchiving in the client | `isArchived: false` | 48 KB, unchanged |

**Test 2, deleted** (`67b9cae2`):

| Step | Record | Transcript |
| --- | --- | --- |
| Before deleting | present, `isArchived: false` | 36 KB, 18:07:59 |
| After deleting | **record removed**, `deleted_<uuid>` written | 36 KB |
| After `--resume` and one message | still only the marker | **45 KB, 18:21:45** |

Four results.

**Both resumed.** The session opened with its history, took a message and
answered. `claude --resume` refuses neither an archived nor a deleted session.

**Both grew.** 41 KB to 48 KB and 36 KB to 45 KB. The tokens were spent and
written to the transcript TurnLens reads.

**Neither marker cleared.** `isArchived` stayed `true` through a full exchange,
and the deletion marker stayed in place. Resuming does not undo either.

**The two operations differ in the store.** Archiving keeps the
`local_<client-id>.json` record and flips a field. Deleting removes the record
entirely, leaving only the thirteen-byte marker -- so a deleted session has no
title, `cwd`, model or turn count left anywhere in the desktop store.

**The pairing was seen live.** Deleting `67b9cae2` also wrote a marker for
`72e6cd8c`, a uuid with no transcript and no record anywhere under `~`, before or
after. Every deletion measured so far has written two markers, one of which
corresponds to nothing. Still unexplained.

**Correction.** An earlier note here, taken from open issues rather than
measured, said archiving is one-way with no unarchive in the interface.
Unarchiving worked on this machine and set `isArchived` back to `false`, verified
on `2b8c11ec`. The issues are real but narrower than the note made them: the
option is reported missing or not working on some desktop versions, which is a
known gap rather than the general rule.

**What the client does with each, for context.** Archiving takes a session out of
the Recent list and gives it a `Status: Archived` filter it can be viewed under,
and it is also the action that removes a worktree Claude created for that session.
Deleting removes the session from the client's list altogether: there is no trash
filter and no restore in the interface, and a resume from the terminal does not
reliably return it to the client's Recent list. The transcript survives both, so
after a delete the CLI is the only way back to the conversation.

Measured on one machine, one Linux desktop client, one case each. The desktop and
web clients' own behaviour towards an archived session was not tested; only the
CLI was.

## Codex archiving, measured 29 July 2026

The Claude Code test above asked whether a hidden session can still be used. The
same question was put to Codex, through the VS Code extension, which is how Codex
runs on this machine.

A new session was created, given one message, then archived.

| Step | `sessions/` | `archived_sessions/` | `session_index.jsonl` |
| --- | --- | --- | --- |
| Before | 20 | 5 | 11 names |
| After creating | **21** -- 52,489 bytes, 20:33 | 5 | **12 names** |
| After archiving | 20 | **6** -- 52,489 bytes, 20:33 | 12 names |

**The file is moved, not rewritten.** Byte count and modification time are
identical either side of the move, so an archived transcript keeps the timestamp
that would sort it.

**The name survives.** The `session_index.jsonl` entry stays after archiving, so
an archived session still resolves to its display name rather than
`(unnamed session)`.

**Archiving is not reversible from the extension.** There is no unarchive there.
The only way back is to move the file into `~/.codex/sessions/<year>/<month>/<day>/`
by hand -- the account owner had previously written a small tool to do exactly
that.

**So an archived Codex session cannot produce another turn while it is archived**,
which is the opposite of Claude Code, where the marker leaves the session fully
usable. Restoring it puts the file back under the scanned root, where TurnLens
finds it again with no code involved.

### The archived directory is flat, and that is a trap for reporting

Live transcripts are nested by date; archived ones sit directly in
`archived_sessions/`. `sessionId` is derived as `relative(sessionsRoot, path)`
(`providers/codex/sessions.ts`), so the same transcript yields two different ids
depending on which root it was read from:

```
sessions/2026/07/29/rollout-…jsonl   ->  2026/07/29/rollout-…
archived_sessions/rollout-…jsonl     ->  rollout-…
```

The CSV filename comes from that id. A reporting pass that scans
`archived_sessions/` naively would therefore write a second CSV for a session
that was watched before it was archived, and count it twice.

## The package, re-measured 29 July 2026

Taken before Plan 4 starts, because the section describing it was written on
27 July and several of its figures had moved since.

| Measured | Then | Now |
| --- | --- | --- |
| `npm pack` file count | 31 | **35** |
| Packed size | 37 kB | **47.7 kB** |
| Unpacked size | -- | 160.5 kB |
| Test suite | 375 across 28 files | **423 across 30 files**, all passing |
| `turnlens` on npm | unclaimed | **still unclaimed** (`404 Not Found`) |

The four files are `dist/core/env-paths.js`, `dist/core/home.js`,
`dist/ui/banner.js` and `dist/ui/terminal.js` -- Plans 3.5, 3.6 and 3.7 adding
modules. Nothing about packaging changed, which is why the growth needed no
decision, only a corrected number.

Two package facts checked at the same time, both against the machine rather than
against documentation:

- Node 24.18.0 bundles npm 11.16.0, so the claim that the publish job must leave
  Node 22 behind holds. The current npm is 12.0.1, one major further on, which is
  the case the "install the latest npm regardless" step exists for.
- `npm trust github` is present and takes the workflow filename as `--file`. The
  filename being part of the trust configuration is therefore literal, not a
  convention someone might rename past.

Three claims in that section were wrong rather than merely dated, and are
corrected where they stood: the surviving `HOME` divergence no longer exists in
the source, `package.json` still declares `>=20.0.0` against the README's 22, and
the repository has since gained three tracked symlinks that a Windows checkout
will materialise as plain files.

## Still unmeasured

**macOS.** The findings above are expected to hold, because `os.homedir()` and
dotfile conventions match Linux more closely than Windows does. Expectation is not
measurement, and this document will say so until it has been checked.

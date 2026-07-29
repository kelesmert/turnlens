---
purpose: What a run writes to disk and prints to the terminal, and how both are fitted.
update-when: The CSV schema, a printed surface, or the width-fitting rules change.
---

# Output

**Sections:** What it does · Invariants · Traps · Where the code lives · Decisions

## What it does

Two surfaces. The CSV is the durable record, appended as turns close. The
terminal is a live view of the same turns, plus a session listing printed before
anything else and a summary printed on exit.

The CSV a run produces lands at
`turnlens-usage/<provider>/<session-id>.csv` under `process.cwd()`. It is the
user's output, so running from the desktop should leave it on the desktop.

The user-facing flags are whatever `turnlens --help` prints. That list is not
copied here, because a copy would be right until the next flag is added.

## Invariants

- **Rows are appended; an existing valid file is never rewritten.**
- **A header mismatch is refused, not repaired.** If an existing file's header
  does not match the current schema, TurnLens errors with the header it found and
  the header it expected, and does not touch the file. Changing the schema
  therefore cannot silently corrupt an earlier run's data.
- Prompt previews are opt-in, capped at 20 characters, whitespace-collapsed.
- **Nothing in `ui/` affects a recorded number.** It formats; it does not decide.
- Rate-limit values are reported raw. Window labels are derived from the recorded
  `window_minutes`, never hardcoded.
- Path segments are reduced to `[A-Za-z0-9._-]`, which is narrower than any
  single platform requires and identical on all of them. A segment made only of
  dots is rewritten so it cannot name a directory instead of a file.
- **Text is cut on grapheme boundaries**, via `Intl.Segmenter`, which is built
  into Node. Cutting a character in half is data corruption rather than a display
  flaw, and it reached the CSV.

## Traps

- **One column of the terminal is deliberately left unused.** Fitting the table
  to exactly the measured width was the obvious target and the wrong one. A line
  that fills the last column leaves the cursor at the right margin, and terminals
  record such a line as continuing into the next; maximising the window afterwards
  re-flows the pair together. Observed on Windows: a rule printed at exactly 134
  characters ran past the `Duration` column once the window was enlarged. This is
  the only place in the codebase that reasons about a terminal's own behaviour
  rather than its size.
- **Terminal width is not a property of the screen.** It is the window's pixel
  width divided by the character cell's, and the cell comes from the font and its
  size. The same machine yields 200 columns at a small font and 100 at a large
  one. **No width can be assumed** -- 80 is the default for GNOME Terminal,
  Terminal.app and cmd.exe; 120 for Windows Terminal and the PowerShell shortcut.
- **Nothing here branches on platform, and it must stay that way.**
  `process.stdout.columns` and `COLUMNS` behave identically on all three.
- **`truncate` cuts from the front; `truncateEnd` keeps the end.** The second
  exists for identifiers: a Codex session id is
  `rollout-<timestamp>-<uuid>`, the uuid identifies it, and the date is already
  shown in its own column, so cutting from the right would discard the only part
  worth reading. The reason outlived its original example -- the id used to carry
  `<year>/<month>/<day>/` in front as well, and dropping those made the string
  shorter without making the front of it any more worth keeping.
- **Display width is still counted in code units**, and this is deliberate. See
  Decisions before "fixing" it.
- **The session listing gives up its date last, not first.** Three of its four
  columns are never dropped -- the number the user types, the name a session is
  recognised by, and the id that matches a CSV filename. Removing the date frees
  21 characters, so dropping it to recover one leaves a 100-column terminal
  printing a 79-column listing. The name narrows first; the date goes only once
  the name would fall below 24 characters.

## Where the code lives

```
src/core/store/csv.ts    header check, append, column order
src/core/text.ts         collapseWhitespace, truncate, truncateEnd, preview cap
src/core/paths.ts        CSV path, segment sanitisation
src/ui/live-table.ts     fit, selectLayout, column dropping
src/ui/terminal.ts       width measurement
src/ui/prompts.ts        session listing
src/ui/summary.ts        exit summary
src/ui/banner.ts         startup banner
```

## Decisions

- `displayWidth` deferred; code units retained -- `DECISIONS.md`
- CSV as the store format, and what would replace it -- `DECISIONS.md`, `ROADMAP.md`
- The provider segment in the CSV path buys readability, not correctness --
  `DECISIONS.md`
- Width measurements from two Windows runs -- `../VALIDATION.md`

---
name: live-verification
description: Checks TurnLens against live agent data without measuring a moving target. Use when comparing totals against an oracle such as ccusage, reproducing a reported miscount, confirming a fix against real sessions, or taking any figure that will be treated as evidence.
---

# Live verification

A session file grows while it is being read. Any figure taken from a file that is
still being written measures the growth, not the program. This has already
produced one false result, and the rules below exist because of it.

## Never verify against the session doing the work

**Do not verify TurnLens against the agent session that is running the
conversation.** Point it at a separate, idle session instead.

On this machine that session is **"Superpowers plugin installation"**
(`79c14101-4f5d-4793-ab69-8649e76d2062`). Start or resume it in its own terminal,
drive it deliberately, and watch that one.

## This binds verification, not use

The user running TurnLens on their own session, as a user, is the product
working. Say nothing about it.

The rule binds only work done to check whether TurnLens is correct: comparing
totals against an oracle, reproducing a bug, confirming a fix. If a watcher is
running on the current session, that is worth raising only when a figure from it
is about to be treated as evidence.

## Copy a static file before measuring it

When a file has to be measured rather than watched, copy it first and measure the
copy, so the bytes cannot change between two tools reading them.

Comparing across tools needs an isolated `HOME` as well. Pointing
`CLAUDE_CONFIG_DIR` at a frozen copy does **not** exclude the default roots:
ccusage scans both, deduplicates across them, and splits one session's usage
between two report entries. Under `HOME=<frozen>` the figures are unambiguous.

## The false result this prevents

A live file was compared against a `ccusage` run taken minutes later, and the
resulting 0.33 percent gap was reported as a token-attribution difference. It was
the file growing during measurement.

Repeated on a frozen copy, the same rules reproduce ccusage exactly, with no
difference in any figure. Both runs are recorded in `docs/VALIDATION.md`.

## Recording the result

A measurement is appended to `docs/VALIDATION.md`, never written over an earlier
one. A figure later found wrong is corrected by a new entry, because the original
figure is part of the record.

`docs/` is gitignored and is not in a clone. Where it is absent, report the
figure and say where it was taken rather than inventing a file to put it in.

---
name: design-doc
description: Produces one design document for work that will be implemented in the same session. Use when designing a feature, a refactor or a change that the session doing the design will also carry out, and to decide whether a full plan is needed instead.
---

# Design documents for inline work

**When the work will be done inline, `superpowers:brainstorming` writes one
document and `superpowers:writing-plans` is not invoked afterwards.** The
document goes to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Nothing
is written to `docs/superpowers/plans/`.

## Why one document

The plan format carries working code because a fresh subagent sees only its own
task and cannot ask a question. Inline there is no such reader: the session that
designs the work also implements it. The code is then written twice -- once
unverified in the plan, once again while implementing. Plans 1 through 3 spent
8,439 lines that way to produce 7,557 lines of source and tests.

## What the document contains

Everything a spec had -- problem, decisions with their reasoning, verified
findings, out of scope -- plus the parts of a plan that survive inline:

- **Global constraints**, copied verbatim, so no task re-decides them.
- **Tasks in order**, each ending in a commit. Per task: the deliverable, the
  files to create or modify, the interface it produces as **signatures only**,
  which existing code to reuse rather than rewrite, the behaviours that must hold
  and therefore be tested, and the command that proves it together with its
  expected output.
- A self-review of the finished document: spec coverage, placeholders, and type
  consistency between tasks.

**No implementation bodies and no pre-written test bodies.** Both are unverified
code, and TDD derives an implementation from its test rather than from a
document. `docs/superpowers/plans/2026-07-27-turnlens-pre-release-cleanup.md` is
the shape to copy: 344 lines, one `interface` block, behaviours as prose.

## One gate, not two

One document means one review gate where there were two. Present the design in
sections and take approval as you go, so the written file records a design
already agreed rather than being the first sight of it.

## The exception

Work that will be handed to **parallel subagents** gets a full
`superpowers:writing-plans` plan in the old format, code and checkboxes included,
because there the cold reader is real.

## Afterwards

A design document is scaffolding. `docs/superpowers/` is not part of the
repository. Anything in it that outlives the work it was written for is moved:
reasoning to `docs/DECISIONS.md`, current behaviour to `docs/areas/`, figures to
`docs/VALIDATION.md`, remaining sequence to `docs/ROADMAP.md`.

---
purpose: How the documents under docs/ are organised, and what keeps them true.
update-when: A document class is added or removed, or a rule for writing them changes.
---

# Documentation conventions

**Sections:** What these documents are for · Classes · The header every document carries · What belongs in a document · Documents route, code decides · Detail has one home · Check a document against the code before editing it · How each class is updated

## What these documents are for

They are a map, not the territory. Their job is to make finding something cheap:
where to look, what was already decided, what was already measured. **The source
of truth is the code.**

That makes them living documents rather than a fixed manual. A document changes
in the same commit as the work it describes, not in a documentation pass
afterwards, because a pass that is deferred is a pass that does not happen. Each
file names the change that obliges an edit, in `update-when`, so nobody has to
remember.

A document that has not moved while the code it describes has is not stable. It
is unverified.

Five classes, split by how often they change rather than by subject. A document
that records a measurement and a document that describes current behaviour age
at completely different rates, and putting them in one file is what made the
single `ARCHITECTURE.md` expensive to keep current.

| File | Class | Sections | Changes |
| --- | --- | --- | --- |
| `ARCHITECTURE.md` | Explanation | Quality goals · Constraints · Solution strategy · Building blocks | Rarely |
| `areas/*.md` | Reference | What it does · Invariants · Traps · Where the code lives · Decisions | With the code |
| `DECISIONS.md` | Record | per decision: Context · Decision · Consequences · Status | Appended |
| `VALIDATION.md` | Record | per run: What was measured · Method · Result | Appended |
| `ROADMAP.md` | Plan | Plans · Open questions | As work moves |
| `FUTURE.md` | Plan | per candidate: What was observed · Why deferred · Decisions to make | As candidates are raised or dropped |
| topic documents | Plan | The question · What was measured · Why nothing is decided · Decisions to make | While the question is open |

A topic document is one question, held open on purpose, with the evidence
gathered for it in one place. `SESSION-LIFECYCLE.md` is the first. A question
earns its own file when the measurements behind it outgrow a section of
`FUTURE.md`; when it is answered, the answer moves to `DECISIONS.md` and the
figures to `VALIDATION.md`, and the file goes.

`areas/` follows the pipeline: `providers`, `turns`, `pricing`, `output`,
`runtime`. Each is a stage that can be reasoned about without opening the
others, which is the only test a split has to pass.

## The header every document carries

```
---
purpose: One sentence. What this document holds.
update-when: The change that obliges someone to edit this file.
---

# Title

**Sections:** A · B · C
```

`purpose` is a routing key, not a summary. It is read to decide whether to open
the file at all, so it says what is inside rather than why it matters.

`update-when` is an acceptance criterion. A change that matches it is not
finished until this file is edited.

The `Sections` line exists so a reader can reach one section without loading the
whole file. Keep it in document order.

No document carries a hand-written date. `docs/` is committed, so
`git log -1 --format=%ad -- <file>` is exact and cannot drift out of step with
the content the way a line typed by hand does.

## What belongs in a document

Write what the code cannot state: why a boundary was drawn, what must not be
changed, what was tried and rejected, what looks like a defect and is deliberate.

Do not write directory listings, file inventories, function signatures or
dependency lists. An agent derives those in one command, and they are always
right when derived. Written down, they are right until the next commit and then
quietly wrong, which is worse than absent.

The same test decides borderline cases: if it can be recovered by reading the
code, leave it to the code.

## Documents route, code decides

Reading a document is not the same as knowing what is true now. A record says
what was decided and why it was decided *then*; the code says what happens
today, and the two drift apart in one direction only.

So the obligation depends on what is about to be done with the answer:

| Doing this | Enough |
| --- | --- |
| Finding where to look | The document |
| Learning that a choice was already made, and why | The document |
| **Changing code** | **Open the files the area document names** |
| **Stating what is true now** | **Open the files the area document names** |
| **Proposing to reverse a decision, or refusing to** | **Open the files the area document names** |

The last row is the one that gets skipped. A record knows why a decision was
made; it does not know what would break today, because the code has moved since
it was written. Answering "no, that was decided against" from the record alone
produces the answer that was right on the day the record was written.

This is not hypothetical. Asked whether a second pricing source should be added,
a session holding this documentation cited the decision and never opened
`pricing/`. A session without it read `types.ts`, `litellm.ts` and `resolver.ts`
and found three things the record does not contain: the unit and shape mismatch,
the `RawPricingEntry` contract it would break, and a rate tier the second source
does not carry. Both refused the change. Only one of them knew what refusing was
protecting.

The **Where the code lives** section in each area document exists for this. It is
not an index; it is the list of files to open before acting.

## Detail has one home; scope may be named anywhere

The rule is about depth, not about mentions. A fact may be named at more than one
level as long as only one document holds it in full.

| Level | Holds | Example |
| --- | --- | --- |
| `AGENTS.md` | The instruction, one line | "An unpriced turn is empty, not zero." |
| `ARCHITECTURE.md` | The goal it serves, in passing | "Never invent a number." |
| `areas/*.md` | **The detail** -- what is true, precisely | Which field, which `cost_status` values |
| `DECISIONS.md` | Why, and what was traded away | The spreadsheet-sum argument |

Detail always belongs to the area document. `ARCHITECTURE.md` may say that
pricing resolves in three layers; what each layer is, and what happens when one
fails, belongs to `areas/pricing.md` and nowhere else.

The test is depth, not repetition: **if two documents state the same thing at the
same level of detail, one of them is wrong.** Cross-reference by path and section
instead of copying, because two copies become two versions.

## Check a document against the code before editing it

A document is edited on the assumption that what is already in it is still true,
and that assumption is how stale text survives. Before changing a document, check
the claims it makes about the code -- a claim that names a file, a function, a
field or a flag can be verified in one command, and a claim that no longer holds
is corrected in the same edit rather than left for a later pass.

This has already caught one: `ARCHITECTURE.md` described the provider modules
resolving the home directory separately from `core/paths.ts` as a live defect,
after it had been fixed and every module routed through `core/home.ts`. The
passage now records it as resolved, in `VALIDATION.md`.

The check is cheap in proportion to the claim. Verify what the document asserts,
not the whole file.

## How each class is updated

**Reference** (`areas/*.md`) is edited in place. It describes what is true now,
so an obsolete line is deleted rather than annotated.

**Records** (`DECISIONS.md`, `VALIDATION.md`) are never edited in place. A
decision that changes is superseded by a new entry that links to it and says why;
the old entry stays and is marked. A measurement that is later found wrong is
corrected by a new entry, because the original figure is itself part of the
record. The chain is the value.

**Explanation** (`ARCHITECTURE.md`) changes only when a structural decision does,
and then usually by one paragraph.

**Plans** (`ROADMAP.md`) hold two different things and the line between them is
worth keeping sharp: a plan is work that is intended, an open question is a
choice nobody has made yet. A question that gets answered moves to
`DECISIONS.md` rather than being deleted here.

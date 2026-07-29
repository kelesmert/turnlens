---
purpose: What archiving and deleting a session actually do in each agent, and whether TurnLens should keep listing one.
update-when: An agent changes what archive or delete does, a resume test is run, or one of the open decisions below is made.
---

# Session lifecycle

**Sections:** The question · What each agent does · Where the markers live · What was measured · Why nothing has been decided · Decisions to make · What would settle it

A session the user archived or deleted still appears in TurnLens's listing and can
be selected for watching. The intent is that it should not: a conversation that
cannot receive another message cannot produce another turn, so offering it is
offering something that will never print a row.

Whether that premise holds is the open part, and the evidence currently runs
against it.

## What each agent does

Measured on this machine, 29 July 2026. The two agents do not mean the same thing
by "archive", and only one of them has a deletion at all.

| | Codex | Claude Code |
| --- | --- | --- |
| **Archive** | **Moves the transcript** to `~/.codex/archived_sessions/`. Counted: 5 archived against 20 live | **A flag, nothing more.** `isArchived: true` in the desktop client's store; the transcript stays under `~/.claude/projects/` |
| **Delete** | **No such operation.** Nothing under `~/.codex/` records one | Writes a `deleted_<uuid>` file, 13 bytes, holding a millisecond timestamp. **The transcript stays** |

**Codex therefore needs nothing.** TurnLens already omits its archived sessions --
not by deciding to, but because the file is no longer where it looks. This is
worth stating plainly because it is easy to mistake for a precedent: TurnLens has
never chosen to hide a session it could see.

Every case that needs work is Claude Code's, and in both of them the transcript is
still on disk and still readable.

## Where the markers live

Outside the transcript tree, in a store belonging to the desktop client:

```
~/.config/Claude/claude-code-sessions/<a>/<b>/local_<client-id>.json   archive flag
~/.config/Claude/claude-code-sessions/<a>/<b>/deleted_<uuid>           deletion marker
```

The two cost different amounts to join, and the difference decides whether they
can be answered together:

- **`deleted_<uuid>` is named after the transcript's uuid.** Matching it is a
  filename comparison. Nothing is opened.
- **`local_<client-id>.json` is named after the client's own id**, and carries the
  transcript uuid inside as `cliSessionId`. Matching it means opening every file
  in the tree and reading a schema nobody documents.

The second cost is what settled *"The desktop client's `isArchived` marker is not
joined"* in `DECISIONS.md`. It does not carry to deletion.

## What was measured

**The marker only exists for sessions the desktop client opened.** Counted the
same day: **18** transcripts under `~/.claude/projects/`, **9** records in the
desktop store. Half the sessions on this machine carry no marker of either kind.

Any filter built on this store is partial by construction, and its default must
be *visible*: a terminal-only user has no records at all, and must not end up with
an empty listing.

**Nothing was written to a transcript after its deletion marker.** Of eight
markers, four name a transcript still on disk. For three, the last write and the
marker share a second; for one, the last write is five seconds earlier. So these
four sessions did stop -- but that is a fact about four sessions, not a property
of deletion.

**The other four uuids exist nowhere else.** Not under `~` anywhere, not in
`backups/`, not in any project directory. They most likely never had a transcript.
Retention does not explain them: the last cleanup ran hours before those
deletions.

**Exactly one session carries `isArchived: true`**, which matches what the desktop
client's own archived filter shows.

## Why nothing has been decided

**The premise is unverified, and the documentation runs against it.** Claude
Code's own session page states that the desktop app, the web version and the VS
Code extension *each maintain their own session history*, and the CLI page
describes neither archiving nor deletion. The flag lives in a store the CLI never
reads.

`claude --resume <session-id>` therefore has no reason to refuse an archived or
deleted session, and the transcript is still in place for it to read. If that is
right, **an archived session can still burn tokens through the terminal**, and
hiding it from the watcher removes something the user may deliberately want to
watch.

Archiving is also reported to be one-way: there is no unarchive in the interface,
and the documented workaround is editing `isArchived` back to `false` by hand.
That makes an accidental archive a permanent removal from the listing rather than
a temporary one, which raises the cost of getting this wrong.

**Retention bounds what any of it is worth.** Transcripts are kept for 30 days by
default, configurable through `cleanupPeriodDays`. Whatever is decided about
archived history, the history is not permanent.

## Decisions to make

1. **Can an archived or deleted session still be resumed from the CLI?** Nothing
   else here can be settled until this is measured. If it can, the premise fails
   and the answer is probably to label rather than hide.
2. **Hide, or label?** Codex sets no precedent either way, for the reason given
   above. Hiding a file that is visible and readable would be new behaviour, and
   this project's habit runs the other way: an unpriced turn is empty rather than
   absent, an empty listing names every root it searched, a narrowed table says it
   was narrowed.
3. **Archive and deletion together, or deletion alone?** Deletion is a filename
   match; archive is a tree walk and an undocumented schema. They can be answered
   separately and probably should be.
4. **What does the listing owe a session it hides?** If anything is hidden, the
   count belongs on screen, by the same reasoning as the diagnostics above.
5. **What does reporting count?** Watching and reporting pull in opposite
   directions. Both agents keep the transcript of an archived session, and Claude
   Code keeps a deleted one, so a total across all history can include them and
   arguably should -- the tokens were spent. That is the reverse of the listing
   decision, and it is why this is not one yes or no.

## What would settle it

A two-minute test, and it decides most of the above:

1. Archive an idle session in the desktop client.
2. From a terminal, in that session's directory, run `claude --resume <id>`.
3. Repeat with a deleted session.

Record the result in `VALIDATION.md`. If both resume, decision 2 answers itself
and this becomes a labelling feature. If neither does, hiding is defensible for
Claude Code and the remaining question is only decision 5.

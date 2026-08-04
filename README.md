# TurnLens

[![CI](https://github.com/kelesmert/turnlens/actions/workflows/ci.yml/badge.svg)](https://github.com/kelesmert/turnlens/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/turnlens.svg)](https://www.npmjs.com/package/turnlens)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Per-turn token and cost monitoring for Codex and Claude Code.**

Most usage tools tell you what a session or a day cost. TurnLens tells you what
**the prompt you just sent** cost, as soon as the agent finishes, along with the
tokens it used and the tool calls it made.

```text
   # Time     Status    Prompt                     Input       Cache    Output    Reason        Total       Cost Tools Model              Effort
--------------------------------------------------------------------------------------------------------------------------------------------------
  13 17:19:39 completed analyze the co...      87,103   1,470,976     3,269       891    1,561,348    $1.2691     9 gpt-5.6-sol        medium
      Tool calls: apply_patch=1, exec=4, exec_command=2, view_image=1, wait=1
  14 17:36:16 completed 1- follow task 5 as its..      58,872   1,135,872     1,632       201    1,196,376    $0.9113     6 gpt-5.6-sol        medium
      Tool calls: apply_patch=1, exec=3, view_image=1, wait=1
  15 17:56:40 aborted   resarch the latest...      23,616     334,336       886       445      358,838    $0.3118     2 gpt-5.6-sol        medium
      Tool calls: exec=1, exec_command=1
```

> [!NOTE]
> **Costs are API-equivalent.** Every figure is what those tokens would cost at
> published API rates. If you are on a Codex or Claude subscription, nothing here
> is charged to you; the number is what the same work would have cost through the
> API. Reasoning tokens are part of `Output` and are shown separately for
> visibility, which is why adding them again overshoots `Total`.
>
> **One gap is worth knowing up front:** Claude Code writes subagent work to a
> separate transcript that TurnLens does not read, so a total that includes
> subagent use is low by however much they spent. See [Limits](#limits).

Works with **Codex** and **Claude Code** on **Linux, macOS and Windows**. It runs
locally, has no runtime dependencies and never modifies agent session files.

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/7ea3d9d9-c382-447b-9182-881ac40f7b91"
    alt="TurnLens monitoring completed and interrupted AI coding-agent turns"
    width="1280"
  />
</p>

## When this is the right tool

A session total tells you the session was expensive. It does not tell you which
prompt made it expensive, and that is usually the thing you can act on.

- **Costing a skill, a command or a prompt you are writing.** Run it, read the
  one row it produced. Change the wording, run it again, compare. A session total
  cannot separate the two attempts; a per-turn row is the measurement.
- **Finding what actually spent the money.** Turns are not evenly priced. One
  prompt that pulled a large file into context can outweigh a whole morning of
  small ones, and it is invisible in any figure that averages.
- **Seeing what an interruption cost.** Work you stopped is recorded on its own
  row rather than folded into your next question, so pressing Ctrl+C after an
  agent has read half the repository shows up as its own number.
- **Deciding whether a setting is worth it.** A different model, or a different
  reasoning effort, is a before-and-after you can read directly.
- **Checking a month.** `turnlens report` answers what has already been spent,
  by day, week, month or session, without having watched any of it.

If all you need is a monthly total, a broader tool will serve you better, and
[ccusage](https://github.com/ryoppippi/ccusage) covers more agents.

## Install

```bash
npx turnlens@latest
```

Or for a permanent command:

```bash
npm install -g turnlens
```

Node 22 or newer.

`npx turnlens@latest` always runs the newest release. A global install does not:
npm pins whatever version was current when you ran it. So once a day, before it
starts, TurnLens asks the registry whether something newer exists and prints two
lines if so:

```bash
npm install -g turnlens@latest
```

It asks nothing else and installs nothing. The check is skipped under
`--offline`, under `NO_UPDATE_NOTIFIER`, in CI, and whenever output is not a
terminal.

<details>
<summary>From source</summary>

```bash
git clone https://github.com/kelesmert/turnlens.git
cd turnlens
npm install
npm run build
node dist/cli.js --help
```

</details>

## Usage

Two modes. Watch a session as it runs, or count what has already been spent.

```bash
turnlens claude            # watch: pick a session and follow it
turnlens claude report     # count: what has been spent already
```

Everything is one of these, in this order:

```
turnlens [claude | codex] [report [daily | weekly | monthly | session]] [options]
```

Agents are `claude` and `codex`. `claude-code` is accepted for `claude`; they are
the same agent and reach the same place. Each mode documents its own flags:

```bash
turnlens --help
turnlens claude --help          # what watching takes
turnlens claude report --help   # what a report takes
```

### Watching

TurnLens lists the sessions it can find, most recently active first, and asks
which one to watch. On selection it prices the turns the session already closed
and shows them as one summary line, then follows the transcript and prints a row
each time a turn closes. Stop with Ctrl+C; a summary is printed on exit.

Those earlier turns are counted in the on-screen summary only. **Only turns that
close while you are watching are written to the CSV**, which is why a report and
a CSV of the same session can hold different numbers of rows.

```bash
turnlens                            # ask which agent, then which session
turnlens codex                      # Codex, pick from its list
turnlens claude --id a3f2c891       # skip the list
turnlens --id a3f2c891              # the id alone says which agent
turnlens codex --prompt-preview     # also record 20 characters of each prompt
```

Watching asks which agent when none is named, because two sessions cannot be
followed at once. A prefix is enough for `--id` as long as it is unique; if more
than one session answers to it you are shown the matches and asked which, and
piped input is not asked but stops instead.

```
  --id <session>       Skip the list. A full session id or a unique prefix.
                       Works without an agent: the id says which one.
  --prompt-preview     Record a 20-character preview of each prompt.
                       This writes part of your prompt to disk.
  --no-prompt-preview  Never record prompt previews.
  --no-color           Print without colour.
  --offline            Price from local data only. Never access the network.
  --refresh-pricing    Download the pricing list now, even if it looks current.
  --help               Show this message
```

### Reporting

A report reads the agents' own transcripts, so it works whether or not you have
ever run the watcher. Nothing is written and no session is followed. Naming no
agent covers every agent rather than asking for one.

One word after `report` says how the rows are grouped. There are four, and
`daily` is what you get by leaving it out:

| Grouping | Rows |
|---|---|
| `daily` | one row per day, the default |
| `weekly` | one row per week, beginning Monday |
| `monthly` | one row per month |
| `session` | one row per session |

```bash
turnlens report                                  # every agent, by day
turnlens codex report                            # Codex only, by day
turnlens claude report weekly                    # weeks begin Monday
turnlens claude report monthly
turnlens report session                          # one row per session
turnlens codex report session --id a3f2          # that session's total
turnlens codex report session --id a3f2 daily    # that session, day by day
```

Both date bounds are inclusive, both take `YYYY-MM-DD`, and either can stand
alone:

```bash
turnlens report --since 2026-07-01
turnlens report --until 2026-07-31
turnlens claude report weekly --since 2026-07-01 --until 2026-07-31
```

```text
╭───────────────────────────────────────────────────────────────╮
│   Claude Code Token Usage Report - Daily                      │
│                                                               │
│   28 sessions over 10 days                                    │
│                                                               │
│   2026-07-25 to 2026-08-04, Europe/Istanbul                   │
│   Priced at today's rates, from litellm@sha256:ba37bb46dc46   │
╰───────────────────────────────────────────────────────────────╯

┌────────────┬─────────────┬──────────────┬──────────────┬─────────────┐
│ Date       │ Models      │        Input │       Output │  Cost (USD) │
├────────────┼─────────────┼──────────────┼──────────────┼─────────────┤
│ 2026-08-03 │ - haiku-4-5 │        3,753 │      384,852 │     $100.46 │
│            │ - opus-5    │              │              │             │
├────────────┼─────────────┼──────────────┼──────────────┼─────────────┤
│ 2026-08-02 │ - opus-5    │        9,033 │      252,133 │      $40.29 │
├────────────┼─────────────┼──────────────┼──────────────┼─────────────┤
│ TOTAL      │ - haiku-4-5 │       12,786 │      636,985 │     $140.75 │
│            │ - opus-5    │              │              │             │
└────────────┴─────────────┴──────────────┴──────────────┴─────────────┘
```

That is a narrow terminal, which is why cache columns are missing and the costs
look larger than the tokens beside them explain. Cache reads are most of what an
agent spends; a wider terminal shows them, and `--json` always carries every
category.

A period that used more than one model gets a line per model rather than a cut
list. Model names are shortened for reading; `--json` keeps the full identifier.

```
  --id <session>       One session only. Goes with the word `session`.
  --since <date>       Earliest day to include, YYYY-MM-DD. Inclusive.
  --until <date>       Latest day to include, YYYY-MM-DD. Inclusive.
  --json               Machine-readable output on stdout.
  --compact            Fewer columns, whatever the terminal's width.
  --no-color           Print without colour.
  --offline            Price from local data only. Never access the network.
  --refresh-pricing    Download the pricing list now, even if it looks current.
  --help               Show this message
```

Days are your local days, and every report says which timezone it used. The box
above the table says what the figures cover: how much was read, over what window,
priced against which list, and how many turns could not be priced at all.

Handing a report to something else:

```bash
turnlens report --json > usage.json
turnlens report --json | jq '[.buckets[].costUsd] | add'
turnlens report --compact           # fewer columns whatever the width
```

`--json` prints one object with two keys. `buckets` is the rows, each carrying
its label, turn count, every token category separately, its models as full
identifiers, and its cost. `coverage` is what the box says: sessions read, days,
per-agent counts, the window, the timezone, the unpriced count and the pricing
version. There is no grand total, and a bucket with no cost omits `costUsd`
rather than reporting zero, which is why summing is left to the consumer.

Colour never carries meaning of its own: yellow marks a turn that could not be
priced and a turn you interrupted, both of which are spelled out in words too.
Turn it off with `--no-color` or `NO_COLOR`. It is already off when output is not
a terminal.

## How the numbers work

Worth reading once, because these decide what a figure means.

**A turn is one prompt and everything the agent did to answer it.** It closes
when the agent finishes, when you interrupt it, or when the conversation is
compacted, and each closed turn is recorded with the status that closed it:
`completed`, `aborted` or `compacted`.

**Interrupted work is recorded separately**, not folded into whatever comes next.
This matters more than it sounds: an interrupted turn can be the most expensive
one in a session, and a tool that quietly bills it to your next question is
answering the wrong question.

**A turn counts on the day you sent the prompt**, not the day the agent finished
answering. It only differs for a turn that runs across midnight, and the reason
is that the alternative makes the day depend on how long the agent thought: the
same question asked at 23:55 would land on a different day depending on whether
the answer took four minutes or twelve. The CSV still records when each turn
closed.

**A report and a CSV can disagree, on purpose.** A report prices every turn at
today's rates, because a transcript records tokens and not the rate that applied
when the turn closed. A row the watcher wrote keeps the rate of its own moment.
If you want figures that stay put when upstream prices change, keep the CSVs.

**Archived sessions are always counted** by a report. Their tokens were spent,
and there is no option to leave them out of a total. Watching excludes them,
because an archived session has ended and cannot be followed.

## Where output goes

One CSV per session, under the directory you ran the command in:

```
turnlens-usage/<provider>/<session-id>.csv
```

Rows are appended and never rewritten. A closed turn keeps the price that was in
effect when it closed, and records which pricing list that was, so a rate change
upstream never moves a number you already have.

27 columns, named in the header row: timestamps and status, the model and its
reasoning effort, every token category separately, the cost and which pricing
list produced it, tool calls, rate-limit windows and duration.

An empty cost is always explained by the `cost_status` column. TurnLens never
records a cost of zero for a model it could not price, because a zero joins a
spreadsheet sum and cannot be told apart from a genuinely free turn.

TurnLens's own state, the pricing cache and session locks, lives under
`~/.turnlens/`.

## Environment

Nothing here has to be set. Each variable exists because a default can be wrong
on some machine.

| Variable | Purpose |
|---|---|
| `TURNLENS_HOME` | Where the pricing cache, session locks and update check live. Default `~/.turnlens/`. |
| `TZ` | Which timezone a report's days are cut on. Default is the machine's. Every report prints the zone it used. |
| `NO_COLOR` | Turns colour off. See above. |
| `NO_UPDATE_NOTIFIER` | Set to anything to stop TurnLens checking for a newer release. `CI` does the same. |
| `COLUMNS` | Table width in characters, overriding what the terminal reports. The only way to correct a measurement that is wrong, as it can be under tmux or over SSH. Ignored when output is not a terminal, where there is no window to fit. |
| `CODEX_HOME` | Where Codex keeps its sessions. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code keeps its sessions. |
| `XDG_CONFIG_HOME` | Consulted for Claude Code when `CLAUDE_CONFIG_DIR` is unset. |

The last three are the agents' own variables, not TurnLens's. If a listing comes
back empty, TurnLens prints every directory it searched and the value of each of
these, because "the agent never ran here" and "it writes somewhere else" look
identical otherwise.

## Pricing

Rates come from LiteLLM's published price list. Before monitoring starts, once
per run and never while watching, TurnLens asks whether that list has changed and
downloads it only if so, keeping it under `~/.turnlens/pricing/`. If the network
is unreachable it falls back to that file, then to the list shipped inside the
package, and carries on. `--offline` skips the check entirely.

No subprocess is spawned to price anything, and nothing is fetched while a
session is being watched.

## Privacy

**Session files are only ever read. TurnLens never writes to, moves or deletes
them.**

Prompt previews are **off by default**. Turning them on writes the first 20
characters of each prompt into the CSV, on disk and in plain text. With neither
flag given you are asked once at startup and the answer defaults to no. Piped
input is never asked and previews stay off.

Nothing is sent anywhere. The only network access is fetching the public LiteLLM
price list.

## Limits

Worth knowing before you trust a number:

- **Two agents today: Codex and Claude Code.** Any other coding agent writes its
  transcripts in a format TurnLens does not read, so it will find nothing rather
  than report a partial figure. **More agents are planned.** Each one is a
  self-contained adapter, which is what keeps adding the next a contained piece
  of work. If there is one you want, open an issue and say so; which comes first
  follows what people ask for.
- **One session at a time.** A lock under `~/.turnlens/locks/` stops two
  watchers recording the same session twice. A lock left behind by a process that
  is no longer running is reclaimed automatically, and TurnLens says so.
- **Subagent turns are not recorded.** Claude Code writes them to a separate
  transcript that TurnLens does not read, so their cost appears nowhere.
- **Claude Code turns report no reasoning tokens.** Anthropic exposes no counter
  for them, so the column is 0 there while Codex fills it. This is a gap in the
  data, not an estimate.
- **Long-context tier rates are unused.** A turn's token total is the sum over
  many requests rather than one request's context size, so testing that sum
  against a 200k or 272k threshold would misprice systematically.
- **Priority, flex, batch and regional rates are unused**, for a simpler reason:
  nothing in a session file says which tier a request used.
- **Turns that closed before you started watching are not recorded.** TurnLens
  follows a transcript from where it is when it starts.
- **Column widths are counted in characters, not in terminal cells.** The two
  agree for Latin text, Turkish included. They do not for CJK or emoji, so a
  session named in Japanese or with an emoji in it can sit the report's
  right-hand border a column or two out of line. This is a measurement gap, not a
  font problem, and it is known: terminals disagree with each other about emoji
  width, so a partial fix would be exact for CJK and a guess for emoji.

## Feedback

Bug reports, feature ideas and support for another agent all belong in
[issues](https://github.com/kelesmert/turnlens/issues). A number that looks wrong
is the most useful report of all: say which agent, paste the row and what you
expected, and if you can, run the same window through another usage tool so there
is something to compare against.

Released versions and what changed in each are under
[releases](https://github.com/kelesmert/turnlens/releases).

## Development

```bash
npm install
npm test          # unit and pipeline tests
npm run typecheck
npm run build
```

Tests run against fixtures anonymised from real sessions by
`scripts/make-fixture.mjs` and `scripts/make-claude-code-fixture.mjs`, which redact
by allowlist: only the fields the parser reads are copied, so a field an agent
adds later cannot leak by default.

`npm run pricing:snapshot` regenerates the price list embedded in the package.

`npm run verify:costs` recomputes every row of a CSV from its recorded token
counts, using a second implementation written separately from the one under test:

```bash
npm run verify:costs -- turnlens-usage/claude-code/<session>.csv
```

## Acknowledgment

[ccusage](https://github.com/ryoppippi/ccusage) is a broader tool covering many
more agents, and it was used throughout as an independent oracle: TurnLens's
token attribution and costs were verified against it on real sessions until they
agreed to the cent. TurnLens is **not a fork of ccusage and is not affiliated
with it**.

## License

MIT. Copyright (c) 2026 Mert Keles.

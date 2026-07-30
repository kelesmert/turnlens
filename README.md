# TurnLens

[![CI](https://github.com/kelesmert/turnlens/actions/workflows/ci.yml/badge.svg)](https://github.com/kelesmert/turnlens/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/turnlens.svg)](https://www.npmjs.com/package/turnlens)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Per-turn token and cost monitoring for Codex and Claude Code.**

Most usage tools tell you what a session or a day cost. TurnLens tells you what
**the prompt you just sent** cost as soon as the agent finishes together with
the tokens it used and the tool calls it made.

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

Works with **Codex** and **Claude Code** on **Linux, macOS and Windows**. It runs
locally, has no runtime dependencies and never modifies agent session files.

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/7ea3d9d9-c382-447b-9182-881ac40f7b91"
    alt="TurnLens monitoring completed and interrupted AI coding-agent turns"
    width="1280"
  />
</p>

## Install

```bash
npx turnlens@latest
```

Or for a permanent command:

```bash
npm install -g turnlens
```

Node 22 or newer. No runtime dependencies.

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

Run it, pick a session, leave it running in a second terminal while you work.

For a one-off run without installing globally:

```bash
npx turnlens@latest --provider claude-code
```

If installed globally:

```bash
turnlens --provider claude-code
```

TurnLens lists the sessions it can find, most recently active first, and asks
which one to watch. It then follows that session's transcript and prints a row
each time a turn closes. Stop with Ctrl+C; a summary is printed on exit.

### Options

```
  --provider <id>      Agent to monitor. One of: codex, claude-code. Default: codex
  --prompt-preview     Record a 20-character preview of each prompt.
                       This writes part of your prompt to disk.
  --no-prompt-preview  Never record prompt previews.
  --offline            Price from local data only. Never access the network.
  --refresh-pricing    Download the pricing list now, even if it looks current.
  --help               Show this message
```

## What counts as a turn

One prompt and everything the agent did to answer it. A turn closes when the
agent finishes, when you interrupt it, or when the conversation is compacted, and
each closed turn is recorded with the status that closed it: `completed`,
`aborted` or `compacted`.

Interrupted work is recorded **separately**, not folded into whatever comes next.
This matters more than it sounds: an interrupted turn can be the most expensive
one in a session, and a tool that quietly bills it to your next question is
answering the wrong question.

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

TurnLens's own state the pricing cache and session locks lives under
`~/.turnlens/`, overridable with `TURNLENS_HOME`.

## Pricing

Rates come from LiteLLM's published price list. Before monitoring starts once
per run, never while watching TurnLens asks whether that list has changed and
downloads it only if so, keeping it under `~/.turnlens/pricing/`. If the network
is unreachable it falls back to that file, then to the list shipped inside the
package, and carries on. `--offline` skips the check entirely.

No subprocess is spawned to price anything, and nothing is fetched while a
session is being watched.

You can check the arithmetic yourself. This recomputes every row from its
recorded token counts, using a second implementation written separately from the
one under test:

```bash
npm run verify:costs -- turnlens-usage/claude-code/<session>.csv
```

## Privacy

**Session files are only ever read. TurnLens never writes to, moves or deletes
them.**

Prompt previews are **off by default**. Turning them on writes the first 20
characters of each prompt into the CSV on disk, in plain text. With neither
flag given you are asked once at startup and the answer defaults to no. Piped
input is never asked and previews stay off.

Nothing is sent anywhere. The only network access is fetching the public LiteLLM
price list.

## Limits

Worth knowing before you trust a number:

- **One session at a time.** A lock under `~/.turnlens/locks/` stops two
  watchers recording the same session twice.
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

## Acknowledgment

[ccusage](https://github.com/ryoppippi/ccusage) is a broader tool covering many
more agents, and it was used throughout as an independent oracle: TurnLens's
token attribution and costs were verified against it on real sessions until they
agreed to the cent. TurnLens is **not a fork of ccusage and is not affiliated
with it**.

## License

MIT. Copyright (c) 2026 Mert Keles.

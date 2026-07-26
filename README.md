# TurnScope

Per-turn token and cost monitoring for AI coding agents.

Other tools tell you what a session cost, or what a day cost. TurnScope tells you
what **one turn** cost — the prompt you just sent, priced the moment the agent
finishes answering, with the tool calls it made and the tokens it burned.

```
   # Time     Status    Prompt          Input       Cache    Output    Reason        Total       Cost Tools Model              Effort
-----------------------------------------------------------------------------------------------------------------------------------
   1 16:18:27 completed 1+1?                2      46,501         3         0       46,624    $0.0245     0 claude-opus-5      low
   2 16:19:00 aborted   summarise th...     2      46,636       130         0       46,785    $0.0267     1 claude-opus-5      low
      Tool calls: WebSearch=1
   3 16:19:17 completed 3+3?                2      46,653         3         0       46,899    $0.0258     0 claude-opus-5      low
```

Row 2 is a turn stopped mid tool call. It gets its own row, with its own tokens
and its own tool call — not the next one's.

Supported agents: **Codex** and **Claude Code**.

## Install

Requires Node 20 or newer. No runtime dependencies.

**Not on npm yet.** Until it is published, run it from source:

```bash
git clone https://github.com/kelesmert/turnscope.git
cd turnscope
npm install
npm run build
node dist/cli.js --help
```

Once published, `npx turnscope@latest` will be the whole install.

## Usage

Run it, pick a session, leave it running in a second terminal while you work.

```bash
node dist/cli.js --provider claude-code
```

TurnScope lists the sessions it can find, most recently active first, and asks
which one to watch. It then follows that session's transcript and prints a row
each time a turn closes. Stop with Ctrl+C; a summary is printed on exit.

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
turnscope-usage/<provider>/<session-id>.csv
```

Rows are appended and never rewritten. A closed turn keeps the price that was in
effect when it closed, and records which pricing list that was, so a rate change
upstream never moves a number you already have.

TurnScope's own state — the pricing cache and session locks — lives under
`~/.turnscope/`, overridable with `TURNSCOPE_HOME`.

### CSV columns

| Column | Meaning |
|---|---|
| `timestamp` | When the turn closed, ISO 8601 |
| `provider` | `codex` or `claude-code` |
| `session_id`, `session_name` | Which session this turn belongs to |
| `turn_number` | Position in this recording, starting at 1 |
| `turn_id` | The agent's own id for the turn, when it has one |
| `status` | `completed`, `aborted` or `compacted` |
| `prompt_preview` | First 20 characters of the prompt, only if you opted in |
| `model` | The model that answered |
| `reasoning_effort` | Reasoning effort in effect, when the agent reports one |
| `tool_call_count`, `tool_calls_json` | How many tools ran, and which |
| `input_uncached` | Input tokens billed at the full rate |
| `cache_read` | Input tokens served from the prompt cache |
| `cache_creation_5m`, `cache_creation_1h` | Cache writes, split by lifetime because they are priced differently |
| `output_including_reasoning` | Output tokens, reasoning included |
| `reasoning_subset` | How many of those were reasoning tokens |
| `total_tokens` | Sum of every category above |
| `estimated_cost_usd` | Cost in US dollars, six decimals |
| `cost_status` | `priced`, `model_unknown` or `no_pricing_data` |
| `pricing_version` | The pricing list this row was priced from |
| `primary_used_percent`, `primary_window_minutes` | Rate-limit window, when the agent reports one |
| `secondary_used_percent`, `secondary_window_minutes` | Second rate-limit window, likewise |
| `duration_ms` | How long the turn took, when the agent reports it |

An empty `estimated_cost_usd` is always explained by `cost_status`. TurnScope
never records a cost of zero for a model it could not price: a zero would be
indistinguishable from a free turn.

## Pricing

Rates come from LiteLLM's published price list. Before monitoring starts — once
per run, never while watching — TurnScope asks whether that list has changed and
downloads it only if so, keeping it under `~/.turnscope/pricing/`. If the network
is unreachable it falls back to that file, then to the list shipped inside the
package, and carries on. `--offline` skips the check entirely.

No subprocess is spawned to price anything, and nothing is fetched while a
session is being watched.

You can check the arithmetic yourself. This recomputes every row from its
recorded token counts, using a second implementation written separately from the
one under test:

```bash
npm run verify:costs -- turnscope-usage/claude-code/<session>.csv
```

## Privacy

**Session files are only ever read. TurnScope never writes to, moves or deletes
them.**

Prompt previews are **off by default**. Turning them on writes the first 20
characters of each prompt into the CSV — on disk, in plain text. With neither
flag given you are asked once at startup and the answer defaults to no. Piped
input is never asked and previews stay off.

Nothing is sent anywhere. The only network access is fetching the public LiteLLM
price list.

## Limits

Worth knowing before you trust a number:

- **One session at a time.** A lock under `~/.turnscope/locks/` stops two
  watchers recording the same session twice.
- **Subagent turns are not recorded.** Claude Code writes them to a separate
  transcript that TurnScope does not read, so their cost appears nowhere.
- **Claude Code turns report no reasoning tokens.** Anthropic exposes no counter
  for them, so the column is 0 there while Codex fills it. This is a gap in the
  data, not an estimate.
- **Long-context tier rates are unused.** A turn's token total is the sum over
  many requests rather than one request's context size, so testing that sum
  against a 200k or 272k threshold would misprice systematically.
- **Priority, flex, batch and regional rates are unused**, for a simpler reason:
  nothing in a session file says which tier a request used.
- **Turns that closed before you started watching are not recorded.** TurnScope
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
more agents, and it was used throughout as an independent oracle: TurnScope's
token attribution and costs were verified against it on real sessions until they
agreed to the cent. TurnScope is **not a fork of ccusage and is not affiliated
with it**.

## License

MIT. Copyright (c) 2026 Mert Keles.

# model-picker

Stop overpaying for AI models. Find the cheapest model that's smart enough for the job, and the cheapest provider to run it on, from live [Artificial Analysis](https://artificialanalysis.ai) benchmarks pulled through [Firecrawl Alexandria](https://firecrawl.dev).

```
$ model-picker pick --min-score 45 --vs claude-fable-5-1

score  $/task  speed     model                         vs Claude Fable 5.1
46.3   $0.13   48 tok/s  MiMo-V2.6-Pro (Xiaomi)         87% of the score, 57x cheaper
47.8   $0.21   55 tok/s  GPT-6.1 Sol (Medium) (OpenAI)  90% of the score, 36x cheaper
50.2   $0.32   57 tok/s  GPT-6.1 Sol (High) (OpenAI)    94% of the score, 24x cheaper
...
```

Every row is a model nothing else beats on both score and cost. If a model isn't listed, something cheaper is at least as smart.

## Install

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/firecrawl/model-picker/main/install.sh | sh
```

This downloads the build for your machine from the [latest release](https://github.com/firecrawl/model-picker/releases/latest), checks it against the release's `SHA256SUMS`, and puts `model-picker` (and its short name `mp`) in `~/.local/bin`. It needs nothing else: no Bun, no Node, and [Pi](https://pi.dev) comes with it. Run the same line again to update, or end it with `| MODEL_PICKER_VERSION=v0.1.0 sh` to install a particular release.

At the end it offers to run `mp setup`, which asks for your API keys, checks them with Firecrawl and OpenRouter, and saves them to `~/.config/model-picker/.env` (readable only by you). Run `mp setup` again any time to change a key. You can also edit that file or export the keys in your shell, which wins over the file:

| Key | For |
|---|---|
| `FIRECRAWL_API_KEY` | every command; free at [firecrawl.dev](https://firecrawl.dev) |
| `OPENROUTER_API_KEY` | `chat` and `build`; model usage is billed to it |
| `SUBQ_API_KEY` | optional: [SubQ Snap](#labelling-with-subq-snap-optional), a decision model, labels the work instead of a GPT model |

```sh
mp pick --min-score 45
mp chat                                           # in the project folder you want to work in
```

model-picker is a command-line tool, a Claude Code skill that drives it, and an experimental chat router for Pi. Both ways of running models use Pi: `build` runs each step as its own Pi session, and `chat` runs inside one Pi session, switching models as you go. `build` can use [OpenCode](https://opencode.ai) instead with `--harness opencode`, which must be on your PATH. `mp chat --help` lists the chat options; see [Pi router](#pi-router-experimental) for how routing works.

To check where a release came from: `gh attestation verify model-picker-darwin-arm64.tar.gz --repo firecrawl/model-picker`. To uninstall: `rm -rf ~/.local/share/model-picker ~/.local/bin/model-picker ~/.local/bin/mp ~/.config/model-picker`.

### Claude Code

Inside Claude Code:

```
/plugin marketplace add firecrawl/model-picker
/plugin install model-picker@model-picker
```

The skill uses the `model-picker` command, so install it as above first. Then ask things like "which model should I use for my support bot?", "find me a cheaper provider for GLM-5.3" or "build this with the cheapest models".

### From source

Needs [Bun](https://bun.sh) 1.4+, and [Node](https://nodejs.org) 22.19+ for `chat` and `build` (Pi runs on Node from source):

```sh
git clone https://github.com/firecrawl/model-picker
cd model-picker
bun install
bun link                                          # puts `model-picker` and `mp` on your PATH
```

From source, a `.env` in the model-picker folder works as well as `~/.config/model-picker/.env`.

## How it picks

It picks the cheapest model that clears a score floor, with one exception: a model costing at most 10% more wins if it scores higher, since a few percent of price isn't worth several points of intelligence. There's nothing to switch on to make it prefer cheap models. A model at a given reasoning effort counts as its own row (e.g. `gpt-6-1-sol-low` and `gpt-6-1-sol-high`), so picking a row also picks the effort level. To steer it:

- `--min-score` raises or lowers the floor for `pick` (`build` uses hard 50, medium 42, easy 30).
- `--max-cost` caps the benchmark cost per task.
- `--open` limits it to open-weights models.
- `--claude-code` limits it to Claude models and effort levels.

`--max-cost`, `--open` and `--claude-code` also apply to `build`.

## Commands

| Command | What it does |
|---|---|
| `pick [--min-score N] [--max-cost USD] [--open] [--claude-code] [--vs slug]` | Cheapest models at or above a score, optionally compared with the one you use now. `--claude-code` limits it to the Claude models and effort levels Claude Code runs natively |
| `providers <slug> [--sort cost\|speed]` | Every provider serving one model, by cost per task or speed |
| `search <name>` | Find a model's slug. Also lists models Artificial Analysis hasn't measured a cost for yet |
| `build "<task>" [--dir ./out] [--report dir] [--harness pi\|opencode] [--planner-min-score N]` | Build something with the cheapest good-enough model per step, through Pi (or [OpenCode](https://opencode.ai)) and OpenRouter, and write a report of every step's model, time, tokens and cost |

Add `--json` to any command for machine-readable output.

**Score** is the Artificial Analysis Intelligence Index (0-100; today's best models score about 55-58). **$/task** is what it costs to run one Intelligence Index task, which accounts for how many tokens a model actually burns, not just its price per token.

## Building with the cheapest model per step (experimental)

`build` needs an `OPENROUTER_API_KEY`. Each step runs in Pi by default, or in [OpenCode](https://opencode.ai) with `--harness opencode`; the report says which.

1. The cheapest model scoring 50+ writes `plan.json`: as few steps as the job needs (1 for a focused edit, up to 4 for a large build). Each step lists the files it owns and the steps it depends on.
2. Each step is labelled hard, medium or easy and given a kind of work (coding, 3d, general and so on): by SubQ Snap if `SUBQ_API_KEY` is set, otherwise by the planner, which then labels difficulty only.
3. Each step runs as its own Pi (or OpenCode) session on the model clearing that difficulty's floor (hard 50, medium 42, easy 30) that's best at its kind of work, among models within 10% of the cheapest. Steps whose dependencies are done and whose files don't overlap run at the same time.
4. Only the last step runs the app or checks screenshots; earlier steps just write code.
5. `REPORT.md` and `report.json` record the harness and each step's label (and Snap's confidence), model, time, tokens (input, output, reasoning, cache) and cost, from Pi's session usage or OpenCode's session export, plus the build's wall-clock time and each step's session ID.

Both harnesses run tool calls without asking (Pi always does in print mode; OpenCode runs with `--auto`), so only build in folders you're happy for it to change.

Pi refreshes its model catalog only when asked, so model-picker runs `pi update --models` at most once a day before `build` and `chat`; otherwise models released since the last refresh would be missing.

### How `build` decides which model does what

```
Any prompt ──► Planner: the cheapest model scoring 50+ (today GPT-6.1 Sol High)
                  │ writes plan.json: a to-do list
                  ▼
               SubQ Snap: labels each item hard / medium / easy and a kind of work
                  │ (without a SubQ key, the planner labels difficulty instead)
                  ▼
               Workers: one per item, picked by a lookup (no AI)
                  hard   (50+) ──► e.g. GPT-6.1 Sol (High)
                  medium (42+) ──► e.g. MiMo-V2.6-Pro or GPT-6.1 Sol (Low)
                  easy   (30+) ──► e.g. GPT-6 Luna (High)
```

- **AI labels the work, a lookup picks the model.** The planner splits the job; Snap (or the planner) labels each part. model-picker then takes the leaderboard models clearing that label's score floor that OpenRouter can run, and of those priced within 10% of the cheapest, the one best at that kind of work. No model picks another model.
- **The planner is the same for every prompt.** By default it's picked by the same rule as a hard step (50+), because a bad split hurts every step after it. `--planner-min-score` changes its floor without touching the steps' floors, e.g. `--planner-min-score 42` to plan with a cheaper model now that Snap does the labelling. Planning cost $0.07-0.17 per build in our tests.
- **Models only change when the leaderboard does.** The Artificial Analysis leaderboard is fetched at most once a day. Within a build everything is fixed; a new cheaper model scoring 50+ becomes the planner from the next day's fetch. `--claude-code`, `--open` and `--max-cost` filter the candidates (with `--claude-code` the planner is Claude Opus 5.5 Medium).

### Labelling with SubQ Snap (optional)

[SubQ Snap](https://subq.ai) (`subq-snap-preview`) is a decision model: it answers multiple-choice questions rather than writing text, at $0.05 per million input tokens with free output. With `SUBQ_API_KEY` set, it answers two questions for every build step and chat message: how hard is it, and what kind of work is it? It also gives its confidence; under 60%, the work goes one tier up, so an unsure "medium" runs as hard. The threshold isn't tuned on labelled data yet.

This keeps a GPT model from labelling the work that GPT models then compete for, reads the whole message rather than its first 8,000 characters, and costs a fraction of a cent per build.

## Pi router (experimental)

`pi/router.ts` is a [Pi](https://pi.dev) extension that adds a model called `model-picker/auto`. For each message you send:

1. SubQ Snap (with `SUBQ_API_KEY`), or else the cheapest easy-tier model, labels it with a difficulty (hard, medium, easy) and a kind of work (coding, tools, vision, long-context, 3d, general).
2. Every benchmarked model on OpenRouter is a candidate. Models that can't take the message are dropped: no image input when you attached an image, or a context window too small for the conversation.
3. Of the rest clearing the difficulty floor (50 / 42 / 30), it takes the one best at that kind of work, ranked on that work's own benchmark (Terminal-Bench and SciCode for coding, τ²-Bench for tools, MMMU-Pro for images, LCR for long context, [MineBench](https://minebench.ai/leaderboard) for 3D), among models priced within `valueMargin` of the cheapest. The default is 1.1, i.e. 10%; raise it to pay more for specialists.

It all happens in one session. Tool calls and retries within a turn stay on that turn's model, so the prompt cache survives. Computer use isn't ranked: the benchmark data has no computer-use score.

MineBench isn't on Alexandria, so its leaderboard is scraped with Firecrawl and cached for a day like everything else. It rates a model without its effort level, so every effort level of a model shares one rating, and models it hasn't tested (OpenAI's non-Pro GPT-6 models, for example) rank last for 3D. If the page can't be scraped, the router still works and 3D messages go to the cheapest qualifying model.

```sh
model-picker chat            # in any project folder; extra options go to Pi
```

For one session you can narrow or tune the models with flags, on top of the settings file below:

```sh
mp chat --region china          # or us / europe; makers with an unclear home country are left out
mp chat --creators Anthropic,OpenAI
mp chat --open                  # open-weights models only
mp chat --value-margin 2        # pay up to 2x the cheapest for a better-suited model
```

If a filter leaves no model above a difficulty's floor (no Chinese model scores 50+, for instance), that difficulty goes to the strongest allowed model, marked "best available" in the header and footer.

`chat` opens Pi's terminal UI with the router loaded and selected. It needs `OPENROUTER_API_KEY` and `FIRECRAWL_API_KEY`, from your environment or `~/.config/model-picker/.env`.

The footer shows why each message went where it did (e.g. `hard · coding → GPT-6.1 Sol high`) and a running savings line, e.g. `$0.42 spent · ~$3.10 on Claude Opus 5.5 · saved 86%`. The comparison prices this session's actual tokens at the baseline model's rates, so it's an estimate: the baseline would have written different responses. `/session` shows cost per model. To limit the candidates, write `~/.config/model-picker/router.json` (or point `MODEL_PICKER_ROUTER_SETTINGS` at a file):

```json
{ "region": "us", "creators": ["OpenAI", "Anthropic"], "openWeightsOnly": false, "maxCost": 1, "valueMargin": 2, "baseline": "anthropic/claude-opus-5.5" }
```

Pi's virtual-model API is experimental, so Pi is pinned (1.2.0).

## Cost

A `pick` uses 20 Firecrawl credits and a `providers` lookup 5. Results are cached for 24 hours, so repeat runs are free.

## Contributing

The repo includes [agent-harness](https://github.com/firecrawl/model-picker/tree/main/.harness) checks: if you work on it with Claude Code, `.claude/settings.json` runs formatting, lint and typecheck after each edit and the full checks (`.harness/hooks/check-all.sh`) before the agent stops. Without Claude Code, run that script yourself before opening a pull request, plus `bun test`.

To release, bump `version` in `package.json`, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The Release workflow builds the four platforms with `scripts/package.sh`, which you can also run locally (e.g. `scripts/package.sh darwin-arm64`), and publishes them with `SHA256SUMS` and build attestations. Pi's version comes from the `@earendil-works/pi-coding-agent` pin in `package.json`.

## License

MIT

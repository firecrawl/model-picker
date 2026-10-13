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

model-picker is a command-line tool (`model-picker`, or `mp` for short), a Claude Code skill that drives it, and an experimental chat router for [Pi](https://pi.dev).

| To use | You need |
|---|---|
| `pick`, `providers`, `search` | [Bun](https://bun.sh) 1.4+ and a free [Firecrawl](https://firecrawl.dev) API key (`FIRECRAWL_API_KEY`) |
| `chat` | the above, plus [Node](https://nodejs.org) 22.19+ (Pi runs on Node) and an [OpenRouter](https://openrouter.ai) key (`OPENROUTER_API_KEY`) |
| `build` (experimental) | the above, plus [OpenCode](https://opencode.ai) on your PATH |

Model usage in `chat` and `build` is billed to your OpenRouter key.

### Command line

```sh
git clone https://github.com/firecrawl/model-picker
cd model-picker
bun install
bun link                                          # puts `model-picker` and `mp` on your PATH
export FIRECRAWL_API_KEY=fc-...
model-picker pick --min-score 45
```

### Claude Code

Inside Claude Code:

```
/plugin marketplace add firecrawl/model-picker
/plugin install model-picker@model-picker
```

Set `FIRECRAWL_API_KEY` in the shell you start Claude Code from. Then ask things like "which model should I use for my support bot?", "find me a cheaper provider for GLM-5.3" or "build this with the cheapest models".

### For `build`

`build` also needs [OpenCode](https://opencode.ai) on your PATH and an [OpenRouter](https://openrouter.ai) key in `OPENROUTER_API_KEY`; OpenCode reads it from the environment. The models' usage is billed to that OpenRouter key.

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
| `build "<task>" [--dir ./out] [--report dir]` | Build something with the cheapest good-enough model per step, through [OpenCode](https://opencode.ai) and OpenRouter, and write a report of every step's model, time, tokens and cost |

Add `--json` to any command for machine-readable output.

**Score** is the Artificial Analysis Intelligence Index (0-100; today's best models score about 55-58). **$/task** is what it costs to run one Intelligence Index task, which accounts for how many tokens a model actually burns, not just its price per token.

## Building with the cheapest model per step (experimental)

`build` needs [OpenCode](https://opencode.ai) and an `OPENROUTER_API_KEY`.

1. The cheapest model scoring 50+ writes `plan.json`: as few steps as the job needs (1 for a focused edit, up to 4 for a large build). Each step is tagged hard, medium or easy, and lists the files it owns and the steps it depends on.
2. Each step runs as its own OpenCode session on the cheapest model clearing that difficulty's floor (hard 50, medium 42, easy 30). Steps whose dependencies are done and whose files don't overlap run at the same time.
3. Only the last step runs the app or checks screenshots; earlier steps just write code.
4. `REPORT.md` and `report.json` record each step's model, time, tokens (input, output, reasoning, cache) and cost from OpenCode's session export, plus the build's wall-clock time and each step's session ID.

OpenCode runs with `--auto`, which approves its tool calls without asking, so only build in folders you're happy for it to change.

### How `build` decides which model does what

```
Any prompt ──► Planner: the cheapest model scoring 50+ (today GPT-6.1 Sol High)
                  │ writes plan.json: a to-do list, each item labelled hard / medium / easy
                  ▼
               Workers: one per item, picked by a lookup (no AI)
                  hard   (50+) ──► today GPT-6.1 Sol (High)
                  medium (42+) ──► today GPT-6.1 Sol (Low)
                  easy   (30+) ──► today GPT-6 Luna (High)
```

- **One AI decision, then a lookup.** The planner reads the prompt and labels each part of the work. model-picker then takes the cheapest model on the leaderboard clearing that label's score floor, filtered to what OpenRouter can run. No other model, Claude included, takes part in routing.
- **The planner is the same for every prompt.** It's picked by the same rule as a hard step, because a wrong label sends hard work to a weak model or splits the job badly. Planning cost $0.07-0.17 per build in our tests.
- **Models only change when the leaderboard does.** The Artificial Analysis leaderboard is fetched at most once a day. Within a build everything is fixed; a new cheaper model scoring 50+ becomes the planner from the next day's fetch. `--claude-code`, `--open` and `--max-cost` filter the candidates (with `--claude-code` the planner is Claude Opus 5.5 Medium).

## Pi router (experimental)

`pi/router.ts` is a [Pi](https://pi.dev) extension that adds a model called `model-picker/auto`. For each message you send:

1. A cheap model labels it with a difficulty (hard, medium, easy) and a kind of work (coding, tools, vision, long-context, general).
2. Every benchmarked model on OpenRouter is a candidate. Models that can't take the message are dropped: no image input when you attached an image, or a context window too small for the conversation.
3. Of the rest clearing the difficulty floor (50 / 42 / 30), it takes the one best at that kind of work, ranked on that work's own benchmark (Terminal-Bench and SciCode for coding, τ²-Bench for tools, MMMU-Pro for images, LCR for long context), among models priced within `valueMargin` of the cheapest. The default is 1.1, i.e. 10%; raise it to pay more for specialists.

It all happens in one session. Tool calls and retries within a turn stay on that turn's model, so the prompt cache survives. Computer use isn't ranked: the benchmark data has no computer-use score.

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

`chat` opens Pi's terminal UI with the router loaded and selected. It needs `OPENROUTER_API_KEY`, and the Firecrawl key from your environment or model-picker's own `.env`.

The footer shows why each message went where it did (e.g. `hard · coding → GPT-6.1 Sol high`) and a running savings line, e.g. `$0.42 spent · ~$3.10 on Claude Opus 5.5 · saved 86%`. The comparison prices this session's actual tokens at the baseline model's rates, so it's an estimate: the baseline would have written different responses. `/session` shows cost per model. To limit the candidates, write `~/.config/model-picker/router.json` (or point `MODEL_PICKER_ROUTER_SETTINGS` at a file):

```json
{ "region": "us", "creators": ["OpenAI", "Anthropic"], "openWeightsOnly": false, "maxCost": 1, "valueMargin": 2, "baseline": "anthropic/claude-opus-5.5" }
```

Pi's virtual-model API is experimental, so Pi is pinned (1.2.0).

## Cost

A `pick` uses 20 Firecrawl credits and a `providers` lookup 5. Results are cached for 24 hours, so repeat runs are free.

## Contributing

The repo includes [agent-harness](https://github.com/firecrawl/model-picker/tree/main/.harness) checks: if you work on it with Claude Code, `.claude/settings.json` runs formatting, lint and typecheck after each edit and the full checks (`.harness/hooks/check-all.sh`) before the agent stops. Without Claude Code, run that script yourself before opening a pull request, plus `bun test`.

## License

MIT

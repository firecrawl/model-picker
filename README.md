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

model-picker is a command-line tool plus a Claude Code skill that drives it. You need [Bun](https://bun.sh) 1.4+ and a free [Firecrawl](https://firecrawl.dev) API key.

### Command line

```sh
git clone https://github.com/OWNER/model-picker   # replace OWNER once the repo is public
cd model-picker
bun install
bun link                                          # puts `model-picker` on your PATH
export FIRECRAWL_API_KEY=fc-...
model-picker pick --min-score 45
```

### Claude Code

Inside Claude Code:

```
/plugin marketplace add OWNER/model-picker
/plugin install model-picker@model-picker
```

Set `FIRECRAWL_API_KEY` in the shell you start Claude Code from. Then ask things like "which model should I use for my support bot?", "find me a cheaper provider for GLM-5.3" or "build this with the cheapest models".

### For `build`

`build` also needs [OpenCode](https://opencode.ai) on your PATH and an [OpenRouter](https://openrouter.ai) key in `OPENROUTER_API_KEY`; OpenCode reads it from the environment. The models' usage is billed to that OpenRouter key.

## How it picks

It always picks the cheapest model that clears a score floor; there's nothing to switch on to make it prefer cheap models. A model at a given reasoning effort counts as its own row (e.g. `gpt-6-1-sol-low` and `gpt-6-1-sol-high`), so picking a row also picks the effort level. To steer it:

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

## Building with the cheapest model per step

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

## Cost

A `pick` uses 20 Firecrawl credits and a `providers` lookup 5. Results are cached for 24 hours, so repeat runs are free.

## License

MIT

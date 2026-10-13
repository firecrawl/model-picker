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

## Setup

1. Get a free Firecrawl API key at [firecrawl.dev](https://firecrawl.dev) and `export FIRECRAWL_API_KEY=fc-...`
2. Clone and install: `git clone <this repo> && cd model-picker && bun install`

### As a Claude Code skill

```
/plugin marketplace add <this repo>
/plugin install model-picker@model-picker
```

Then ask Claude Code things like "which model should I use for my support bot?" or "find me a cheaper provider for GLM-5.3".

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

## Cost

A `pick` uses 20 Firecrawl credits and a `providers` lookup 5. Results are cached for 12 hours, so repeat runs are free.

## License

MIT

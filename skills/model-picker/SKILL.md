---
name: model-picker
description: Find the cheapest AI model that is smart enough for a task, and the cheapest provider to run it on, from live Artificial Analysis benchmarks via Firecrawl. Use when the user asks which model to use, how to cut their LLM or API bill, whether a cheaper model would do, which provider is cheapest or fastest for a model, or which open-weights model to self-host.
---

# Model picker

The CLI is `src/cli.ts` two directories above this skill's base directory; the commands below write it as `bun src/cli.ts`, so run them from there or use the full path. It needs `FIRECRAWL_API_KEY` (free at https://firecrawl.dev). Results are cached for 12 hours, so repeat runs cost nothing.

## 1. Turn the task into a score floor

Scores are the Artificial Analysis Intelligence Index (0-100; the best models score about 55-58).

| Task | `--min-score` |
|---|---|
| Hard agentic coding, multi-step research, long autonomous runs | 50 |
| Everyday coding, writing, analysis, tool use | 42 |
| Summaries, extraction, classification, routing | 30 |

If the user names the model they use today, pass it with `--vs <slug>`; find slugs with `search <name>`.

## 2. Pick the model

```bash
bun src/cli.ts pick --min-score 42 --vs claude-fable-5-1
bun src/cli.ts pick --min-score 35 --open        # self-hostable only
bun src/cli.ts pick --min-score 42 --max-cost 0.5
```

Each row is a model nothing else beats on both score and cost, cheapest first. Recommend the cheapest row that clears the floor, and say what the user gives up versus their current model (the `vs` column).

## 3. Pick the provider

```bash
bun src/cli.ts providers <slug>               # cheapest first
bun src/cli.ts providers <slug> --sort speed
```

Cost per task includes how many tokens each provider's setup actually burns, so it can rank providers differently from list prices.

Add `--json` to any command to read the numbers programmatically.

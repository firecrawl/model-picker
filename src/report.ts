import { join } from "node:path";
import type { BuildStep } from "./build.ts";

const thousands = (count: number): string => `${(count / 1000).toFixed(1)}k`;
const minutes = (seconds: number): string =>
  seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
const dollars = (usd: number | undefined): string =>
  usd === undefined ? "unknown" : `$${usd.toFixed(3)}`;

export function stepLine(step: BuildStep): string {
  const { run, runnable } = step;
  const status = run.exitCode === 0 ? "✓" : `✗ (exit ${run.exitCode})`;
  const tokens = run.usage
    ? `${thousands(run.usage.inputTokens + run.usage.outputTokens + run.usage.reasoningTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens)} tokens`
    : "tokens unknown";
  return `${status} [${step.difficulty}] ${step.title}: ${runnable.model.name} · ${minutes(run.seconds)} · ${tokens} · ${dollars(run.usage?.costUsd)}`;
}

function totals(steps: BuildStep[]) {
  const sum = (value: (step: BuildStep) => number): number =>
    steps.reduce((total, step) => total + value(step), 0);
  return {
    seconds: sum((step) => step.run.seconds),
    costUsd: steps.every((step) => step.run.usage)
      ? sum((step) => step.run.usage?.costUsd ?? 0)
      : undefined,
    inputTokens: sum((step) => step.run.usage?.inputTokens ?? 0),
    outputTokens: sum((step) => step.run.usage?.outputTokens ?? 0),
    reasoningTokens: sum((step) => step.run.usage?.reasoningTokens ?? 0),
    cacheReadTokens: sum((step) => step.run.usage?.cacheReadTokens ?? 0),
    cacheWriteTokens: sum((step) => step.run.usage?.cacheWriteTokens ?? 0),
  };
}

export function summaryLine(steps: BuildStep[]): string {
  const total = totals(steps);
  return `Total: ${minutes(total.seconds)} · ${dollars(total.costUsd)} across ${steps.length} OpenCode sessions`;
}

/** Writes report.json (every number) and REPORT.md (the table to show) into `dir`. */
export async function writeReport(dir: string, task: string, steps: BuildStep[]): Promise<void> {
  const total = totals(steps);
  await Bun.write(
    join(dir, "report.json"),
    JSON.stringify(
      {
        task,
        total,
        steps: steps.map((step) => ({
          title: step.title,
          difficulty: step.difficulty,
          model: step.runnable.model.name,
          opencodeModel: step.runnable.opencodeId,
          benchmarkScore: step.runnable.model.score,
          benchmarkCostPerTaskUsd: step.runnable.model.costPerTask,
          opencodeSession: step.run.sessionId ?? null,
          exitCode: step.run.exitCode,
          seconds: step.run.seconds,
          usage: step.run.usage ?? null,
          reply: step.run.reply,
        })),
      },
      null,
      2,
    ),
  );
  const rows = steps.map((step) => {
    const usage = step.run.usage;
    return `| ${step.title} | ${step.difficulty} | ${step.runnable.model.name} | ${minutes(step.run.seconds)} | ${usage ? thousands(usage.inputTokens) : "-"} | ${usage ? thousands(usage.outputTokens) : "-"} | ${usage ? thousands(usage.reasoningTokens) : "-"} | ${usage ? thousands(usage.cacheReadTokens) : "-"} | ${usage ? thousands(usage.cacheWriteTokens) : "-"} | ${dollars(usage?.costUsd)} |`;
  });
  await Bun.write(
    join(dir, "REPORT.md"),
    `# model-picker build report

Task: ${task}

| Step | Difficulty | Model | Time | Input | Output | Reasoning | Cache read | Cache write | Cost |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
| **Total** | | | **${minutes(total.seconds)}** | ${thousands(total.inputTokens)} | ${thousands(total.outputTokens)} | ${thousands(total.reasoningTokens)} | ${thousands(total.cacheReadTokens)} | ${thousands(total.cacheWriteTokens)} | **${dollars(total.costUsd)}** |

Costs and tokens come from each OpenCode session's export (OpenRouter prices). Check them against https://openrouter.ai/activity.
`,
  );
}

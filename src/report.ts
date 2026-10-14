import { join } from "node:path";
import type { BuildResult, BuildStep } from "./build.ts";
import type { HarnessName } from "./harness.ts";
import { runnableId } from "./openrouter.ts";

const HARNESS_LABELS: Record<HarnessName, string> = { pi: "Pi", opencode: "OpenCode" };
const COST_SOURCES: Record<HarnessName, string> = {
  pi: "each Pi session's usage (Pi's OpenRouter prices)",
  opencode: "each OpenCode session's export (OpenRouter prices)",
};

const thousands = (count: number): string => `${(count / 1000).toFixed(1)}k`;
const minutes = (seconds: number): string =>
  seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
const dollars = (usd: number | undefined): string =>
  usd === undefined ? "unknown" : `$${usd.toFixed(3)}`;

/** e.g. "medium · coding" or, when Snap was unsure and the step went up a tier, "hard (Snap: medium, 52%) · coding". */
function labelText(step: BuildStep): string {
  if (step.difficulty === "plan") return "plan";
  const { snap } = step;
  const difficulty =
    snap === undefined
      ? step.difficulty
      : snap.snapDifficulty === step.difficulty
        ? `${step.difficulty} (Snap ${Math.round(snap.confidence * 100)}%)`
        : `${step.difficulty} (Snap: ${snap.snapDifficulty}, ${Math.round(snap.confidence * 100)}%)`;
  return `${difficulty} · ${step.work}`;
}

export function stepLine(step: BuildStep): string {
  const { run, runnable } = step;
  const status = run.exitCode === 0 ? "✓" : `✗ (exit ${run.exitCode})`;
  const tokens = run.usage
    ? `${thousands(run.usage.inputTokens + run.usage.outputTokens + run.usage.reasoningTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens)} tokens`
    : "tokens unknown";
  return `${status} [${labelText(step)}] ${step.title}: ${runnable.model.name} · ${minutes(run.seconds)} · ${tokens} · ${dollars(run.usage?.costUsd)}`;
}

function usageTotals(steps: BuildStep[]) {
  const sum = (value: (step: BuildStep) => number): number =>
    steps.reduce((total, step) => total + value(step), 0);
  return {
    sessionSeconds: sum((step) => step.run.seconds),
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

const totals = ({ steps, wallSeconds }: BuildResult) => ({ wallSeconds, ...usageTotals(steps) });

/** One row per model: what it was used for, its tokens and cost, and its share of the bill. */
function byModel(steps: BuildStep[], totalCost: number | undefined) {
  const groups = Map.groupBy(steps, (step) => runnableId(step.runnable));
  return [...groups.entries()].map(([harnessModel, modelSteps]) => {
    const usage = usageTotals(modelSteps);
    return {
      model: modelSteps[0]?.runnable.model.name ?? harnessModel,
      harnessModel,
      usedFor: modelSteps.map((step) => `${labelText(step)}: ${step.title}`),
      ...usage,
      shareOfCost:
        usage.costUsd === undefined || totalCost === undefined || totalCost === 0
          ? undefined
          : usage.costUsd / totalCost,
    };
  });
}

export function summaryLine(result: BuildResult): string {
  const total = totals(result);
  return `Total: ${minutes(total.wallSeconds)} wall clock (${minutes(total.sessionSeconds)} of sessions) · ${dollars(total.costUsd)} across ${result.steps.length} ${HARNESS_LABELS[result.harness]} sessions`;
}

/** Writes report.json (every number) and REPORT.md (the table to show) into `dir`. */
export async function writeReport(dir: string, task: string, result: BuildResult): Promise<void> {
  const { steps } = result;
  const total = totals(result);
  const models = byModel(steps, total.costUsd);
  await Bun.write(
    join(dir, "report.json"),
    JSON.stringify(
      {
        task,
        harness: result.harness,
        total,
        byModel: models,
        steps: steps.map((step) => ({
          title: step.title,
          difficulty: step.difficulty,
          work: step.work,
          snap: step.snap ?? null,
          model: step.runnable.model.name,
          harnessModel: runnableId(step.runnable),
          benchmarkScore: step.runnable.model.score,
          benchmarkCostPerTaskUsd: step.runnable.model.costPerTask,
          session: step.run.sessionId ?? null,
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
    return `| ${step.title} | ${labelText(step)} | ${step.runnable.model.name} | ${minutes(step.run.seconds)} | ${usage ? thousands(usage.inputTokens) : "-"} | ${usage ? thousands(usage.outputTokens) : "-"} | ${usage ? thousands(usage.reasoningTokens) : "-"} | ${usage ? thousands(usage.cacheReadTokens) : "-"} | ${usage ? thousands(usage.cacheWriteTokens) : "-"} | ${dollars(usage?.costUsd)} |`;
  });
  await Bun.write(
    join(dir, "REPORT.md"),
    `# model-picker build report

Task: ${task}

Harness: ${HARNESS_LABELS[result.harness]}

| Step | Label | Model | Time | Input | Output | Reasoning | Cache read | Cache write | Cost |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
| **Total** | | | **${minutes(total.wallSeconds)}** wall clock (${minutes(total.sessionSeconds)} of sessions) | ${thousands(total.inputTokens)} | ${thousands(total.outputTokens)} | ${thousands(total.reasoningTokens)} | ${thousands(total.cacheReadTokens)} | ${thousands(total.cacheWriteTokens)} | **${dollars(total.costUsd)}** |

## By model

| Model | Used for | Time | Input | Output | Reasoning | Cache read | Cache write | Cost | Share |
|---|---|---|---|---|---|---|---|---|---|
${models.map((row) => `| ${row.model} | ${row.usedFor.join("<br>")} | ${minutes(row.sessionSeconds)} | ${thousands(row.inputTokens)} | ${thousands(row.outputTokens)} | ${thousands(row.reasoningTokens)} | ${thousands(row.cacheReadTokens)} | ${thousands(row.cacheWriteTokens)} | ${dollars(row.costUsd)} | ${row.shareOfCost === undefined ? "-" : `${Math.round(row.shareOfCost * 100)}%`} |`).join("\n")}

${steps.some((step) => step.snap) ? "Steps were labelled by SubQ Snap (subq-snap-preview): its difficulty and confidence, then the kind of work, whose benchmark ranked the models. A step Snap was under 60% sure about went up a tier.\n\n" : ""}Costs and tokens come from ${COST_SOURCES[result.harness]}. Check them against https://openrouter.ai/activity.
`,
  );
}

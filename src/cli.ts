#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { fetchModels, pick, type Model, type PickOptions } from "./models.ts";
import { openRouterModels, toRunnable, type Runnable } from "./openrouter.ts";
import { print, printError } from "./output.ts";
import { fetchProviders, type ProviderSort } from "./providers.ts";
import { race, repoRoot, type RaceResult } from "./race.ts";

const USAGE = `model-picker: find the cheapest AI model that's smart enough for the job.
Data: Artificial Analysis benchmarks via Firecrawl Alexandria. Needs FIRECRAWL_API_KEY.

  model-picker pick [--min-score 40] [--max-cost 5] [--open] [--claude-code] [--vs <slug>] [--json]
      Models nothing else beats on both score and cost, cheapest first.
      --min-score    Intelligence Index floor (0-100). Top models score ~55.
      --max-cost     Max USD to run one Intelligence Index task.
      --open         Open-weights models only (self-hostable).
      --claude-code  Claude models and effort levels only: what Claude Code runs natively.
      --vs           Compare each pick against a model you use today (e.g. claude-fable-5-1).

  model-picker providers <slug> [--sort cost|speed] [--json]
      Every provider serving one model, with cost per task and speed.

  model-picker search <text> [--json]
      Find a model's slug by name. Also lists models with no measured cost yet.

  model-picker run "<task>" --vs <slug> [--min-score 45] [--check "bun test"] [--dir .]
      Race the cheapest qualifying model against --vs on a real task in your repo, through
      OpenCode + OpenRouter (needs OPENROUTER_API_KEY). Each model works in its own git
      worktree; --check runs your tests in each one afterwards. Takes pick's filters too.`;

const money = (usd: number): string => (usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);
const taskCost = (usd: number | undefined): string =>
  usd === undefined ? "not measured" : money(usd);
const speed = (tps: number | undefined): string =>
  tps === undefined ? "-" : `${Math.round(tps)} tok/s`;

function printTable(rows: string[][]): void {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  for (const row of rows)
    print(
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    );
}

function comparison(model: Model & { costPerTask: number }, baseline: Model | undefined): string {
  if (!baseline || model.slug === baseline.slug) return "";
  const scoreShare = Math.round((model.score / baseline.score) * 100);
  if (baseline.costPerTask === undefined) return `${scoreShare}% of the score`;
  const ratio = baseline.costPerTask / model.costPerTask;
  const cost =
    ratio >= 1
      ? `${ratio.toFixed(ratio < 10 ? 1 : 0)}x cheaper`
      : `${(1 / ratio).toFixed(1)}x pricier`;
  return `${scoreShare}% of the score, ${cost}`;
}

function findModel(models: Model[], slug: string): Model {
  const model = models.find((candidate) => candidate.slug === slug);
  if (!model)
    throw new Error(`No model with slug "${slug}". Find it with: model-picker search <name>`);
  return model;
}

type Values = Record<string, string | boolean | undefined>;

const pickOptions = (values: Values): PickOptions => ({
  minScore: Number(values["min-score"] ?? 0),
  maxCost: Number(values["max-cost"] ?? Number.POSITIVE_INFINITY),
  openWeightsOnly: values.open === true,
  creator: values["claude-code"] === true ? "Anthropic" : undefined,
});

async function runPick(values: Values): Promise<void> {
  const models = await fetchModels();
  const baseline = typeof values.vs === "string" ? findModel(models, values.vs) : undefined;
  const picks = pick(models, pickOptions(values));
  if (values.json === true) {
    print(JSON.stringify({ baseline, picks }, null, 2));
    return;
  }
  if (picks.length === 0) {
    print("No model matches. Lower --min-score or raise --max-cost.");
    return;
  }
  const header = ["score", "$/task", "speed", "model", "slug", "weights"];
  if (baseline) header.push(`vs ${baseline.name}`);
  printTable([
    header,
    ...picks.map((model) => [
      model.score.toFixed(1),
      money(model.costPerTask),
      speed(model.tokensPerSecond),
      `${model.name} (${model.creator})`,
      model.slug,
      model.openWeights ? "open" : "closed",
      comparison(model, baseline),
    ]),
  ]);
  if (baseline) {
    print(
      `\n${baseline.name}: score ${baseline.score.toFixed(1)}, ${taskCost(baseline.costPerTask)} per task`,
    );
  }
}

async function runProviders(
  slug: string | undefined,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  if (slug === undefined || slug === "") throw new Error("Usage: model-picker providers <slug>");
  const sort: ProviderSort = values.sort === "speed" ? "speed" : "cost";
  const providers = await fetchProviders(slug, sort);
  if (values.json === true) {
    print(JSON.stringify(providers, null, 2));
    return;
  }
  if (providers.length === 0) {
    print(`No benchmarked providers for "${slug}".`);
    return;
  }
  printTable([
    ["provider", "$/task", "speed", "$/1M in", "$/1M out"],
    ...providers.map((provider) => [
      provider.host,
      money(provider.costPerTask),
      speed(provider.tokensPerSecond),
      provider.inputPerMillion === undefined ? "-" : money(provider.inputPerMillion),
      provider.outputPerMillion === undefined ? "-" : money(provider.outputPerMillion),
    ]),
  ]);
  const cheapest = providers.reduce((a, b) => (a.costPerTask <= b.costPerTask ? a : b));
  const priciest = providers.reduce((a, b) => (a.costPerTask >= b.costPerTask ? a : b));
  if (priciest.costPerTask > cheapest.costPerTask) {
    const spread = (priciest.costPerTask / cheapest.costPerTask).toFixed(1);
    print(
      `\nSame model, ${spread}x price spread: ${cheapest.host} ${money(cheapest.costPerTask)} vs ${priciest.host} ${money(priciest.costPerTask)} per task.`,
    );
  }
}

async function runSearch(
  text: string | undefined,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  if (text === undefined || text === "") throw new Error("Usage: model-picker search <text>");
  const needle = text.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const matches = (await fetchModels()).filter((model) =>
    `${model.name}${model.slug}${model.creator}`
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, "")
      .includes(needle),
  );
  if (values.json === true) {
    print(JSON.stringify(matches, null, 2));
    return;
  }
  printTable([
    ["slug", "model", "score", "$/task", "list $/1M tokens"],
    ...matches.map((model) => [
      model.slug,
      model.name,
      model.score.toFixed(1),
      taskCost(model.costPerTask),
      model.listPrice === undefined ? "-" : money(model.listPrice),
    ]),
  ]);
}

function describe(runnable: Runnable): string {
  const { model } = runnable;
  return `${model.name} (${runnable.opencodeId}): score ${model.score.toFixed(1)}, ${taskCost(model.costPerTask)} per benchmark task`;
}

function finished(result: RaceResult): string {
  const status = result.exitCode === 0 ? "finished" : `failed (exit ${result.exitCode})`;
  const check =
    result.checkPassed === undefined ? "" : result.checkPassed ? " · check PASS" : " · check FAIL";
  const diff = result.diffStat === "" ? "no changes" : result.diffStat;
  return `${result.runnable.model.name} ${status} in ${Math.round(result.seconds)}s · ${diff}${check}`;
}

async function runRace(task: string | undefined, values: Values): Promise<void> {
  if (task === undefined || task === "")
    throw new Error('Usage: model-picker run "<task>" --vs <slug>');
  if (typeof values.vs !== "string")
    throw new Error("run needs --vs <slug>: the model you'd use today.");
  const repo = await repoRoot(typeof values.dir === "string" ? values.dir : ".");
  const [models, openRouter] = await Promise.all([fetchModels(), openRouterModels()]);
  if (openRouter.size === 0) {
    throw new Error(
      "OpenCode isn't installed or lists no OpenRouter models. Install it from opencode.ai.",
    );
  }
  const baseline = toRunnable(findModel(models, values.vs), openRouter);
  if (!baseline) throw new Error(`${values.vs} isn't available on OpenRouter through OpenCode.`);
  const challenger = pick(models, pickOptions(values))
    .map((model) => toRunnable(model, openRouter))
    .find((runnable) => runnable !== undefined && runnable.model.slug !== baseline.model.slug);
  if (!challenger)
    throw new Error("No cheaper qualifying model is on OpenRouter. Lower --min-score.");

  print(`Task: ${task}\nRepo: ${repo}\n`);
  print(`  cheapest pick  ${describe(challenger)}`);
  print(`  vs             ${describe(baseline)}\n`);
  const check = typeof values.check === "string" ? values.check : undefined;
  const results = await race(repo, [challenger, baseline], task, check, (result) =>
    print(`✓ ${finished(result)}`),
  );
  print("");
  for (const result of results) {
    print(
      `${result.runnable.model.name}\n  worktree: ${result.worktree}\n  reply: ${result.reply.slice(0, 400)}\n`,
    );
  }
  print("Compare what each run cost at https://openrouter.ai/activity");
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "min-score": { type: "string" },
    "max-cost": { type: "string" },
    open: { type: "boolean" },
    vs: { type: "string" },
    sort: { type: "string" },
    json: { type: "boolean" },
    "claude-code": { type: "boolean" },
    check: { type: "string" },
    dir: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, argument] = positionals;
try {
  if (command === "pick") await runPick(values);
  else if (command === "providers") await runProviders(argument, values);
  else if (command === "search") await runSearch(argument, values);
  else if (command === "run") await runRace(argument, values);
  else print(USAGE);
} catch (error) {
  printError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

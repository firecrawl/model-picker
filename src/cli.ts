#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { fetchModels, pick, type Model } from "./models.ts";
import { print, printError } from "./output.ts";
import { fetchProviders, type ProviderSort } from "./providers.ts";

const USAGE = `model-picker: find the cheapest AI model that's smart enough for the job.
Data: Artificial Analysis benchmarks via Firecrawl Alexandria. Needs FIRECRAWL_API_KEY.

  model-picker pick [--min-score 40] [--max-cost 5] [--open] [--vs <slug>] [--json]
      Models nothing else beats on both score and cost, cheapest first.
      --min-score  Intelligence Index floor (0-100). Top models score ~55.
      --max-cost   Max USD to run one Intelligence Index task.
      --open       Open-weights models only (self-hostable).
      --vs         Compare each pick against a model you use today (e.g. claude-fable-5-1).

  model-picker providers <slug> [--sort cost|speed] [--json]
      Every provider serving one model, with cost per task and speed.

  model-picker search <text> [--json]
      Find a model's slug by name.`;

const money = (usd: number): string => (usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);
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

function comparison(model: Model, baseline: Model | undefined): string {
  if (!baseline || model.slug === baseline.slug) return "";
  const scoreShare = Math.round((model.score / baseline.score) * 100);
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

async function runPick(values: Record<string, string | boolean | undefined>): Promise<void> {
  const models = await fetchModels();
  const baseline = typeof values.vs === "string" ? findModel(models, values.vs) : undefined;
  const picks = pick(models, {
    minScore: Number(values["min-score"] ?? 0),
    maxCost: Number(values["max-cost"] ?? Number.POSITIVE_INFINITY),
    openWeightsOnly: values.open === true,
  });
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
      `\n${baseline.name}: score ${baseline.score.toFixed(1)}, ${money(baseline.costPerTask)}/task`,
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
    ["slug", "model", "score", "$/task"],
    ...matches.map((model) => [
      model.slug,
      model.name,
      model.score.toFixed(1),
      money(model.costPerTask),
    ]),
  ]);
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
    help: { type: "boolean", short: "h" },
  },
});

const [command, argument] = positionals;
try {
  if (command === "pick") await runPick(values);
  else if (command === "providers") await runProviders(argument, values);
  else if (command === "search") await runSearch(argument, values);
  else print(USAGE);
} catch (error) {
  printError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

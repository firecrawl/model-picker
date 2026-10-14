import { z } from "zod";
import { callAll } from "./alexandria.ts";

export const speedSchema = z
  .object({ output_speed_tokens_per_s: z.object({ median: z.number().nullish() }).nullish() })
  .nullish()
  .transform((performance) => performance?.output_speed_tokens_per_s?.median ?? undefined);

export const pricingSchema = z
  .object({ input: z.number().nullish(), output: z.number().nullish() })
  .nullish();

const pageSchema = z.object({
  results: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      creator_name: z.string(),
      intelligence_index: z.number().nullable(),
      intelligence_index_cost_per_task_usd: z.number().nullable(),
      is_open_weights: z.boolean(),
      performance: speedSchema,
      pricing_usd_per_1m_tokens: pricingSchema,
      benchmarks: z.record(z.string(), z.number().nullable()).nullish(),
    }),
  ),
});

export interface Model {
  slug: string;
  name: string;
  creator: string;
  score: number;
  /** Undefined when Artificial Analysis hasn't measured it; list prices can't stand in, see README. */
  costPerTask: number | undefined;
  /** USD per 1M tokens, blended 3 input : 1 output. */
  listPrice: number | undefined;
  openWeights: boolean;
  tokensPerSecond: number | undefined;
  /** Per-benchmark scores (e.g. terminal_bench_4_0, mmmu_pro); null where not measured. */
  benchmarks: Record<string, number | null>;
}

type MeasuredModel = Model & { costPerTask: number };

function blendedPrice(pricing: z.infer<typeof pricingSchema>): number | undefined {
  const input = pricing?.input;
  const output = pricing?.output;
  return input === undefined || input === null || output === undefined || output === null
    ? undefined
    : (3 * input + output) / 4;
}

// The current (non-deprecated) leaderboard is under 300 rows; four pages in one batched request covers it.
const PAGE_SIZE = 100;
const PAGES = 4;

export async function fetchModels(): Promise<Model[]> {
  const pages = await callAll(
    Array.from({ length: PAGES }, (_, page) => ({
      provider: "artificialanalysis-ai",
      capability: "benchmarks/search_models",
      options:
        page === 0 ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor: String(page * PAGE_SIZE) },
    })),
  );
  const rows = pages.flatMap((page) => pageSchema.parse(page).results);
  return rows.flatMap((row) =>
    row.intelligence_index === null
      ? []
      : [
          {
            slug: row.slug,
            name: row.name,
            creator: row.creator_name,
            score: row.intelligence_index,
            costPerTask: row.intelligence_index_cost_per_task_usd ?? undefined,
            listPrice: blendedPrice(row.pricing_usd_per_1m_tokens),
            openWeights: row.is_open_weights,
            tokensPerSecond: row.performance,
            benchmarks: row.benchmarks ?? {},
          },
        ],
  );
}

// Index differences under half a point are benchmark noise, not a reason to pay more.
const MIN_SCORE_GAIN = 0.5;

export interface PickOptions {
  minScore: number;
  maxCost: number;
  openWeightsOnly: boolean;
  /** Restrict to one creator, e.g. Anthropic for what Claude Code can run natively. */
  creator: string | undefined;
}

/**
 * Models no other model beats on both score and cost, cheapest first: every other model is
 * either dumber or pricier than something on this list.
 */
export function pick(models: Model[], options: PickOptions): MeasuredModel[] {
  const byCost = eligible(models, options).toSorted(
    (a, b) => a.costPerTask - b.costPerTask || b.score - a.score,
  );
  const frontier: MeasuredModel[] = [];
  for (const model of byCost) {
    const best = frontier.at(-1);
    if (!best || model.score >= best.score + MIN_SCORE_GAIN) frontier.push(model);
  }
  return frontier;
}

/** Every model with a measured cost that clears the floor and the filters. */
export function eligible(models: Model[], options: PickOptions): MeasuredModel[] {
  return models.filter(
    (model): model is MeasuredModel =>
      model.costPerTask !== undefined &&
      model.costPerTask > 0 &&
      model.costPerTask <= options.maxCost &&
      model.score >= options.minScore &&
      (!options.openWeightsOnly || model.openWeights) &&
      (options.creator === undefined || model.creator === options.creator),
  );
}

// A model costing up to this much more than the cheapest qualifying one wins if it scores higher:
// a few percent of price isn't worth several points of intelligence.
const VALUE_MARGIN = 1.1;

/** The highest-scoring candidate priced within `margin` times the cheapest one. */
export function bestValue<T>(
  candidates: readonly T[],
  score: (candidate: T) => number,
  cost: (candidate: T) => number,
  margin = VALUE_MARGIN,
): T | undefined {
  const cheapest = Math.min(...candidates.map(cost));
  return candidates
    .filter((candidate) => cost(candidate) <= cheapest * margin)
    .reduce<T | undefined>(
      (best, candidate) =>
        best === undefined ||
        score(candidate) > score(best) ||
        // Ties include models the benchmark never measured, which all rank last.
        (score(candidate) === score(best) && cost(candidate) < cost(best))
          ? candidate
          : best,
      undefined,
    );
}

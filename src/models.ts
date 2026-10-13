import { z } from "zod";
import { callAll } from "./alexandria.ts";

export const speedSchema = z
  .object({ output_speed_tokens_per_s: z.object({ median: z.number().nullish() }).nullish() })
  .nullish()
  .transform((performance) => performance?.output_speed_tokens_per_s?.median ?? undefined);

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
    }),
  ),
});

export interface Model {
  slug: string;
  name: string;
  creator: string;
  score: number;
  costPerTask: number;
  openWeights: boolean;
  tokensPerSecond: number | undefined;
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
    row.intelligence_index === null || row.intelligence_index_cost_per_task_usd === null
      ? []
      : [
          {
            slug: row.slug,
            name: row.name,
            creator: row.creator_name,
            score: row.intelligence_index,
            costPerTask: row.intelligence_index_cost_per_task_usd,
            openWeights: row.is_open_weights,
            tokensPerSecond: row.performance,
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
}

/**
 * Models no other model beats on both score and cost, cheapest first: every other model is
 * either dumber or pricier than something on this list.
 */
export function pick(models: Model[], options: PickOptions): Model[] {
  const candidates = models.filter(
    (model) =>
      model.score >= options.minScore &&
      model.costPerTask <= options.maxCost &&
      model.costPerTask > 0 &&
      (!options.openWeightsOnly || model.openWeights),
  );
  const byCost = candidates.toSorted((a, b) => a.costPerTask - b.costPerTask || b.score - a.score);
  const frontier: Model[] = [];
  for (const model of byCost) {
    const best = frontier.at(-1);
    if (!best || model.score >= best.score + MIN_SCORE_GAIN) frontier.push(model);
  }
  return frontier;
}

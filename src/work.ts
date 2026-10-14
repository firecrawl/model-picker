import { fetchMineBench } from "./minebench.ts";
import type { Model } from "./models.ts";

// Intelligence Index floors: hard is frontier-level reasoning, easy is boilerplate a small model handles.
export const FLOORS = { hard: 50, medium: 42, easy: 30 } as const;
export type Difficulty = keyof typeof FLOORS;
export const DIFFICULTIES = ["hard", "medium", "easy"] as const satisfies readonly Difficulty[];

export const WORK_KINDS = ["coding", "tools", "vision", "long-context", "3d", "general"] as const;
export type Work = (typeof WORK_KINDS)[number];
// Benchmarks that measure each kind of work, best first. General work ranks on the Intelligence Index.
const WORK_BENCHMARKS: Record<Work, readonly string[]> = {
  coding: ["terminal_bench_4_0", "terminalbench_hard", "scicode"],
  tools: ["tau2", "terminal_bench_4_0"],
  vision: ["mmmu_pro"],
  "long-context": ["lcr"],
  "3d": ["minebench"],
  general: [],
};

export const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
export const normalize = (id: string): string => id.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
/** A model's slug without its effort, normalized, e.g. `gpt-6-1-sol-high` → `gpt61sol`. */
export const baseName = (slug: string): string => normalize(slug.replace(EFFORT_SUFFIX, ""));

/** How well a model does the kind of work; a model without that benchmark ranks last. */
export function workScore(model: Model, work: Work): number {
  const benchmarks = WORK_BENCHMARKS[work];
  if (benchmarks.length === 0) return model.score;
  for (const name of benchmarks) {
    const score = model.benchmarks[name];
    if (score !== null && score !== undefined) return score;
  }
  return -1;
}

/** Adds each model's MineBench rating (3D building) to its benchmarks as `minebench`. */
export async function withMineBench(models: Model[]): Promise<Model[]> {
  // A third-party page: if it can't be scraped, everything still works and 3D work ranks no one first.
  const mineBench = await fetchMineBench().catch(() => new Map<string, number>());
  const ratings = new Map(
    [...mineBench].map(([name, rating]): [string, number] => [normalize(name), rating]),
  );
  return models.map((model) => {
    const base = baseName(model.slug);
    // MineBench names a model without its effort ("Claude Opus 5.5"), sometimes after its maker
    // ("Z.AI GLM 5.3"), so every effort level of a model shares its rating.
    const minebench = ratings.get(base) ?? ratings.get(normalize(model.creator) + base) ?? null;
    return { ...model, benchmarks: { ...model.benchmarks, minebench } };
  });
}

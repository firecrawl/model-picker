import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bestValue, fetchModels, type Model as BenchmarkedModel } from "../src/models.ts";

// Same Intelligence Index floors as `model-picker build`.
const FLOORS = { hard: 50, medium: 42, easy: 30 } as const;
export type Difficulty = keyof typeof FLOORS;
export const DIFFICULTIES: readonly Difficulty[] = ["hard", "medium", "easy"];

export const TASKS = ["coding", "tools", "vision", "long-context", "general"] as const;
export type Task = (typeof TASKS)[number];
// Benchmarks that measure each kind of work, best first. General work ranks on the Intelligence Index.
const TASK_BENCHMARKS: Record<Task, readonly string[]> = {
  coding: ["terminal_bench_4_0", "terminalbench_hard", "scicode"],
  tools: ["tau2", "terminal_bench_4_0"],
  vision: ["mmmu_pro"],
  "long-context": ["lcr"],
  general: [],
};

export interface RouterState {
  difficulty: Difficulty;
  task: Task;
}

export interface Candidates {
  all: Candidate[];
  valueMargin: number;
}

export interface Candidate {
  benchmarked: BenchmarkedModel & { costPerTask: number };
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

interface Needs {
  image: boolean;
  /** Rough size of the conversation, so the chosen model's context window fits it. */
  tokens: number;
}

const settingsSchema = z.object({
  creators: z.array(z.string()).optional(),
  openWeightsOnly: z.boolean().default(false),
  maxCost: z.number().default(Number.POSITIVE_INFINITY),
  // How much pricier than the cheapest qualifying model a better-suited one may be (1.1 = 10%).
  valueMargin: z.number().min(1).default(1.1),
  // OpenRouter model the savings line compares against.
  baseline: z.string().default("anthropic/claude-opus-5.5"),
});
const SETTINGS_FILE =
  process.env.MODEL_PICKER_ROUTER_SETTINGS ??
  join(homedir(), ".config", "model-picker", "router.json");

const EFFORTS: Record<string, ModelThinkingLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};
const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
const normalize = (id: string): string => id.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

export async function loadSettings(): Promise<z.infer<typeof settingsSchema>> {
  const text = await readFile(SETTINGS_FILE, "utf8").catch(() => "{}");
  return settingsSchema.parse(JSON.parse(text));
}

/** Every benchmarked model, with a measured cost, that Pi can reach through OpenRouter. */
export async function loadCandidates(ctx: ExtensionContext): Promise<Candidates> {
  const settings = await loadSettings();
  const allowed = new Set(settings.creators?.map((creator) => creator.toLowerCase()));
  const openRouter = new Map(
    ctx.modelRegistry
      .getAll()
      .filter((model) => model.provider === "openrouter")
      .map((model): [string, Model<Api>] => [normalize(model.id.split("/").at(-1) ?? ""), model]),
  );
  const all = (await fetchModels()).flatMap((benchmarked) => {
    const { costPerTask } = benchmarked;
    if (costPerTask === undefined || costPerTask <= 0 || costPerTask > settings.maxCost) return [];
    if (settings.openWeightsOnly && !benchmarked.openWeights) return [];
    if (allowed.size > 0 && !allowed.has(benchmarked.creator.toLowerCase())) return [];
    const model = openRouter.get(normalize(benchmarked.slug.replace(EFFORT_SUFFIX, "")));
    if (!model) return [];
    // Artificial Analysis labels a model's top effort "Max" and gives it no slug suffix.
    const effort = EFFORT_SUFFIX.exec(benchmarked.slug)?.[1];
    const thinkingLevel =
      effort === undefined ? (/\(Max\b/.test(benchmarked.name) ? "max" : "off") : EFFORTS[effort];
    return [
      {
        benchmarked: { ...benchmarked, costPerTask },
        model,
        thinkingLevel: thinkingLevel ?? "medium",
      },
    ];
  });
  return { all, valueMargin: settings.valueMargin };
}

/** How well a candidate does the kind of work; a model without that benchmark ranks last. */
function taskScore(candidate: Candidate, task: Task): number {
  const benchmarks = TASK_BENCHMARKS[task];
  if (benchmarks.length === 0) return candidate.benchmarked.score;
  for (const name of benchmarks) {
    const score = candidate.benchmarked.benchmarks[name];
    if (score !== null && score !== undefined) return score;
  }
  return -1;
}

/**
 * Among models that clear the difficulty floor and can take the request (images, context size),
 * the best at this kind of work within a few percent of the cheapest price.
 */
export function choose(
  { all: candidates, valueMargin }: Candidates,
  difficulty: Difficulty,
  task: Task,
  needs: Needs,
): ModelRoute<RouterState> {
  const eligible = candidates.filter(
    ({ benchmarked, model }) =>
      benchmarked.score >= FLOORS[difficulty] &&
      (!needs.image || model.input.includes("image")) &&
      model.contextWindow >= needs.tokens * 1.2,
  );
  const choice = bestValue(
    eligible,
    (candidate) => taskScore(candidate, task),
    (candidate) => candidate.benchmarked.costPerTask,
    valueMargin,
  );
  if (!choice) {
    throw new Error(
      `model-picker: no ${difficulty} ${task} model (score ${FLOORS[difficulty]}+${needs.image ? ", images" : ""}) on OpenRouter`,
    );
  }
  return { model: choice.model, thinkingLevel: choice.thinkingLevel, state: { difficulty, task } };
}

export function needsOf(messages: readonly Message[]): Needs {
  const content = messages.findLast((message) => message.role === "user")?.content;
  return {
    image: Array.isArray(content) && content.some((block) => block.type === "image"),
    // About four characters a token; good enough to rule out models that can't hold the conversation.
    tokens: JSON.stringify(messages).length / 4,
  };
}

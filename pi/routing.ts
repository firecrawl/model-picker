import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bestValue, fetchModels, type Model as BenchmarkedModel } from "../src/models.ts";
import {
  baseName,
  EFFORT_SUFFIX,
  FLOORS,
  normalize,
  withMineBench,
  workScore,
  type Difficulty,
  type Work as Task,
} from "../src/work.ts";
import { REGIONS } from "./regions.ts";

export { DIFFICULTIES, WORK_KINDS as TASKS } from "../src/work.ts";
export type { Difficulty, Task };

export interface RouterState {
  difficulty: Difficulty;
  task: Task;
  /** No allowed model clears the difficulty's floor, so the highest-scoring one answers. */
  bestAvailable?: boolean;
  /** How sure SubQ Snap was of the difficulty, when it labelled the message. */
  snapConfidence?: number;
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
  region: z.enum(["china", "us", "europe"]).optional(),
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
  max: "max",
};
const NAME_EFFORT = /\((low|medium|high|xhigh|max)\b/i;

/** The settings file, with `mp chat` flags (passed as JSON in the environment) on top. */
export async function loadSettings(): Promise<z.infer<typeof settingsSchema>> {
  const text = await readFile(SETTINGS_FILE, "utf8").catch(() => "{}");
  const overrides = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(process.env.MODEL_PICKER_ROUTER_OVERRIDES ?? "{}"));
  return settingsSchema.parse({
    ...z.record(z.string(), z.unknown()).parse(JSON.parse(text)),
    ...overrides,
  });
}

/** Every benchmarked model, with a measured cost, that Pi can reach through OpenRouter. */
export async function loadCandidates(ctx: ExtensionContext): Promise<Candidates> {
  const settings = await loadSettings();
  const allowed = new Set(settings.creators?.map(normalize));
  const regional = settings.region
    ? new Set<string>(REGIONS[settings.region].map(normalize))
    : undefined;
  const openRouter = new Map(
    ctx.modelRegistry
      .getAll()
      .filter((model) => model.provider === "openrouter")
      .map((model): [string, Model<Api>] => [normalize(model.id.split("/").at(-1) ?? ""), model]),
  );
  const all = (await withMineBench(await fetchModels())).flatMap((benchmarked) => {
    const { costPerTask } = benchmarked;
    if (costPerTask === undefined || costPerTask <= 0 || costPerTask > settings.maxCost) return [];
    if (settings.openWeightsOnly && !benchmarked.openWeights) return [];
    // Names compare without case, spaces or punctuation, so "Zai" matches "Z AI".
    if (allowed.size > 0 && !allowed.has(normalize(benchmarked.creator))) return [];
    if (regional && !regional.has(normalize(benchmarked.creator))) return [];
    const model = openRouter.get(baseName(benchmarked.slug));
    if (!model) return [];
    // Some slugs carry no effort suffix and only the name has it, e.g. "Gemini 4 Argon (High)" or "(Max)".
    const effort = (
      EFFORT_SUFFIX.exec(benchmarked.slug)?.[1] ?? NAME_EFFORT.exec(benchmarked.name)?.[1]
    )?.toLowerCase();
    const thinkingLevel = effort === undefined ? "off" : EFFORTS[effort];
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
  const able = candidates.filter(
    ({ model }) =>
      (!needs.image || model.input.includes("image")) && model.contextWindow >= needs.tokens * 1.2,
  );
  const eligible = able.filter(({ benchmarked }) => benchmarked.score >= FLOORS[difficulty]);
  // Filters like a region can leave nothing above the floor; then the strongest allowed model answers.
  if (eligible.length === 0 && able.length > 0) {
    const strongest = able.reduce((best, candidate) =>
      candidate.benchmarked.score > best.benchmarked.score ? candidate : best,
    );
    return {
      model: strongest.model,
      thinkingLevel: strongest.thinkingLevel,
      state: { difficulty, task, bestAvailable: true },
    };
  }
  const choice = bestValue(
    eligible,
    (candidate) => workScore(candidate.benchmarked, task),
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

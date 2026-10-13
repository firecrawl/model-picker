import { join } from "node:path";
import { z } from "zod";
import { pick, type Model, type PickOptions } from "./models.ts";
import { runOpenCode, type OpenCodeRun } from "./opencode.ts";
import { toRunnable, type Runnable } from "./openrouter.ts";

const difficulties = ["hard", "medium", "easy"] as const;
type Difficulty = (typeof difficulties)[number];

// Intelligence Index floors: hard is frontier-level reasoning, easy is boilerplate a small model handles.
const MIN_SCORE: Record<Difficulty, number> = { hard: 50, medium: 42, easy: 30 };

const planSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string(),
        instructions: z.string(),
        difficulty: z.enum(difficulties),
      }),
    )
    .min(1),
});

export interface BuildStep {
  title: string;
  difficulty: Difficulty | "plan";
  runnable: Runnable;
  run: OpenCodeRun;
}

const planPrompt = (task: string): string => `You are the planner. Do not build anything yet.

Split the task below into 3 to 6 sequential build steps that other engineers will carry out one at a time in this folder. Tag each step with how much reasoning it needs:
- "hard": architecture, tricky math or algorithms, subtle bugs likely
- "medium": substantial feature code following a clear design
- "easy": boilerplate, styling, simple additions, docs

Write only the file plan.json in this folder, shaped exactly like:
{"steps":[{"title":"...","instructions":"...","difficulty":"hard|medium|easy"}]}

Instructions must be specific enough for someone who hasn't seen the task (name files, functions and how steps connect). Mark a step hard only when it truly needs it.

Task:
${task}`;

const stepPrompt = (
  task: string,
  index: number,
  total: number,
  title: string,
  instructions: string,
): string =>
  `You are doing step ${index} of ${total} of a larger build in this folder. Earlier steps' files are already here: read them and build on them rather than starting over. The full plan is in plan.json; do only your step.

Overall task:
${task}

Your step: ${title}
${instructions}`;

function cheapestRunnable(
  models: Model[],
  openRouter: Map<string, string>,
  options: PickOptions,
): Runnable {
  const runnable = pick(models, options)
    .map((model) => toRunnable(model, openRouter))
    .find((candidate) => candidate !== undefined);
  if (!runnable) throw new Error(`No model scoring ${options.minScore}+ is on OpenRouter.`);
  return runnable;
}

/** Plans the task with a capable model, then gives each step to the cheapest model good enough for it. */
export async function build(
  task: string,
  dir: string,
  models: Model[],
  openRouter: Map<string, string>,
  baseOptions: Omit<PickOptions, "minScore">,
  onStep: (step: BuildStep) => void,
): Promise<BuildStep[]> {
  const runnableFor = (difficulty: Difficulty): Runnable =>
    cheapestRunnable(models, openRouter, { ...baseOptions, minScore: MIN_SCORE[difficulty] });

  const planner = runnableFor("hard");
  const planRun = await runOpenCode(dir, planner.opencodeId, planPrompt(task));
  const planStep: BuildStep = {
    title: "Plan the build",
    difficulty: "plan",
    runnable: planner,
    run: planRun,
  };
  onStep(planStep);
  const planFile = Bun.file(join(dir, "plan.json"));
  if (!(await planFile.exists()))
    throw new Error(`The planner didn't write plan.json: ${planRun.reply}`);
  const { steps } = planSchema.parse(await planFile.json());

  const done: BuildStep[] = [planStep];
  for (const [index, step] of steps.entries()) {
    const runnable = runnableFor(step.difficulty);
    const prompt = stepPrompt(task, index + 1, steps.length, step.title, step.instructions);
    const result: BuildStep = {
      title: step.title,
      difficulty: step.difficulty,
      runnable,
      run: await runOpenCode(dir, runnable.opencodeId, prompt),
    };
    onStep(result);
    done.push(result);
  }
  return done;
}

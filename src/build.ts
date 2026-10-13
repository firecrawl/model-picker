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
        id: z.number(),
        title: z.string(),
        instructions: z.string(),
        difficulty: z.enum(difficulties),
        files: z.array(z.string()).default([]),
        dependsOn: z.array(z.number()).default([]),
      }),
    )
    .min(1),
});
type PlannedStep = z.infer<typeof planSchema>["steps"][number];

export interface BuildStep {
  title: string;
  difficulty: Difficulty | "plan";
  runnable: Runnable;
  run: OpenCodeRun;
}

export interface BuildResult {
  steps: BuildStep[];
  wallSeconds: number;
}

const planPrompt = (task: string): string => `You are the planner. Do not build anything yet.

Split the task below into as few build steps as will do it well: 1 step for a focused change to existing code, at most 4 for a large build. Every step is a fresh session that has to re-read the project, so fewer, bigger steps are faster and cheaper.

Steps run at the same time when they can. For each step, list the files it creates or edits ("files") and the ids of the steps that must finish before it starts ("dependsOn"). Two steps must never edit the same file unless one depends on the other.

Only the last step may run the app, take screenshots or compare against references; earlier steps just write code.

Tag each step with how much reasoning it needs:
- "hard": architecture, tricky math or algorithms, subtle bugs likely
- "medium": substantial feature code following a clear design
- "easy": boilerplate, styling, simple additions, docs

Write only the file plan.json in this folder, shaped exactly like:
{"steps":[{"id":1,"title":"...","instructions":"...","difficulty":"hard|medium|easy","files":["index.html"],"dependsOn":[]}]}

Instructions must be specific enough for someone who hasn't seen the task (name files, functions and how steps connect). Mark a step hard only when it truly needs it.

Task:
${task}`;

function stepPrompt(task: string, step: PlannedStep, total: number): string {
  const files =
    step.files.length === 0
      ? ""
      : `\nOther steps may be editing other files in this folder at the same time. Only create or edit these files: ${step.files.join(", ")}.`;
  return `You are doing step ${step.id} of ${total} of a larger build in this folder. Files from finished steps are already here: build on them rather than starting over. The full plan is in plan.json; do only your step.${files}

Overall task:
${task}

Your step: ${step.title}
${step.instructions}`;
}

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

// A step that lists no files could touch anything, so it runs alone.
const conflicts = (step: PlannedStep, busy: PlannedStep[]): boolean =>
  busy.length > 0 &&
  (step.files.length === 0 ||
    busy.some(
      (other) => other.files.length === 0 || other.files.some((file) => step.files.includes(file)),
    ));

/** Starts every step whose dependencies are done and whose files no running step is editing. */
async function runInParallel(
  steps: PlannedStep[],
  start: (step: PlannedStep) => Promise<BuildStep>,
): Promise<BuildStep[]> {
  const finished = new Map<number, BuildStep>();
  const running = new Map<number, Promise<void>>();
  const waiting = new Set(steps);
  while (waiting.size > 0 || running.size > 0) {
    for (const step of waiting) {
      const busy = steps.filter((other) => running.has(other.id));
      if (!step.dependsOn.every((id) => finished.has(id)) || conflicts(step, busy)) continue;
      waiting.delete(step);
      running.set(
        step.id,
        start(step).then((result) => {
          finished.set(step.id, result);
          running.delete(step.id);
        }),
      );
    }
    if (running.size === 0) {
      throw new Error(
        `plan.json can't finish: steps ${[...waiting].map((step) => step.id).join(", ")} wait on missing or circular dependencies.`,
      );
    }
    await Promise.race(running.values());
  }
  return steps.flatMap((step) => {
    const result = finished.get(step.id);
    return result ? [result] : [];
  });
}

/** Plans the task with a capable model, then gives each step to the cheapest model good enough for it. */
export async function build(
  task: string,
  dir: string,
  models: Model[],
  openRouter: Map<string, string>,
  baseOptions: Omit<PickOptions, "minScore">,
  onStep: (step: BuildStep) => void,
): Promise<BuildResult> {
  const started = performance.now();
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

  const built = await runInParallel(steps, async (step) => {
    const runnable = runnableFor(step.difficulty);
    const result: BuildStep = {
      title: step.title,
      difficulty: step.difficulty,
      runnable,
      run: await runOpenCode(dir, runnable.opencodeId, stepPrompt(task, step, steps.length)),
    };
    onStep(result);
    return result;
  });
  return { steps: [planStep, ...built], wallSeconds: (performance.now() - started) / 1000 };
}

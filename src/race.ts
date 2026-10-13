import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Runnable } from "./openrouter.ts";

export interface RaceResult {
  runnable: Runnable;
  worktree: string;
  seconds: number;
  exitCode: number;
  reply: string;
  diffStat: string;
  checkPassed: boolean | undefined;
}

const eventSchema = z.object({
  type: z.string(),
  part: z.object({ text: z.string().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

function lastReply(jsonLines: string): string {
  let reply = "";
  for (const line of jsonLines.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed = eventSchema.safeParse(JSON.parse(line));
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.type === "text" && event.part?.text !== undefined) reply = event.part.text;
    if (event.type === "error" && event.error) reply = `Error: ${event.error.message}`;
  }
  return reply;
}

export async function repoRoot(dir: string): Promise<string> {
  const result = await Bun.$`git -C ${dir} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`${dir} is not a git repo. run needs one so each model gets its own worktree.`);
  }
  return result.text().trim();
}

async function runOne(
  repo: string,
  base: string,
  runnable: Runnable,
  task: string,
  check: string | undefined,
): Promise<RaceResult> {
  const worktree = join(base, runnable.model.slug);
  await Bun.$`git -C ${repo} worktree add --detach ${worktree}`.quiet();
  const started = performance.now();
  const opencode = Bun.spawn(
    [
      "opencode",
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "-m",
      runnable.opencodeId,
      task,
    ],
    // OpenCode takes its project directory from PWD, not the process cwd.
    { cwd: worktree, env: { ...process.env, PWD: worktree }, stdout: "pipe", stderr: "ignore" },
  );
  const output = await new Response(opencode.stdout).text();
  const exitCode = await opencode.exited;
  const seconds = (performance.now() - started) / 1000;
  const diffStat = (
    await Bun.$`git -C ${worktree} add -A && git -C ${worktree} diff --cached --shortstat`
      .quiet()
      .nothrow()
      .text()
  ).trim();
  const checkPassed =
    check === undefined
      ? undefined
      : (await Bun.$`sh -c ${check}`.cwd(worktree).quiet().nothrow()).exitCode === 0;
  return { runnable, worktree, seconds, exitCode, reply: lastReply(output), diffStat, checkPassed };
}

/** Runs the same task with each model in parallel, each in its own git worktree of `repo`. */
export async function race(
  repo: string,
  runnables: Runnable[],
  task: string,
  check: string | undefined,
  onFinish: (result: RaceResult) => void,
): Promise<RaceResult[]> {
  const base = await mkdtemp(join(tmpdir(), "model-picker-race-"));
  return Promise.all(
    runnables.map(async (runnable) => {
      const result = await runOne(repo, base, runnable, task, check);
      onFinish(result);
      return result;
    }),
  );
}

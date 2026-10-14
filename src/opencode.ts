import { z } from "zod";
import { jsonEvents, parseJson, type AgentRun, type Harness, type Usage } from "./harness.ts";
import { modelMap, runnableId, type Runnable } from "./openrouter.ts";

// A cold OpenCode background service answers `models` with exit 0 and no output; later calls work.
const LIST_ATTEMPTS = 3;

async function openCodeModels(): Promise<Map<string, string>> {
  for (let attempt = 1; ; attempt++) {
    const output = await Bun.$`opencode models`.quiet().nothrow().text();
    if (output.trim() !== "" || attempt === LIST_ATTEMPTS)
      return modelMap(output.split("\n").map((line) => line.trim()));
    await Bun.sleep(1000);
  }
}

const eventSchema = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  part: z.object({ text: z.string().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

const sessionSchema = z.object({
  info: z.object({
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({ read: z.number(), write: z.number() }),
    }),
  }),
});

const STEP_TIMEOUT_MS = 30 * 60 * 1000;
// Exports of long sessions run to megabytes; give them room before treating usage as unknown.
const EXPORT_TIMEOUT_MS = 3 * 60 * 1000;


function parseEvents(jsonLines: string): { sessionId: string | undefined; reply: string } {
  let sessionId: string | undefined;
  let reply = "";
  for (const event of jsonEvents(jsonLines, eventSchema)) {
    sessionId ??= event.sessionID;
    if (event.type === "text" && event.part?.text !== undefined) reply = event.part.text;
    if (event.type === "error" && event.error) reply = `Error: ${event.error.message}`;
  }
  return { sessionId, reply };
}

// OpenCode takes its project directory from PWD, not the process cwd.
const inDir = (dir: string) => ({ cwd: dir, env: { ...process.env, PWD: dir } });

// Right after a session ends, its export can fail while OpenCode is still saving it; by hand
// a few seconds later it succeeds, so wait longer before each retry.
const EXPORT_RETRY_DELAYS_MS = [0, 3000, 10_000, 30_000];

async function exportUsage(dir: string, sessionId: string): Promise<Usage | undefined> {
  const exporter = Bun.spawn(["opencode", "session", "export", sessionId], {
    ...inDir(dir),
    stdout: "pipe",
    stderr: "ignore",
    timeout: EXPORT_TIMEOUT_MS,
  });
  const output = await new Response(exporter.stdout).text();
  if ((await exporter.exited) !== 0) return undefined;
  const parsed = sessionSchema.safeParse(parseJson(output));
  if (!parsed.success) return undefined;
  const { cost, tokens } = parsed.data.info;
  return {
    costUsd: cost,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    cacheReadTokens: tokens.cache.read,
    cacheWriteTokens: tokens.cache.write,
  };
}

async function sessionUsage(dir: string, sessionId: string): Promise<Usage | undefined> {
  for (const delay of EXPORT_RETRY_DELAYS_MS) {
    await Bun.sleep(delay);
    const usage = await exportUsage(dir, sessionId);
    if (usage) return usage;
  }
  return undefined;
}

/**
 * One non-interactive OpenCode session in `dir`, with its cost and tokens from the session export.
 * A failed export leaves usage unknown; the session id lets it be retried by hand with
 * `opencode session export <id>`.
 */
async function runOpenCode(dir: string, runnable: Runnable, prompt: string): Promise<AgentRun> {
  const started = performance.now();
  const opencode = Bun.spawn(
    ["opencode", "run", "--standalone", "--auto", "--format", "json", "-m", runnableId(runnable), prompt],
    { ...inDir(dir), stdout: "pipe", stderr: "ignore", timeout: STEP_TIMEOUT_MS },
  );
  const output = await new Response(opencode.stdout).text();
  const exitCode = await opencode.exited;
  const seconds = (performance.now() - started) / 1000;
  const { sessionId, reply } = parseEvents(output);
  const usage = sessionId === undefined ? undefined : await sessionUsage(dir, sessionId);
  return { exitCode, seconds, reply, usage, sessionId };
}

export const openCodeHarness: Harness = {
  name: "opencode",
  label: "OpenCode",
  models: openCodeModels,
  run: runOpenCode,
  missing: "OpenCode isn't installed or lists no OpenRouter models. Install it from opencode.ai.",
};

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { jsonEvents, type AgentRun, type Harness, type Usage } from "./harness.ts";
import { modelMap, type Runnable } from "./openrouter.ts";
import { compiled, CONFIG_DIR, PI_BIN } from "./paths.ts";

// A Pi config folder of its own, so model-picker starts clean without changing the user's Pi setup.
export const PI_DIR = join(CONFIG_DIR, "pi");
const piEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  PI_CODING_AGENT_DIR: PI_DIR,
});

const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESHED_MARKER = join(PI_DIR, ".models-refreshed");

/**
 * Pi only refreshes its model catalog when asked, so models released since its last refresh
 * are missing from both `build` and `chat` until then. Refresh at most once a day.
 */
export async function refreshPiModels(): Promise<void> {
  const marker = await stat(REFRESHED_MARKER).catch(() => undefined);
  if (marker && Date.now() - marker.mtimeMs < CATALOG_TTL_MS) return;
  const update = Bun.spawn([PI_BIN, "update", "--models"], {
    env: piEnv(),
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await update.exited) === 0) await Bun.write(REFRESHED_MARKER, new Date().toISOString());
}

async function piModels(): Promise<Map<string, string>> {
  await refreshPiModels();
  const output = await Bun.$`${PI_BIN} --list-models openrouter`
    .env(piEnv())
    .quiet()
    .nothrow()
    .text();
  // Rows read `openrouter  openai/gpt-6.1-sol  1.1M ...`; Pi takes the model as `provider/id`.
  const ids = output.split("\n").flatMap((line) => {
    const [provider, id] = line.trim().split(/\s+/);
    return provider === "openrouter" && id !== undefined ? [`openrouter/${id}`] : [];
  });
  return modelMap(ids);
}

const eventSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  message: z
    .object({
      role: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      stopReason: z.string().optional(),
      errorMessage: z.string().optional(),
      usage: z
        .object({
          input: z.number(),
          output: z.number(),
          cacheRead: z.number(),
          cacheWrite: z.number(),
          reasoning: z.number().optional(),
          cost: z.object({ total: z.number() }),
        })
        .optional(),
    })
    .optional(),
});

/** Pi's JSON mode prints one event per line; usage arrives on every finished assistant message. */
function parseEvents(jsonLines: string): Omit<AgentRun, "exitCode" | "seconds"> {
  let sessionId: string | undefined;
  let reply = "";
  let usage: Usage | undefined;
  for (const event of jsonEvents(jsonLines, eventSchema)) {
    if (event.type === "session") sessionId ??= event.id;
    const message = event.message;
    if (event.type !== "message_end" || message?.role !== "assistant") continue;
    const text = message.content?.flatMap((block) =>
      block.type === "text" ? [block.text ?? ""] : [],
    );
    if (text && text.length > 0) reply = text.join("\n");
    if (message.stopReason === "error" && message.errorMessage !== undefined)
      reply = `Error: ${message.errorMessage}`;
    if (message.usage) {
      const { input, output, cacheRead, cacheWrite, reasoning, cost } = message.usage;
      usage = {
        costUsd: (usage?.costUsd ?? 0) + cost.total,
        inputTokens: (usage?.inputTokens ?? 0) + input,
        outputTokens: (usage?.outputTokens ?? 0) + output,
        reasoningTokens: (usage?.reasoningTokens ?? 0) + (reasoning ?? 0),
        cacheReadTokens: (usage?.cacheReadTokens ?? 0) + cacheRead,
        cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + cacheWrite,
      };
    }
  }
  return { sessionId, reply, usage };
}

/** One non-interactive Pi session in `dir`. Pi runs its tools without asking, like OpenCode's --auto. */
async function runPi(dir: string, runnable: Runnable, prompt: string): Promise<AgentRun> {
  const started = performance.now();
  const pi = Bun.spawn(
    [
      PI_BIN,
      "--print",
      "--mode",
      "json",
      "--model",
      runnable.modelId,
      ...(runnable.effort === undefined ? [] : ["--thinking", runnable.effort]),
      // Only the step: no global skills, prompt templates or extensions.
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      "--",
      prompt,
    ],
    { cwd: dir, env: piEnv(), stdout: "pipe", stderr: "ignore", timeout: STEP_TIMEOUT_MS },
  );
  const output = await new Response(pi.stdout).text();
  const exitCode = await pi.exited;
  return { exitCode, seconds: (performance.now() - started) / 1000, ...parseEvents(output) };
}

export const piHarness: Harness = {
  name: "pi",
  label: "Pi",
  models: piModels,
  run: runPi,
  missing: compiled
    ? "Pi lists no OpenRouter models. Reinstall model-picker to restore the Pi that ships with it."
    : "Pi lists no OpenRouter models. Run `bun install` in the model-picker folder.",
};

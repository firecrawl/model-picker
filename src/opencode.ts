import { z } from "zod";

export interface Usage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface OpenCodeRun {
  exitCode: number;
  seconds: number;
  reply: string;
  /** Undefined when OpenCode's session export failed; the OpenRouter activity page still has it. */
  usage: Usage | undefined;
  /** Kept so a failed export can be retried by hand: `opencode session export <id>`. */
  sessionId: string | undefined;
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

// OpenCode's output can end mid-line (a killed run, a truncated export); skip what doesn't parse.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseEvents(jsonLines: string): { sessionId: string | undefined; reply: string } {
  let sessionId: string | undefined;
  let reply = "";
  for (const line of jsonLines.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed = eventSchema.safeParse(parseJson(line));
    if (!parsed.success) continue;
    const event = parsed.data;
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

/** One non-interactive OpenCode session in `dir`, with its cost and tokens from the session export. */
export async function runOpenCode(
  dir: string,
  opencodeId: string,
  prompt: string,
): Promise<OpenCodeRun> {
  const started = performance.now();
  const opencode = Bun.spawn(
    ["opencode", "run", "--standalone", "--auto", "--format", "json", "-m", opencodeId, prompt],
    { ...inDir(dir), stdout: "pipe", stderr: "ignore", timeout: STEP_TIMEOUT_MS },
  );
  const output = await new Response(opencode.stdout).text();
  const exitCode = await opencode.exited;
  const seconds = (performance.now() - started) / 1000;
  const { sessionId, reply } = parseEvents(output);
  const usage = sessionId === undefined ? undefined : await sessionUsage(dir, sessionId);
  return { exitCode, seconds, reply, usage, sessionId };
}

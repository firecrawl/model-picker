import type { z } from "zod";
import type { Runnable } from "./openrouter.ts";

export const HARNESS_NAMES = ["pi", "opencode"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export interface Usage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRun {
  exitCode: number;
  seconds: number;
  reply: string;
  /** Undefined when the harness didn't report usage; the OpenRouter activity page still has it. */
  usage: Usage | undefined;
  sessionId: string | undefined;
}

/** The coding agent that runs each build step: one non-interactive session per step. */
export interface Harness {
  name: HarnessName;
  label: string;
  /** OpenRouter models it can run, keyed by normalized name without the vendor prefix. */
  models(): Promise<Map<string, string>>;
  run(dir: string, runnable: Runnable, prompt: string): Promise<AgentRun>;
  /** Shown when it lists no OpenRouter models. */
  missing: string;
}

/** A harness's output can end mid-line (a killed run, a truncated export); skip what doesn't parse. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every line of a harness's JSON-lines output that parses and matches `schema`. */
export function jsonEvents<T>(output: string, schema: z.ZodType<T>): T[] {
  return output.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const parsed = schema.safeParse(parseJson(line));
    return parsed.success ? [parsed.data] : [];
  });
}

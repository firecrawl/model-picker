import type { Model } from "./models.ts";
import { baseName, EFFORT_SUFFIX, normalize } from "./work.ts";

export interface Runnable {
  model: Model;
  /** The OpenRouter model as harnesses name it, e.g. `openrouter/openai/gpt-6.1-sol`. */
  modelId: string;
  /** Reasoning effort, e.g. `high`; undefined leaves the model's default. */
  effort: string | undefined;
}

/** One string per model and effort, e.g. `openrouter/openai/gpt-6.1-sol#high`, as OpenCode takes it. */
export const runnableId = ({ modelId, effort }: Runnable): string =>
  effort === undefined ? modelId : `${modelId}#${effort}`;

/** `openrouter/vendor/name` ids keyed by normalized name without the vendor prefix. */
export function modelMap(ids: Iterable<string>): Map<string, string> {
  const models = new Map<string, string>();
  for (const id of ids) {
    // `~` entries are moving "latest" aliases and `:batch`-style ids are variants; benchmarks
    // belong to one fixed model.
    if (!id.startsWith("openrouter/") || id.startsWith("openrouter/~") || id.includes(":")) continue;
    const name = id.split("/").at(-1);
    if (name !== undefined) models.set(normalize(name), id);
  }
  return models;
}

/**
 * Artificial Analysis slugs carry the effort as a suffix (`gpt-6-1-sol-high`), or none, in which
 * case the name may still say it ("Gemini 4 Argon (High)", or "(Max)" for the top effort).
 */
export function toRunnable(model: Model, available: Map<string, string>): Runnable | undefined {
  const effort = (
    EFFORT_SUFFIX.exec(model.slug)?.[1] ?? /\((low|medium|high|xhigh|max)\b/i.exec(model.name)?.[1]
  )?.toLowerCase();
  const modelId = available.get(baseName(model.slug));
  return modelId === undefined ? undefined : { model, modelId, effort };
}

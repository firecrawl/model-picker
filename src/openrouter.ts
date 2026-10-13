import type { Model } from "./models.ts";

export interface Runnable {
  model: Model;
  /** OpenCode model id, e.g. `openrouter/openai/gpt-6.1-sol#high`. */
  opencodeId: string;
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;

const normalize = (id: string): string => id.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

/** OpenRouter models OpenCode can run, keyed by normalized name without the vendor prefix. */
export async function openRouterModels(): Promise<Map<string, string>> {
  const output = await Bun.$`opencode models`.quiet().nothrow().text();
  const ids = new Map<string, string>();
  for (const line of output.split("\n")) {
    const id = line.trim();
    // `~` entries are moving "latest" aliases; benchmarks belong to one fixed model.
    if (!id.startsWith("openrouter/") || id.startsWith("openrouter/~")) continue;
    const name = id.split("/").at(-1);
    if (name !== undefined) ids.set(normalize(name), id);
  }
  return ids;
}

/**
 * Artificial Analysis slugs carry the effort as a suffix (`gpt-6-1-sol-high`), or none for the
 * model's top effort, which its name labels "Max". OpenCode takes the effort after `#`.
 */
export function toRunnable(model: Model, openRouter: Map<string, string>): Runnable | undefined {
  const effort =
    EFFORT_SUFFIX.exec(model.slug)?.[1] ?? (/\(Max\b/.test(model.name) ? "max" : undefined);
  const id = openRouter.get(normalize(model.slug.replace(EFFORT_SUFFIX, "")));
  if (id === undefined) return undefined;
  return { model, opencodeId: effort === undefined ? id : `${id}#${effort}` };
}

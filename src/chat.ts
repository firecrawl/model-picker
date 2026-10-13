import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Keys from model-picker's own .env, for when `chat` runs outside its folder (Bun only loads the cwd's). */
async function keysFromDotEnv(): Promise<Record<string, string>> {
  const file = Bun.file(join(ROOT, ".env"));
  if (!(await file.exists())) return {};
  const keys: Record<string, string> = {};
  for (const line of (await file.text()).split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) keys[match[1]] = match[2];
  }
  return keys;
}

// A Pi config folder of its own, so chat starts clean without changing the user's Pi setup.
const PI_DIR = join(homedir(), ".config", "model-picker", "pi");

async function prepareConfig(): Promise<void> {
  const settings = Bun.file(join(PI_DIR, "settings.json"));
  if (await settings.exists()) return;
  // "header" keeps the router's header but drops Pi's listing of loaded resources.
  await Bun.write(settings, JSON.stringify({ quietStartup: "header" }, null, 2));
}

/** Opens Pi's terminal UI with the model-picker router loaded and selected; extra args go to Pi. */
export async function runChat(piArgs: string[]): Promise<number> {
  await prepareConfig();
  const env = { ...(await keysFromDotEnv()), ...process.env, PI_CODING_AGENT_DIR: PI_DIR };
  const pi = Bun.spawn(
    [
      join(ROOT, "node_modules", ".bin", "pi"),
      "--extension",
      join(ROOT, "pi", "router.ts"),
      "--model",
      "model-picker/auto",
      // Only the router: no global skills, prompt templates or other extensions.
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      ...piArgs,
    ],
    { env, stdio: ["inherit", "inherit", "inherit"] },
  );
  return pi.exited;
}

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

/** Splits chat's own flags (router settings for this session) from the ones meant for Pi. */
function splitArgs(args: string[]): { overrides: Record<string, unknown>; piArgs: string[] } {
  const overrides: Record<string, unknown> = {};
  const piArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = (): string => {
      const next = args[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--region") overrides.region = value();
    else if (arg === "--creators")
      overrides.creators = value()
        .split(",")
        .map((name) => name.trim());
    else if (arg === "--open") overrides.openWeightsOnly = true;
    else if (arg === "--value-margin") overrides.valueMargin = Number(value());
    else if (arg !== undefined) piArgs.push(arg);
  }
  return { overrides, piArgs };
}

/** Opens Pi's terminal UI with the model-picker router loaded and selected; extra args go to Pi. */
export async function runChat(args: string[]): Promise<number> {
  await prepareConfig();
  const { overrides, piArgs } = splitArgs(args);
  const env = {
    ...(await keysFromDotEnv()),
    ...process.env,
    PI_CODING_AGENT_DIR: PI_DIR,
    MODEL_PICKER_ROUTER_OVERRIDES: JSON.stringify(overrides),
  };
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

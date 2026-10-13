import { homedir } from "node:os";
import { join } from "node:path";
import { print } from "./output.ts";

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

const CHAT_HELP = `mp chat: chat and code in Pi, each message routed to the cheapest model good enough for it.

Usage: mp chat [options] [pi options] [@files...] [message]

Model options (this session only, on top of ~/.config/model-picker/router.json):
  --region <china|us|europe>  Only models from makers based there
  --creators <A,B>            Only these makers, as Artificial Analysis names them (e.g. Anthropic,OpenAI)
  --open                      Only open-weights models
  --value-margin <n>          Pay up to n times the cheapest model for one better at the task (default 1.1)

Common Pi options:
  -c, --continue              Continue your last chat
  -r, --resume                Pick a previous chat to resume
  -p, --print <message>       Answer once and exit, without the UI
  @file                       Attach a file or image, e.g. mp chat @screenshot.png

Examples:
  mp chat
  mp chat --region china
  mp chat --creators Anthropic --value-margin 2
  mp chat @screenshot.png "what's wrong with this layout?"

Needs OPENROUTER_API_KEY. Every Pi option: mp chat --pi-help`;

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
  if (args.includes("--help") || args.includes("-h")) {
    print(CHAT_HELP);
    return 0;
  }
  await prepareConfig();
  const { overrides, piArgs } = splitArgs(
    args.map((arg) => (arg === "--pi-help" ? "--help" : arg)),
  );
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

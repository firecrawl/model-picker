import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { normalize } from "../pi/routing.ts";
import { REGIONS } from "../pi/regions.ts";
import { fetchModels } from "./models.ts";
import { print, printError } from "./output.ts";

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
    if (arg === "--region") {
      const region = value().toLowerCase();
      if (!Object.hasOwn(REGIONS, region)) {
        throw new Error(`Unknown region "${region}". Use ${Object.keys(REGIONS).join(", ")}.`);
      }
      overrides.region = region;
    } else if (arg === "--creators")
      overrides.creators = value()
        .split(",")
        .map((name) => name.trim());
    else if (arg === "--open") overrides.openWeightsOnly = true;
    else if (arg === "--value-margin") {
      const margin = Number(value());
      if (!(margin >= 1)) throw new Error("--value-margin needs a number of at least 1, e.g. 2.");
      overrides.valueMargin = margin;
    } else if (arg !== undefined) piArgs.push(arg);
  }
  return { overrides, piArgs };
}

/** Opens Pi's terminal UI with the model-picker router loaded and selected; extra args go to Pi. */
/** Letters to insert, delete or change to turn one name into the other. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Every requested maker that isn't on the leaderboard, with a suggestion where one is close. */
async function unknownCreators(requested: readonly string[]): Promise<string[]> {
  const known = [...new Set((await fetchModels()).map((model) => model.creator))].toSorted();
  const keys = new Set(known.map(normalize));
  const problems = requested
    .filter((name) => !keys.has(normalize(name)))
    .map((name) => {
      const key = normalize(name);
      const close = known.filter((maker) => {
        const other = normalize(maker);
        const typo = editDistance(key, other) <= Math.max(1, Math.floor(other.length / 4));
        return key.length > 1 && (typo || other.includes(key) || key.includes(other));
      });
      const suggestion =
        close.length > 0 ? ` Did you mean ${close.map((maker) => `"${maker}"`).join(" or ")}?` : "";
      return `No model maker called "${name}".${suggestion}`;
    });
  return problems.length === 0 ? [] : [...problems, `Known makers: ${known.join(", ")}`];
}

export async function runChat(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    print(CHAT_HELP);
    return 0;
  }
  const dotEnv = await keysFromDotEnv();
  process.env.FIRECRAWL_API_KEY ??= dotEnv.FIRECRAWL_API_KEY;
  try {
    const { overrides, piArgs } = splitArgs(
      args.map((arg) => (arg === "--pi-help" ? "--help" : arg)),
    );
    const creators = z.array(z.string()).optional().parse(overrides.creators);
    const problems = creators ? await unknownCreators(creators) : [];
    if (problems.length > 0) throw new Error(problems.join("\n"));
    return await launchPi(overrides, piArgs, dotEnv);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function launchPi(
  overrides: Record<string, unknown>,
  piArgs: string[],
  dotEnv: Record<string, string>,
): Promise<number> {
  await prepareConfig();
  const env = {
    ...dotEnv,
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

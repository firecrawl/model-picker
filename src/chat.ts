import { join } from "node:path";
import { z } from "zod";
import { REGIONS } from "../pi/regions.ts";
import { fetchModels } from "./models.ts";
import { print, printError } from "./output.ts";
import { PI_BIN, ROUTER } from "./paths.ts";
import { PI_DIR, refreshPiModels } from "./pi.ts";
import { normalize } from "./work.ts";

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

const CHAT_FLAGS = ["--region", "--creators", "--open", "--value-margin", "--pi-help", "--help"];

/** Every option Pi accepts, read from its own --help so it stays right across Pi versions. */
async function piOptions(): Promise<Set<string>> {
  const help = await Bun.$`${PI_BIN} --help`.quiet().nothrow().text();
  const options = new Set<string>();
  for (const line of help.split("\n")) {
    if (!/^\s+-/.test(line)) continue;
    const usage = line.trim().split(/\s{2,}/)[0] ?? "";
    for (const match of usage.matchAll(/-{1,2}[a-zA-Z][\w-]*/g)) options.add(match[0]);
  }
  return options;
}

/** Options neither chat nor Pi knows, each with the closest real one when there is one. */
async function unknownOptions(piArgs: readonly string[]): Promise<string[]> {
  const end = piArgs.indexOf("--");
  const flags = (end === -1 ? piArgs : piArgs.slice(0, end))
    .filter((arg) => /^-{1,2}[a-zA-Z]/.test(arg))
    .map((arg) => arg.split("=")[0] ?? arg);
  if (flags.length === 0) return [];
  const known = [...CHAT_FLAGS, ...(await piOptions())];
  const problems = flags
    .filter((flag) => !known.includes(flag))
    .map((flag) => {
      const close = known.filter(
        (option) =>
          option.length > 2 && (editDistance(flag, option) <= 2 || option.startsWith(flag)),
      );
      const suggestion =
        close.length > 0
          ? ` Did you mean ${close.map((option) => `"${option}"`).join(" or ")}?`
          : "";
      return `Unknown option "${flag}".${suggestion}`;
    });
  return problems.length === 0 ? [] : [...problems, "See mp chat --help for every option."];
}

export async function runChat(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    print(CHAT_HELP);
    return 0;
  }
  try {
    const { overrides, piArgs } = splitArgs(
      args.map((arg) => (arg === "--pi-help" ? "--help" : arg)),
    );
    const creators = z.array(z.string()).optional().parse(overrides.creators);
    const problems = [
      ...(await unknownOptions(piArgs)),
      ...(creators ? await unknownCreators(creators) : []),
    ];
    if (problems.length > 0) throw new Error(problems.join("\n"));
    return await launchPi(overrides, piArgs);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function launchPi(overrides: Record<string, unknown>, piArgs: string[]): Promise<number> {
  await prepareConfig();
  await refreshPiModels();
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: PI_DIR,
    MODEL_PICKER_ROUTER_OVERRIDES: JSON.stringify(overrides),
  };
  const pi = Bun.spawn(
    [
      PI_BIN,
      "--extension",
      ROUTER,
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

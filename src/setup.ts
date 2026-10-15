import { parse } from "dotenv";
import { readSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { isatty } from "node:tty";
import { z } from "zod";
import { print } from "./output.ts";
import { CONFIG_DIR, DOT_ENV } from "./paths.ts";

type Check = (key: string) => Promise<{ ok: boolean; note: string }>;

const FIRECRAWL_API_URL = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";
const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL ?? "https://openrouter.ai/api/v1";

const creditsSchema = z.object({ data: z.object({ remainingCredits: z.number() }) });

/** Both checks call free endpoints that answer 401 for a bad key, so checking costs nothing. */
const checkFirecrawl: Check = async (key) => {
  const response = await fetch(`${FIRECRAWL_API_URL}/v2/team/credit-usage`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const credits = creditsSchema.safeParse(await response.json().catch(() => undefined));
  return {
    ok: response.ok,
    note: credits.success
      ? `${credits.data.data.remainingCredits.toLocaleString("en-US")} credits left`
      : "",
  };
};

const checkOpenRouter: Check = async (key) => {
  const response = await fetch(`${OPENROUTER_API_URL}/key`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { ok: response.ok, note: "" };
};

const KEYS: readonly { name: string; label: string; need: string; url: string; check?: Check }[] = [
  {
    name: "FIRECRAWL_API_KEY",
    label: "Firecrawl",
    need: "needed for every command",
    url: "https://firecrawl.dev/app/api-keys (free)",
    check: checkFirecrawl,
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    need: "needed for chat and build; model usage is billed to it",
    url: "https://openrouter.ai/settings/keys",
    check: checkOpenRouter,
  },
  {
    name: "SUBQ_API_KEY",
    label: "SubQ",
    need: "optional: SubQ Snap labels the work instead of a GPT model",
    url: "https://subq.ai",
  },
];

export function requireKey(name: string): void {
  if ((process.env[name] ?? "") === "")
    throw new Error(`${name} is not set. Run \`mp setup\` to add it.`);
}

const mask = (value: string): string =>
  value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-4)}` : "****";
const home = (path: string): string => path.replace(homedir(), "~");

/** The .env text with each key set: replaces its line (or its commented-out placeholder), else appends. */
export function withKeys(text: string, keys: Record<string, string>): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const [name, value] of Object.entries(keys)) {
    const active = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${name}\\s*=`);
    const index = lines.findIndex((line) => active.test(line));
    const at = index === -1 ? lines.findIndex((line) => commented.test(line)) : index;
    if (at === -1) lines.push(`${name}=${value}`);
    else lines[at] = `${name}=${value}`;
  }
  return `${lines.join("\n")}\n`;
}

let piped: ReturnType<typeof createInterface> | undefined;
let pipedLines: AsyncIterator<string> | undefined;

const stty = (...args: string[]): string =>
  Bun.spawnSync(["stty", ...args], { stdin: "inherit", stdout: "pipe" })
    .stdout.toString()
    .trim();

/**
 * Reads keystrokes with blocking reads, not process.stdin: when the installer hands over its
 * terminal with `</dev/tty`, Bun's event loop never sees input after the first answer.
 */
function readHidden(prompt: string): string {
  const saved = stty("-g");
  // No echo, a byte at a time, and Ctrl-C arrives as a byte: a blocking read can't run a SIGINT handler.
  // Set before the prompt shows, so a key pasted straight away is never echoed.
  stty("-echo", "-icanon", "-isig", "min", "1");
  process.stdout.write(prompt);
  const byte = Buffer.alloc(1);
  let input = "";
  try {
    for (;;) {
      if (readSync(0, byte, 0, 1, null) === 0) break;
      const key = byte.toString("latin1");
      if (key === "\r" || key === "\n") break;
      if (key === "\u0003") {
        stty(saved);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key === "\u007f" || key === "\b") {
        if (input.length > 0) process.stdout.write("\b \b");
        input = input.slice(0, -1);
      } else if (key >= " " && key <= "~") {
        input += key;
        process.stdout.write("*");
      }
    }
  } finally {
    stty(saved);
  }
  process.stdout.write("\n");
  return input.trim();
}

/** Reads one answer: hidden behind asterisks in a terminal, or a plain line when stdin is piped. */
async function readSecret(prompt: string): Promise<string> {
  if (isatty(0)) return readHidden(prompt);
  process.stdout.write(prompt);
  piped ??= createInterface({ input: process.stdin });
  pipedLines ??= piped[Symbol.asyncIterator]();
  const line = await pipedLines.next();
  process.stdout.write("\n");
  return line.done === true ? "" : line.value.trim();
}

/** Asks for one key until it's accepted or skipped; undefined keeps what's there. */
async function askFor(key: (typeof KEYS)[number]): Promise<string | undefined> {
  for (;;) {
    const answer = await readSecret("  Key (Enter to keep as is): ");
    if (answer === "") return undefined;
    if (key.check === undefined) return answer;
    const result = await key.check(answer).catch((error: unknown) => {
      print(
        `  Couldn't reach ${key.label} to check it (${String(error)}), so saving it unchecked.`,
      );
      return undefined;
    });
    if (result === undefined) return answer;
    if (result.ok) {
      print(`  ✓ ${key.label} accepted it${result.note === "" ? "" : ` (${result.note})`}.`);
      return answer;
    }
    print(`  ✗ ${key.label} didn't accept that key. Paste it again, or press Enter to skip.`);
  }
}

export async function runSetup(): Promise<void> {
  const file = Bun.file(DOT_ENV);
  const text = (await file.exists()) ? await file.text() : "";
  const saved = parse(text);
  print(`mp setup: saves your API keys to ${home(DOT_ENV)}, readable only by you.\n`);

  const updates: Record<string, string> = {};
  for (const key of KEYS) {
    print(`${key.label} (${key.name}): ${key.need}.\n  Get one at ${key.url}`);
    const current = process.env[key.name] ?? "";
    const fromShell = current !== "" && current !== saved[key.name];
    if (current === "") print("  Not set yet.");
    else if (fromShell)
      print(`  Set in your environment (${mask(current)}), which wins over the file.`);
    else print(`  Saved: ${mask(current)}`);
    const value = await askFor(key);
    if (value !== undefined) {
      updates[key.name] = value;
      if (fromShell)
        print(`  Unset ${key.name} in your environment for the saved key to take effect.`);
    }
    print("");
  }

  piped?.close();
  if (Object.keys(updates).length > 0) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(DOT_ENV, withKeys(text, updates), { mode: 0o600 });
    await chmod(DOT_ENV, 0o600);
    print(`Saved to ${home(DOT_ENV)}.`);
  } else print("Nothing changed.");
  const firecrawl = updates.FIRECRAWL_API_KEY ?? process.env.FIRECRAWL_API_KEY ?? "";
  print(
    firecrawl === ""
      ? "model-picker needs a Firecrawl key for every command: run `mp setup` again once you have one."
      : "Try: mp pick --min-score 45",
  );
}

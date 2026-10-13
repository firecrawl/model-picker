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

/** Opens Pi's terminal UI with the model-picker router loaded and selected; extra args go to Pi. */
export async function runChat(piArgs: string[]): Promise<number> {
  const env = { ...(await keysFromDotEnv()), ...process.env };
  const pi = Bun.spawn(
    [
      join(ROOT, "node_modules", ".bin", "pi"),
      "--extension",
      join(ROOT, "pi", "router.ts"),
      "--model",
      "model-picker/auto",
      ...piArgs,
    ],
    { env, stdio: ["inherit", "inherit", "inherit"] },
  );
  return pi.exited;
}

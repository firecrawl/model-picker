import { parse } from "dotenv";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// In a compiled binary this module lives in Bun's virtual filesystem, so the files the release
// ships with (Pi, the bundled router) are found next to the executable instead.
export const compiled = ["$bunfs", "~BUN", "%7EBUN"].some((marker) =>
  import.meta.url.includes(marker),
);
const ROOT = compiled
  ? dirname(dirname(realpathSync(process.execPath)))
  : join(import.meta.dir, "..");

export const CONFIG_DIR = join(homedir(), ".config", "model-picker");
export const PI_BIN =
  process.env.MODEL_PICKER_PI ??
  (compiled ? join(ROOT, "pi", "pi") : join(ROOT, "node_modules", ".bin", "pi"));
export const ROUTER = compiled ? join(ROOT, "router.js") : join(ROOT, "pi", "router.ts");

/**
 * Keys from ~/.config/model-picker/.env (and, from a checkout, the repo's own .env), for when
 * model-picker runs outside its folder: Bun only loads the cwd's. The real environment wins.
 */
export async function loadDotEnv(): Promise<void> {
  const files = [join(CONFIG_DIR, ".env"), ...(compiled ? [] : [join(ROOT, ".env")])];
  for (const path of files) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    for (const [key, value] of Object.entries(parse(await file.text()))) {
      if (value !== "") process.env[key] ??= value;
    }
  }
}

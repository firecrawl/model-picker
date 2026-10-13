import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { printError } from "./output.ts";

export interface Call {
  provider: string;
  capability: string;
  options: Record<string, unknown>;
}

const responseSchema = z.object({
  data: z.object({
    alexandria: z.array(
      z.object({
        provider: z.string(),
        capability: z.string(),
        data: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
    ),
  }),
});
const cacheSchema = z.array(z.unknown());

const API_URL = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";
const CACHE_DIR = process.env.MODEL_PICKER_CACHE ?? join(homedir(), ".cache", "model-picker");
// Leaderboard and provider prices move daily at most; caching keeps repeat runs free and under the per-minute limit.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

async function readCache(key: string): Promise<unknown[] | undefined> {
  const file = Bun.file(join(CACHE_DIR, `${key}.json`));
  if (!(await file.exists())) return undefined;
  if (Date.now() - file.lastModified > CACHE_TTL_MS) return undefined;
  return cacheSchema.parse(await file.json());
}

async function writeCache(key: string, value: unknown[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await Bun.write(join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
}

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (key === undefined || key === "") {
    throw new Error(
      "FIRECRAWL_API_KEY is not set. Get a free key at https://firecrawl.dev and export it.",
    );
  }
  return key;
}

async function post(calls: Call[]): Promise<z.infer<typeof responseSchema>["data"]["alexandria"]> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API_URL}/v2/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({ alexandria: calls }),
    });
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const waitSeconds = Number(response.headers.get("retry-after") ?? 20);
      printError(`Rate limited by Firecrawl, retrying in ${waitSeconds}s...`);
      await Bun.sleep(waitSeconds * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Firecrawl returned ${response.status}: ${await response.text()}`);
    }
    return responseSchema.parse(await response.json()).data.alexandria;
  }
}

/** Runs up to 10 Alexandria calls in one request, serving them from the local cache when fresh. */
export async function callAll(calls: Call[]): Promise<unknown[]> {
  const key = new Bun.CryptoHasher("sha256").update(JSON.stringify(calls)).digest("hex");
  const cached = await readCache(key);
  if (cached) return cached;
  const results = await post(calls);
  const data = results.map((result) => {
    if (result.error) {
      throw new Error(
        `${result.provider}/${result.capability}: ${result.error.code} - ${result.error.message}`,
      );
    }
    return result.data;
  });
  await writeCache(key, data);
  return data;
}

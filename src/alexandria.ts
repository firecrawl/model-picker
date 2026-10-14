// Node APIs rather than Bun's: the Pi router loads this module inside Pi, which runs on Node.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

async function readCache(key: string): Promise<unknown[] | undefined> {
  const path = join(CACHE_DIR, `${key}.json`);
  const info = await stat(path).catch(() => undefined);
  if (!info || Date.now() - info.mtimeMs > CACHE_TTL_MS) return undefined;
  return cacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function writeCache(key: string, value: unknown[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
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

async function scrape(body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API_URL}/v2/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify(body),
    });
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const waitSeconds = Number(response.headers.get("retry-after") ?? 20);
      printError(`Rate limited by Firecrawl, retrying in ${waitSeconds}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Firecrawl returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}

async function post(calls: Call[]): Promise<z.infer<typeof responseSchema>["data"]["alexandria"]> {
  return responseSchema.parse(await scrape({ alexandria: calls })).data.alexandria;
}

const markdownSchema = z.object({ data: z.object({ markdown: z.string() }) });

/** One web page as markdown, for leaderboards Alexandria doesn't cover; cached like Alexandria calls. */
export async function scrapeMarkdown(url: string): Promise<string> {
  const key = createHash("sha256").update(`markdown:${url}`).digest("hex");
  const cached = await readCache(key);
  if (cached) return z.string().parse(cached[0]);
  const { markdown } = markdownSchema.parse(await scrape({ url, formats: ["markdown"] })).data;
  await writeCache(key, [markdown]);
  return markdown;
}

/** Runs up to 10 Alexandria calls in one request, serving them from the local cache when fresh. */
export async function callAll(calls: Call[]): Promise<unknown[]> {
  const key = createHash("sha256").update(JSON.stringify(calls)).digest("hex");
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

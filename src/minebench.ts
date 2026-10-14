import { scrapeMarkdown } from "./alexandria.ts";

const LEADERBOARD_URL = "https://minebench.ai/leaderboard";
// e.g. `| 2NEW<br>Gemini 4 Argon<br>geminiProvisional | 2,247±48.4<br>\[2,198, 2,295\] | ...`:
// rank, name and maker share the first cell; the Elo rating leads the second.
const ROW = /^\|\s*\d+[^<|]*<br>([^<|]+)<br>[^|]*\|\s*([\d,]+)±/;

/** MineBench Elo by model name as the site writes it, e.g. "Gemini 4 Argon" → 2247. */
export function parseLeaderboard(markdown: string): Map<string, number> {
  const ratings = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    const match = ROW.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      ratings.set(match[1].trim(), Number(match[2].replaceAll(",", "")));
    }
  }
  return ratings;
}

/**
 * MineBench (minebench.ai): models write raw block coordinates for a voxel build from a text
 * prompt and people vote between pairs, so it rates 3D spatial modelling, which no Artificial
 * Analysis benchmark covers.
 */
export async function fetchMineBench(): Promise<Map<string, number>> {
  return parseLeaderboard(await scrapeMarkdown(LEADERBOARD_URL));
}

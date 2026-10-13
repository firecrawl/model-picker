import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const model = (slug: string, score: number, cost: number, openWeights = false) => ({
  slug,
  name: slug,
  creator_name: "Test",
  intelligence_index: score,
  intelligence_index_cost_per_task_usd: cost,
  is_open_weights: openWeights,
  performance: { output_speed_tokens_per_s: { median: 100 } },
});

const LEADERBOARD = [
  model("frontier", 55, 6),
  model("dominated", 40, 3),
  model("mid", 50, 0.3),
  model("cheap-open", 42, 0.1, true),
  model("noise", 50.2, 0.4),
];

const ENDPOINTS = [
  {
    host: { name: "Pricey" },
    intelligence_index_cost_per_task_usd: { total: 4 },
    performance: null,
    pricing_usd_per_1m_tokens: null,
  },
  {
    host: { name: "Cheap" },
    intelligence_index_cost_per_task_usd: { total: 1 },
    performance: null,
    pricing_usd_per_1m_tokens: null,
  },
];

const requestSchema = z.object({
  alexandria: z.array(
    z.object({
      provider: z.string(),
      capability: z.string(),
      options: z.object({ cursor: z.string().optional() }),
    }),
  ),
});
const picksSchema = z.object({ picks: z.array(z.object({ slug: z.string() })) });

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { alexandria } = requestSchema.parse(await request.json());
    const results = alexandria.map((call) => {
      if (call.capability === "benchmarks/list_model_providers")
        return { ...call, data: { endpoints: ENDPOINTS } };
      return { ...call, data: { results: call.options.cursor === undefined ? LEADERBOARD : [] } };
    });
    return Response.json({ success: true, data: { alexandria: results } });
  },
});
afterAll(() => server.stop());

const cacheDir = await mkdtemp(join(tmpdir(), "model-picker-test-"));

// A fake OpenCode: lists two OpenRouter models, and "solves" any task by writing done.txt.
const fakeBin = join(cacheDir, "bin");
await mkdir(fakeBin);
await Bun.write(
  join(fakeBin, "opencode"),
  `#!/bin/sh
if [ "$1" = models ]; then printf 'openrouter/test/mid\\nopenrouter/test/frontier\\n'; exit 0; fi
echo done > done.txt
echo '{"type":"text","part":{"text":"Fixed it."}}'
`,
);
await chmod(join(fakeBin, "opencode"), 0o755);

async function run(...args: string[]): Promise<string> {
  const process = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      ...Bun.env,
      PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
      FIRECRAWL_API_KEY: "test",
      FIRECRAWL_API_URL: server.url.origin,
      MODEL_PICKER_CACHE: cacheDir,
    },
  });
  expect(await process.exited).toBe(0);
  return new Response(process.stdout).text();
}

test("pick returns the cost/score frontier, compared against a baseline", async () => {
  const { picks } = picksSchema.parse(
    JSON.parse(await run("pick", "--min-score", "40", "--vs", "frontier", "--json")),
  );
  expect(picks.map((pick) => pick.slug)).toEqual(["cheap-open", "mid", "frontier"]);

  const table = await run("pick", "--min-score", "40", "--vs", "frontier");
  expect(table).toContain("91% of the score, 20x cheaper");
  expect(picksSchema.parse(JSON.parse(await run("pick", "--open", "--json"))).picks).toHaveLength(
    1,
  );
});

test("providers sorts cheapest first and reports the spread", async () => {
  const table = await run("providers", "some-model");
  expect(table.indexOf("Cheap")).toBeLessThan(table.indexOf("Pricey"));
  expect(table).toContain("4.0x price spread");
});

test("run races the cheapest pick against --vs, each in its own worktree", async () => {
  const repo = await mkdtemp(join(tmpdir(), "model-picker-repo-"));
  await Bun.$`git init -q && git commit -q --allow-empty -m init`.cwd(repo);
  const output = await run(
    "run",
    "fix the bug",
    "--vs",
    "frontier",
    "--min-score",
    "45",
    "--dir",
    repo,
    "--check",
    "test -f done.txt",
  );
  expect(output).toContain("openrouter/test/mid");
  expect(output).toMatch(/✓ mid finished .* check PASS/);
  expect(output).toMatch(/✓ frontier finished .* check PASS/);
  expect(output).toContain("reply: Fixed it.");
});

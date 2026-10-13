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

// A fake OpenCode: lists two OpenRouter models, writes plan.json when asked to plan, logs every
// step it's given to steps.txt, and reports each session as costing $0.01.
const fakeBin = join(cacheDir, "bin");
await mkdir(fakeBin);
await Bun.write(
  join(fakeBin, "opencode"),
  `#!/bin/sh
if [ "$1" = models ]; then printf 'openrouter/test/mid\\nopenrouter/test/cheap-open\\n'; exit 0; fi
if [ "$1" = session ]; then
  echo '{"info":{"cost":0.01,"tokens":{"input":100,"output":50,"reasoning":0,"cache":{"read":0,"write":0}}}}'
  exit 0
fi
for prompt; do :; done
case "$prompt" in
  *"You are the planner"*) echo '{"steps":[{"id":1,"title":"Engine","instructions":"x","difficulty":"hard","files":["engine.js"]},{"id":2,"title":"Styles","instructions":"y","difficulty":"medium","files":["styles.css"]},{"id":3,"title":"Wire up","instructions":"z","difficulty":"easy","files":["index.html"],"dependsOn":[1,2]}]}' > plan.json ;;
  *) echo "start $(printf '%s' "$prompt" | sed -n 's/^Your step: //p')" >> steps.txt
     sleep 0.3
     echo "end $(printf '%s' "$prompt" | sed -n 's/^Your step: //p')" >> steps.txt ;;
esac
echo '{"type":"text","sessionID":"ses_1","part":{"text":"Done."}}'
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

test("build runs independent steps in parallel, after their dependencies, on the cheapest qualifying models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-picker-build-"));
  const output = await run("build", "make a game", "--dir", dir);
  expect(output).toContain("[plan] Plan the build: mid");
  expect(output).toContain("[hard] Engine: mid");
  expect(output).toContain("[medium] Styles: cheap-open");
  expect(output).toContain("[easy] Wire up: cheap-open");
  expect(output).toContain("$0.040 across 4 OpenCode sessions");
  const log = (await Bun.file(join(dir, "steps.txt")).text()).trim().split("\n");
  // Engine and Styles share no files, so both start before either ends; Wire up waits for both.
  expect(log.slice(0, 2).toSorted()).toEqual(["start Engine", "start Styles"]);
  expect(log.slice(-2)).toEqual(["start Wire up", "end Wire up"]);
  const report = await Bun.file(join(dir, "REPORT.md")).text();
  expect(report).toContain("wall clock");
  expect(report).toContain("| cheap-open | medium: Styles<br>easy: Wire up |");
});

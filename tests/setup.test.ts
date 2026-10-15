import { afterAll, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withKeys } from "../src/setup.ts";

test("withKeys replaces a key's line or placeholder and appends new ones", () => {
  const text = [
    "# model-picker reads keys from here",
    "# FIRECRAWL_API_KEY=fc-...      every command",
    "export OPENROUTER_API_KEY=sk-or-old",
    "OTHER=kept",
  ].join("\n");
  expect(
    withKeys(text, {
      FIRECRAWL_API_KEY: "fc-new",
      OPENROUTER_API_KEY: "sk-or-new",
      SUBQ_API_KEY: "sq",
    }),
  ).toBe(
    [
      "# model-picker reads keys from here",
      "FIRECRAWL_API_KEY=fc-new",
      "OPENROUTER_API_KEY=sk-or-new",
      "OTHER=kept",
      "SUBQ_API_KEY=sq",
      "",
    ].join("\n"),
  );
  expect(withKeys("", { SUBQ_API_KEY: "sq" })).toBe("SUBQ_API_KEY=sq\n");
});

// Firecrawl and OpenRouter stand-ins that accept only the keys ending in "-good".
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const good = request.headers.get("authorization")?.endsWith("-good") === true;
    if (!good) return new Response("unauthorized", { status: 401 });
    if (new URL(request.url).pathname === "/v2/team/credit-usage")
      return Response.json({ success: true, data: { remainingCredits: 1234 } });
    return Response.json({ data: {} });
  },
});
afterAll(() => server.stop());

async function setup(home: string, answers: string[]): Promise<string> {
  const run = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "setup"], {
    env: {
      HOME: home,
      PATH: Bun.env.PATH,
      FIRECRAWL_API_URL: server.url.origin,
      OPENROUTER_API_URL: server.url.origin,
    },
    stdin: new Blob([answers.map((answer) => `${answer}\n`).join("")]),
    stdout: "pipe",
  });
  expect(await run.exited).toBe(0);
  return new Response(run.stdout).text();
}

test("setup checks each key, retries a rejected one, and saves to a private .env", async () => {
  const home = await mkdtemp(join(tmpdir(), "mp-setup-"));
  const envFile = join(home, ".config", "model-picker", ".env");

  const output = await setup(home, ["fc-bad", "fc-0123456789-good", "sk-or-good", ""]);
  expect(output).toContain("Firecrawl didn't accept that key");
  expect(output).toContain("Firecrawl accepted it (1,234 credits left)");
  expect(output).toContain("OpenRouter accepted it");
  expect(await Bun.file(envFile).text()).toBe(
    "FIRECRAWL_API_KEY=fc-0123456789-good\nOPENROUTER_API_KEY=sk-or-good\n",
  );
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);

  // Enter keeps what's saved; a skipped bad key isn't saved.
  const again = await setup(home, ["", "sk-or-bad", "", "subq-key"]);
  expect(again).toContain("Saved: fc-01…good");
  expect(await Bun.file(envFile).text()).toBe(
    "FIRECRAWL_API_KEY=fc-0123456789-good\nOPENROUTER_API_KEY=sk-or-good\nSUBQ_API_KEY=subq-key\n",
  );
});

test("commands that need a missing key say to run mp setup", async () => {
  const home = await mkdtemp(join(tmpdir(), "mp-nokeys-"));
  const run = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "chat"], {
    env: { HOME: home, PATH: Bun.env.PATH },
    stderr: "pipe",
  });
  expect(await run.exited).toBe(1);
  expect(await new Response(run.stderr).text()).toContain(
    "FIRECRAWL_API_KEY is not set. Run `mp setup`",
  );
});

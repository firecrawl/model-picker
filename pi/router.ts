import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fetchModels, pick } from "../src/models.ts";

// Same Intelligence Index floors as `model-picker build`.
const FLOORS = { hard: 50, medium: 42, easy: 30 } as const;
type Difficulty = keyof typeof FLOORS;
type Routes = Record<Difficulty, ModelRoute<RouterState>>;

interface RouterState {
  difficulty: Difficulty;
}

const settingsSchema = z.object({
  creators: z.array(z.string()).optional(),
  openWeightsOnly: z.boolean().default(false),
  maxCost: z.number().default(Number.POSITIVE_INFINITY),
});
const SETTINGS_FILE =
  process.env.MODEL_PICKER_ROUTER_SETTINGS ??
  join(homedir(), ".config", "model-picker", "router.json");

const EFFORTS: Record<string, ModelThinkingLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};
const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
const normalize = (id: string): string => id.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

const CLASSIFY_PROMPT = `You route coding requests to models. Rate how much reasoning the user's latest request needs:
- hard: architecture, tricky algorithms, subtle debugging, large cross-cutting changes
- medium: ordinary features and fixes with a clear approach
- easy: small edits, renames, styling, questions with short answers
Reply with exactly one word: hard, medium or easy.`;

async function loadSettings(): Promise<z.infer<typeof settingsSchema>> {
  const text = await readFile(SETTINGS_FILE, "utf8").catch(() => "{}");
  return settingsSchema.parse(JSON.parse(text));
}

/** The cheapest benchmarked model clearing each floor that Pi can reach through OpenRouter. */
async function loadRoutes(ctx: ExtensionContext): Promise<Routes> {
  const settings = await loadSettings();
  const allowed = new Set(settings.creators?.map((creator) => creator.toLowerCase()));
  const benchmarked = (await fetchModels()).filter(
    (model) => allowed.size === 0 || allowed.has(model.creator.toLowerCase()),
  );
  const openRouter = new Map(
    ctx.modelRegistry
      .getAll()
      .filter((model) => model.provider === "openrouter")
      .map((model): [string, Model<Api>] => [normalize(model.id.split("/").at(-1) ?? ""), model]),
  );
  const routeFor = (difficulty: Difficulty): ModelRoute<RouterState> => {
    const options = { ...settings, minScore: FLOORS[difficulty], creator: undefined };
    for (const candidate of pick(benchmarked, options)) {
      const model = openRouter.get(normalize(candidate.slug.replace(EFFORT_SUFFIX, "")));
      if (!model) continue;
      // Artificial Analysis labels a model's top effort "Max" and gives it no slug suffix.
      const effort = EFFORT_SUFFIX.exec(candidate.slug)?.[1];
      const thinkingLevel =
        effort === undefined ? (/\(Max\b/.test(candidate.name) ? "max" : "off") : EFFORTS[effort];
      return { model, thinkingLevel: thinkingLevel ?? "medium", state: { difficulty } };
    }
    throw new Error(
      `model-picker: no ${difficulty} model (score ${FLOORS[difficulty]}+) on OpenRouter`,
    );
  };
  return { hard: routeFor("hard"), medium: routeFor("medium"), easy: routeFor("easy") };
}

function lastUserText(messages: readonly Message[]): string {
  const content = messages.findLast((message) => message.role === "user")?.content ?? "";
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function classify(
  ctx: ExtensionContext,
  classifier: Model<Api>,
  request: ModelRouteRequest<RouterState>,
): Promise<Difficulty> {
  const reply = await ctx.modelRegistry.complete(
    classifier,
    {
      systemPrompt: CLASSIFY_PROMPT,
      messages: [
        {
          role: "user",
          content: lastUserText(request.messages).slice(0, 8000),
          timestamp: Date.now(),
        },
      ],
    },
    { signal: request.signal },
  );
  const answer = reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .toLowerCase();
  if (answer.includes("hard")) return "hard";
  return answer.includes("easy") ? "easy" : "medium";
}

function header(theme: Theme, byDifficulty: Routes | undefined): string[] {
  const rows = byDifficulty
    ? FLOOR_ORDER.map(
        (difficulty) =>
          `  ${theme.fg("dim", difficulty.padEnd(7))}${theme.fg("dim", "→")} ${byDifficulty[difficulty].model.name} ${theme.fg("dim", byDifficulty[difficulty].thinkingLevel)}`,
      )
    : [theme.fg("dim", "  loading the leaderboard…")];
  return [
    "",
    `  ${theme.bold(theme.fg("accent", "model-picker"))}  ${theme.fg("muted", "the cheapest good-enough model for every message")}`,
    "",
    ...rows,
    "",
  ];
}

const FLOOR_ORDER: readonly Difficulty[] = ["hard", "medium", "easy"];

export default function modelPickerRouter(pi: ExtensionAPI): void {
  let routes: Promise<Routes> | undefined;
  const getRoutes = (ctx: ExtensionContext): Promise<Routes> =>
    (routes ??= loadRoutes(ctx).catch((error: unknown) => {
      routes = undefined;
      throw error;
    }));

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle("model-picker");
    // Replace Pi's header straight away; the routes fill in once the leaderboard has loaded.
    ctx.ui.setHeader((tui, theme) => {
      let loaded: Routes | undefined;
      getRoutes(ctx).then(
        (byDifficulty) => {
          loaded = byDifficulty;
          tui.requestRender();
        },
        () => {},
      );
      return { render: () => header(theme, loaded), invalidate() {} };
    });
  });

  pi.registerVirtualModel<RouterState>({
    provider: "model-picker",
    id: "auto",
    name: "Auto (model-picker)",
    async route(request, ctx) {
      const byDifficulty = await getRoutes(ctx);
      // Tool follow-ups and retries stay on the turn's model: switching would lose the prompt cache.
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && request.reason !== "direct" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      if (request.reason !== "user") return byDifficulty.easy;
      // The cheapest easy-tier model is the classifier: one short call per user message.
      return byDifficulty[await classify(ctx, byDifficulty.easy.model, request)];
    },
  });
}

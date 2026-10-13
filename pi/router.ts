import { calculateCost, type Api, type Message, type Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRouteRequest,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  choose,
  DIFFICULTIES,
  loadCandidates,
  loadSettings,
  needsOf,
  TASKS,
  type Candidates,
  type Difficulty,
  type RouterState,
  type Task,
} from "./routing.ts";

const dollars = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

const CLASSIFY_PROMPT = `You route requests in a coding assistant to models. Rate the user's latest request.
Difficulty:
- hard: architecture, tricky algorithms, subtle debugging, large cross-cutting changes
- medium: ordinary features and fixes with a clear approach
- easy: small edits, renames, styling, questions with short answers
Kind of work:
- coding: writing or changing code
- tools: multi-step work driving tools, the terminal or a browser
- vision: understanding images or screenshots
- long-context: reading or reasoning over large files or documents
- general: anything else
Reply with exactly two words, difficulty then kind, e.g. "medium coding".`;

function lastUserText(messages: readonly Message[]): string {
  const content = messages.findLast((message) => message.role === "user")?.content ?? "";
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function classify(
  ctx: ExtensionContext,
  classifier: Model<Api>,
  request: ModelRouteRequest<RouterState>,
): Promise<RouterState> {
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
  return {
    difficulty: DIFFICULTIES.find((difficulty) => answer.includes(difficulty)) ?? "medium",
    task: TASKS.find((task) => answer.includes(task)) ?? "general",
  };
}

/** Every model the router can send a typical message to, with the work it gets. */
function routingTable(candidates: Candidates): { name: string; uses: string }[] {
  const uses = new Map<string, { name: string; work: Map<Difficulty, Task[]> }>();
  for (const difficulty of DIFFICULTIES) {
    for (const task of TASKS) {
      const route = choose(candidates, difficulty, task, { image: task === "vision", tokens: 0 });
      const key = `${route.model.id}#${route.thinkingLevel}`;
      const effort = route.thinkingLevel === "off" ? "" : ` ${route.thinkingLevel}`;
      const entry = uses.get(key) ?? {
        name: `${route.model.name}${effort}`,
        work: new Map<Difficulty, Task[]>(),
      };
      entry.work.set(difficulty, [...(entry.work.get(difficulty) ?? []), task]);
      uses.set(key, entry);
    }
  }
  return [...uses.values()].map(({ name, work }) => ({
    name,
    uses: [...work.entries()]
      .map(
        ([difficulty, tasks]) =>
          `${difficulty}: ${tasks.length === TASKS.length ? "all work" : tasks.join(", ")}`,
      )
      .join(" · "),
  }));
}

function header(theme: Theme, candidates: Candidates | undefined): string[] {
  const table = candidates ? routingTable(candidates) : [];
  const width = Math.max(0, ...table.map((row) => row.name.length));
  const rows = candidates
    ? table.map((row) => `  ${row.name.padEnd(width)}  ${theme.fg("dim", row.uses)}`)
    : [theme.fg("dim", "  loading the leaderboard…")];
  return [
    "",
    `  ${theme.bold(theme.fg("accent", "model-picker"))}  ${theme.fg("muted", "the cheapest good-enough model for every message")}`,
    "",
    ...rows,
    "",
    theme.fg(
      "dim",
      `  ${table.length} models in use, chosen from ${candidates?.all.length ?? "…"} · each kind of work ranks on its own benchmark`,
    ),
    "",
  ];
}

export default function modelPickerRouter(pi: ExtensionAPI): void {
  let candidates: Promise<Candidates> | undefined;
  const getCandidates = (ctx: ExtensionContext): Promise<Candidates> =>
    (candidates ??= loadCandidates(ctx).catch((error: unknown) => {
      candidates = undefined;
      throw error;
    }));

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle("model-picker");
    // Replace Pi's header straight away; the routes fill in once the leaderboard has loaded.
    ctx.ui.setHeader((tui, theme) => {
      let loaded: Candidates | undefined;
      getCandidates(ctx).then(
        (all) => {
          loaded = all;
          tui.requestRender();
        },
        () => {},
      );
      return { render: () => header(theme, loaded), invalidate() {} };
    });
  });

  // Prices this session's actual token usage at the baseline model's rates. It's an estimate:
  // the baseline would have produced different responses and token counts.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const { baseline } = await loadSettings();
    const baselineModel = ctx.modelRegistry.find("openrouter", baseline);
    // At message_end the finished reply isn't on the branch yet, so add it explicitly.
    const replies = ctx.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
      )
      .filter((reply) => reply.timestamp !== event.message.timestamp)
      .concat(event.message);
    let spent = 0;
    let baselineCost = 0;
    for (const reply of replies) {
      spent += reply.usage.cost.total;
      if (baselineModel) baselineCost += calculateCost(baselineModel, reply.usage).total;
    }
    const comparison =
      baselineModel && baselineCost > 0
        ? ` · ~${dollars(baselineCost)} on ${baselineModel.name} · saved ${Math.round((1 - spent / baselineCost) * 100)}%`
        : "";
    ctx.ui.setStatus("model-picker-savings", `${dollars(spent)} spent${comparison}`);
  });

  pi.registerVirtualModel<RouterState>({
    provider: "model-picker",
    id: "auto",
    name: "Auto (model-picker)",
    async route(request, ctx) {
      const all = await getCandidates(ctx);
      // Tool follow-ups and retries stay on the turn's model: switching would lose the prompt cache.
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && request.reason !== "direct" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      const needs = needsOf(request.messages);
      const cheapest = choose(all, "easy", "general", { image: false, tokens: 0 });
      if (request.reason !== "user") return choose(all, "easy", "general", needs);
      // The cheapest easy-tier model is the classifier: one short call per user message.
      const { difficulty, task } = await classify(ctx, cheapest.model, request);
      const route = choose(all, difficulty, task, needs);
      ctx.ui.setStatus(
        "model-picker-route",
        `${difficulty} · ${task}${needs.image ? " · image" : ""} → ${route.model.name} ${route.thinkingLevel}`,
      );
      return route;
    },
  });
}

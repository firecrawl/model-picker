import { z } from "zod";
import { callAll } from "./alexandria.ts";
import { speedSchema } from "./models.ts";

export interface Provider {
  host: string;
  costPerTask: number;
  tokensPerSecond: number | undefined;
  inputPerMillion: number | undefined;
  outputPerMillion: number | undefined;
}

const endpointsSchema = z.object({
  endpoints: z.array(
    z.object({
      host: z.object({ name: z.string() }),
      intelligence_index_cost_per_task_usd: z.object({ total: z.number().nullish() }).nullish(),
      performance: speedSchema,
      pricing_usd_per_1m_tokens: z
        .object({ input: z.number().nullish(), output: z.number().nullish() })
        .nullish(),
    }),
  ),
});

export type ProviderSort = "cost" | "speed";

export async function fetchProviders(slug: string, sort: ProviderSort): Promise<Provider[]> {
  const [result] = await callAll([
    {
      provider: "artificialanalysis-ai",
      capability: "benchmarks/list_model_providers",
      options: { slug },
    },
  ]);
  const providers = endpointsSchema.parse(result).endpoints.flatMap((endpoint) => {
    const costPerTask = endpoint.intelligence_index_cost_per_task_usd?.total;
    return costPerTask === undefined || costPerTask === null
      ? []
      : [
          {
            host: endpoint.host.name,
            costPerTask,
            tokensPerSecond: endpoint.performance,
            inputPerMillion: endpoint.pricing_usd_per_1m_tokens?.input ?? undefined,
            outputPerMillion: endpoint.pricing_usd_per_1m_tokens?.output ?? undefined,
          },
        ];
  });
  return sort === "cost"
    ? providers.toSorted((a, b) => a.costPerTask - b.costPerTask)
    : providers.toSorted((a, b) => (b.tokensPerSecond ?? 0) - (a.tokensPerSecond ?? 0));
}

// Live model catalog for the UI model picker.
//
// Serves the slim in-memory projection of the models.dev payload maintained
// by the pricing-refresh loop (`src/be/models-catalog.ts`). Read-only: the
// catalog is refreshed server-side (boot + every 12h); the UI polls this
// endpoint instead of relying on the build-time snapshot bundled into the SPA.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getModelsCatalog } from "../be/models-catalog";
import { route } from "./route-def";
import { json } from "./utils";

const CatalogModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  limit: z.object({ context: z.number().optional() }).optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(z.object({ type: z.string(), values: z.array(z.string()).optional() }))
    .optional(),
});

const CatalogProviderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  models: z.record(z.string(), CatalogModelSchema),
});

const getCatalog = route({
  method: "get",
  path: "/api/models-catalog",
  pattern: ["api", "models-catalog"],
  summary: "Get the live model catalog for the picker-reachable providers",
  description:
    "Slim projection of the models.dev payload (openrouter / anthropic / openai / amazon-bedrock only), refreshed server-side at boot and every 12h by the pricing-refresh loop. `source` is 'snapshot' with `updatedAt: null` until the first successful fetch (or when models.dev is unreachable), in which case the vendored snapshot is served instead.",
  tags: ["Pricing"],
  responses: {
    200: {
      description: "Model catalog",
      schema: z.object({
        source: z.enum(["live", "snapshot"]),
        updatedAt: z.number().nullable(),
        providers: z.record(z.string(), CatalogProviderSchema),
      }),
    },
  },
});

export async function handleModelsCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getCatalog.match(req.method, pathSegments)) {
    const parsed = await getCatalog.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    json(res, getModelsCatalog());
    return true;
  }

  return false;
}

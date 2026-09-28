// Live model catalog for the UI model picker.
//
// GET serves the slim projection of the persistent `model_catalog` table
// merged with `model_catalog_overlay` (src/be/model-catalog-store.ts). The
// catalog refreshes server-side (boot + every 12h); POST .../refresh forces a
// refresh and PUT/DELETE .../overlay manage hand-verified overlay rows.
// See runbooks/model-catalog.md.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAgentById } from "../be/db";
import {
  deleteModelCatalogOverlay,
  loadModelsCatalog,
  upsertModelCatalogOverlay,
} from "../be/model-catalog-store";
import { refreshModelCatalog } from "../be/pricing-refresh";
import { can, type RbacPrincipal } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

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

const ReasoningOptionSchema = z.object({
  type: z.string(),
  values: z.array(z.string()).optional(),
});

const OverlayPricingSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});

export const ModelCatalogRefreshResultSchema = z.object({
  status: z.enum(["updated", "not-modified", "skipped-fresh", "error"]),
  models: z.number(),
  added: z.array(z.string()),
  checkedAt: z.number().nullable(),
  error: z.string().optional(),
});

export const ModelCatalogOverlayBodySchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  name: z.string().optional(),
  family: z.string().optional(),
  releaseDate: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  reasoningOptions: z.array(ReasoningOptionSchema).optional(),
  pricing: OverlayPricingSchema.optional(),
  status: z.string().optional(),
  reason: z.string().min(1),
  verifiedBy: z.string().optional(),
  expiresWhenUpstreamMatches: z.boolean().optional(),
});

const OverlayEntrySchema = ModelCatalogOverlayBodySchema.extend({
  name: z.string().nullish(),
  family: z.string().nullish(),
  releaseDate: z.string().nullish(),
  contextWindow: z.number().nullish(),
  maxOutput: z.number().nullish(),
  reasoning: z.boolean().nullish(),
  reasoningOptions: z.array(ReasoningOptionSchema).nullish(),
  pricing: OverlayPricingSchema.nullish(),
  status: z.string().nullish(),
  verifiedBy: z.string().nullish(),
  expiresWhenUpstreamMatches: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
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

const refreshCatalog = route({
  method: "post",
  path: "/api/models-catalog/refresh",
  pattern: ["api", "models-catalog", "refresh"],
  summary: "Refresh the model catalog from models.dev",
  description:
    "Unforced calls skip the network when the last models.dev check is younger than 4h (`skipped-fresh`). `force: true` always fetches, still conditional on the stored ETag (`not-modified` on 304). `added` lists provider/modelId keys new since the previous fetch.",
  tags: ["Pricing"],
  rbac: { permission: "models.catalog.write" },
  body: z.object({ force: z.boolean().optional() }),
  responses: {
    200: { description: "Refresh outcome", schema: ModelCatalogRefreshResultSchema },
    403: { description: "Forbidden" },
  },
});

const upsertOverlay = route({
  method: "put",
  path: "/api/models-catalog/overlay",
  pattern: ["api", "models-catalog", "overlay"],
  summary: "Upsert one model-catalog overlay row",
  description:
    "Overlay facts win per non-null field over the models.dev row; overlay-only models are served too. Overlay prices fill pricing-table gaps (never override an active price). With `expiresWhenUpstreamMatches` (default true) the row is deleted once upstream matches every non-null fact.",
  tags: ["Pricing"],
  rbac: { permission: "models.catalog.write" },
  body: ModelCatalogOverlayBodySchema,
  responses: {
    200: { description: "Overlay row upserted", schema: OverlayEntrySchema },
    403: { description: "Forbidden" },
  },
});

const deleteOverlay = route({
  method: "delete",
  path: "/api/models-catalog/overlay",
  pattern: ["api", "models-catalog", "overlay"],
  summary: "Delete one model-catalog overlay row",
  tags: ["Pricing"],
  rbac: { permission: "models.catalog.write" },
  body: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  responses: {
    200: { description: "Overlay row deleted", schema: z.object({ deleted: z.boolean() }) },
    403: { description: "Forbidden" },
  },
});

/** Resolve the caller and gate on `models.catalog.write`; writes a 403 on denial. */
async function ensureCatalogWriter(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ userId: string | null } | null> {
  const auth = getRequestAuth(req);
  let principal: RbacPrincipal;
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
  } else {
    const header = req.headers["x-agent-id"];
    const agentId = auth?.kind === "agent" ? auth.agentId : Array.isArray(header) ? header[0] : header;
    const agent = agentId ? await getAgentById(agentId) : undefined;
    principal = { kind: "agent", agentId: agentId ?? "", isLead: agent?.isLead ?? false };
  }
  const decision = can({
    principal,
    verb: "models.catalog.write",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, "Writing the model catalog requires the lead agent or an operator", 403);
    return null;
  }
  return { userId: auth?.kind === "user" ? auth.userId : null };
}

export async function handleModelsCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getCatalog.match(req.method, pathSegments)) {
    const parsed = await getCatalog.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    getCatalog.respond(res, 200, await loadModelsCatalog());
    return true;
  }

  if (refreshCatalog.match(req.method, pathSegments)) {
    const parsed = await refreshCatalog.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureCatalogWriter(req, res))) return true;
    refreshCatalog.respond(res, 200, await refreshModelCatalog({ force: parsed.body.force }));
    return true;
  }

  if (upsertOverlay.match(req.method, pathSegments)) {
    const parsed = await upsertOverlay.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const writer = await ensureCatalogWriter(req, res);
    if (!writer) return true;
    const entry = await upsertModelCatalogOverlay(parsed.body, { userId: writer.userId });
    upsertOverlay.respond(res, 200, entry);
    return true;
  }

  if (deleteOverlay.match(req.method, pathSegments)) {
    const parsed = await deleteOverlay.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureCatalogWriter(req, res))) return true;
    const deleted = await deleteModelCatalogOverlay(parsed.body.provider, parsed.body.modelId);
    deleteOverlay.respond(res, 200, { deleted });
    return true;
  }

  return false;
}

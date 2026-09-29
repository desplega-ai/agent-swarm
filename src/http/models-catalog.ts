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
  getAgentHarnessCliVersion,
  listHarnessModelSupport,
  recordHarnessModelSupport,
} from "../be/harness-model-support";
import {
  deleteModelCatalogOverlay,
  loadModelsCatalog,
  upsertModelCatalogOverlay,
} from "../be/model-catalog-store";
import { previewModelTiers } from "../be/model-tier-resolution";
import { requestModelCatalogRefresh } from "../be/pricing-refresh";
import { can, type RbacPrincipal } from "../rbac";
import { MODEL_TIERS, ProviderNameSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

const CatalogModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    })
    .optional(),
  limit: z.object({ context: z.number().optional() }).optional(),
  release_date: z.string().optional(),
  status: z.string().optional(),
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
  status: z.enum(["updated", "not-modified", "skipped-fresh", "skipped-cooldown", "error"]),
  models: z.number(),
  added: z.array(z.string()),
  checkedAt: z.number().nullable(),
  /** Set with `skipped-cooldown`: milliseconds until a forced refresh is accepted again. */
  retryAfterMs: z.number().optional(),
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

const ModelTierPreviewSchema = z.object({
  provider: ProviderNameSchema,
  tier: z.enum(MODEL_TIERS),
  key: z.string(),
  defaultValue: z.string(),
  configured: z.string().nullable(),
  source: z.enum(["tier-config", "tier-default"]),
  resolvedModel: z.string().nullable(),
  alias: z.string().nullable(),
});

const getTiers = route({
  method: "get",
  path: "/api/models-catalog/tiers",
  pattern: ["api", "models-catalog", "tiers"],
  summary: "Preview what each model tier resolves to per harness provider",
  description:
    "One row per provider and tier: the built-in default, the `MODEL_TIER_<PROVIDER>_<TIER>` value stored in swarm config (if any), which layer wins, and the concrete model it resolves to against the current catalog (`latest:` aliases resolved with the same soak and auto-upgrade rules as claim time, without recording a resolution). Ignores per-worker `MODEL_TIER_*` overrides and per-task models.",
  tags: ["Pricing"],
  responses: {
    200: {
      description: "Tier previews",
      schema: z.object({ tiers: z.array(ModelTierPreviewSchema) }),
    },
  },
});

const refreshCatalog = route({
  method: "post",
  path: "/api/models-catalog/refresh",
  pattern: ["api", "models-catalog", "refresh"],
  summary: "Refresh the model catalog from models.dev",
  description:
    "Unforced calls skip the network when the last models.dev check is younger than 4h (`skipped-fresh`). `force: true` always fetches, still conditional on the stored ETag (`not-modified` on 304), but a forced call within a minute of the previous one returns `skipped-cooldown` with `retryAfterMs`. Concurrent refreshes share one fetch. Lead agent or operator only. `added` lists provider/modelId keys new since the previous fetch.",
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

const HarnessSupportRowSchema = z.object({
  harness: z.string(),
  cliVersion: z.string(),
  modelId: z.string(),
  status: z.enum(["ok", "unsupported", "unknown"]),
  checkedAt: z.number(),
  error: z.string().nullable(),
});

const listHarnessSupport = route({
  method: "get",
  path: "/api/models-catalog/harness-support",
  pattern: ["api", "models-catalog", "harness-support"],
  summary: "List harness CLI model support rows",
  description:
    "Whether a catalog model runs on a given `claude` / `codex` CLI version, as recorded by workers after a model's first run. No row means unknown (allowed at claim).",
  tags: ["Pricing"],
  query: z.object({ harness: z.string().optional(), cliVersion: z.string().optional() }),
  responses: {
    200: {
      description: "Support rows, newest first",
      schema: z.object({ rows: z.array(HarnessSupportRowSchema) }),
    },
  },
});

const recordHarnessSupport = route({
  method: "put",
  path: "/api/models-catalog/harness-support",
  pattern: ["api", "models-catalog", "harness-support"],
  summary: "Record whether a harness CLI version accepts a model",
  description:
    "Written by workers: `ok` after a model's first successful run, `unsupported` when the CLI rejects the model id. Claim-time resolution falls back (alias/tier) or fails fast (explicit model) on `unsupported`.",
  tags: ["Pricing"],
  rbac: { permission: "models.harness-support.write" },
  body: z.object({
    harness: z.string().min(1).max(32),
    cliVersion: z.string().min(1).max(64),
    modelId: z.string().min(1).max(200),
    status: z.enum(["ok", "unsupported", "unknown"]),
    error: z.string().max(4000).optional(),
  }),
  responses: {
    200: { description: "Support row upserted", schema: HarnessSupportRowSchema },
    403: { description: "Forbidden" },
  },
});

/**
 * Resolve the caller and gate on `verb`; writes a 403 on denial. Refresh and overlay writes
 * (`models.catalog.write`) are lead or operator only. Harness support (`models.harness-support.write`)
 * is a registered agent's report about its own CLI (bound to it by `callerOwnsSupportRow`) or an
 * operator correction. Dashboard users can do neither.
 */
async function ensureCatalogWriter(
  req: IncomingMessage,
  res: ServerResponse,
  verb: "models.catalog.write" | "models.harness-support.write" = "models.catalog.write",
): Promise<{ userId: string | null; agentId: string | null } | null> {
  const auth = getRequestAuth(req);
  const header = req.headers["x-agent-id"];
  const agentId =
    auth?.kind === "agent" ? auth.agentId : Array.isArray(header) ? header[0] : header;
  let principal: RbacPrincipal;
  if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
  } else if (agentId) {
    // An X-Agent-ID wins over the shared API key: a worker holds that key, so treating it as the
    // operator would let any worker skip the verb's lead-only rule.
    const agent = await getAgentById(agentId);
    principal = { kind: "agent", agentId, isLead: agent?.isLead ?? false };
  } else if (auth?.kind === "operator") {
    principal = { kind: "operator" };
  } else {
    principal = { kind: "agent", agentId: "", isLead: false };
  }
  const decision = can({
    principal,
    verb,
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(
      res,
      verb === "models.catalog.write"
        ? "Writing the model catalog requires the lead agent or an operator"
        : "Recording harness model support requires a registered agent or an operator",
      403,
    );
    return null;
  }
  return {
    userId: auth?.kind === "user" ? auth.userId : null,
    agentId: principal.kind === "agent" && principal.agentId ? principal.agentId : null,
  };
}

async function callerOwnsSupportRow(
  agentId: string,
  body: { harness: string; cliVersion: string },
): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent || agent.harnessProvider !== body.harness) return false;
  return (await getAgentHarnessCliVersion(agentId)) === body.cliVersion;
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

  if (getTiers.match(req.method, pathSegments)) {
    const parsed = await getTiers.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    getTiers.respond(res, 200, { tiers: await previewModelTiers() });
    return true;
  }

  if (refreshCatalog.match(req.method, pathSegments)) {
    const parsed = await refreshCatalog.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureCatalogWriter(req, res))) return true;
    refreshCatalog.respond(
      res,
      200,
      await requestModelCatalogRefresh({ force: parsed.body.force }),
    );
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

  if (listHarnessSupport.match(req.method, pathSegments)) {
    const parsed = await listHarnessSupport.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    listHarnessSupport.respond(res, 200, { rows: await listHarnessModelSupport(parsed.query) });
    return true;
  }

  if (recordHarnessSupport.match(req.method, pathSegments)) {
    const parsed = await recordHarnessSupport.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const writer = await ensureCatalogWriter(req, res, "models.harness-support.write");
    if (!writer) return true;
    if (writer.agentId && !(await callerOwnsSupportRow(writer.agentId, parsed.body))) {
      // Support rows are shared per (harness, CLI version), so a worker may only write the row
      // for the harness and CLI version it registered, never an arbitrary tuple.
      jsonError(
        res,
        "Harness support can only be recorded for the calling agent's own harness and registered CLI version",
        403,
      );
      return true;
    }
    recordHarnessSupport.respond(res, 200, await recordHarnessModelSupport(parsed.body));
    return true;
  }

  return false;
}

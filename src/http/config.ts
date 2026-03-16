import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  deleteSwarmConfig,
  getResolvedConfig,
  getSwarmConfigById,
  getSwarmConfigs,
  maskSecrets,
  upsertSwarmConfig,
} from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const getResolvedConfigRoute = route({
  method: "get",
  path: "/api/config/resolved",
  pattern: ["api", "config", "resolved"],
  summary: "Get resolved config (merged global + agent + repo scopes)",
  tags: ["Config"],
  query: z.object({
    agentId: z.string().optional(),
    repoId: z.string().optional(),
    includeSecrets: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: { description: "Resolved config entries" },
  },
});

const getConfigById = route({
  method: "get",
  path: "/api/config/{id}",
  pattern: ["api", "config", null],
  summary: "Get a single config entry by ID",
  tags: ["Config"],
  params: z.object({ id: z.string() }),
  query: z.object({
    includeSecrets: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: { description: "Config entry" },
    404: { description: "Config not found" },
  },
});

const listConfig = route({
  method: "get",
  path: "/api/config",
  pattern: ["api", "config"],
  summary: "List config entries with optional filters",
  tags: ["Config"],
  query: z.object({
    scope: z.string().optional(),
    scopeId: z.string().optional(),
    includeSecrets: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: { description: "List of config entries" },
  },
});

const upsertConfig = route({
  method: "put",
  path: "/api/config",
  pattern: ["api", "config"],
  summary: "Create or update a config entry",
  tags: ["Config"],
  body: z.object({
    scope: z.enum(["global", "agent", "repo"]),
    scopeId: z.string().optional(),
    key: z.string().min(1),
    value: z.unknown(),
    isSecret: z.boolean().optional(),
    envPath: z.string().optional(),
    description: z.string().optional(),
  }),
  responses: {
    200: { description: "Config entry upserted" },
    400: { description: "Validation error" },
  },
});

const deleteConfig = route({
  method: "delete",
  path: "/api/config/{id}",
  pattern: ["api", "config", null],
  summary: "Delete a config entry",
  tags: ["Config"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Config deleted" },
    404: { description: "Config not found" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getResolvedConfigRoute.match(req.method, pathSegments)) {
    const parsed = await getResolvedConfigRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeSecrets = parsed.query.includeSecrets === "true";
    const configs = getResolvedConfig(
      parsed.query.agentId || undefined,
      parsed.query.repoId || undefined,
    );
    json(res, { configs: includeSecrets ? configs : maskSecrets(configs) });
    return true;
  }

  if (getConfigById.match(req.method, pathSegments)) {
    const parsed = await getConfigById.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeSecrets = parsed.query.includeSecrets === "true";
    const config = getSwarmConfigById(parsed.params.id);
    if (!config) {
      jsonError(res, "Config not found", 404);
      return true;
    }
    const result = includeSecrets ? config : maskSecrets([config])[0];
    json(res, result);
    return true;
  }

  if (listConfig.match(req.method, pathSegments)) {
    const parsed = await listConfig.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeSecrets = parsed.query.includeSecrets === "true";
    const configs = getSwarmConfigs({
      scope: parsed.query.scope || undefined,
      scopeId: parsed.query.scopeId || undefined,
    });
    json(res, { configs: includeSecrets ? configs : maskSecrets(configs) });
    return true;
  }

  if (upsertConfig.match(req.method, pathSegments)) {
    const parsed = await upsertConfig.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { scope, scopeId, key, value, isSecret, envPath, description } = parsed.body;

    if (scope === "global" && scopeId) {
      jsonError(res, "Global scope must not have scopeId", 400);
      return true;
    }

    if ((scope === "agent" || scope === "repo") && !scopeId) {
      jsonError(res, "Agent/repo scope requires scopeId", 400);
      return true;
    }

    try {
      const includeSecrets = queryParams.get("includeSecrets") === "true";
      const config = upsertSwarmConfig({
        scope,
        scopeId: scopeId || null,
        key,
        value: String(value),
        isSecret: isSecret || false,
        envPath: envPath || null,
        description: description || null,
      });
      const result = includeSecrets || !config.isSecret ? config : maskSecrets([config])[0];
      json(res, result);
    } catch (_error) {
      jsonError(res, "Failed to upsert config", 500);
    }
    return true;
  }

  if (deleteConfig.match(req.method, pathSegments)) {
    const parsed = await deleteConfig.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const deleted = deleteSwarmConfig(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Config not found", 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  return false;
}

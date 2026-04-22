import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  deleteSwarmConfig,
  getResolvedConfig,
  getSwarmConfigById,
  getSwarmConfigLookupById,
  getSwarmConfigs,
  maskSecrets,
  upsertSwarmConfig,
} from "../be/db";
import { isReservedConfigKey, reservedKeyError } from "../be/swarm-config-guard";
import { reloadGlobalConfigsAndIntegrations } from "./core";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const MAX_ENV_PRESENCE_KEYS = 200;

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

const envPresence = route({
  method: "get",
  path: "/api/config/env-presence",
  pattern: ["api", "config", "env-presence"],
  summary:
    "Check which of the given env var keys are currently set in process.env (presence only, no values)",
  tags: ["Config"],
  query: z.object({
    keys: z.string().min(1),
  }),
  responses: {
    200: { description: "Map of key -> boolean (true iff set in process.env)" },
    400: { description: "Validation error" },
  },
});

const reloadConfigRoute = route({
  method: "post",
  path: "/api/config/reload",
  pattern: ["api", "config", "reload"],
  summary:
    "Reload global swarm_config into process.env (override=true) and re-init integrations (Slack, GitHub, Linear, AgentMail)",
  tags: ["Config"],
  body: z.object({}).optional(),
  responses: {
    200: { description: "Reload result" },
    500: { description: "Reload failed" },
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
  summary: "Create or update a config entry (reserved env-only keys are rejected)",
  tags: ["Config"],
  body: z.object({
    scope: z.enum(["global", "agent", "repo"]),
    scopeId: z.string().nullish(),
    key: z.string().min(1),
    value: z.unknown(),
    isSecret: z.boolean().optional(),
    envPath: z.string().nullish(),
    description: z.string().nullish(),
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
  summary: "Delete a config entry by ID (including legacy reserved rows for cleanup)",
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

  if (envPresence.match(req.method, pathSegments)) {
    const parsed = await envPresence.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const keys = parsed.query.keys
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length > MAX_ENV_PRESENCE_KEYS) {
      jsonError(res, `Too many keys (max ${MAX_ENV_PRESENCE_KEYS})`, 400);
      return true;
    }
    const presence: Record<string, boolean> = {};
    for (const key of keys) {
      presence[key] = process.env[key] !== undefined && process.env[key] !== "";
    }
    json(res, { presence });
    return true;
  }

  if (reloadConfigRoute.match(req.method, pathSegments)) {
    try {
      const result = await reloadGlobalConfigsAndIntegrations();
      console.log(
        `[reload-config] Loaded ${result.configsLoaded} config(s), re-initialized: ${result.integrationsReinitialized.join(", ") || "none"}`,
      );
      json(res, { success: true, ...result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[reload-config] Failed:", message);
      jsonError(res, `Failed to reload config: ${message}`, 500);
    }
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

    if (isReservedConfigKey(key)) {
      jsonError(res, reservedKeyError(key).message, 400);
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
    const existing = getSwarmConfigLookupById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Config not found", 404);
      return true;
    }
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

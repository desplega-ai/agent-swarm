import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  deleteSwarmConfig,
  getAgentById,
  getResolvedConfig,
  getSwarmConfigById,
  getSwarmConfigLookupById,
  getSwarmConfigs,
  maskSecrets,
} from "../be/db";
import { modelProfileRefError } from "../be/db/model-profiles";
import { runtimeReadsRepoSecrets } from "../be/model-profile-check";
import {
  AGENT_MAX_TASKS_CONFIG_KEY,
  resetAgentMaxTasksMirror,
  upsertSwarmConfigWithPolicyMirror,
} from "../be/multi-runtime";
import { fillOrgLogoFromWebsite } from "../be/org-profile";
import { getUserGrant } from "../be/rbac-roles";
import {
  internalConfigKeyError,
  isApiOnlyConfigKey,
  isInternalConfigKey,
  validateConfigEntry,
} from "../be/swarm-config-guard";
import { can, isRbacEnabled, type PermissionVerb } from "../rbac";
import { SwarmConfigSchema } from "../types";
import { getRequestAuth, type HttpRequestAuth } from "../utils/request-auth-context";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { reloadGlobalConfigsAndIntegrations, scheduleIntegrationsReload } from "./core";
import { syncRankingAfterConfigChange } from "./ranking";
import { route } from "./route-def";
import { duplicateGuardedQueryKey, jsonError } from "./utils";

const MAX_ENV_PRESENCE_KEYS = 200;
const SECRETS_FORCE_MASK_NOTE =
  " (secret values masked: this token cannot read secrets in this scope)";

function stripApiOnlyKeys<T extends { key: string }>(configs: T[]): T[] {
  return configs.filter(
    (config) => !isApiOnlyConfigKey(config.key) && !isInternalConfigKey(config.key),
  );
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Whether this caller's `/api/config/resolved` carries secret repo rows (the
 * `includeRepoSecrets` of {@link resolveSecretsRead}): a runtime-token agent
 * gets them only with `config.read.secrets`. Claim uses it so an agent's
 * default profile yields only to repo rows that worker's env really gets.
 */
export function readsRepoSecrets(
  auth: HttpRequestAuth | null,
  agent: { isLead?: boolean } | null | undefined,
): boolean {
  if (auth?.kind !== "agent" || !auth.runtimeId) return true;
  return runtimeReadsRepoSecrets({ id: auth.agentId, isLead: agent?.isLead });
}

async function requestSecretReadScope(
  req: IncomingMessage,
  resolvedScope?: { agentId?: string; repoId?: string },
): Promise<"all" | "self" | "none"> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") return "all";
  if (auth?.kind === "agent") {
    const agent = await getAgentById(auth.agentId);
    if (
      can({
        principal: { kind: "agent", agentId: auth.agentId, isLead: agent?.isLead ?? false },
        verb: "config.read.secrets",
        resource: { kind: "none" },
        source: "http",
      }).allow
    )
      return "all";
    // Runtime and agent tokens stand in for a worker and read their own agent's
    // scope. Task tokens are ACP harness credentials and read no secrets.
    if (auth.tokenKind === "task" || resolvedScope?.agentId !== auth.agentId) return "none";
    return "self";
  }
  if (auth?.kind === "guest") return "none";
  // Preserve legacy reads without a user or session-token principal.
  if (auth?.kind !== "user") return "all";
  if (!isRbacEnabled()) return "all";

  const grant = await getUserGrant(auth.userId);
  return grant.grantsAll || grant.verbs.has("config.read.secrets") ? "all" : "none";
}

async function resolveSecretsRead(
  req: IncomingMessage,
  includeSecrets: boolean,
  resolvedScope?: { agentId?: string; repoId?: string },
) {
  const scope = await requestSecretReadScope(req, resolvedScope);
  const auth = getRequestAuth(req);
  return {
    effectiveIncludeSecrets: includeSecrets && scope !== "none",
    includeRepoSecrets: !(auth?.kind === "agent" && auth.tokenKind !== "task" && scope !== "all"),
    secretsNote: includeSecrets && scope === "none" ? SECRETS_FORCE_MASK_NOTE : "",
  };
}

/**
 * Gate a config write/delete over HTTP (DES-445 follow-up).
 *
 * Config administration is trusted to the operator (shared swarm key) and to
 * authenticated users — they short-circuit as allowed, matching the
 * operator/user-before-agent ordering used by fs.ts (Appendix A row 36). This
 * preserves every existing HTTP caller (dashboard, codex-oauth token refresh,
 * devin playbook cache — all operate as operator). Only an agent-context
 * principal is gated to lead, using the authenticated session identity ahead
 * of the legacy X-Agent-ID fallback;
 * the real per-agent enforcement lives on the MCP set-config/delete-config
 * tools, where the principal is always an agent.
 *
 * Returns true when the request may proceed; on denial it writes a 403 and
 * returns false.
 */
export async function ensureConfigAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  verb: Extract<PermissionVerb, "config.write.any" | "config.delete.any">,
): Promise<boolean> {
  return ensureHttpPermission(
    req,
    res,
    verb,
    verb === "config.write.any"
      ? "Writing swarm config requires the lead agent"
      : "Deleting swarm config requires the lead agent",
  );
}

/**
 * What a committed config write triggers beyond the row itself. Shared by
 * `PUT /api/config` and HITL `config` answers.
 */
export async function runConfigWriteSideEffects(
  scope: "global" | "agent" | "repo",
  key: string,
  value: string,
): Promise<void> {
  if (scope !== "global") return;
  if (key === "SWARM_ORG_WEBSITE") await fillOrgLogoFromWebsite(value);
  await syncRankingAfterConfigChange(key, value);
  // Auto-reload integrations when a global-scoped config changes so callers
  // (CLI, automation, dashboard) don't have to remember to hit /reload.
  // Debounced to coalesce sequential single-key upserts from the dashboard
  // batch save (no bulk endpoint exists).
  scheduleIntegrationsReload();
}

/**
 * The general form of `ensureConfigAdmin`: operators and users pass, guests
 * get a plain 403, and an agent principal (session identity first, then the
 * legacy X-Agent-ID header) must hold `verb`. On denial it writes a 403 with
 * `forbiddenMessage` and returns false.
 */
export async function ensureHttpPermission(
  req: IncomingMessage,
  res: ServerResponse,
  verb: PermissionVerb,
  forbiddenMessage: string,
): Promise<boolean> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "operator" || auth?.kind === "user") return true;
  if (auth?.kind === "guest") {
    jsonError(res, "Forbidden", 403);
    return false;
  }
  const agentId = auth?.kind === "agent" ? auth.agentId : singleHeader(req, "x-agent-id");
  const agent = agentId ? await getAgentById(agentId) : undefined;
  const decision = can({
    principal: { kind: "agent", agentId: agentId ?? "", isLead: agent?.isLead ?? false },
    verb,
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, forbiddenMessage, 403);
    return false;
  }
  return true;
}

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
    key: z
      .string()
      .min(1)
      .optional()
      .describe("Return only the entry with this exact key. Omit to return every resolved entry."),
    includeSecrets: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: {
      description: "Resolved config entries",
      schema: z.object({
        configs: z.array(SwarmConfigSchema),
        message: z.string().optional(),
      }),
    },
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
    200: {
      description: "Map of key -> boolean (true iff set in process.env)",
      schema: z.object({ presence: z.record(z.string(), z.boolean()) }),
    },
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
    200: {
      description: "Reload result",
      schema: z.object({
        success: z.literal(true),
        configsLoaded: z.number(),
        keysUpdated: z.array(z.string()),
        integrationsReinitialized: z.array(z.string()),
      }),
    },
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
    200: {
      description: "Config entry",
      schema: SwarmConfigSchema.extend({ message: z.string().optional() }),
    },
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
    key: z
      .string()
      .min(1)
      .optional()
      .describe("Return only entries with this exact key. Omit to return every entry."),
    includeSecrets: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: {
      description: "List of config entries",
      schema: z.object({
        configs: z.array(SwarmConfigSchema),
        message: z.string().optional(),
      }),
    },
  },
});

const upsertConfig = route({
  method: "put",
  path: "/api/config",
  pattern: ["api", "config"],
  summary:
    "Create or update a config entry (reserved env-only keys are rejected). Global-scope writes auto-trigger an integrations reload (debounced ~250ms) so Slack/GitHub/Linear/Jira/AgentMail pick up new credentials without an explicit /api/config/reload call.",
  tags: ["Config"],
  rbac: { permission: "config.write.any" },
  body: z.object({
    scope: z.enum(["global", "agent", "repo"]),
    scopeId: z.string().nullish(),
    key: z.string().min(1),
    value: z.unknown(),
    isSecret: z.boolean().optional(),
    envPath: z.string().nullish(),
    description: z.string().nullish(),
    exportToEnv: z
      .boolean()
      .optional()
      .describe(
        "Export this row into agent process env (default true on create, false for a few server-side secrets; omitted on update keeps the stored flag). Rejected as true for keys only the API server reads.",
      ),
  }),
  responses: {
    200: { description: "Config entry upserted", schema: SwarmConfigSchema },
    400: { description: "Validation error" },
  },
});

const deleteConfig = route({
  method: "delete",
  path: "/api/config/{id}",
  pattern: ["api", "config", null],
  summary:
    "Delete a config entry by ID (including legacy reserved rows for cleanup). Global-scope deletes auto-trigger an integrations reload.",
  tags: ["Config"],
  rbac: { permission: "config.delete.any" },
  params: z.object({ id: z.string() }),
  responses: {
    200: {
      description: "Config deleted",
      schema: z.object({ success: z.literal(true) }),
    },
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
  if (getRequestAuth(req)?.kind === "agent") {
    const duplicate = duplicateGuardedQueryKey(queryParams);
    if (duplicate) {
      jsonError(res, `Duplicate query parameter: ${duplicate}`, 400);
      return true;
    }
  }
  if (getResolvedConfigRoute.match(req.method, pathSegments)) {
    const parsed = await getResolvedConfigRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeSecrets = parsed.query.includeSecrets === "true";
    const key = parsed.query.key;
    const auth = getRequestAuth(req);
    const resolvedScope = {
      agentId:
        parsed.query.agentId ||
        (auth?.kind === "agent" && auth.tokenKind !== "task" ? auth.agentId : undefined),
      repoId: parsed.query.repoId || undefined,
    };
    const { effectiveIncludeSecrets, includeRepoSecrets, secretsNote } = await resolveSecretsRead(
      req,
      includeSecrets,
      resolvedScope,
    );
    // Filter by key before masking and before any secret is registered, so a
    // caller asking for one key never receives the rest (matches get-config).
    const configs = stripApiOnlyKeys(
      await getResolvedConfig(resolvedScope.agentId, resolvedScope.repoId, { includeRepoSecrets }),
    ).filter((c) => !key || c.key === key);
    const result = effectiveIncludeSecrets ? configs : maskSecrets(configs);
    if (effectiveIncludeSecrets) {
      for (const c of result) {
        if (c.isSecret && c.value) {
          registerVolatileSecret(c.value, `config:${c.key}`);
        }
      }
    }
    getResolvedConfigRoute.respond(res, 200, {
      configs: result,
      ...(secretsNote ? { message: `Found ${result.length} config(s).${secretsNote}` } : {}),
    });
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
      // Organization identity is trimmed by both /status and telemetry.
      // Match that definition without changing presence semantics for secrets.
      const value = key === "SWARM_ORG_NAME" ? process.env[key]?.trim() : process.env[key];
      presence[key] = value !== undefined && value !== "";
    }
    envPresence.respond(res, 200, { presence });
    return true;
  }

  if (reloadConfigRoute.match(req.method, pathSegments)) {
    try {
      const result = await reloadGlobalConfigsAndIntegrations();
      console.log(
        `[reload-config] Loaded ${result.configsLoaded} config(s), re-initialized: ${result.integrationsReinitialized.join(", ") || "none"}`,
      );
      reloadConfigRoute.respond(res, 200, { success: true, ...result });
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
    const config = await getSwarmConfigById(parsed.params.id);
    if (!config || isInternalConfigKey(config.key)) {
      jsonError(res, "Config not found", 404);
      return true;
    }
    const { effectiveIncludeSecrets, secretsNote } = await resolveSecretsRead(req, includeSecrets);
    const singleResult = effectiveIncludeSecrets ? config : maskSecrets([config])[0]!;
    if (effectiveIncludeSecrets && singleResult.isSecret && singleResult.value) {
      registerVolatileSecret(singleResult.value, `config:${singleResult.key}`);
    }
    getConfigById.respond(res, 200, {
      ...singleResult,
      ...(secretsNote ? { message: `Found 1 config(s).${secretsNote}` } : {}),
    });
    return true;
  }

  if (listConfig.match(req.method, pathSegments)) {
    const parsed = await listConfig.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeSecrets = parsed.query.includeSecrets === "true";
    const { effectiveIncludeSecrets, secretsNote } = await resolveSecretsRead(req, includeSecrets);
    const configs = stripApiOnlyKeys(
      await getSwarmConfigs({
        scope: parsed.query.scope || undefined,
        scopeId: parsed.query.scopeId || undefined,
        key: parsed.query.key,
      }),
    );
    const listResult = effectiveIncludeSecrets ? configs : maskSecrets(configs);
    if (effectiveIncludeSecrets) {
      for (const c of listResult) {
        if (c.isSecret && c.value) {
          registerVolatileSecret(c.value, `config:${c.key}`);
        }
      }
    }
    listConfig.respond(res, 200, {
      configs: listResult,
      ...(secretsNote ? { message: `Found ${listResult.length} config(s).${secretsNote}` } : {}),
    });
    return true;
  }

  if (upsertConfig.match(req.method, pathSegments)) {
    const parsed = await upsertConfig.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    const { scope, scopeId, key, value, isSecret, envPath, description, exportToEnv } = parsed.body;

    const validationError = validateConfigEntry({ scope, scopeId, key, value, exportToEnv });
    if (validationError) {
      jsonError(res, validationError, 400);
      return true;
    }

    try {
      const includeSecrets = queryParams.get("includeSecrets") === "true";
      const config = await upsertSwarmConfigWithPolicyMirror({
        scope,
        scopeId: scopeId || null,
        key,
        value: String(value),
        isSecret: isSecret || false,
        envPath: envPath || null,
        description: description || null,
        exportToEnv,
      });
      await runConfigWriteSideEffects(scope, key, String(value));
      const result = includeSecrets || !config.isSecret ? config : maskSecrets([config])[0]!;
      upsertConfig.respond(res, 200, result);
    } catch (error) {
      if (modelProfileRefError(error) === "missing") {
        jsonError(res, `Unknown model profile "${String(value)}"`, 400);
        return true;
      }
      jsonError(res, "Failed to upsert config", 500);
    }
    return true;
  }

  if (deleteConfig.match(req.method, pathSegments)) {
    const parsed = await deleteConfig.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.delete.any"))) return true;
    const existing = await getSwarmConfigLookupById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Config not found", 404);
      return true;
    }
    if (isInternalConfigKey(existing.key)) {
      jsonError(res, internalConfigKeyError(existing.key).message, 400);
      return true;
    }
    const deleted = await deleteSwarmConfig(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Config not found", 404);
      return true;
    }
    if (existing.scope === "global") {
      await syncRankingAfterConfigChange(existing.key, null);
      scheduleIntegrationsReload();
    }
    if (
      existing.scope === "agent" &&
      existing.scopeId &&
      existing.key === AGENT_MAX_TASKS_CONFIG_KEY
    ) {
      await resetAgentMaxTasksMirror(existing.scopeId);
    }
    deleteConfig.respond(res, 200, { success: true });
    return true;
  }

  return false;
}

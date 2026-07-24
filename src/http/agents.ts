import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import {
  createAgent,
  deleteSwarmConfigByKey,
  getAgentById,
  getAgentWithTasks,
  getAllAgents,
  getAllAgentsWithTasks,
  getDb,
  getSwarmConfigs,
  resetEmptyPollCount,
  setAgentHarnessProvider,
  updateAgentActivity,
  updateAgentCredentialState,
  updateAgentCredStatus,
  updateAgentMaxTasks,
  updateAgentName,
  updateAgentProfile,
  updateAgentProvider,
  updateAgentStatus,
  upsertSwarmConfig,
} from "../be/db";
import { reasoningCapability } from "../providers/reasoning-effort";
import { getEnabledCapabilities } from "../server";
import { telemetry } from "../telemetry";
import {
  AgentCredStatusSchema,
  AgentLatestModelSchema,
  type ProviderName,
  ProviderNameSchema,
  ReasoningEffortSchema,
} from "../types";
import { route } from "./route-def";
import { agentWithCapacity, json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const registerAgent = route({
  method: "post",
  path: "/api/agents",
  pattern: ["api", "agents"],
  summary: "Register or re-register an agent",
  tags: ["Agents"],
  body: z.object({
    name: z.string().min(1),
    isLead: z.boolean().optional(),
    description: z.string().optional(),
    role: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    maxTasks: z.number().int().optional(),
    provider: ProviderNameSchema.optional(),
    /**
     * Phase 1.5 (cloud-personalization): worker-pushed canonical harness
     * provider. Persists to `agents.harness_provider`. Validated against
     * the canonical list — unknown values reject the request with 400.
     */
    harness_provider: ProviderNameSchema.optional(),
  }),
  responses: {
    200: {
      description:
        "Agent re-registered (already existed). Response includes `enabledCapabilities` — the server's capability flags (registered MCP tool groups), not the agent's declared skill tags.",
    },
    201: { description: "Agent created. Response includes `enabledCapabilities` (see 200)." },
    400: { description: "Validation error" },
  },
});

const setAgentHarnessProviderRoute = route({
  method: "patch",
  path: "/api/agents/{id}/harness-provider",
  pattern: ["api", "agents", null, "harness-provider"],
  summary: "Re-assign an agent's harness_provider (live)",
  description:
    "Updates `agents.harness_provider` and upserts `swarm_config` (scope=agent, key=HARNESS_PROVIDER) so the worker's poll-loop reconciliation picks up the new provider within ~10s. No restart required. The swarm_config row is what actually drives the worker; the column mirrors the latest set value for dashboards.",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: z.object({
    harness_provider: ProviderNameSchema,
  }),
  responses: {
    200: { description: "Updated agent row" },
    400: { description: "Validation error (unknown provider)" },
    404: { description: "Agent not found" },
  },
});

const LocalHarnessProviderSchema = z.enum(["claude", "codex", "pi", "opencode"]);

const updateAgentRuntimeRoute = route({
  method: "patch",
  path: "/api/agents/{id}/runtime",
  pattern: ["api", "agents", null, "runtime"],
  summary: "Update an agent's runtime harness and default model",
  description:
    "Updates `agents.harness_provider` and upserts agent-scoped `swarm_config` rows for HARNESS_PROVIDER, MODEL_OVERRIDE, and REASONING_EFFORT_OVERRIDE. The settings apply to future provider sessions. For `model` and `reasoning_effort`: omit the field to leave it unchanged, send `null` to clear the corresponding override, or send a value to set it.",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: z.object({
    harness_provider: LocalHarnessProviderSchema,
    model: z.string().trim().min(1).nullable().optional(),
    allow_custom_model: z.boolean().optional().default(false),
    reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  }),
  responses: {
    200: { description: "Updated agent row" },
    400: { description: "Validation error" },
    404: { description: "Agent not found" },
  },
});

const listAgents = route({
  method: "get",
  path: "/api/agents",
  pattern: ["api", "agents"],
  summary: "List all agents",
  description:
    "Returns agents WITHOUT the six identity-markdown blobs (`claudeMd`/`soulMd`/`identityMd`/`toolsMd`/`heartbeatMd`/`setupScript`) by default — they bloat the list by ~16 KB/agent and the overview never renders them. Pass `fields=full` to restore them, or fetch a single agent via `GET /api/agents/{id}`.",
  tags: ["Agents"],
  query: z.object({
    include: z.enum(["tasks"]).optional(),
    /** `full` restores the legacy shape (includes identity markdown); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: { description: "Agent list with capacity info" },
  },
});

const updateAgentNameRoute = route({
  method: "put",
  path: "/api/agents/{id}/name",
  pattern: ["api", "agents", null, "name"],
  summary: "Update agent name",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string().min(1) }),
  responses: {
    200: { description: "Agent updated" },
    404: { description: "Agent not found" },
    409: { description: "Name conflict" },
  },
});

const getAgentSetupScript = route({
  method: "get",
  path: "/api/agents/{id}/setup-script",
  pattern: ["api", "agents", null, "setup-script"],
  summary: "Fetch agent + global setup scripts for Docker entrypoint",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Setup scripts" },
    404: { description: "Agent not found" },
  },
});

const updateAgentProfileRoute = route({
  method: "put",
  path: "/api/agents/{id}/profile",
  pattern: ["api", "agents", null, "profile"],
  summary: "Update agent profile (role, description, capabilities, etc.)",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: z.object({
    role: z.string().max(100).optional(),
    description: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    claudeMd: z.string().max(65536).optional(),
    soulMd: z.string().max(65536).optional(),
    identityMd: z.string().max(65536).optional(),
    setupScript: z.string().max(65536).optional(),
    toolsMd: z.string().max(65536).optional(),
    heartbeatMd: z.string().max(65536).optional(),
    changeSource: z.string().optional(),
    changedByAgentId: z.string().optional(),
    changeReason: z.string().optional(),
  }),
  responses: {
    200: { description: "Profile updated" },
    400: { description: "Validation error" },
    404: { description: "Agent not found" },
  },
});

const updateAgentActivityRoute = route({
  method: "put",
  path: "/api/agents/{id}/activity",
  pattern: ["api", "agents", null, "activity"],
  summary: "Update agent last activity timestamp",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  responses: {
    204: { description: "Activity updated" },
  },
});

const getAgent = route({
  method: "get",
  path: "/api/agents/{id}",
  pattern: ["api", "agents", null],
  summary: "Get a single agent",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  query: z.object({
    include: z.enum(["tasks"]).optional(),
  }),
  responses: {
    200: { description: "Agent with capacity info" },
    404: { description: "Agent not found" },
  },
});

// ─── Credential-status (Phase 3 + 4 of the credential safe-loop plan) ───────

const credentialStatusBody = z.object({
  ready: z.boolean().optional(),
  /** Env-var names (or absolute file paths) the worker is blocked on. Empty/null when ready. */
  missing: z.array(z.string()).optional().nullable(),
  /**
   * Migration 055: full credential snapshot (presence + live test). Optional
   * for backward compat — older workers may only POST `{ready, missing}`.
   * When present, written to `agents.cred_status` as JSON; the dashboard
   * reads the row instead of running its own check.
   */
  cred_status: AgentCredStatusSchema.optional().nullable(),
  /**
   * Worker-reported latest model telemetry. Optional and merge-only: when sent
   * without `cred_status`, the API preserves existing readiness/live-test data.
   */
  latest_model: AgentLatestModelSchema.optional(),
});

const updateAgentCredentialStatusRoute = route({
  method: "put",
  path: "/api/agents/{id}/credential-status",
  pattern: ["api", "agents", null, "credential-status"],
  summary: "Worker self-report of credential readiness (Phase 3 boot loop)",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: credentialStatusBody,
  responses: {
    200: { description: "State updated; returns the agent row." },
    404: { description: "Agent not found" },
  },
});

const getAgentCredentialStatusRoute = route({
  method: "get",
  path: "/api/agents/{id}/credential-status",
  pattern: ["api", "agents", null, "credential-status"],
  summary: "Single-agent credential-status snapshot for the dashboard",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Credential status payload" },
    404: { description: "Agent not found" },
  },
});

const listCredentialStatusRoute = route({
  method: "get",
  path: "/api/agents/credential-status",
  pattern: ["api", "agents", "credential-status"],
  summary: "Bulk credential-status across all agents (powers the dashboard)",
  tags: ["Agents"],
  query: z.object({
    status: z.enum(["idle", "busy", "offline", "waiting_for_credentials"]).optional(),
  }),
  responses: {
    200: { description: "List of {agentId, status, missing[], lastCheckedAt}" },
  },
});

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleAgentRegister(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (registerAgent.match(req.method, pathSegments)) {
    const parsed = await registerAgent.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const agentId = myAgentId || crypto.randomUUID();

    const result = getDb().transaction(() => {
      const existingAgent = getAgentById(agentId);
      if (existingAgent) {
        if (existingAgent.status === "offline") {
          updateAgentStatus(existingAgent.id, "idle");
        }
        if (parsed.body.maxTasks !== undefined && parsed.body.maxTasks !== existingAgent.maxTasks) {
          updateAgentMaxTasks(existingAgent.id, parsed.body.maxTasks);
        }
        if (parsed.body.provider && parsed.body.provider !== existingAgent.provider) {
          updateAgentProvider(existingAgent.id, parsed.body.provider);
        }
        // Phase 1.5: worker-pushed harness_provider always wins on
        // re-registration. Env-driven, by design (per-agent live override
        // belongs to DES-359). NULL => leave existing column untouched
        // so PATCH /harness-provider doesn't get clobbered by re-register
        // payloads from older workers.
        if (
          parsed.body.harness_provider &&
          parsed.body.harness_provider !== existingAgent.harnessProvider
        ) {
          setAgentHarnessProvider(existingAgent.id, parsed.body.harness_provider);
        }
        resetEmptyPollCount(existingAgent.id);
        return { agent: getAgentById(agentId), created: false };
      }

      const agent = createAgent({
        id: agentId,
        name: parsed.body.name,
        isLead: parsed.body.isLead ?? false,
        status: "idle",
        description: parsed.body.description,
        role: parsed.body.role,
        capabilities: parsed.body.capabilities ?? [],
        maxTasks: parsed.body.maxTasks ?? 1,
        provider: parsed.body.provider,
        harnessProvider: parsed.body.harness_provider ?? null,
      });

      return { agent, created: true };
    })();

    telemetry.agent("registered", {
      role: parsed.body.role,
      capabilities: parsed.body.capabilities ?? [],
      isReconnect: !result.created,
    });

    if (result.created) {
      ensure({
        id: "registered",
        flow: "agent",
        runId: agentId,
        data: {
          agentId,
          name: parsed.body.name,
          isLead: parsed.body.isLead ?? false,
        },
      });
    } else {
      ensure({
        id: "reconnected",
        flow: "agent",
        runId: agentId,
        depIds: ["registered"],
        data: {
          agentId,
          name: parsed.body.name,
        },
        validator: (_data, ctx) => {
          // Validates that registered happened before reconnected
          return ctx.deps.length > 0;
        },
        // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
        filter: ({}, ctx) => ctx.deps.length > 0,
        conditions: [{ timeout_ms: 86_400_000 }], // 1 day: agents may be offline for extended periods
      });
    }

    // `enabledCapabilities` = the server's capability flags (which MCP tool
    // groups are registered), NOT the agent's declared skill tags. Workers use
    // it to drop prompt sections that instruct unregistered tools.
    json(
      res,
      { ...result.agent, enabledCapabilities: getEnabledCapabilities() },
      result.created ? 201 : 200,
    );
    return true;
  }

  return false;
}

export async function handleAgentsRest(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  if (listAgents.match(req.method, pathSegments)) {
    const parsed = await listAgents.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeTasks = parsed.query.include === "tasks";
    // List responses default to slim (no identity markdown); `?fields=full` restores it.
    const slim = parsed.query.fields !== "full";
    const agents = includeTasks ? getAllAgentsWithTasks({ slim }) : getAllAgents({ slim });
    const agentsWithCapacity = agents.map(agentWithCapacity);
    json(res, { agents: agentsWithCapacity });
    return true;
  }

  if (updateAgentNameRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentNameRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const agent = updateAgentName(parsed.params.id, parsed.body.name.trim());
      if (!agent) {
        jsonError(res, "Agent not found", 404);
        return true;
      }
      json(res, agentWithCapacity(agent));
    } catch (error) {
      jsonError(res, (error as Error).message, 409);
    }
    return true;
  }

  if (getAgentSetupScript.match(req.method, pathSegments)) {
    const parsed = await getAgentSetupScript.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = getAgentById(parsed.params.id);
    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    const globalConfigs = getSwarmConfigs({ scope: "global", key: "SETUP_SCRIPT" });
    const globalSetupScript = globalConfigs[0]?.value ?? null;
    json(res, {
      setupScript: agent.setupScript ?? null,
      globalSetupScript,
    });
    return true;
  }

  if (updateAgentProfileRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentProfileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const body = parsed.body;

    // At least one profile field must be provided
    if (
      body.role === undefined &&
      body.description === undefined &&
      body.capabilities === undefined &&
      body.claudeMd === undefined &&
      body.soulMd === undefined &&
      body.identityMd === undefined &&
      body.setupScript === undefined &&
      body.toolsMd === undefined &&
      body.heartbeatMd === undefined
    ) {
      jsonError(
        res,
        "At least one field (role, description, capabilities, claudeMd, soulMd, identityMd, setupScript, toolsMd, or heartbeatMd) must be provided",
        400,
      );
      return true;
    }

    // Build version metadata if provided
    const validChangeSources = ["self_edit", "lead_coaching", "api", "system", "session_sync"];
    const versionMeta =
      body.changeSource || body.changedByAgentId || body.changeReason
        ? {
            changeSource: validChangeSources.includes(body.changeSource ?? "")
              ? (body.changeSource as import("../types").ChangeSource)
              : undefined,
            changedByAgentId: body.changedByAgentId ?? null,
            changeReason: body.changeReason ?? null,
          }
        : undefined;

    const agent = updateAgentProfile(
      parsed.params.id,
      {
        role: body.role,
        description: body.description,
        capabilities: body.capabilities,
        claudeMd: body.claudeMd,
        soulMd: body.soulMd,
        identityMd: body.identityMd,
        setupScript: body.setupScript,
        toolsMd: body.toolsMd,
        heartbeatMd: body.heartbeatMd,
      },
      versionMeta,
    );

    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    json(res, agentWithCapacity(agent));
    return true;
  }

  if (updateAgentActivityRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentActivityRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    updateAgentActivity(parsed.params.id);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (setAgentHarnessProviderRoute.match(req.method, pathSegments)) {
    const parsed = await setAgentHarnessProviderRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = setAgentHarnessProvider(parsed.params.id, parsed.body.harness_provider);
    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    // Mirror to swarm_config (scope=agent) so the worker's reconciliation
    // loop actually reads the new value. The column above is for dashboard
    // visibility; this row is the live override.
    upsertSwarmConfig({
      scope: "agent",
      scopeId: parsed.params.id,
      key: "HARNESS_PROVIDER",
      value: parsed.body.harness_provider,
      description: "Set via PATCH /api/agents/{id}/harness-provider",
    });
    json(res, agentWithCapacity(agent));
    return true;
  }

  if (updateAgentRuntimeRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentRuntimeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { harness_provider, model, allow_custom_model, reasoning_effort } = parsed.body;

    // Validate the requested level against the hybrid capability lookup
    // before touching the DB. `model` may be omitted (leave MODEL_OVERRIDE
    // unchanged) — in that case validate against the currently persisted
    // MODEL_OVERRIDE for this agent, not an empty string, so a
    // reasoning_effort-only PATCH doesn't spuriously 400 against a model the
    // agent is already running.
    if (reasoning_effort) {
      const modelForValidation =
        model !== undefined
          ? model
          : (getSwarmConfigs({
              scope: "agent",
              scopeId: parsed.params.id,
              key: "MODEL_OVERRIDE",
            })[0]?.value ?? "");
      const capability = reasoningCapability(harness_provider, modelForValidation ?? "");
      if (!capability.levels.includes(reasoning_effort)) {
        json(
          res,
          {
            error: "Unsupported reasoning_effort for this harness/model",
            harness: harness_provider,
            model: modelForValidation || null,
            level: reasoning_effort,
            allowed: capability.levels,
          },
          400,
        );
        return true;
      }
    }

    const agent = getDb().transaction(() => {
      const updated = setAgentHarnessProvider(parsed.params.id, harness_provider as ProviderName);
      if (!updated) return null;
      upsertSwarmConfig({
        scope: "agent",
        scopeId: parsed.params.id,
        key: "HARNESS_PROVIDER",
        value: harness_provider,
        description: "Set via PATCH /api/agents/{id}/runtime",
      });

      // `model === null` clears MODEL_OVERRIDE; `undefined` leaves it
      // untouched; a string sets/updates it. Symmetric with reasoning_effort
      // below — this closes a pre-existing gap (there was previously no way
      // to clear MODEL_OVERRIDE via the API).
      if (model === null) {
        deleteSwarmConfigByKey("agent", parsed.params.id, "MODEL_OVERRIDE");
      } else if (model !== undefined) {
        upsertSwarmConfig({
          scope: "agent",
          scopeId: parsed.params.id,
          key: "MODEL_OVERRIDE",
          value: model,
          description: allow_custom_model
            ? "Custom model set via PATCH /api/agents/{id}/runtime"
            : "Set via PATCH /api/agents/{id}/runtime",
        });
      }

      // Same tri-state contract for REASONING_EFFORT_OVERRIDE. Note: until
      // the runner reads this key (Phase 3), setting it is a no-op on the
      // worker side — this phase only wires storage + validation.
      if (reasoning_effort === null) {
        deleteSwarmConfigByKey("agent", parsed.params.id, "REASONING_EFFORT_OVERRIDE");
      } else if (reasoning_effort !== undefined) {
        upsertSwarmConfig({
          scope: "agent",
          scopeId: parsed.params.id,
          key: "REASONING_EFFORT_OVERRIDE",
          value: reasoning_effort,
          description: "Set via PATCH /api/agents/{id}/runtime",
        });
      }

      return updated;
    })();
    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    json(res, agentWithCapacity(agent));
    return true;
  }

  // Bulk credential-status MUST be matched BEFORE single-agent routes — the
  // path "api/agents/credential-status" otherwise looks like an agent id.
  if (listCredentialStatusRoute.match(req.method, pathSegments)) {
    const parsed = await listCredentialStatusRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const filter = parsed.query.status;
    const agents = getAllAgents()
      .filter((a) => (filter ? a.status === filter : true))
      .map((a) => ({
        agentId: a.id,
        name: a.name,
        status: a.status,
        missing: a.credentialMissing ?? [],
        provider: a.provider ?? null,
        harnessProvider: a.harnessProvider ?? null,
        credStatus: a.credStatus ?? null,
        lastCheckedAt: a.lastUpdatedAt,
      }));
    json(res, { agents });
    return true;
  }

  if (updateAgentCredentialStatusRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentCredentialStatusRoute.parse(
      req,
      res,
      pathSegments,
      queryParams,
    );
    if (!parsed) return true;
    const existing = getAgentById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    const agent =
      parsed.body.ready !== undefined
        ? (updateAgentCredentialState(
            parsed.params.id,
            parsed.body.ready,
            parsed.body.missing ?? null,
          ) ?? existing)
        : existing;
    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    // Phase 055: persist the richer worker-reported snapshot when sent.
    // We accept `null` to explicitly clear (e.g. on harness change), and
    // `undefined` to leave the existing row value untouched.
    let finalAgent = agent;
    if (parsed.body.cred_status !== undefined) {
      const nextStatus = parsed.body.cred_status
        ? {
            ...parsed.body.cred_status,
            latestModel:
              parsed.body.latest_model ??
              parsed.body.cred_status.latestModel ??
              agent.credStatus?.latestModel ??
              null,
          }
        : null;
      finalAgent = updateAgentCredStatus(parsed.params.id, nextStatus) ?? agent;
    } else if (parsed.body.latest_model) {
      const current = agent.credStatus ?? {
        ready: parsed.body.ready ?? true,
        missing: parsed.body.missing ?? [],
        satisfiedBy: null,
        hint: null,
        liveTest: null,
        latestModel: null,
        reportedAt: parsed.body.latest_model.reportedAt,
        reportKind: "post_task" as const,
        bedrock: null,
      };
      finalAgent =
        updateAgentCredStatus(parsed.params.id, {
          ...current,
          latestModel: parsed.body.latest_model,
        }) ?? agent;
    }
    json(res, agentWithCapacity(finalAgent));
    return true;
  }

  if (getAgentCredentialStatusRoute.match(req.method, pathSegments)) {
    const parsed = await getAgentCredentialStatusRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = getAgentById(parsed.params.id);
    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    json(res, {
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      missing: agent.credentialMissing ?? [],
      provider: agent.provider ?? null,
      harnessProvider: agent.harnessProvider ?? null,
      credStatus: agent.credStatus ?? null,
      lastCheckedAt: agent.lastUpdatedAt,
    });
    return true;
  }

  if (getAgent.match(req.method, pathSegments)) {
    const parsed = await getAgent.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeTasks = parsed.query.include === "tasks";
    const agent = includeTasks
      ? getAgentWithTasks(parsed.params.id)
      : getAgentById(parsed.params.id);

    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    json(res, agentWithCapacity(agent));
    return true;
  }

  return false;
}

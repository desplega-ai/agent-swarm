import { scrubObject } from "../utils/secret-scrubber";
import { Redacted } from "./redacted";
import { isSdkToolAllowed, mcpToolNameForSdkMethod } from "./sdk-allowlist";
import type { SwarmConfig } from "./swarm-config";

type BridgeRequest = {
  method: string;
  path: string;
  body?: unknown;
};

function headers(config: SwarmConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
    "X-Agent-ID": Redacted.value(config.agentId),
    "Content-Type": "application/json",
  };
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function appendQuery(path: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function kvPath(args: Record<string, unknown>, keyRequired = true): string {
  const key = typeof args.key === "string" ? args.key : undefined;
  if (keyRequired && !key) throw new Error("kv tool requires string `key`");
  const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
  if (namespace) {
    return key
      ? `/api/kv/_/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`
      : `/api/kv/_/${encodeURIComponent(namespace)}`;
  }
  return key ? `/api/kv/${encodeURIComponent(key)}` : "/api/kv";
}

/**
 * Maps SDK method names to specific REST endpoints where they exist.
 * Returns null for tools that should fall through to the generic MCP bridge.
 */
function bridgeRequestFor(name: string, args: unknown): BridgeRequest | null {
  const body = argsRecord(args);
  switch (name) {
    // ── memory ──
    case "memory_search":
      return { method: "POST", path: "/api/memory/search", body };
    case "memory_get": {
      const memoryId = typeof body.memoryId === "string" ? body.memoryId : undefined;
      if (!memoryId) throw new Error("memory_get requires string `memoryId`");
      const getIntent = typeof body.intent === "string" ? body.intent : "script-sdk";
      return {
        method: "GET",
        path: `/api/memory/${encodeURIComponent(memoryId)}?intent=${encodeURIComponent(getIntent)}`,
      };
    }
    case "memory_rate": {
      const event = {
        memoryId: body.id,
        signal: body.useful === false ? -1 : 1,
        weight: 1,
        source: "explicit-self",
        reasoning: body.note ?? "",
        ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
        ...(typeof body.referencesSource === "string"
          ? { referencesSource: body.referencesSource }
          : {}),
      };
      return { method: "POST", path: "/api/memory/rate", body: { events: [event] } };
    }
    case "memory_delete": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("memory_delete requires string `id`");
      return { method: "DELETE", path: `/api/memory/${encodeURIComponent(id)}` };
    }

    // ── tasks ──
    case "task_list":
      return { method: "GET", path: appendQuery("/api/tasks", body) };
    case "task_get": {
      const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
      if (!taskId) throw new Error("task_get requires string `taskId`");
      return { method: "GET", path: `/api/tasks/${encodeURIComponent(taskId)}` };
    }
    case "task_storeProgress": {
      const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
      if (!taskId) throw new Error("task_storeProgress requires string `taskId`");
      if (body.status === "completed" || body.status === "failed") {
        return {
          method: "POST",
          path: `/api/tasks/${encodeURIComponent(taskId)}/finish`,
          body: {
            status: body.status,
            output: body.output,
            failureReason: body.failureReason,
          },
        };
      }
      return {
        method: "POST",
        path: `/api/tasks/${encodeURIComponent(taskId)}/progress`,
        body: { progress: body.progress ?? "" },
      };
    }
    case "task_cancel": {
      const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
      if (!taskId) throw new Error("task_cancel requires string `taskId`");
      return { method: "POST", path: `/api/tasks/${encodeURIComponent(taskId)}/cancel` };
    }

    // ── kv ──
    case "kv_get":
      return { method: "GET", path: kvPath(body) };
    case "kv_set":
      return {
        method: "PUT",
        path: kvPath(body),
        body: {
          value: body.value,
          valueType: body.valueType,
          expiresInSec: body.expiresInSec ?? body.ttlSeconds,
        },
      };
    case "kv_del":
      return { method: "DELETE", path: kvPath(body) };
    case "kv_incr":
      return { method: "POST", path: `${kvPath(body)}/incr`, body: { by: body.by } };
    case "kv_list":
      return {
        method: "GET",
        path: appendQuery(kvPath(body, false), {
          prefix: body.prefix,
          limit: body.limit,
          offset: body.offset,
        }),
      };

    // ── repos ──
    case "repo_list":
      return {
        method: "GET",
        path: appendQuery("/api/repos", { autoClone: body.autoClone, name: body.name }),
      };

    // ── schedules ──
    case "schedule_list":
      return {
        method: "GET",
        path: appendQuery("/api/schedules", {
          enabled: body.enabled,
          name: body.name,
          scheduleType: body.scheduleType,
          targetType: body.targetType,
          workflowId: body.workflowId,
          scriptName: body.scriptName,
          hideCompleted: body.hideCompleted,
          consecutiveErrorsMin: body.consecutiveErrorsMin,
          lastRunStatus: body.lastRunStatus,
        }),
      };
    case "schedule_create":
      return { method: "POST", path: "/api/schedules", body };
    case "schedule_update":
    case "schedule_patch": {
      const id = typeof body.id === "string" ? body.id : body.scheduleId;
      if (typeof id !== "string") throw new Error(`${name} requires string \`id\``);
      const { id: _id, scheduleId: _scheduleId, newName, ...rest } = body;
      return {
        method: name === "schedule_patch" ? "PATCH" : "PUT",
        path: `/api/schedules/${encodeURIComponent(id)}`,
        body: { ...rest, ...(newName !== undefined ? { name: newName } : {}) },
      };
    }
    case "schedule_delete": {
      const id = typeof body.id === "string" ? body.id : body.scheduleId;
      if (typeof id !== "string") throw new Error("schedule_delete requires string `id`");
      return { method: "DELETE", path: `/api/schedules/${encodeURIComponent(id)}` };
    }
    case "schedule_runNow": {
      const id = typeof body.id === "string" ? body.id : body.scheduleId;
      if (typeof id !== "string") throw new Error("schedule_runNow requires string `id`");
      return { method: "POST", path: `/api/schedules/${encodeURIComponent(id)}/run` };
    }

    // ── scripts ──
    case "script_search":
      return { method: "POST", path: "/api/scripts/search", body };
    case "script_run":
      return { method: "POST", path: "/api/scripts/run", body };

    // ── swarm / agent ──
    case "db_query":
      return { method: "POST", path: "/api/db-query", body };
    case "swarm_get":
      return {
        method: "GET",
        path: appendQuery("/api/agents", {
          fields: body.includeFull ? "full" : "slim",
        }),
      };
    case "agent_info":
      return { method: "GET", path: "/me" };
    case "metrics_get":
      return { method: "GET", path: "/api/metrics" };
    case "task_poll":
      return { method: "GET", path: "/api/poll" };

    // ── config ──
    case "config_get":
      return {
        method: "GET",
        path: appendQuery("/api/config/resolved", {
          agentId: body.agentId,
          repoId: body.repoId,
          key: body.key,
          includeSecrets: body.includeSecrets,
        }),
      };
    case "config_list":
      return {
        method: "GET",
        path: appendQuery("/api/config", {
          scope: body.scope,
          scopeId: body.scopeId,
          key: body.key,
          includeSecrets: body.includeSecrets,
        }),
      };
    case "config_delete": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("config_delete requires string `id`");
      return { method: "DELETE", path: `/api/config/${encodeURIComponent(id)}` };
    }

    // ── services ──
    case "service_list":
      return {
        method: "GET",
        path: appendQuery("/api/services", {
          agentId: body.agentId,
          name: body.name,
          status: body.status,
        }),
      };

    // ── workflows ──
    case "workflow_list":
      return {
        method: "GET",
        path: appendQuery("/api/workflows", {
          enabled: body.enabled,
          consecutiveErrorsMin: body.consecutiveErrorsMin,
          lastRunStatus: body.lastRunStatus,
          fields: body.includeFull ? "full" : "slim",
        }),
      };
    case "workflow_get": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_get requires string `id`");
      return { method: "GET", path: `/api/workflows/${encodeURIComponent(id)}` };
    }
    case "workflow_listRuns": {
      const wfId = typeof body.workflowId === "string" ? body.workflowId : undefined;
      if (!wfId) throw new Error("workflow_listRuns requires string `workflowId`");
      return {
        method: "GET",
        path: appendQuery(`/api/workflows/${encodeURIComponent(wfId)}/runs`, {
          status: body.status,
        }),
      };
    }
    case "workflow_getRun": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_getRun requires string `id`");
      return { method: "GET", path: `/api/workflow-runs/${encodeURIComponent(id)}` };
    }
    case "workflow_delete": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_delete requires string `id`");
      return { method: "DELETE", path: `/api/workflows/${encodeURIComponent(id)}` };
    }
    case "workflow_create":
      return { method: "POST", path: "/api/workflows", body };
    case "workflow_update": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_update requires string `id`");
      const { id: _id, ...rest } = body;
      return { method: "PUT", path: `/api/workflows/${encodeURIComponent(id)}`, body: rest };
    }
    case "workflow_patch": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_patch requires string `id`");
      const { id: _id, ...rest } = body;
      return { method: "PATCH", path: `/api/workflows/${encodeURIComponent(id)}`, body: rest };
    }
    case "workflow_patchNode": {
      const id = typeof body.id === "string" ? body.id : undefined;
      const nodeId = typeof body.nodeId === "string" ? body.nodeId : undefined;
      if (!id || !nodeId) {
        throw new Error("workflow_patchNode requires string `id` and `nodeId`");
      }
      const { id: _id, nodeId: _nodeId, ...rest } = body;
      return {
        method: "PATCH",
        path: `/api/workflows/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}`,
        body: rest,
      };
    }
    case "workflow_trigger": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_trigger requires string `id`");
      return {
        method: "POST",
        path: `/api/workflows/${encodeURIComponent(id)}/trigger`,
        body: body.triggerData ?? {},
      };
    }
    case "workflow_retryRun": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_retryRun requires string `id`");
      return { method: "POST", path: `/api/workflow-runs/${encodeURIComponent(id)}/retry` };
    }
    case "workflow_cancelRun": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_cancelRun requires string `id`");
      return {
        method: "POST",
        path: `/api/workflow-runs/${encodeURIComponent(id)}/cancel`,
        body: body.reason !== undefined ? { reason: body.reason } : undefined,
      };
    }

    // ── prompt templates ──
    case "prompt_list":
      return {
        method: "GET",
        path: appendQuery("/api/prompt-templates", {
          eventType: body.eventType,
          scope: body.scope,
          scopeId: body.scopeId,
          isDefault: body.isDefault,
        }),
      };
    case "prompt_get": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("prompt_get requires string `id`");
      return { method: "GET", path: `/api/prompt-templates/${encodeURIComponent(id)}` };
    }
    case "prompt_delete": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("prompt_delete requires string `id`");
      return { method: "DELETE", path: `/api/prompt-templates/${encodeURIComponent(id)}` };
    }

    // ── skills ──
    case "skill_list":
      return {
        method: "GET",
        path: appendQuery("/api/skills", {
          scope: body.scope,
          scopeId: body.scopeId,
          includeBuiltin: body.includeBuiltin,
        }),
      };
    case "skill_get": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("skill_get requires string `id`");
      return { method: "GET", path: `/api/skills/${encodeURIComponent(id)}` };
    }
    case "skill_getFile": {
      const skillId = typeof body.skillId === "string" ? body.skillId : undefined;
      const path = typeof body.path === "string" ? body.path : undefined;
      if (!skillId) throw new Error("skill_getFile requires string `skillId`");
      if (!path) throw new Error("skill_getFile requires string `path`");
      return {
        method: "GET",
        path: `/api/skills/${encodeURIComponent(skillId)}/files/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      };
    }
    case "skill_search":
      return { method: "POST", path: "/api/skills/search", body };
    case "skill_delete": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("skill_delete requires string `id`");
      return { method: "DELETE", path: `/api/skills/${encodeURIComponent(id)}` };
    }

    // ── mcp servers ──
    case "mcpServer_list":
      return { method: "GET", path: "/api/mcp-servers" };
    case "mcpServer_get": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("mcpServer_get requires string `id`");
      return { method: "GET", path: `/api/mcp-servers/${encodeURIComponent(id)}` };
    }
    case "mcpServer_delete": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("mcpServer_delete requires string `id`");
      return { method: "DELETE", path: `/api/mcp-servers/${encodeURIComponent(id)}` };
    }

    // ── fallthrough: proxy via generic MCP bridge ──
    default:
      return null;
  }
}

async function callBridgeApi(
  name: string,
  args: unknown,
  config: SwarmConfig,
  options: { throwOnError?: boolean } = {},
): Promise<unknown> {
  const baseUrl = Redacted.value(config.mcpBaseUrl).replace(/\/$/, "");
  const request = bridgeRequestFor(name, args);

  // Tools without a specific REST route go through the generic MCP bridge
  if (!request) {
    const mcpToolName = mcpToolNameForSdkMethod(name);
    const res = await fetch(`${baseUrl}/api/mcp-bridge`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ tool: mcpToolName, args: args ?? {} }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok && options.throwOnError) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `api failed with ${res.status}`;
      throw new Error(`swarm-sdk: ${name} failed with ${res.status}: ${message}`);
    }
    return scrubObject({ success: res.ok, status: res.status, data });
  }

  const res = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: headers(config),
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok && options.throwOnError) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `api failed with ${res.status}`;
    throw new Error(`swarm-sdk: ${name} failed with ${res.status}: ${message}`);
  }
  return scrubObject({ success: res.ok, status: res.status, data });
}

async function callTool(name: string, args: unknown, config: SwarmConfig): Promise<unknown> {
  if (!isSdkToolAllowed(name)) {
    throw new Error(
      `Tool '${name}' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent`,
    );
  }

  if (name === "script_search" || name === "script_run") {
    return callBridgeApi(name, args, config, { throwOnError: true });
  }

  return callBridgeApi(name, args, config);
}

export function createSwarmSdk(
  config: SwarmConfig,
): Record<string, (args?: unknown) => Promise<unknown>> {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      return (args?: unknown) => callTool(prop, args, config);
    },
  }) as Record<string, (args?: unknown) => Promise<unknown>>;
}

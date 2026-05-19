import { scrubObject } from "../utils/secret-scrubber";
import { Redacted } from "./redacted";
import { isSdkToolAllowed } from "./sdk-allowlist";
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

function bridgeRequestFor(name: string, args: unknown): BridgeRequest {
  const body = argsRecord(args);
  switch (name) {
    case "memory_search":
      return { method: "POST", path: "/api/memory/search", body };
    case "memory_get": {
      const memoryId = typeof body.memoryId === "string" ? body.memoryId : undefined;
      if (!memoryId) throw new Error("memory_get requires string `memoryId`");
      return { method: "GET", path: `/api/memory/${encodeURIComponent(memoryId)}` };
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
    case "repo_list":
      return {
        method: "GET",
        path: appendQuery("/api/repos", { autoClone: body.autoClone, name: body.name }),
      };
    case "schedule_list":
      return {
        method: "GET",
        path: appendQuery("/api/schedules", {
          enabled: body.enabled,
          name: body.name,
          scheduleType: body.scheduleType,
          hideCompleted: body.hideCompleted,
        }),
      };
    case "script_search":
      return { method: "POST", path: "/api/scripts/search", body };
    case "script_run":
      return { method: "POST", path: "/api/scripts/run", body };
    default:
      throw new Error(`Tool '${name}' is not exposed through the scripts SDK bridge`);
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

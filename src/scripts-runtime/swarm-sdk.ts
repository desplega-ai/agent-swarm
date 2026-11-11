import { scrubObject } from "../utils/secret-scrubber";
import { Redacted } from "./redacted";
import { readScriptSdkJsonResponse } from "./response-limit";
import {
  assertNamespaces,
  isSdkToolAllowed,
  mcpToolNameForSdkMethod,
  SDK_NAMESPACES,
  type SdkNamespaceRegistry,
  sdkMethodForNamespace,
  unwrapToolPayload,
} from "./sdk-allowlist";
import { backoffMs, retryAfterMs } from "./stdlib/retry";
import type { SwarmConfig } from "./swarm-config";

type BridgeRequest = {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

function headers(config: SwarmConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
    "X-Agent-ID": Redacted.value(config.agentId),
    // Per-boot identity of the invoking worker process (system context, not
    // script input) — work-acquisition endpoints gate on it in multi-runtime
    // mode.
    ...(config.runtimeInstanceId
      ? { "X-Runtime-Instance-ID": Redacted.value(config.runtimeInstanceId) }
      : {}),
    ...(config.extensionToken
      ? { "X-Extension-Token": Redacted.value(config.extensionToken) }
      : {}),
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
      if (body.status === "completed" || body.status === "failed" || body.status === "skipped") {
        return {
          method: "POST",
          path: `/api/tasks/${encodeURIComponent(taskId)}/finish`,
          body: {
            status: body.status,
            output: body.output,
            failureReason: body.failureReason,
            force: body.force,
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
    case "approval_cancel": {
      const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
      if (!requestId) throw new Error("approval_cancel requires string `requestId`");
      return {
        method: "POST",
        path: `/api/approval-requests/${encodeURIComponent(requestId)}/cancel`,
        body: { reason: body.reason },
      };
    }

    // ── kv ──
    case "kv_get":
    case "kv_getOrNull": {
      // Optional targeted read: dot path into a JSON value + offset/limit page.
      const view = new URLSearchParams();
      if (typeof body.path === "string") view.set("path", body.path);
      if (typeof body.offset === "number") view.set("offset", String(body.offset));
      if (typeof body.limit === "number") view.set("limit", String(body.limit));
      const qs = view.toString();
      return { method: "GET", path: qs ? `${kvPath(body)}?${qs}` : kvPath(body) };
    }
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
    case "kv_delete":
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

    // ── realtime rooms ──
    case "room_get":
      return { method: "GET", path: appendQuery("/api/rooms/get", body) };
    case "room_change":
      return { method: "POST", path: "/api/rooms/change", body };
    case "room_reset":
      return { method: "POST", path: "/api/rooms/reset", body };
    case "room_decode":
      return { method: "POST", path: "/api/rooms/decode", body };

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
          fields: body.includeFull ? "full" : undefined,
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

    // ── savings calibration (REST only, no MCP tool) ──
    case "savings_calibrationGet":
      return { method: "GET", path: "/api/savings/calibration" };
    case "savings_calibrationRun":
      return { method: "POST", path: "/api/savings/calibration", body };

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
      const limit = body.limit === undefined ? 20 : body.limit;
      const offset = body.offset === undefined ? 0 : body.offset;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
        throw new Error("workflow_listRuns `limit` must be an integer between 1 and 100");
      }
      if (!Number.isInteger(offset) || (offset as number) < 0) {
        throw new Error("workflow_listRuns `offset` must be a non-negative integer");
      }
      return {
        method: "GET",
        path: appendQuery(`/api/workflows/${encodeURIComponent(wfId)}/runs`, {
          status: body.status,
          limit,
          offset,
        }),
      };
    }
    case "workflow_getRun": {
      const id = typeof body.id === "string" ? body.id : undefined;
      if (!id) throw new Error("workflow_getRun requires string `id`");
      if (body.fields !== undefined && body.fields !== "full" && body.fields !== "slim") {
        throw new Error('workflow_getRun `fields` must be "full" or "slim"');
      }
      return {
        method: "GET",
        path: appendQuery(`/api/workflow-runs/${encodeURIComponent(id)}`, { fields: body.fields }),
      };
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
      const path = `/api/workflows/${encodeURIComponent(id)}/trigger`;
      return {
        method: "POST",
        path: body.wait === false ? `${path}?wait=false` : path,
        body: body.triggerData ?? {},
        // The route's own Idempotency-Key: recorded in the run's transaction,
        // so a retry after a kill replays the run instead of starting another.
        ...(typeof body.idempotencyKey === "string"
          ? { headers: { "Idempotency-Key": body.idempotencyKey } }
          : {}),
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

// ── transient-failure retries ──
// Every ctx.swarm call retries a 429 (the rate limiter refused it before any
// work ran). A 502/503/504 or a network error retries only when a repeat is
// safe: a read, or a write whose route dedupes by its `Idempotency-Key`
// header (workflow_trigger with `idempotencyKey`). Any other write may have
// landed, and a second call would repeat it. script_run's `idempotencyKey`
// does not count: it overwrites a KV entry and does not dedupe the run.
const BRIDGE_MAX_RETRIES = 3;
const BRIDGE_MIN_DELAY_MS = 250;
const BRIDGE_MAX_DELAY_MS = 2_000;
/** Total retry time per call, so retries cannot eat the script's wall clock. */
const BRIDGE_RETRY_BUDGET_MS = 5_000;
const READ_RETRY_STATUSES = new Set([502, 503, 504]);

// MCP tool names that only read. Prefix/suffix rules cover get-* / list-* /
// *-get / *-list / *-search; the set lists the rest. A tool missing here is
// treated as a write, which is the safe default. tool-annotations.test.ts
// fails when a tool annotated `readOnlyHint: true` is missing here.
// read-messages may mark messages read; repeating that is harmless.
const READ_TOOL_PATTERN = /^(get|list)-|-(get|list|search)$/;
const READ_TOOLS = new Set([
  "db-query",
  "kv-get",
  "kv-list",
  "my-agent-info",
  "script-query-types",
  "skill-get-file",
  "slack-read",
  "slack-list-channels",
  "chat-read-thread",
  "app-rows-list",
  "app-row-get",
  "app-history",
  "app-diff",
  "context-history",
  "context-diff",
  "extension-catalog",
  "tracker-status",
  "tracker-sync-status",
  "app-query",
  "resolve-user",
  "room-decode",
  "read-messages",
  "check-model-profile",
  "preview-prompt-template",
]);
// GET routes that change state: polling claims work.
const NON_READ_GET_METHODS = new Set(["task_poll"]);

export function isReadOnlyBridgeCall(name: string, method: string): boolean {
  if (method === "GET") return !NON_READ_GET_METHODS.has(name);
  const tool = mcpToolNameForSdkMethod(name);
  return READ_TOOL_PATTERN.test(tool) || READ_TOOLS.has(tool);
}

function hasIdempotencyKey(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "idempotency-key");
}

/** A keyed write may repeat, but it stays a write: only a read gets the retry deadline. */
function bridgeSafety(readOnly: boolean, keyed: boolean) {
  return { repeatSafe: readOnly || keyed, readOnly };
}

/** Waits `ms`, or less when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * What a retry that ran out of budget hands back: the failure the caller would
 * have seen with no retry, the earlier status with a note in place of its
 * already-cancelled body.
 */
function budgetSpentResponse(previous: Response): Response {
  return Response.json(
    {
      error: `HTTP ${previous.status}; the retry did not answer within the ${BRIDGE_RETRY_BUDGET_MS}ms retry budget`,
    },
    { status: previous.status, statusText: previous.statusText },
  );
}

/**
 * `signal` is the run's own signal (quickjs aborts it when the run ends): an
 * aborted run gets the current outcome at once, never another wait or attempt.
 *
 * `repeatSafe`: a 502/503/504 or a network error may be retried (a read, or a
 * keyed write). `readOnly`: the call only reads.
 *
 * The first attempt runs unbounded, as it did before retries existed. A retry
 * of a read is cut off when the retry budget is spent, and the caller gets
 * the earlier failure. A write's retry, keyed or not, is never cut off: it may
 * be the write's first real run (after a 429) or start the work a keyed route
 * dedupes, and cutting it off reports a failure for work that went ahead.
 */
async function bridgeFetch(
  url: string,
  init: RequestInit,
  { repeatSafe, readOnly }: { repeatSafe: boolean; readOnly: boolean },
  signal: AbortSignal | undefined,
): Promise<Response> {
  const started = Date.now();
  const remaining = () => BRIDGE_RETRY_BUDGET_MS - (Date.now() - started);
  const fits = (delay: number) => delay <= remaining();
  let previous: { response: Response } | { error: unknown } | undefined;
  for (let attempt = 1; ; attempt++) {
    const budget = previous && readOnly ? AbortSignal.timeout(Math.max(1, remaining())) : undefined;
    let res: Response;
    try {
      res = await fetch(url, budget ? { ...init, signal: budget } : init);
    } catch (error) {
      if (budget?.aborted && !signal?.aborted && previous) {
        if ("error" in previous) throw previous.error;
        return budgetSpentResponse(previous.response);
      }
      const delay = backoffMs(attempt, BRIDGE_MIN_DELAY_MS, BRIDGE_MAX_DELAY_MS);
      // An abort means the run is ending: settle now, never wait and retry.
      const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
      if (aborted || !repeatSafe || attempt > BRIDGE_MAX_RETRIES || (readOnly && !fits(delay)))
        throw error;
      previous = { error };
      await sleep(delay, signal);
      if (signal?.aborted) throw error;
      continue;
    }
    const retryable = res.status === 429 || (repeatSafe && READ_RETRY_STATUSES.has(res.status));
    if (!retryable || attempt > BRIDGE_MAX_RETRIES || signal?.aborted) return res;
    const delay =
      (res.status === 429 ? retryAfterMs(res.headers.get("retry-after")) : undefined) ??
      backoffMs(attempt, BRIDGE_MIN_DELAY_MS, BRIDGE_MAX_DELAY_MS);
    // A Retry-After past the budget: hand the 429 back rather than wait.
    if ((readOnly || res.status === 429) && !fits(delay)) return res;
    await res.body?.cancel().catch(() => {});
    previous = { response: res };
    await sleep(delay, signal);
    if (signal?.aborted) return res;
  }
}

async function callBridgeApi(
  name: string,
  args: unknown,
  config: SwarmConfig,
  options: { throwOnError?: boolean; preserveData?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const baseUrl = Redacted.value(config.mcpBaseUrl).replace(/\/$/, "");
  const request = bridgeRequestFor(name, args);

  // Tools without a specific REST route go through the generic MCP bridge
  if (!request) {
    const mcpToolName = mcpToolNameForSdkMethod(name);
    const res = await bridgeFetch(
      `${baseUrl}/api/mcp-bridge`,
      {
        method: "POST",
        headers: headers(config),
        body: JSON.stringify({ tool: mcpToolName, args: args ?? {} }),
      },
      bridgeSafety(isReadOnlyBridgeCall(name, "POST"), false),
      options.signal,
    );
    const data = await readScriptSdkJsonResponse(res, `ctx.swarm.${name}`);
    if (!res.ok && options.throwOnError) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `api failed with ${res.status}`;
      throw new Error(`swarm-sdk: ${name} failed with ${res.status}: ${message}`);
    }
    // The bridge answers 200 with the tool's structuredContent, whose registrar
    // envelope always carries `success: ok` (data cannot override it). A tool
    // refusal (toolErr) is therefore HTTP 200 with `data.success === false`;
    // fold it into the outer flag so scripts gating on `.success` see it, and
    // mirror the refusal text so helpers that read the first failing layer's
    // `message` keep the tool's reason.
    const envelope =
      data !== null && typeof data === "object"
        ? (data as { success?: unknown; message?: unknown })
        : undefined;
    const toolRefused = envelope?.success === false;
    const refusalMessage = toolRefused ? envelope?.message : undefined;
    return scrubObject({
      success: res.ok && !toolRefused,
      status: res.status,
      data,
      ...(typeof refusalMessage === "string" ? { message: refusalMessage } : {}),
    });
  }

  const res = await bridgeFetch(
    `${baseUrl}${request.path}`,
    {
      method: request.method,
      headers: { ...headers(config), ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    },
    bridgeSafety(isReadOnlyBridgeCall(name, request.method), hasIdempotencyKey(request.headers)),
    options.signal,
  );
  const data = await readScriptSdkJsonResponse(res, `ctx.swarm.${name}`);
  if (!res.ok && options.throwOnError) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `api failed with ${res.status}`;
    throw new Error(`swarm-sdk: ${name} failed with ${res.status}: ${message}`);
  }
  const result = { success: res.ok, status: res.status, data };
  return options.preserveData ? result : scrubObject(result);
}

async function callTool(
  name: string,
  args: unknown,
  config: SwarmConfig,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (!isSdkToolAllowed(name)) {
    throw new Error(
      `Tool '${name}' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent`,
    );
  }

  if (name === "script_search" || name === "script_run") {
    return callBridgeApi(name, args, config, { throwOnError: true, signal });
  }

  if (name === "kv_getOrNull") {
    const result = (await callBridgeApi(name, args, config, { signal })) as {
      success: boolean;
      status: number;
      data: unknown;
    };
    if (result.status === 404) return null;
    if (!result.success) {
      const message =
        result.data && typeof result.data === "object" && "error" in result.data
          ? String((result.data as { error: unknown }).error)
          : "api failed";
      throw new Error(`swarm-sdk: ${name} failed with ${result.status}: ${message}`);
    }
    return result.data;
  }

  return callBridgeApi(name, args, config, { signal });
}

type RoomMethods = Record<
  "get" | "change" | "reset" | "decode",
  (args?: unknown) => Promise<unknown>
>;
type RuntimeSwarmSdk = Record<string, (args?: unknown) => Promise<unknown>> & { room: RoomMethods };

/** `signal`: the run's abort signal; it stops bridge retries when the run ends. */
export function createSwarmSdk(
  config: SwarmConfig,
  options: { signal?: AbortSignal } = {},
): RuntimeSwarmSdk {
  const { signal } = options;
  const roomCall = (method: keyof RoomMethods) => async (args?: unknown) => {
    const result = (await callBridgeApi(`room_${method}`, args, config, {
      throwOnError: true,
      preserveData: true,
      signal,
    })) as { data: { room?: unknown } };
    return method === "decode" ? result.data : result.data.room;
  };
  const room: RoomMethods = {
    get: roomCall("get"),
    change: roomCall("change"),
    reset: roomCall("reset"),
    decode: roomCall("decode"),
  };
  const target: Record<string, unknown> = { room };
  return new Proxy(target, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      return (args?: unknown) => callTool(prop, args, config, signal);
    },
  }) as RuntimeSwarmSdk;
}

export type SdkNamespaceClient = Readonly<Record<string, (args?: unknown) => Promise<unknown>>>;

/**
 * One frozen client per registered namespace. `ctx.<ns>.<m>(args)` calls SDK
 * method `<ns>_<m>`, throws on a non-2xx or a tool refusal, and returns the
 * tool payload without `success` (flat `ctx.swarm.<ns>_<m>` keeps the envelope).
 */
export function createNamespaceClients(
  config: SwarmConfig,
  options: { signal?: AbortSignal; registry?: SdkNamespaceRegistry } = {},
): Readonly<Record<string, SdkNamespaceClient>> {
  const { signal, registry = SDK_NAMESPACES } = options;
  assertNamespaces(registry);
  const call = (ns: string, method: string) => async (args?: unknown) => {
    const label = `ctx.${ns}.${method}`;
    const result = (await callTool(sdkMethodForNamespace(ns, method), args, config, signal)) as {
      success: boolean;
      status: number;
      data: unknown;
    };
    const data = result.data as { success?: unknown; error?: unknown } | null;
    // A tool refusal is a 200 with `data.success === false`: unwrapToolPayload throws its message.
    if (!result.success && data?.success !== false) {
      const reason =
        data && typeof data === "object" && "error" in data ? String(data.error) : "api failed";
      throw new Error(`${label} failed with ${result.status}: ${reason}`);
    }
    return unwrapToolPayload(label, result.data);
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(registry).map(([ns, methods]) => [
        ns,
        Object.freeze(Object.fromEntries(methods.map((method) => [method, call(ns, method)]))),
      ]),
    ),
  );
}

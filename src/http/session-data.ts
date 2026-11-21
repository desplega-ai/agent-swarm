import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSessionLogs,
  getActivePricingRow,
  getAllSessionCosts,
  getAttributionByPerson,
  getDashboardCostSummary,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  getSessionLogsByTaskId,
  getTaskById,
  insertSessionCost,
  refreshActiveSessionOnActivity,
  SessionCostConflictError,
} from "../be/db";
import {
  clearToolCallIntent,
  listToolCallIntents,
  recordToolCallIntent,
} from "../be/db/tool-call-intents";
import { isScriptRunToken } from "../be/users";
import { recordSessionCost } from "../otel";
import { incrementServerSessionsProcessed } from "../server-runtime-counters";
import type { SessionCost } from "../types";
import {
  PricingProviderSchema,
  ProviderNameSchema,
  SessionCostModelBreakdownSchema,
  SessionCostSchema,
  SessionLogSchema,
  ToolCallIntentSchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { bodyTask, route } from "./route-def";
import { canReadSession, SESSION_READ_DENIED } from "./session-access";
import { recomputeSessionCost } from "./session-cost-recompute";
import { cachedUsageReport } from "./usage-cache";
import { jsonError } from "./utils";

// ─── Response Schemas ────────────────────────────────────────────────────────

/** Mirrors `SessionCostSummaryTotals` in src/be/db.ts. */
const SessionCostSummaryTotalsSchema = z.object({
  totalCostUsd: z.number(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCacheReadTokens: z.number().int(),
  totalCacheWriteTokens: z.number().int(),
  totalDurationMs: z.number().int(),
  totalSessions: z.number().int(),
  avgCostPerSession: z.number(),
  attributedCostUsd: z.number(),
  attributableCostUsd: z.number(),
  excludedCostUsd: z.number(),
  excludedTaskCount: z.number().int(),
  subscriptionCostUsd: z.number(),
  credentialUnattributedCostUsd: z.number(),
  credentialUnattributedSessions: z.number().int(),
});

/** Mirrors `SessionCostDailyRow` in src/be/db.ts. */
const SessionCostDailyRowSchema = z.object({
  date: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  sessions: z.number().int(),
  subscriptionCostUsd: z.number(),
  credentialUnattributedCostUsd: z.number(),
  credentialUnattributedSessions: z.number().int(),
});

/** Mirrors `SessionCostByAgentRow` in src/be/db.ts. */
const SessionCostByAgentRowSchema = z.object({
  agentId: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  sessions: z.number().int(),
  durationMs: z.number().int(),
});

/** Mirrors `SessionCostByUserRow` in src/be/db.ts. */
const SessionCostByUserRowSchema = z.object({
  userId: z.string().nullable(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  tasks: z.number().int(),
  durationMs: z.number().int(),
});

/** Mirrors `SessionCostByCredentialRow` in src/be/db.ts. */
const SessionCostByCredentialRowSchema = z.object({
  keyType: z.string().nullable(),
  keySuffix: z.string().nullable(),
  name: z.string().nullable(),
  subscription: z.boolean(),
  plan: z.string().nullable(),
  planSource: z.enum(["manual", "detected", "estimated"]).nullable(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  sessions: z.number().int(),
  firstSessionAt: z.string(),
  lastSessionAt: z.string(),
});

/** Mirrors the return type of `getSessionCostSummary` in src/be/db.ts. */
const SessionCostSummarySchema = z.object({
  totals: SessionCostSummaryTotalsSchema,
  daily: z.array(SessionCostDailyRowSchema),
  byAgent: z.array(SessionCostByAgentRowSchema),
  byUser: z.array(SessionCostByUserRowSchema),
  /** Filled for `groupBy=both` only. */
  byCredential: z.array(SessionCostByCredentialRowSchema),
});

/** Mirrors `DashboardCostSummary` in src/be/db.ts. */
const DashboardCostSummarySchema = z.object({
  costToday: z.number(),
  costMtd: z.number(),
});

/** Mirrors `AttributionByPersonRow` in src/be/db.ts. */
const AttributionByPersonRowSchema = z.object({
  userId: z.string(),
  problemsInitiated: z.number().int(),
  problemsShipped: z.number().int(),
  agentsReached: z.number().int(),
  reposReached: z.number().int(),
  surfacesReached: z.number().int(),
  firstPassYield: z.null(),
});

// ─── Route Definitions ───────────────────────────────────────────────────────

const createSessionLogsRoute = route({
  method: "post",
  path: "/api/session-logs",
  pattern: ["api", "session-logs"],
  session: bodyTask("taskId"),
  summary: "Store session logs",
  tags: ["Session Data"],
  body: z.object({
    sessionId: z.string().min(1),
    iteration: z.number().int().min(1),
    lines: z.array(z.string()).min(1),
    taskId: z.string().optional(),
    cli: z.string().optional(),
  }),
  responses: {
    201: {
      description: "Logs stored",
      schema: z.object({ success: z.literal(true), count: z.number().int().nonnegative() }),
    },
    400: { description: "Validation error" },
  },
  rbac: { ungated: "worker telemetry ingest; no user flow writes it" },
});

const getSessionLogsByTask = route({
  method: "get",
  path: "/api/tasks/{taskId}/session-logs",
  pattern: ["api", "tasks", null, "session-logs"],
  session: { taskParam: "taskId" },
  summary: "Get session logs for a task",
  tags: ["Session Data"],
  params: z.object({ taskId: z.string() }),
  query: z.object({
    // When set, returns the last N log rows ordered ASC. Used by the
    // resume context preamble to avoid pulling the full log set over HTTP
    // just to slice the tail. Server-side limit prevents OOM / slow
    // dispatch for tasks with very long run history (PR #594 review).
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: {
      description: "Session logs",
      schema: z.object({ logs: z.array(SessionLogSchema) }),
    },
    404: { description: "Task not found" },
  },
});

const TOOL_INTENT_UNGATED =
  "Worker hook write: the session posture gates users; the handler admits only the task's own agent or the operator key.";

const recordToolIntentRoute = route({
  method: "post",
  path: "/api/tasks/{taskId}/tool-intents",
  pattern: ["api", "tasks", null, "tool-intents"],
  session: { taskParam: "taskId" },
  rbac: { ungated: TOOL_INTENT_UNGATED },
  summary: "Record a side-effecting tool call before it runs",
  tags: ["Session Data"],
  params: z.object({ taskId: z.string() }),
  body: z.object({
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200),
    argsSummary: z.string().max(4000).optional(),
  }),
  responses: {
    201: { description: "Intent recorded", schema: z.object({ intent: ToolCallIntentSchema }) },
    403: { description: "The task belongs to another agent" },
    404: { description: "Task not found" },
  },
});

const clearToolIntentRoute = route({
  method: "delete",
  path: "/api/tasks/{taskId}/tool-intents/{toolCallId}",
  pattern: ["api", "tasks", null, "tool-intents", null],
  session: { taskParam: "taskId" },
  rbac: { ungated: TOOL_INTENT_UNGATED },
  summary: "Clear the intent of a tool call that finished",
  tags: ["Session Data"],
  params: z.object({ taskId: z.string(), toolCallId: z.string() }),
  responses: {
    200: { description: "Intent cleared", schema: z.object({ deleted: z.boolean() }) },
    403: { description: "The task belongs to another agent" },
    404: { description: "Task not found" },
  },
});

const listToolIntentsRoute = route({
  method: "get",
  path: "/api/tasks/{taskId}/tool-intents",
  pattern: ["api", "tasks", null, "tool-intents"],
  session: { taskParam: "taskId" },
  summary: "List side-effecting tool calls that started and never finished",
  tags: ["Session Data"],
  params: z.object({ taskId: z.string() }),
  responses: {
    200: {
      description: "Open tool call intents, oldest first",
      schema: z.object({ intents: z.array(ToolCallIntentSchema) }),
    },
    404: { description: "Task not found" },
  },
});

const createSessionCostRoute = route({
  method: "post",
  path: "/api/session-costs",
  pattern: ["api", "session-costs"],
  session: bodyTask("taskId"),
  summary: "Store session cost record",
  tags: ["Session Data"],
  body: z.object({
    id: z.string().uuid().optional(),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    credentialKeyType: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable()
      .optional(),
    credentialKeySuffix: z.string().min(1).max(10).nullable().optional(),
    harness: ProviderNameSchema.nullable().optional(),
    totalCostUsd: z.number(),
    // The adapter's totalCostUsd is the provider's bill (e.g. OpenRouter's
    // `usage.cost`), so it wins over the pricing table.
    harnessCostBilled: z.boolean().optional(),
    // Token counts summed from per-message usage; the priced row is tagged `estimated`.
    estimated: z.boolean().optional(),
    taskId: z.string().optional(),
    // Phase 3: non-negative — the recompute no longer clamps, so negative
    // token counts must be rejected at the wire instead of pricing below $0.
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
    // Migration 063: nullable — adapters that can't honestly report cache writes
    // (e.g. Codex SDK) prefer null over a faked 0.
    cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
    // Same nullable rationale as cacheWriteTokens: adapters that can't report
    // the TTL split send null/omit rather than a faked 0.
    cacheWrite5mTokens: z.number().int().nonnegative().nullable().optional(),
    cacheWrite1hTokens: z.number().int().nonnegative().nullable().optional(),
    // Migration 063: new token classes previously dropped on the floor.
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    thinkingTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().optional(),
    // Migration 063: nullable for adapters that can't honestly report numTurns.
    numTurns: z.number().int().nullable().optional(),
    model: z.string().optional(),
    // Reuses the canonical breakdown schema minus costUsd (server-computed,
    // never accepted from the wire).
    models: z.array(SessionCostModelBreakdownSchema.omit({ costUsd: true })).optional(),
    isError: z.boolean().optional(),
    /**
     * Phase 6 (extended migration 063): drives the API recompute path. After
     * Phase 2 every provider with seeded pricing rows participates.
     */
    // `acp` has no seeded pricing rows by design — a generic ACP target owns
    // its own billing and the adapter reports `totalCostUsd: 0`, so the row
    // lands as `costSource: 'unpriced'`. It still has to be accepted here or
    // every ACP session's cost POST 400s and the row is silently dropped.
    // Reuses PricingProviderSchema so this list can't drift from it again
    // (#1636: it previously forgot `dsh`).
    provider: PricingProviderSchema.optional(),
    /**
     * Phase 6: epoch-ms timestamp used as the "active price at time T" lookup
     * basis. Defaults to `Date.now()` when omitted. Including it lets
     * historical recomputes pick the correct `effective_from` row.
     */
    createdAt: z.number().int().nonnegative().optional(),
  }),
  responses: {
    201: {
      description: "Cost record stored",
      schema: z.object({ success: z.literal(true), cost: SessionCostSchema }),
    },
    400: { description: "Validation error" },
    403: { description: "Untrusted session attribution" },
    409: { description: "Session identity conflict" },
  },
  rbac: { ungated: "worker telemetry ingest; no user flow writes it" },
});

const getSessionCostSummaryRoute = route({
  method: "get",
  path: "/api/session-costs/summary",
  pattern: ["api", "session-costs", "summary"],
  summary: "Aggregated session cost summary",
  tags: ["Session Data"],
  query: z.object({
    groupBy: z.enum(["day", "agent", "both", "user"]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    agentId: z.string().optional(),
    /** A user id, or `unattributed` for spend with no human requester. */
    userId: z.string().optional(),
  }),
  responses: {
    200: { description: "Cost summary", schema: SessionCostSummarySchema },
    400: { description: "Invalid groupBy" },
  },
});

const getAttributionByPersonRoute = route({
  method: "get",
  path: "/api/attribution/by-person",
  pattern: ["api", "attribution", "by-person"],
  summary: "Four-metric per-person attribution (problems initiated/shipped, reach)",
  tags: ["Session Data"],
  query: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Per-person attribution rows",
      schema: z.object({ rows: z.array(AttributionByPersonRowSchema) }),
    },
  },
});

const getDashboardCosts = route({
  method: "get",
  path: "/api/session-costs/dashboard",
  pattern: ["api", "session-costs", "dashboard"],
  summary: "Cost today and month-to-date for dashboard",
  tags: ["Session Data"],
  responses: {
    200: { description: "Dashboard cost data", schema: DashboardCostSummarySchema },
  },
});

const listSessionCosts = route({
  method: "get",
  path: "/api/session-costs",
  pattern: ["api", "session-costs"],
  summary: "Query session costs with filters",
  tags: ["Session Data"],
  query: z.object({
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    limit: z.coerce.number().int().min(1).optional(),
  }),
  responses: {
    200: {
      description: "Session costs",
      schema: z.object({ costs: z.array(SessionCostSchema) }),
    },
  },
});

/** The task a tool-intent write names, when the caller is its agent or the operator; else answers. */
async function ownTaskForToolIntent(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  myAgentId: string | undefined,
) {
  const task = await getTaskById(taskId);
  if (!task) {
    jsonError(res, "Task not found", 404);
    return null;
  }
  const auth = getRequestAuth(req);
  const callerAgentId = auth?.kind === "agent" ? auth.agentId : myAgentId;
  const admitted =
    (auth?.kind === "agent" || auth?.kind === "operator") &&
    (callerAgentId === undefined ? auth.kind === "operator" : callerAgentId === task.agentId);
  if (!admitted) {
    jsonError(res, "Only the task's own agent records its tool calls.", 403);
    return null;
  }
  return task;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSessionData(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (createSessionLogsRoute.match(req.method, pathSegments)) {
    const parsed = await createSessionLogsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      await createSessionLogs({
        taskId: parsed.body.taskId || undefined,
        sessionId: parsed.body.sessionId,
        iteration: parsed.body.iteration,
        cli: parsed.body.cli || "claude",
        lines: parsed.body.lines,
      });
      // Every harness streams its output through this endpoint, so a task that
      // is producing output keeps its session alive here instead of per
      // provider. Best-effort: a liveness write must never fail log storage.
      if (parsed.body.taskId) {
        try {
          await refreshActiveSessionOnActivity(parsed.body.taskId);
        } catch (error) {
          console.warn("[HTTP] Failed to refresh session liveness from session logs:", error);
        }
      }
      createSessionLogsRoute.respond(res, 201, {
        success: true,
        count: parsed.body.lines.length,
      });
    } catch (error) {
      console.error("[HTTP] Failed to create session logs:", error);
      jsonError(res, "Failed to store session logs", 500);
    }
    return true;
  }

  if (getSessionLogsByTask.match(req.method, pathSegments)) {
    const parsed = await getSessionLogsByTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.taskId);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    if (!(await canReadSession(req, myAgentId, task.id))) {
      jsonError(res, SESSION_READ_DENIED, 403);
      return true;
    }
    const logs = await getSessionLogsByTaskId(parsed.params.taskId, parsed.query?.limit);
    getSessionLogsByTask.respond(res, 200, { logs });
    return true;
  }

  if (recordToolIntentRoute.match(req.method, pathSegments)) {
    const parsed = await recordToolIntentRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await ownTaskForToolIntent(req, res, parsed.params.taskId, myAgentId);
    if (!task) return true;
    const intent = await recordToolCallIntent({
      taskId: task.id,
      agentId: task.agentId ?? null,
      toolCallId: parsed.body.toolCallId,
      toolName: parsed.body.toolName,
      argsSummary: parsed.body.argsSummary,
    });
    recordToolIntentRoute.respond(res, 201, { intent });
    return true;
  }

  if (clearToolIntentRoute.match(req.method, pathSegments)) {
    const parsed = await clearToolIntentRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await ownTaskForToolIntent(req, res, parsed.params.taskId, myAgentId);
    if (!task) return true;
    const deleted = await clearToolCallIntent(task.id, parsed.params.toolCallId);
    clearToolIntentRoute.respond(res, 200, { deleted });
    return true;
  }

  if (listToolIntentsRoute.match(req.method, pathSegments)) {
    const parsed = await listToolIntentsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.taskId);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    if (!(await canReadSession(req, myAgentId, task.id))) {
      jsonError(res, SESSION_READ_DENIED, 403);
      return true;
    }
    listToolIntentsRoute.respond(res, 200, { intents: await listToolCallIntents(task.id) });
    return true;
  }

  if (createSessionCostRoute.match(req.method, pathSegments)) {
    const parsed = await createSessionCostRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const auth = getRequestAuth(req);
    const trustedWorker =
      !auth?.page &&
      (auth?.kind === "operator" ||
        (auth?.kind === "agent" &&
          (auth.tokenKind === "runtime" ||
            (auth.tokenKind === "agent" && !(await isScriptRunToken(auth.tokenId)))) &&
          auth.agentId === parsed.body.agentId));
    const hasAttribution =
      parsed.body.credentialKeyType != null ||
      parsed.body.credentialKeySuffix != null ||
      parsed.body.harness != null;
    if (hasAttribution && !trustedWorker) {
      jsonError(res, "Session attribution requires a worker or operator credential.", 403);
      return true;
    }
    if (auth?.kind === "agent" && auth.agentId !== parsed.body.agentId) {
      jsonError(res, "Session cost agent does not match the authenticated agent.", 403);
      return true;
    }
    if ((parsed.body.credentialKeyType != null) !== (parsed.body.credentialKeySuffix != null)) {
      jsonError(res, "Session credential type and suffix must be supplied together.", 400);
      return true;
    }
    try {
      const inputTokens = parsed.body.inputTokens ?? 0;
      const cachedInputTokens = parsed.body.cacheReadTokens ?? 0;
      const cacheWriteTokens = parsed.body.cacheWriteTokens ?? 0;
      const outputTokens = parsed.body.outputTokens ?? 0;
      // Phase 2: don't paper over a missing model with a fake default — that
      // poisoned the pricing-table lookup against the wrong rate. Only the
      // back-compat case (no provider tag) keeps "opus" so old callers don't
      // explode.
      const model = parsed.body.model || (parsed.body.provider ? "" : "opus");

      // Phase 3: when a per-model breakdown is present, the row's token totals
      // come from it — the top-level usage block covers the main thread only
      // (claude sidechain/subagent tokens live exclusively in models[]).
      const bodyModels = parsed.body.models?.length ? parsed.body.models : null;
      const rowInputTokens = bodyModels
        ? bodyModels.reduce((sum, m) => sum + m.inputTokens, 0)
        : inputTokens;
      const rowOutputTokens = bodyModels
        ? bodyModels.reduce((sum, m) => sum + m.outputTokens, 0)
        : outputTokens;
      const rowCacheReadTokens = bodyModels
        ? bodyModels.reduce((sum, m) => sum + m.cacheReadTokens, 0)
        : (parsed.body.cacheReadTokens ?? null);
      const rowCacheWriteTokens = bodyModels
        ? bodyModels.reduce((sum, m) => sum + m.cacheWriteTokens, 0)
        : (parsed.body.cacheWriteTokens ?? null);

      // Keep the adapter's report even when the pricing-table branch replaces
      // totalCostUsd with the server's canonical recomputation. Harnesses that
      // report tokens but no money (dsh, acp) post 0; storing that as their
      // cost would make every recomputed row read as a 100% drift.
      const harnessCostUsd = parsed.body.totalCostUsd > 0 ? parsed.body.totalCostUsd : null;
      const recomputed = await recomputeSessionCost(
        {
          provider: parsed.body.provider,
          model,
          harnessCostUsd: parsed.body.totalCostUsd,
          harnessCostBilled: parsed.body.harnessCostBilled,
          estimated: parsed.body.estimated,
          inputTokens,
          outputTokens,
          cacheReadTokens: cachedInputTokens,
          cacheWriteTokens,
          cacheWrite5mTokens: parsed.body.cacheWrite5mTokens,
          cacheWrite1hTokens: parsed.body.cacheWrite1hTokens,
          models: parsed.body.models,
          durationMs: parsed.body.durationMs,
          atEpochMs: parsed.body.createdAt ?? Date.now(),
        },
        async (provider, lookupModel, tokenClass, atEpochMs) =>
          (await getActivePricingRow(provider, lookupModel, tokenClass, atEpochMs))
            ?.pricePerMillionUsd ?? null,
      );
      const { totalCostUsd, costSource } = recomputed;

      const { cost, created } = await insertSessionCost({
        credentialKeyType: parsed.body.credentialKeyType,
        credentialKeySuffix: parsed.body.credentialKeySuffix,
        harness: parsed.body.harness,
        id: parsed.body.id,
        sessionId: parsed.body.sessionId,
        taskId: parsed.body.taskId || undefined,
        agentId: parsed.body.agentId,
        totalCostUsd,
        inputTokens: rowInputTokens,
        outputTokens: rowOutputTokens,
        cacheReadTokens: rowCacheReadTokens,
        cacheWriteTokens: rowCacheWriteTokens,
        reasoningOutputTokens: parsed.body.reasoningOutputTokens ?? 0,
        thinkingTokens: parsed.body.thinkingTokens ?? 0,
        durationMs: parsed.body.durationMs ?? 0,
        // Migration 063: pass null through honestly instead of faking a 1.
        numTurns: parsed.body.numTurns ?? null,
        model,
        isError: parsed.body.isError ?? false,
        costSource,
        harnessCostUsd,
        cacheWrite5mTokens: parsed.body.cacheWrite5mTokens,
        cacheWrite1hTokens: parsed.body.cacheWrite1hTokens,
        modelBreakdown: recomputed.modelBreakdown,
      });
      if (created) {
        recordSessionCost({
          totalCostUsd,
          harnessCostUsd: harnessCostUsd ?? undefined,
          harness: parsed.body.provider ?? "unknown",
          model,
          costSource,
          isError: parsed.body.isError ?? false,
          tokens: {
            input: rowInputTokens,
            output: rowOutputTokens,
            cacheRead: rowCacheReadTokens ?? 0,
            cacheWrite: rowCacheWriteTokens ?? 0,
            reasoning: parsed.body.reasoningOutputTokens ?? 0,
            thinking: parsed.body.thinkingTokens ?? 0,
          },
        });
        incrementServerSessionsProcessed();
      }
      createSessionCostRoute.respond(res, 201, { success: true, cost });
    } catch (error) {
      if (error instanceof SessionCostConflictError) {
        jsonError(res, error.message, 409);
        return true;
      }
      console.error("[HTTP] Failed to create session cost:", scrubSecrets(String(error)));
      jsonError(res, "Failed to store session cost", 500);
    }
    return true;
  }

  if (getSessionCostSummaryRoute.match(req.method, pathSegments)) {
    const parsed = await getSessionCostSummaryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const opts = {
      startDate: parsed.query.startDate || undefined,
      endDate: parsed.query.endDate || undefined,
      agentId: parsed.query.agentId || undefined,
      userId: parsed.query.userId || undefined,
      groupBy: parsed.query.groupBy || "both",
    } as const;
    const summary = await cachedUsageReport(`summary:${JSON.stringify(opts)}`, () =>
      getSessionCostSummary(opts),
    );
    getSessionCostSummaryRoute.respond(res, 200, summary);
    return true;
  }

  if (getDashboardCosts.match(req.method, pathSegments)) {
    const dashboardCosts = await getDashboardCostSummary();
    getDashboardCosts.respond(res, 200, dashboardCosts);
    return true;
  }

  if (getAttributionByPersonRoute.match(req.method, pathSegments)) {
    const parsed = await getAttributionByPersonRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const opts = {
      startDate: parsed.query.startDate || undefined,
      endDate: parsed.query.endDate || undefined,
    };
    const rows = await cachedUsageReport(`attribution:${JSON.stringify(opts)}`, () =>
      getAttributionByPerson(opts),
    );
    getAttributionByPersonRoute.respond(res, 200, { rows });
    return true;
  }

  if (listSessionCosts.match(req.method, pathSegments)) {
    const parsed = await listSessionCosts.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const { agentId, taskId, startDate, endDate } = parsed.query;

    let costs: SessionCost[];
    if (taskId) {
      costs = await getSessionCostsByTaskId(taskId, limit);
    } else if (startDate || endDate) {
      costs = await getSessionCostsFiltered({
        agentId: agentId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit,
      });
    } else if (agentId) {
      costs = await getSessionCostsByAgentId(agentId, limit);
    } else {
      costs = await getAllSessionCosts(limit);
    }

    listSessionCosts.respond(res, 200, { costs });
    return true;
  }

  return false;
}

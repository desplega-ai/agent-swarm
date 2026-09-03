import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSessionCost,
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
} from "../be/db";
import { recordSessionCost } from "../otel";
import { incrementServerSessionsProcessed } from "../server-runtime-counters";
import type { SessionCost } from "../types";
import { SessionCostModelBreakdownSchema, SessionCostSchema, SessionLogSchema } from "../types";
import { route } from "./route-def";
import { recomputeSessionCost } from "./session-cost-recompute";
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
});

/** Mirrors `SessionCostDailyRow` in src/be/db.ts. */
const SessionCostDailyRowSchema = z.object({
  date: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  sessions: z.number().int(),
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

/** Mirrors the return type of `getSessionCostSummary` in src/be/db.ts. */
const SessionCostSummarySchema = z.object({
  totals: SessionCostSummaryTotalsSchema,
  daily: z.array(SessionCostDailyRowSchema),
  byAgent: z.array(SessionCostByAgentRowSchema),
  byUser: z.array(SessionCostByUserRowSchema),
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
});

const getSessionLogsByTask = route({
  method: "get",
  path: "/api/tasks/{taskId}/session-logs",
  pattern: ["api", "tasks", null, "session-logs"],
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

const createSessionCostRoute = route({
  method: "post",
  path: "/api/session-costs",
  pattern: ["api", "session-costs"],
  summary: "Store session cost record",
  tags: ["Session Data"],
  body: z.object({
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    totalCostUsd: z.number(),
    taskId: z.string().optional(),
    // Phase 3: non-negative — the recompute no longer clamps, so negative
    // token counts must be rejected at the wire instead of pricing below $0.
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
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
    provider: z
      .enum(["claude", "claude-managed", "codex", "pi", "opencode", "devin", "gemini", "acp"])
      .optional(),
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
  },
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSessionData(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
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
    const logs = await getSessionLogsByTaskId(parsed.params.taskId, parsed.query?.limit);
    getSessionLogsByTask.respond(res, 200, { logs });
    return true;
  }

  if (createSessionCostRoute.match(req.method, pathSegments)) {
    const parsed = await createSessionCostRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

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
        : cachedInputTokens;
      const rowCacheWriteTokens = bodyModels
        ? bodyModels.reduce((sum, m) => sum + m.cacheWriteTokens, 0)
        : (parsed.body.cacheWriteTokens ?? 0);

      // Keep the adapter's report even when the pricing-table branch replaces
      // totalCostUsd with the server's canonical recomputation.
      const harnessCostUsd = parsed.body.totalCostUsd;
      const recomputed = await recomputeSessionCost(
        {
          provider: parsed.body.provider,
          model,
          harnessCostUsd,
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

      const cost = await createSessionCost({
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
      recordSessionCost({
        totalCostUsd,
        harnessCostUsd,
        harness: parsed.body.provider ?? "unknown",
        model,
        costSource,
        isError: parsed.body.isError ?? false,
        tokens: {
          input: rowInputTokens,
          output: rowOutputTokens,
          cacheRead: rowCacheReadTokens,
          cacheWrite: rowCacheWriteTokens,
          reasoning: parsed.body.reasoningOutputTokens ?? 0,
          thinking: parsed.body.thinkingTokens ?? 0,
        },
      });
      incrementServerSessionsProcessed();
      createSessionCostRoute.respond(res, 201, { success: true, cost });
    } catch (error) {
      console.error("[HTTP] Failed to create session cost:", error);
      jsonError(res, "Failed to store session cost", 500);
    }
    return true;
  }

  if (getSessionCostSummaryRoute.match(req.method, pathSegments)) {
    const parsed = await getSessionCostSummaryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const summary = await getSessionCostSummary({
      startDate: parsed.query.startDate || undefined,
      endDate: parsed.query.endDate || undefined,
      agentId: parsed.query.agentId || undefined,
      userId: parsed.query.userId || undefined,
      groupBy: parsed.query.groupBy || "both",
    });
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
    const rows = await getAttributionByPerson({
      startDate: parsed.query.startDate || undefined,
      endDate: parsed.query.endDate || undefined,
    });
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

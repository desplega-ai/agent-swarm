import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSessionCost,
  createSessionLogs,
  getActivePricingRow,
  getAllSessionCosts,
  getDashboardCostSummary,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  getSessionLogsByTaskId,
  getTaskById,
} from "../be/db";
import type { SessionCost, SessionCostSource } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

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
    201: { description: "Logs stored" },
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
  responses: {
    200: { description: "Session logs" },
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
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    cacheReadTokens: z.number().int().optional(),
    cacheWriteTokens: z.number().int().optional(),
    durationMs: z.number().int().optional(),
    numTurns: z.number().int().optional(),
    model: z.string().optional(),
    isError: z.boolean().optional(),
    /**
     * Phase 6: when present, drives the codex pricing-table recompute path.
     * Other providers ('claude' / 'pi') always trust harness-reported USD.
     * Optional / undefined keeps back-compat for existing callers.
     */
    provider: z.enum(["claude", "codex", "pi"]).optional(),
    /**
     * Phase 6: epoch-ms timestamp used as the "active price at time T" lookup
     * basis. Defaults to `Date.now()` when omitted. Including it lets
     * historical recomputes pick the correct `effective_from` row.
     */
    createdAt: z.number().int().nonnegative().optional(),
  }),
  responses: {
    201: { description: "Cost record stored" },
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
    groupBy: z.enum(["day", "agent", "both"]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    agentId: z.string().optional(),
  }),
  responses: {
    200: { description: "Cost summary" },
    400: { description: "Invalid groupBy" },
  },
});

const getDashboardCosts = route({
  method: "get",
  path: "/api/session-costs/dashboard",
  pattern: ["api", "session-costs", "dashboard"],
  summary: "Cost today and month-to-date for dashboard",
  tags: ["Session Data"],
  responses: {
    200: { description: "Dashboard cost data" },
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
    200: { description: "Session costs" },
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
      createSessionLogs({
        taskId: parsed.body.taskId || undefined,
        sessionId: parsed.body.sessionId,
        iteration: parsed.body.iteration,
        cli: parsed.body.cli || "claude",
        lines: parsed.body.lines,
      });
      json(res, { success: true, count: parsed.body.lines.length }, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create session logs:", error);
      jsonError(res, "Failed to store session logs", 500);
    }
    return true;
  }

  if (getSessionLogsByTask.match(req.method, pathSegments)) {
    const parsed = await getSessionLogsByTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.taskId);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    const logs = getSessionLogsByTaskId(parsed.params.taskId);
    json(res, { logs });
    return true;
  }

  if (createSessionCostRoute.match(req.method, pathSegments)) {
    const parsed = await createSessionCostRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const inputTokens = parsed.body.inputTokens ?? 0;
      const cachedInputTokens = parsed.body.cacheReadTokens ?? 0;
      const outputTokens = parsed.body.outputTokens ?? 0;
      const model = parsed.body.model || "opus";

      // Phase 6: Codex USD recompute. When the worker reports `provider='codex'`
      // and DB pricing rows exist for ALL three token classes at the lookup
      // time, recompute `totalCostUsd` from tokens × DB prices and tag the
      // row as 'pricing-table'. If any class has no row, fall back to the
      // worker-reported value with `costSource='harness'` (back-compat for
      // unseeded models). Claude / pi paths always use 'harness'.
      let totalCostUsd = parsed.body.totalCostUsd;
      let costSource: SessionCostSource = "harness";

      if (parsed.body.provider === "codex") {
        const lookupTime = parsed.body.createdAt ?? Date.now();
        const inputRow = getActivePricingRow("codex", model, "input", lookupTime);
        const cachedRow = getActivePricingRow("codex", model, "cached_input", lookupTime);
        const outputRow = getActivePricingRow("codex", model, "output", lookupTime);

        if (inputRow && cachedRow && outputRow) {
          // Mirror the existing computeCodexCostUsd logic: subtract cached
          // tokens from input before billing the uncached portion at the full
          // rate (Codex SDK reports input_tokens as TOTAL across the turn).
          const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
          totalCostUsd =
            (uncachedInputTokens * inputRow.pricePerMillionUsd +
              cachedInputTokens * cachedRow.pricePerMillionUsd +
              outputTokens * outputRow.pricePerMillionUsd) /
            1_000_000;
          costSource = "pricing-table";
        }
      }

      const cost = createSessionCost({
        sessionId: parsed.body.sessionId,
        taskId: parsed.body.taskId || undefined,
        agentId: parsed.body.agentId,
        totalCostUsd,
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedInputTokens,
        cacheWriteTokens: parsed.body.cacheWriteTokens ?? 0,
        durationMs: parsed.body.durationMs ?? 0,
        numTurns: parsed.body.numTurns ?? 1,
        model,
        isError: parsed.body.isError ?? false,
        costSource,
      });
      json(res, { success: true, cost }, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create session cost:", error);
      jsonError(res, "Failed to store session cost", 500);
    }
    return true;
  }

  if (getSessionCostSummaryRoute.match(req.method, pathSegments)) {
    const parsed = await getSessionCostSummaryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const summary = getSessionCostSummary({
      startDate: parsed.query.startDate || undefined,
      endDate: parsed.query.endDate || undefined,
      agentId: parsed.query.agentId || undefined,
      groupBy: parsed.query.groupBy || "both",
    });
    json(res, summary);
    return true;
  }

  if (getDashboardCosts.match(req.method, pathSegments)) {
    const dashboardCosts = getDashboardCostSummary();
    json(res, dashboardCosts);
    return true;
  }

  if (listSessionCosts.match(req.method, pathSegments)) {
    const parsed = await listSessionCosts.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const { agentId, taskId, startDate, endDate } = parsed.query;

    let costs: SessionCost[];
    if (taskId) {
      costs = getSessionCostsByTaskId(taskId, limit);
    } else if (startDate || endDate) {
      costs = getSessionCostsFiltered({
        agentId: agentId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit,
      });
    } else if (agentId) {
      costs = getSessionCostsByAgentId(agentId, limit);
    } else {
      costs = getAllSessionCosts(limit);
    }

    json(res, { costs });
    return true;
  }

  return false;
}

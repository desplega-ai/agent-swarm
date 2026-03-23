import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSessionCost,
  createSessionLogs,
  getAllSessionCosts,
  getDashboardCostSummary,
  getDb,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  getSessionLogsByTaskId,
  getTaskById,
} from "../be/db";
import type { SessionCost } from "../types";
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
      // For pool tasks: check if logs for this session were already reassociated
      // to a real task ID. If so, use the real taskId instead of the random UUID.
      let effectiveTaskId = parsed.body.taskId || undefined;
      if (effectiveTaskId && parsed.body.sessionId) {
        const existing = getDb()
          .prepare<{ taskId: string }, [string, string]>(
            "SELECT taskId FROM session_logs WHERE sessionId = ? AND taskId != ? LIMIT 1",
          )
          .get(parsed.body.sessionId, effectiveTaskId);
        if (existing?.taskId) {
          effectiveTaskId = existing.taskId;
        }
      }

      createSessionLogs({
        taskId: effectiveTaskId,
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
      const cost = createSessionCost({
        sessionId: parsed.body.sessionId,
        taskId: parsed.body.taskId || undefined,
        agentId: parsed.body.agentId,
        totalCostUsd: parsed.body.totalCostUsd,
        inputTokens: parsed.body.inputTokens ?? 0,
        outputTokens: parsed.body.outputTokens ?? 0,
        cacheReadTokens: parsed.body.cacheReadTokens ?? 0,
        cacheWriteTokens: parsed.body.cacheWriteTokens ?? 0,
        durationMs: parsed.body.durationMs ?? 0,
        numTurns: parsed.body.numTurns ?? 1,
        model: parsed.body.model || "opus",
        isError: parsed.body.isError ?? false,
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

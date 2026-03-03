import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createSessionCost,
  createSessionLogs,
  getAllSessionCosts,
  getDashboardCostSummary,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  getSessionLogsByTaskId,
  getTaskById,
} from "../be/db";
import type { SessionCost } from "../types";
import { parseQueryParams } from "./utils";

export async function handleSessionData(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (req.method === "POST" && pathSegments[0] === "api" && pathSegments[1] === "session-logs") {
    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate required fields
    if (!body.sessionId || typeof body.sessionId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'sessionId' field" }));
      return true;

    }

    if (typeof body.iteration !== "number" || body.iteration < 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'iteration' field" }));
      return true;

    }

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'lines' array" }));
      return true;

    }

    try {
      createSessionLogs({
        taskId: body.taskId || undefined,
        sessionId: body.sessionId,
        iteration: body.iteration,
        cli: body.cli || "claude",
        lines: body.lines,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, count: body.lines.length }));
    } catch (error) {
      console.error("[HTTP] Failed to create session logs:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to store session logs" }));
    }
    return true;

  }

  // GET /api/tasks/:id/session-logs - Get session logs for a task
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "session-logs"
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return true;

    }

    const logs = getSessionLogsByTaskId(taskId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs }));
    return true;

  }

  // POST /api/session-costs - Store session cost record
  if (req.method === "POST" && pathSegments[0] === "api" && pathSegments[1] === "session-costs") {
    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate required fields
    if (!body.sessionId || typeof body.sessionId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'sessionId' field" }));
      return true;

    }

    if (!body.agentId || typeof body.agentId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'agentId' field" }));
      return true;

    }

    if (typeof body.totalCostUsd !== "number") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'totalCostUsd' field" }));
      return true;

    }

    try {
      const cost = createSessionCost({
        sessionId: body.sessionId,
        taskId: body.taskId || undefined,
        agentId: body.agentId,
        totalCostUsd: body.totalCostUsd,
        inputTokens: body.inputTokens ?? 0,
        outputTokens: body.outputTokens ?? 0,
        cacheReadTokens: body.cacheReadTokens ?? 0,
        cacheWriteTokens: body.cacheWriteTokens ?? 0,
        durationMs: body.durationMs ?? 0,
        numTurns: body.numTurns ?? 1,
        model: body.model || "opus",
        isError: body.isError ?? false,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, cost }));
    } catch (error) {
      console.error("[HTTP] Failed to create session cost:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to store session cost" }));
    }
    return true;

  }

  // GET /api/session-costs/summary - Aggregated session cost summary
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    pathSegments[2] === "summary"
  ) {
    const summaryParams = parseQueryParams(req.url || "");
    const rawGroupBy = summaryParams.get("groupBy");
    const validGroupBy = ["day", "agent", "both"] as const;
    if (rawGroupBy && !validGroupBy.includes(rawGroupBy as (typeof validGroupBy)[number])) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Invalid groupBy value '${rawGroupBy}'. Must be one of: ${validGroupBy.join(", ")}`,
        }),
      );
      return true;

    }
    const summary = getSessionCostSummary({
      startDate: summaryParams.get("startDate") || undefined,
      endDate: summaryParams.get("endDate") || undefined,
      agentId: summaryParams.get("agentId") || undefined,
      groupBy: (rawGroupBy as "day" | "agent" | "both") || "both",
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summary));
    return true;

  }

  // GET /api/session-costs/dashboard - Cost today and month-to-date
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    pathSegments[2] === "dashboard"
  ) {
    const dashboardCosts = getDashboardCostSummary();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dashboardCosts));
    return true;

  }

  // GET /api/session-costs - Query session costs with filters
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    !pathSegments[2]
  ) {
    const costsQueryParams = parseQueryParams(req.url || "");
    const agentId = costsQueryParams.get("agentId");
    const taskId = costsQueryParams.get("taskId");
    const startDate = costsQueryParams.get("startDate");
    const endDate = costsQueryParams.get("endDate");
    const limitParam = costsQueryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;

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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ costs }));
    return true;

  }

  // GET /ecosystem - Generate PM2 ecosystem config for agent's services

  return false;
}

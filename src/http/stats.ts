import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  getAllAgents,
  getAllLogs,
  getAllServices,
  getConcurrentContext,
  getLogsByAgentId,
  getScheduledTasks,
  getTaskStats,
} from "../be/db";
import type { AgentLog } from "../types";
import { route } from "./route-def";
import { json } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listLogs = route({
  method: "get",
  path: "/api/logs",
  pattern: ["api", "logs"],
  summary: "List agent logs",
  tags: ["Stats"],
  query: z.object({
    limit: z.coerce.number().int().min(1).optional(),
    agentId: z.string().uuid().optional(),
  }),
  responses: {
    200: { description: "Agent logs" },
  },
});

const getStats = route({
  method: "get",
  path: "/api/stats",
  pattern: ["api", "stats"],
  summary: "Dashboard summary stats",
  tags: ["Stats"],
  responses: {
    200: { description: "Agent and task statistics" },
  },
});

const listServices = route({
  method: "get",
  path: "/api/services",
  pattern: ["api", "services"],
  summary: "List all registered services",
  tags: ["Stats"],
  query: z.object({
    status: z.string().optional(),
    agentId: z.string().optional(),
    name: z.string().optional(),
  }),
  responses: {
    200: { description: "Service list" },
  },
});

const listScheduledTasks = route({
  method: "get",
  path: "/api/scheduled-tasks",
  pattern: ["api", "scheduled-tasks"],
  summary: "List scheduled tasks",
  tags: ["Stats"],
  query: z.object({
    enabled: z.enum(["true", "false"]).optional(),
    name: z.string().optional(),
    scheduleType: z.enum(["recurring", "one_time"]).optional(),
    hideCompleted: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: { description: "Scheduled tasks list" },
  },
});

const getConcurrentContextRoute = route({
  method: "get",
  path: "/api/concurrent-context",
  pattern: ["api", "concurrent-context"],
  summary: "Get concurrent session context for lead awareness",
  tags: ["Stats"],
  responses: {
    200: { description: "Concurrent context data" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listLogs.match(req.method, pathSegments)) {
    const parsed = await listLogs.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const agentId = parsed.query.agentId;
    let logs: AgentLog[] = [];
    if (agentId) {
      logs = getLogsByAgentId(agentId).slice(0, limit);
    } else {
      logs = getAllLogs(limit);
    }
    json(res, { logs });
    return true;
  }

  if (getStats.match(req.method, pathSegments)) {
    const agents = getAllAgents();
    const taskStats = getTaskStats();

    const stats = {
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        busy: agents.filter((a) => a.status === "busy").length,
        offline: agents.filter((a) => a.status === "offline").length,
      },
      tasks: {
        total: taskStats.total,
        unassigned: taskStats.unassigned,
        offered: taskStats.offered,
        reviewing: taskStats.reviewing,
        pending: taskStats.pending,
        in_progress: taskStats.in_progress,
        paused: taskStats.paused,
        completed: taskStats.completed,
        failed: taskStats.failed,
      },
    };

    json(res, stats);
    return true;
  }

  if (listServices.match(req.method, pathSegments)) {
    const parsed = await listServices.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const services = getAllServices({
      status: (parsed.query.status as import("../types").ServiceStatus) || undefined,
      agentId: parsed.query.agentId || undefined,
      name: parsed.query.name || undefined,
    });
    json(res, { services });
    return true;
  }

  if (listScheduledTasks.match(req.method, pathSegments)) {
    const parsed = await listScheduledTasks.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const scheduledTasks = getScheduledTasks({
      enabled: parsed.query.enabled !== undefined ? parsed.query.enabled === "true" : undefined,
      name: parsed.query.name || undefined,
      scheduleType: (parsed.query.scheduleType as "recurring" | "one_time") || undefined,
      hideCompleted:
        parsed.query.hideCompleted !== undefined
          ? parsed.query.hideCompleted !== "false"
          : undefined,
    });
    json(res, { scheduledTasks });
    return true;
  }

  if (getConcurrentContextRoute.match(req.method, pathSegments)) {
    const context = getConcurrentContext();
    json(res, context);
    return true;
  }

  return false;
}

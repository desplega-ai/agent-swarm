import type { IncomingMessage, ServerResponse } from "node:http";
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
import { matchRoute } from "./utils";

export async function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (matchRoute(req.method, pathSegments, "GET", ["api", "logs"])) {
    const limitParam = queryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    const agentId = queryParams.get("agentId");
    let logs: AgentLog[] = [];
    if (agentId) {
      logs = getLogsByAgentId(agentId).slice(0, limit);
    } else {
      logs = getAllLogs(limit);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs }));
    return true;
  }

  // GET /api/stats - Dashboard summary stats
  if (matchRoute(req.method, pathSegments, "GET", ["api", "stats"])) {
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return true;
  }

  // GET /api/services - List all services (with optional filters: status, agentId, name)
  if (matchRoute(req.method, pathSegments, "GET", ["api", "services"], true)) {
    const status = queryParams.get("status") as import("../types").ServiceStatus | null;
    const agentId = queryParams.get("agentId");
    const name = queryParams.get("name");
    const services = getAllServices({
      status: status || undefined,
      agentId: agentId || undefined,
      name: name || undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ services }));
    return true;
  }

  // GET /api/scheduled-tasks - List all scheduled tasks (with optional filters: enabled, name)
  if (matchRoute(req.method, pathSegments, "GET", ["api", "scheduled-tasks"], true)) {
    const enabledParam = queryParams.get("enabled");
    const name = queryParams.get("name");
    const scheduleType = queryParams.get("scheduleType") as "recurring" | "one_time" | null;
    const hideCompletedParam = queryParams.get("hideCompleted");
    const scheduledTasks = getScheduledTasks({
      enabled: enabledParam !== null ? enabledParam === "true" : undefined,
      name: name || undefined,
      scheduleType: scheduleType || undefined,
      hideCompleted: hideCompletedParam !== null ? hideCompletedParam !== "false" : undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ scheduledTasks }));
    return true;
  }

  // GET /api/concurrent-context - Get concurrent session context for lead awareness
  if (matchRoute(req.method, pathSegments, "GET", ["api", "concurrent-context"], true)) {
    const context = getConcurrentContext();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(context));
    return true;
  }

  return false;
}

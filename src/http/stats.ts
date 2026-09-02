import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  getAllAgents,
  getAllLogs,
  getAllServices,
  getConcurrentContext,
  getLogsByAgentId,
  getScheduledTasks,
  getSwarmMetrics,
  getTaskStats,
  withFavoriteFlags,
} from "../be/db";
import { getDbRetentionStats } from "../be/db-retention";
import { isSteeringEnabled } from "../be/steering";
import type { AgentLog } from "../types";
import { AgentLogSchema, ScheduledTaskSchema, ServiceSchema } from "../types";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { route } from "./route-def";

// ─── Response schemas ────────────────────────────────────────────────────────

const AgentCountsSchema = z.object({
  total: z.number(),
  idle: z.number(),
  busy: z.number(),
  offline: z.number(),
});

// getTaskStats() runs a scalar SUM(CASE ...) aggregate with no GROUP BY: on a
// totally empty agent_tasks table (fresh DB) every SUM comes back SQL NULL
// (COUNT(*) is the only one that reliably yields 0), so these must be
// nullable to match the actual wire payload.
const TaskCountsSchema = z.object({
  total: z.number(),
  unassigned: z.number().nullable(),
  offered: z.number().nullable(),
  reviewing: z.number().nullable(),
  pending: z.number().nullable(),
  in_progress: z.number().nullable(),
  paused: z.number().nullable(),
  completed: z.number().nullable(),
  failed: z.number().nullable(),
});

/** Mirrors the object literal built by handleStats for GET /api/stats. */
const DashboardStatsSchema = z.object({
  agents: AgentCountsSchema,
  tasks: TaskCountsSchema,
  steeringEnabled: z.boolean(),
});

/** Mirrors `DbRetentionTableStats` (src/be/db-retention.ts). */
const RetentionTableStatsSchema = z.object({
  at: z.string(),
  rowsDeleted: z.number(),
  batches: z.number(),
  durationMs: z.number(),
  dryRun: z.boolean(),
  cumulativeRowsDeleted: z.number(),
  outcome: z.enum(["converged", "budget_exhausted", "error"]),
  drained: z.boolean(),
  backlogRemaining: z.number(),
  batchSize: z.number(),
  slowestStatementMs: z.number(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
});

/** Mirrors `SwarmMetrics` (src/be/db.ts). */
const SwarmMetricsSchema = z.object({
  tasks: z.object({ total: z.number(), by_status: z.record(z.string(), z.number()) }),
  agents: z.object({ total: z.number(), by_status: z.record(z.string(), z.number()) }),
  workflows: z.object({ total: z.number(), enabled: z.number() }),
  pages: z.object({ total: z.number() }),
  sessions: z.object({ active: z.number() }),
  skills: z.object({ total: z.number() }),
  retention: z.object({
    sessionLogs: RetentionTableStatsSchema.optional(),
    agentLog: RetentionTableStatsSchema.optional(),
    events: RetentionTableStatsSchema.optional(),
  }),
});

/** Mirrors `ConcurrentContext` (src/be/db.ts). */
const ConcurrentContextSchema = z.object({
  processingInboxMessages: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      source: z.string(),
      slackChannelId: z.string().nullable(),
      slackThreadTs: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  recentTaskDelegations: z.array(
    z.object({
      id: z.string(),
      task: z.string(),
      agentId: z.string().nullable(),
      agentName: z.string().nullable(),
      creatorAgentId: z.string().nullable(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  activeSwarmTasks: z.array(
    z.object({
      id: z.string(),
      task: z.string(),
      agentId: z.string().nullable(),
      agentName: z.string().nullable(),
      status: z.string(),
      createdAt: z.string(),
      progress: z.string().nullable(),
    }),
  ),
});

// ─── Route Definitions ───────────────────────────────────────────────────────

const listLogs = route({
  method: "get",
  path: "/api/logs",
  pattern: ["api", "logs"],
  summary: "List agent logs",
  tags: ["Stats"],
  query: z.object({
    limit: z.coerce.number().int().min(1).optional(),
    agentId: z.string().optional(),
  }),
  responses: {
    200: { description: "Agent logs", schema: z.object({ logs: z.array(AgentLogSchema) }) },
  },
});

const getStats = route({
  method: "get",
  path: "/api/stats",
  pattern: ["api", "stats"],
  summary: "Dashboard summary stats",
  tags: ["Stats"],
  responses: {
    200: { description: "Agent and task statistics", schema: DashboardStatsSchema },
  },
});

const getMetrics = route({
  method: "get",
  path: "/api/metrics",
  pattern: ["api", "metrics"],
  summary: "Lightweight swarm-wide counts",
  description:
    "Single JSON object of cheap `COUNT(*)` metrics — tasks (by status), agents (by status), workflows (total + enabled), pages, active sessions, skills. Use this instead of fetching full list payloads just to count. Powers UI footers/sidebars and MCP context.",
  tags: ["Stats"],
  responses: {
    200: { description: "Swarm metrics counts", schema: SwarmMetricsSchema },
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
    200: { description: "Service list", schema: z.object({ services: z.array(ServiceSchema) }) },
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
    targetType: z.enum(["agent-task", "workflow", "script"]).optional(),
    workflowId: z.string().uuid().optional(),
    scriptName: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Scheduled tasks list",
      schema: z.object({ scheduledTasks: z.array(ScheduledTaskSchema) }),
    },
  },
});

const getConcurrentContextRoute = route({
  method: "get",
  path: "/api/concurrent-context",
  pattern: ["api", "concurrent-context"],
  summary: "Get concurrent session context for lead awareness",
  tags: ["Stats"],
  responses: {
    200: { description: "Concurrent context data", schema: ConcurrentContextSchema },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId?: string,
): Promise<boolean> {
  if (listLogs.match(req.method, pathSegments)) {
    const parsed = await listLogs.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const agentId = parsed.query.agentId;
    let logs: AgentLog[] = [];
    if (agentId) {
      logs = (await getLogsByAgentId(agentId)).slice(0, limit);
    } else {
      logs = await getAllLogs(limit);
    }
    listLogs.respond(res, 200, { logs });
    return true;
  }

  if (getStats.match(req.method, pathSegments)) {
    const agents = await getAllAgents();
    const taskStats = await getTaskStats();

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
      // Authenticated home for the steering feature flag — deliberately NOT on
      // the unauthenticated /health endpoint (config must not leak).
      steeringEnabled: isSteeringEnabled(),
    };

    getStats.respond(res, 200, stats);
    return true;
  }

  if (getMetrics.match(req.method, pathSegments)) {
    getMetrics.respond(res, 200, {
      ...(await getSwarmMetrics()),
      retention: getDbRetentionStats(),
    });
    return true;
  }

  if (listServices.match(req.method, pathSegments)) {
    const parsed = await listServices.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const services = await getAllServices({
      status: (parsed.query.status as import("../types").ServiceStatus) || undefined,
      agentId: parsed.query.agentId || undefined,
      name: parsed.query.name || undefined,
    });
    listServices.respond(res, 200, { services });
    return true;
  }

  if (listScheduledTasks.match(req.method, pathSegments)) {
    const parsed = await listScheduledTasks.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const scheduledTasks = await getScheduledTasks({
      enabled: parsed.query.enabled !== undefined ? parsed.query.enabled === "true" : undefined,
      name: parsed.query.name || undefined,
      scheduleType: (parsed.query.scheduleType as "recurring" | "one_time") || undefined,
      hideCompleted:
        parsed.query.hideCompleted !== undefined
          ? parsed.query.hideCompleted !== "false"
          : undefined,
      targetType: parsed.query.targetType,
      workflowId: parsed.query.workflowId,
      scriptName: parsed.query.scriptName,
    });
    const favoriteScope = (await resolveHttpFavoriteOwner(req, myAgentId))?.scope;
    listScheduledTasks.respond(res, 200, {
      scheduledTasks: await withFavoriteFlags(scheduledTasks, {
        favoriteScope,
        itemType: "schedule",
      }),
    });
    return true;
  }

  if (getConcurrentContextRoute.match(req.method, pathSegments)) {
    const context = await getConcurrentContext();
    getConcurrentContextRoute.respond(res, 200, context);
    return true;
  }

  return false;
}

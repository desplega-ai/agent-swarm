import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { countSessions, getRootTaskChain, getTaskById, listRecentSessions } from "../be/db";
import { getTaskSteeringFields } from "../be/steering";
import { AgentTaskSchema, AgentTaskStatusSchema, SteerModeSchema } from "../types";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Response Schemas ────────────────────────────────────────────────────────

/**
 * `/api/sessions` list item's `root` when slim (default) — mirrors the
 * `AgentTaskSummary` TS type in ../types: the `task` text truncated to a
 * bounded preview and completion/integration/context blobs dropped. Kept in
 * lock-step with that type's `Pick<...>` field list (mirrors the sibling
 * definition in src/http/tasks.ts — not imported from there since it isn't
 * exported).
 */
const AgentTaskSummarySchema = AgentTaskSchema.pick({
  id: true,
  key: true,
  agentId: true,
  creatorAgentId: true,
  task: true,
  title: true,
  status: true,
  source: true,
  taskType: true,
  tags: true,
  priority: true,
  dependsOn: true,
  offeredTo: true,
  acceptedAt: true,
  parentTaskId: true,
  scheduleId: true,
  model: true,
  modelTier: true,
  effort: true,
  provider: true,
  requestedByUserId: true,
  progress: true,
  createdAt: true,
  lastUpdatedAt: true,
  finishedAt: true,
  peakContextPercent: true,
  totalCostUsd: true,
});

/**
 * A `/api/sessions` list item. `root` is a full `AgentTask` when
 * `?fields=full`, an `AgentTaskSummary` otherwise (default).
 */
const SessionListItemSchema = z.object({
  root: z.union([AgentTaskSchema, AgentTaskSummarySchema]),
  chainTaskCount: z.number().int(),
  lastActivityAt: z.string(),
  latestStatus: AgentTaskStatusSchema,
});

/**
 * A full `AgentTask` decorated with `getTaskSteeringFields` — the shape of
 * `root` and each `chain` entry on `GET /api/sessions/{rootTaskId}`.
 */
const TaskWithSteeringSchema = AgentTaskSchema.extend({
  isLeadTask: z.boolean(),
  supportedSteerModes: z.array(SteerModeSchema),
});

// ─── Route Definitions ───────────────────────────────────────────────────────

const listSessions = route({
  method: "get",
  path: "/api/sessions",
  pattern: ["api", "sessions"],
  summary: "List recent task sessions (root tasks + chain summary)",
  description:
    "Each item's `root` is a slim task summary by default — the full `task` text is replaced with a bounded `taskPreview` and completion/integration blobs are dropped. Pass `fields=full` to restore the full root `AgentTask`. The full root + descendant chain are on `GET /api/sessions/{rootTaskId}`.",
  tags: ["Sessions"],
  query: z.object({
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    /** Comma-separated source filter (e.g. `ui,slack`). Omit to include all. */
    source: z.string().optional(),
    /** Case-insensitive substring match against the root task's text or custom title. */
    q: z.string().optional(),
    /**
     * When present, restrict results to root tasks where
     * `agent_tasks.requestedByUserId` equals this value. NULL rows are
     * excluded. Omit to return every session (legacy / non-UI callers).
     */
    requestedByUserId: z.string().min(1).optional(),
    /** `full` restores the legacy shape (full root `AgentTask`); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: {
      description: "Recent sessions ordered by chain-wide last activity",
      schema: z.object({
        sessions: z.array(SessionListItemSchema),
        total: z.number().int(),
        limit: z.number().int(),
        offset: z.number().int(),
      }),
    },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const getSession = route({
  method: "get",
  path: "/api/sessions/{rootTaskId}",
  pattern: ["api", "sessions", null],
  summary: "Get a session — root task + the entire descendant chain",
  tags: ["Sessions"],
  params: z.object({ rootTaskId: z.string() }),
  responses: {
    200: {
      description: "Root task + chain (ordered by createdAt)",
      schema: z.object({
        root: TaskWithSteeringSchema,
        chain: z.array(TaskWithSteeringSchema),
      }),
    },
    401: { description: "Unauthorized" },
    404: { description: "Root task not found" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listSessions.match(req.method, pathSegments)) {
    const parsed = await listSessions.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const sources = parsed.query.source
      ? parsed.query.source
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const baseOpts = {
      limit: parsed.query.limit,
      offset: parsed.query.offset,
      source: sources,
      q: parsed.query.q,
      requestedByUserId: parsed.query.requestedByUserId,
    };
    // List responses default to slim (root is a task summary); `?fields=full` restores it.
    const sessions =
      parsed.query.fields === "full"
        ? listRecentSessions(baseOpts)
        : listRecentSessions({ ...baseOpts, slim: true });
    // Filter-aware total: same `source`/`q`/`requestedByUserId` WHERE as the
    // list query, so the UI pager reflects the filtered result set.
    const total = countSessions({
      source: sources,
      q: parsed.query.q,
      requestedByUserId: parsed.query.requestedByUserId,
    });
    listSessions.respond(res, 200, {
      sessions,
      total,
      limit: parsed.query.limit ?? 25,
      offset: parsed.query.offset ?? 0,
    });
    return true;
  }

  if (getSession.match(req.method, pathSegments)) {
    const parsed = await getSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const root = getTaskById(parsed.params.rootTaskId);
    if (!root) {
      jsonError(res, "Root task not found", 404);
      return true;
    }
    const chain = getRootTaskChain(parsed.params.rootTaskId);
    getSession.respond(res, 200, {
      root: { ...root, ...getTaskSteeringFields(root) },
      chain: chain.map((task) => ({ ...task, ...getTaskSteeringFields(task) })),
    });
    return true;
  }

  return false;
}

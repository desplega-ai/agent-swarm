import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  countSessions,
  getDbClient,
  getRootTaskChain,
  getTaskById,
  listRecentSessions,
} from "../be/db";
import { getTaskSteeringFieldsForTasks } from "../be/steering";
import { getTaskCitationsForTasks, TaskCitationSchema } from "../be/task-citations";
import {
  InvalidRuntimeTokenError,
  mintRuntimeToken,
  mintSessionToken,
  revokeSessionToken,
} from "../be/users";
import { type AgentTask, AgentTaskSchema, AgentTaskStatusSchema, SteerModeSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
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
  citations: z.array(TaskCitationSchema),
  isLeadTask: z.boolean(),
  supportedSteerModes: z.array(SteerModeSchema),
});

// ─── Route Definitions ───────────────────────────────────────────────────────

/** Maximum TTL for an ephemeral session token: 7 days. */
const MAX_SESSION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const mintSessionTokenRoute = route({
  method: "post",
  path: "/api/sessions/tokens",
  pattern: ["api", "sessions", "tokens"],
  summary: "Mint an ephemeral task or runtime token",
  description:
    "Operators can mint task or runtime tokens. Runtime tokens can mint task tokens for their own assigned tasks. Child tokens expire with their parent runtime.",
  tags: ["Sessions"],
  body: z
    .object({
      agentId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      runtimeId: z.string().min(1).optional(),
      ttlMs: z.number().int().positive().max(MAX_SESSION_TOKEN_TTL_MS).optional(),
    })
    .refine((body) => Boolean(body.taskId) !== Boolean(body.runtimeId), {
      message: "Provide exactly one of taskId or runtimeId",
    })
    .refine((body) => !body.taskId || body.ttlMs !== undefined, {
      message: "ttlMs is required for a task token",
    }),
  responses: {
    200: {
      description: "Minted token plaintext (returned once) and its stable token ID",
      schema: z.object({
        tokenId: z.string(),
        plaintext: z.string(),
      }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    403: { description: "Token cannot mint for this agent or task" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated: "operator or runtime token minting for its own assigned task, enforced in the handler",
  },
});

const revokeSessionTokenRoute = route({
  method: "delete",
  path: "/api/sessions/tokens/{tokenId}",
  pattern: ["api", "sessions", "tokens", null],
  summary: "Revoke an ephemeral session token",
  description:
    "Operators can revoke any ephemeral token. With runtime pools enabled, runtime tokens can revoke their own child task tokens. Repeated revocation has no effect.",
  tags: ["Sessions"],
  params: z.object({ tokenId: z.string() }),
  responses: {
    204: { description: "Token revoked (or was already revoked)" },
    401: { description: "Unauthorized" },
    403: { description: "Token cannot revoke this child" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated: "operator or runtime token revoking its own child, enforced in the handler",
  },
});

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
    /**
     * When present, restrict results to root tasks whose `contextKey` starts
     * with this literal prefix. The UI contextual session panel passes its page
     * key plus a trailing `:` (e.g. `task:ui:workflow:abc:`).
     */
    contextKeyPrefix: z.string().min(1).optional(),
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
  if (mintSessionTokenRoute.match(req.method, pathSegments)) {
    const auth = getRequestAuth(req);
    if (auth?.kind !== "operator" && !(auth?.kind === "agent" && auth.runtimeId)) {
      jsonError(res, "Unauthorized", 401);
      return true;
    }
    const parsed = await mintSessionTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { agentId, taskId, runtimeId, ttlMs } = parsed.body;
    try {
      const result = await getDbClient().transaction(async () => {
        if (auth.kind === "agent") {
          const task = taskId ? await getTaskById(taskId) : null;
          if (
            agentId !== auth.agentId ||
            runtimeId ||
            !task ||
            task.agentId !== auth.agentId ||
            (task.status !== "pending" && task.status !== "in_progress")
          ) {
            return { error: "Token can mint only for its own live assigned task" };
          }
          return {
            token: await mintSessionToken(agentId, taskId!, ttlMs!, {
              tokenId: auth.tokenId,
              runtimeId: auth.runtimeId!,
            }),
          };
        }
        return {
          token: runtimeId
            ? await mintRuntimeToken(agentId, runtimeId, ttlMs)
            : await mintSessionToken(agentId, taskId!, ttlMs!),
        };
      });
      if (result.error) {
        jsonError(res, result.error, 403);
        return true;
      }
      const token = result.token!;
      mintSessionTokenRoute.respond(res, 200, {
        tokenId: token.tokenId,
        plaintext: token.plaintext,
      });
    } catch (error) {
      if (!(error instanceof InvalidRuntimeTokenError)) throw error;
      jsonError(res, "Unauthorized", 401);
      return true;
    }
    return true;
  }

  if (revokeSessionTokenRoute.match(req.method, pathSegments)) {
    const auth = getRequestAuth(req);
    if (
      auth?.kind !== "operator" &&
      !(isRuntimePoolsEnabled() && auth?.kind === "agent" && auth.runtimeId)
    ) {
      jsonError(res, "Unauthorized", 401);
      return true;
    }
    const parsed = await revokeSessionTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const revoked = await getDbClient().transaction(async (client) => {
      if (auth.kind === "agent") {
        const child = await client.get(
          "SELECT id FROM session_tokens WHERE id = ? AND agentId = ? AND parentRuntimeId = ? AND taskId IS NOT NULL",
          [parsed.params.tokenId, auth.agentId, auth.runtimeId!],
        );
        if (!child) return false;
      }
      await revokeSessionToken(parsed.params.tokenId);
      return true;
    });
    if (!revoked) {
      jsonError(res, "Token can revoke only its own child task token", 403);
      return true;
    }
    res.writeHead(204);
    res.end();
    return true;
  }

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
      contextKeyPrefix: parsed.query.contextKeyPrefix,
    };
    // List responses default to slim (root is a task summary); `?fields=full` restores it.
    const sessions =
      parsed.query.fields === "full"
        ? await listRecentSessions(baseOpts)
        : await listRecentSessions({ ...baseOpts, slim: true });
    // Filter-aware total: same WHERE as the list query, so the UI pager
    // reflects the filtered result set.
    const total = await countSessions({
      source: sources,
      q: parsed.query.q,
      requestedByUserId: parsed.query.requestedByUserId,
      contextKeyPrefix: parsed.query.contextKeyPrefix,
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
    const root = await getTaskById(parsed.params.rootTaskId);
    if (!root) {
      jsonError(res, "Root task not found", 404);
      return true;
    }
    const chain = await getRootTaskChain(parsed.params.rootTaskId);
    // Fixed query count regardless of chain length: one agents lookup and one
    // citations lookup for the whole chain (chunked past 500 ids).
    const tasks = [root, ...chain];
    const [steering, citations] = await Promise.all([
      getTaskSteeringFieldsForTasks(tasks),
      getTaskCitationsForTasks(tasks.map((task) => task.id)),
    ]);
    const decorate = (task: AgentTask) => ({
      ...task,
      ...steering.get(task.id)!,
      citations: citations.get(task.id)!,
    });
    getSession.respond(res, 200, { root: decorate(root), chain: chain.map(decorate) });
    return true;
  }

  return false;
}

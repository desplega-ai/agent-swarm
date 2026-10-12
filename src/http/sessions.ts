import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  countSessions,
  createAgent,
  getAgentById,
  getDbClient,
  getRootTaskChain,
  getTaskById,
  listRecentSessions,
} from "../be/db";
import { getTaskSteeringFieldsForTasks } from "../be/steering";
import { getTaskCitationsForTasks, TaskCitationSchema } from "../be/task-citations";
import {
  AgentTokenExistsError,
  InvalidRuntimeTokenError,
  mintAgentToken,
  mintRuntimeToken,
  mintSessionToken,
  revokeAgentTokens,
  revokeSessionToken,
  rotateAgentToken,
} from "../be/users";
import { can } from "../rbac";
import { type AgentTask, AgentTaskSchema, AgentTaskStatusSchema, SteerModeSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { agentFirstPrincipal } from "./request-principal";
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
    "Operators can mint task or runtime tokens. Runtime and agent tokens can mint task tokens for their own assigned tasks. A child token never outlives its parent and is revoked with it.",
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
    ungated:
      "operator, or a runtime or agent token minting for its own assigned task, enforced in the handler",
  },
});

const revokeSessionTokenRoute = route({
  method: "delete",
  path: "/api/sessions/tokens/{tokenId}",
  pattern: ["api", "sessions", "tokens", null],
  summary: "Revoke an ephemeral session token",
  description:
    "Operators can revoke any ephemeral token. Agent tokens, and runtime tokens when runtime pools are enabled, can revoke their own child task tokens. Repeated revocation has no effect.",
  tags: ["Sessions"],
  params: z.object({ tokenId: z.string() }),
  responses: {
    204: { description: "Token revoked (or was already revoked)" },
    401: { description: "Unauthorized" },
    403: { description: "Token cannot revoke this child" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated:
      "operator, or a runtime or agent token revoking its own child, enforced in the handler",
  },
});

/** Default rotation grace: the old worker token keeps working this long. */
const AGENT_TOKEN_ROTATE_GRACE_SEC = 300;

const AgentTokenSchema = z.object({
  agentId: z.string(),
  tokenId: z.string(),
  plaintext: z.string(),
  expiresAt: z.string().nullable().describe("null when the token does not expire"),
});

const agentTokenTtl = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Token lifetime in ms. Omit for the default (no expiry).");

const mintAgentTokenRoute = route({
  method: "post",
  path: "/api/agents/{id}/token",
  pattern: ["api", "agents", null, "token"],
  operationId: "agents_mintWorkerToken",
  summary: "Mint an agent-bound worker token",
  description:
    "Returns the token once. A worker runs on it in place of the swarm API key and acts only as this agent. Creates the agent when it does not exist and `name` is given. Fails with 409 when the agent already holds an active token.",
  tags: ["Sessions"],
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({ name: z.string().min(1).optional(), ttlMs: agentTokenTtl })
    .strict()
    .optional(),
  responses: {
    200: {
      description: "Minted worker token",
      schema: AgentTokenSchema.extend({ agentCreated: z.boolean() }),
    },
    403: { description: "Operator or user credentials required" },
    404: { description: "Agent not found and no name given" },
    409: { description: "Agent already holds an active token" },
  },
  rbac: { permission: "agent.token.manage" },
});

const rotateAgentTokenRoute = route({
  method: "post",
  path: "/api/agents/{id}/token/rotate",
  pattern: ["api", "agents", null, "token", "rotate"],
  operationId: "agents_rotateWorkerToken",
  summary: "Rotate an agent-bound worker token",
  description:
    "Returns a new token once. The previous token keeps working for `graceSec` (default 300), then expires. Use revoke for a token that must stop now.",
  tags: ["Sessions"],
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({ graceSec: z.number().int().min(0).max(86_400).optional(), ttlMs: agentTokenTtl })
    .strict()
    .optional(),
  responses: {
    200: {
      description: "New worker token",
      schema: AgentTokenSchema.extend({ previousExpiresAt: z.string() }),
    },
    403: { description: "Operator or user credentials required" },
    404: { description: "Agent holds no active token" },
  },
  rbac: { permission: "agent.token.manage" },
});

const revokeAgentTokenRoute = route({
  method: "delete",
  path: "/api/agents/{id}/token",
  pattern: ["api", "agents", null, "token"],
  operationId: "agents_revokeWorkerToken",
  summary: "Revoke an agent-bound worker token",
  description:
    "Revokes every active worker token of the agent and the task tokens they minted. Open realtime connections on them close.",
  tags: ["Sessions"],
  params: z.object({ id: z.string().min(1) }),
  responses: {
    200: {
      description: "Number of worker tokens revoked (0 when none was active)",
      schema: z.object({ revoked: z.number().int() }),
    },
    403: { description: "Operator or user credentials required" },
  },
  rbac: { permission: "agent.token.manage" },
});

const AGENT_TOKEN_ROUTES = [mintAgentTokenRoute, rotateAgentTokenRoute, revokeAgentTokenRoute];

/**
 * Gate the worker-token routes. Only an operator key or a user may manage
 * them, never a session token. The principal is agent-first: an operator key
 * sent with X-Agent-ID acts as that agent and is refused, as on the
 * controller-token route.
 */
async function ensureAgentTokenManager(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<boolean> {
  const auth = getRequestAuth(req);
  if (auth?.kind !== "operator" && auth?.kind !== "user") {
    jsonError(res, "Worker tokens require operator or user credentials", 403);
    return false;
  }
  const header = req.headers["x-agent-id"];
  const decision = can({
    principal: await agentFirstPrincipal(req, Array.isArray(header) ? header[0] : header),
    verb: "agent.token.manage",
    resource: { kind: "agent", agentId },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, decision.reason, 403);
    return false;
  }
  return true;
}

async function handleAgentTokens(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  const matched = AGENT_TOKEN_ROUTES.find((def) => def.match(req.method, pathSegments));
  if (!matched) return false;
  if (!(await ensureAgentTokenManager(req, res, pathSegments[2]!))) return true;
  res.setHeader("Cache-Control", "no-store");

  if (matched === mintAgentTokenRoute) {
    const parsed = await mintAgentTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agentId = parsed.params.id;
    const result = await getDbClient()
      .transaction(async () => {
        let agentCreated = false;
        if (!(await getAgentById(agentId))) {
          if (!parsed.body?.name) return { status: 404 as const };
          // Same defaults as a worker's first registration; it is offline until it connects.
          await createAgent({
            id: agentId,
            name: parsed.body.name,
            isLead: false,
            status: "offline",
            capabilities: [],
            maxTasks: 1,
          });
          agentCreated = true;
        }
        return {
          status: 200 as const,
          agentCreated,
          token: await mintAgentToken(agentId, parsed.body?.ttlMs),
        };
      })
      .catch((error) => {
        if (error instanceof AgentTokenExistsError) return { status: 409 as const };
        throw error;
      });
    if (result.status === 404) {
      jsonError(res, "Agent not found; pass name to create it", 404);
      return true;
    }
    if (result.status === 409) {
      jsonError(res, "Agent already holds an active worker token; rotate or revoke it", 409);
      return true;
    }
    mintAgentTokenRoute.respond(res, 200, {
      agentId,
      ...result.token,
      agentCreated: result.agentCreated,
    });
    return true;
  }

  if (matched === rotateAgentTokenRoute) {
    const parsed = await rotateAgentTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const graceSec = parsed.body?.graceSec ?? AGENT_TOKEN_ROTATE_GRACE_SEC;
    const token = await rotateAgentToken(parsed.params.id, graceSec * 1000, parsed.body?.ttlMs);
    if (!token) {
      jsonError(res, "Agent holds no active worker token", 404);
      return true;
    }
    rotateAgentTokenRoute.respond(res, 200, { agentId: parsed.params.id, ...token });
    return true;
  }

  const parsed = await revokeAgentTokenRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  revokeAgentTokenRoute.respond(res, 200, { revoked: await revokeAgentTokens(parsed.params.id) });
  return true;
}

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
  if (await handleAgentTokens(req, res, pathSegments, queryParams)) return true;

  if (mintSessionTokenRoute.match(req.method, pathSegments)) {
    const auth = getRequestAuth(req);
    if (auth?.kind !== "operator" && !(auth?.kind === "agent" && auth.tokenKind !== "task")) {
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
              runtimeId: auth.runtimeId,
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
      !(
        auth?.kind === "agent" &&
        (auth.tokenKind === "agent" || (auth.tokenKind === "runtime" && isRuntimePoolsEnabled()))
      )
    ) {
      jsonError(res, "Unauthorized", 401);
      return true;
    }
    const parsed = await revokeSessionTokenRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const revoked = await getDbClient().transaction(async (client) => {
      if (auth.kind === "agent") {
        const child = await client.get(
          `SELECT id FROM session_tokens WHERE id = ? AND agentId = ? AND taskId IS NOT NULL
           AND ${auth.runtimeId ? "parentRuntimeId" : "parentTokenId"} = ?`,
          [parsed.params.tokenId, auth.agentId, auth.runtimeId ?? auth.tokenId],
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

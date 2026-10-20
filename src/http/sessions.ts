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
import { getUserGrant } from "../be/rbac-roles";
import {
  getSessionRoot,
  listActiveSessionShares,
  type SessionAccess,
  sessionAccessForRoot,
  setSessionShares,
  toSessionSharesState,
} from "../be/session-shares";
import { getTaskSteeringFieldsForTasks } from "../be/steering";
import { getTaskCitationsForTasks, TaskCitationSchema } from "../be/task-citations";
import {
  AgentTokenExistsError,
  findUserById,
  InvalidRuntimeTokenError,
  mintAgentToken,
  mintRuntimeToken,
  mintSessionToken,
  revokeAgentTokens,
  revokeSessionToken,
  rotateAgentToken,
} from "../be/users";
import { can, isRbacEnabled } from "../rbac";
import { sessionAccessTopic } from "../realtime/auth";
import { realtimeBus } from "../realtime/bus";
import {
  type AgentTask,
  AgentTaskSchema,
  AgentTaskStatusSchema,
  SessionAccessSchema,
  SessionOwnerSchema,
  SessionSharesSchema,
  SessionSharesUpdateSchema,
  SteerModeSchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { resolveSessionActor, type SessionActor } from "./session-access";
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
  session: {
    none: "user tokens cannot mint: the handler admits only the operator key or the task's own runtime",
  },
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
  // A worker token carries the target agent's privileges and reads that
  // agent's resolved config, global secrets included. A user without a
  // grant-all role must already hold both, and may not manage the token of an
  // agent that may itself act on any agent (a lead).
  if (auth.kind === "user" && isRbacEnabled()) {
    const grant = await getUserGrant(auth.userId);
    if (!grant.grantsAll) {
      const target = await getAgentById(agentId);
      const targetActsOnAny = can({
        principal: { kind: "agent", agentId, isLead: target?.isLead ?? false },
        verb: "agent.act.any",
        resource: { kind: "agent", agentId },
        source: "http",
      }).allow;
      if (targetActsOnAny) {
        jsonError(res, "A lead agent's worker token requires a grant-all role", 403);
        return false;
      }
      const missing = (["agent.act.any", "config.read.secrets"] as const).filter(
        (verb) => !grant.verbs.has(verb),
      );
      if (missing.length > 0) {
        jsonError(res, `Worker tokens also require: ${missing.join(", ")}`, 403);
        return false;
      }
    }
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
    /**
     * `mine`: sessions the caller owns. `shared`: sessions someone else owns
     * with an active share to the caller or to everyone. Omit for every
     * session the caller can open. Callers that act for no user (agents, the
     * operator key with no picked dashboard user) see every session, and
     * an empty list for either scope.
     */
    scope: z.enum(["mine", "shared"]).optional(),
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
  session: { taskParam: "rootTaskId" },
  summary: "Get a session — root task + the entire descendant chain",
  tags: ["Sessions"],
  params: z.object({ rootTaskId: z.string() }),
  responses: {
    200: {
      description:
        "Root task + chain (ordered by createdAt), plus the caller's `access` and the session `owner`",
      schema: z.object({
        root: TaskWithSteeringSchema,
        chain: z.array(TaskWithSteeringSchema),
        access: SessionAccessSchema,
        owner: SessionOwnerSchema.nullable(),
      }),
    },
    401: { description: "Unauthorized" },
    403: { description: "The caller has no access to this session" },
    404: { description: "Root task not found" },
  },
  auth: { apiKey: true },
});

const getSessionShares = route({
  method: "get",
  path: "/api/sessions/{rootTaskId}/shares",
  pattern: ["api", "sessions", null, "shares"],
  session: { taskParam: "rootTaskId" },
  summary: "List a session's active shares",
  description:
    "Active shares only. `everyone` is the access every user has; `users` are per-person shares. A session with no shares is private to its owner.",
  tags: ["Sessions"],
  params: z.object({ rootTaskId: z.string() }),
  responses: {
    200: { description: "Active shares", schema: SessionSharesSchema },
    401: { description: "Unauthorized" },
    403: { description: "The caller has no access to this session" },
    404: { description: "Root task not found" },
  },
  auth: { apiKey: true },
});

const putSessionShares = route({
  method: "put",
  path: "/api/sessions/{rootTaskId}/shares",
  pattern: ["api", "sessions", null, "shares"],
  session: { taskParam: "rootTaskId" },
  summary: "Set who can view or edit a session",
  description:
    "Owner only. The body is the full desired state: users left out lose access. Changed targets have their active share revoked and a new one inserted in one transaction; shares are never deleted.",
  tags: ["Sessions"],
  params: z.object({ rootTaskId: z.string() }),
  body: SessionSharesUpdateSchema,
  responses: {
    200: { description: "Active shares after the change", schema: SessionSharesSchema },
    400: { description: "Validation error or unknown user" },
    401: { description: "Unauthorized" },
    403: { description: "Only the session owner can share it" },
    404: { description: "Root task not found" },
    409: { description: "The session has no owner, so it is already open to everyone" },
  },
  auth: { apiKey: true },
  rbac: { permission: "session.share" },
});

/** The actor's access to the session rooted at `root`; `owner` when the actor bypasses checks. */
async function accessForRoot(
  actor: SessionActor,
  root: { id: string; requestedByUserId: string | null },
): Promise<SessionAccess> {
  return actor.kind === "bypass" ? "owner" : sessionAccessForRoot(actor.userId, root);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId?: string,
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
    const actor = await resolveSessionActor(req, myAgentId);
    if (actor.kind === "bypass" && parsed.query.scope) {
      // No user to own or receive a share.
      listSessions.respond(res, 200, {
        sessions: [],
        total: 0,
        limit: parsed.query.limit ?? 25,
        offset: parsed.query.offset ?? 0,
      });
      return true;
    }
    const filterOpts = {
      source: sources,
      q: parsed.query.q,
      requestedByUserId: parsed.query.requestedByUserId,
      contextKeyPrefix: parsed.query.contextKeyPrefix,
      ...(actor.kind === "user"
        ? { viewer: { userId: actor.userId, scope: parsed.query.scope ?? "all" } as const }
        : {}),
    };
    const baseOpts = {
      ...filterOpts,
      limit: parsed.query.limit,
      offset: parsed.query.offset,
    };
    // List responses default to slim (root is a task summary); `?fields=full` restores it.
    const sessions =
      parsed.query.fields === "full"
        ? await listRecentSessions(baseOpts)
        : await listRecentSessions({ ...baseOpts, slim: true });
    // Filter-aware total: same WHERE as the list query, so the UI pager
    // reflects the filtered result set.
    const total = await countSessions(filterOpts);
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
    // The route accepts any task id; access follows the topmost root.
    const sessionRoot = (await getSessionRoot(root.id)) ?? {
      id: root.id,
      requestedByUserId: root.requestedByUserId ?? null,
    };
    const access = await accessForRoot(await resolveSessionActor(req, myAgentId), sessionRoot);
    if (access === "none") {
      jsonError(res, "You don't have access to this session. Ask the owner to share it.", 403);
      return true;
    }
    const ownerUser = sessionRoot.requestedByUserId
      ? await findUserById(sessionRoot.requestedByUserId)
      : null;
    const owner = sessionRoot.requestedByUserId
      ? {
          id: sessionRoot.requestedByUserId,
          name: ownerUser?.name ?? sessionRoot.requestedByUserId,
        }
      : null;
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
    getSession.respond(res, 200, {
      root: decorate(root),
      chain: chain.map(decorate),
      access,
      owner,
    });
    return true;
  }

  if (getSessionShares.match(req.method, pathSegments)) {
    const parsed = await getSessionShares.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const root = await getSessionRoot(parsed.params.rootTaskId);
    if (!root) {
      jsonError(res, "Root task not found", 404);
      return true;
    }
    const access = await accessForRoot(await resolveSessionActor(req, myAgentId), root);
    if (access === "none") {
      jsonError(res, "You don't have access to this session. Ask the owner to share it.", 403);
      return true;
    }
    getSessionShares.respond(
      res,
      200,
      toSessionSharesState(await listActiveSessionShares(root.id)),
    );
    return true;
  }

  if (putSessionShares.match(req.method, pathSegments)) {
    const parsed = await putSessionShares.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const auth = getRequestAuth(req);
    const actor = await resolveSessionActor(req, myAgentId);
    // Sharing is a dashboard action: a person, or the operator key itself.
    const principal =
      auth?.kind === "user"
        ? ({ kind: "user", userId: auth.userId } as const)
        : auth?.kind === "operator" && !myAgentId
          ? ({ kind: "operator" } as const)
          : null;
    if (
      !principal ||
      !can({ principal, verb: "session.share", resource: { kind: "none" }, source: "http" }).allow
    ) {
      jsonError(res, "Only the session owner can share it", 403);
      return true;
    }
    const root = await getSessionRoot(parsed.params.rootTaskId);
    if (!root) {
      jsonError(res, "Root task not found", 404);
      return true;
    }
    if (!root.requestedByUserId) {
      jsonError(res, "This session has no owner, so it is already open to everyone", 409);
      return true;
    }
    if (actor.kind === "user" && actor.userId !== root.requestedByUserId) {
      jsonError(res, "Only the session owner can share it", 403);
      return true;
    }
    const userIds = [...new Set(parsed.body.users.map((user) => user.userId))];
    if (userIds.length !== parsed.body.users.length) {
      jsonError(res, "Each user may appear only once", 400);
      return true;
    }
    for (const userId of userIds) {
      if (!(await findUserById(userId))) {
        jsonError(res, `Unknown user ${userId}`, 400);
        return true;
      }
    }
    const state = await setSessionShares(
      root,
      parsed.body,
      actor.kind === "user" ? actor.userId : null,
    );
    // Committed: presence sockets re-check access, so a revoked viewer leaves.
    realtimeBus.publish(sessionAccessTopic(root.id), null);
    putSessionShares.respond(res, 200, state);
    return true;
  }

  return false;
}

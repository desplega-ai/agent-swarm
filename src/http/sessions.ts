import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  ASSET_KEY_MAX_LENGTH,
  defaultAssetKey,
  normalizeAssetKey,
  parseAssetKey,
} from "../assets/key";
import { SOURCE_GROUPS_READ_ONLY, sourceMoveError, sourceOfKey } from "../assets/source-key";
import { AssetKeyAuthorizationError, authorizeAssetKeyWrite } from "../be/asset-key-auth";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  AssetKeyMovesBlockedError,
  assertAssetKeyMovesAllowed,
  countSessions,
  createAgent,
  getAgentById,
  getDbClient,
  getPendingApprovalsForTasks,
  getRootTaskChain,
  getTaskById,
  listRecentSessions,
} from "../be/db";
import { getSessionLabels } from "../be/db/session-labels";
import {
  listPrefixRoots,
  listSharedPrefixRoots,
  moveSessionChains,
  type SessionKeyMove,
} from "../be/db/session-moves";
import {
  getSessionGroupKey,
  getSessionReadState,
  getSessionTree,
  triageSessionList,
} from "../be/db/session-tree";
import { getUserGrant } from "../be/rbac-roles";
import {
  getSessionRoot,
  hasSessionAccess,
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
import { warmSlackChannelLabels } from "../slack/channel-labels";
import {
  type AgentTask,
  AgentTaskSchema,
  AgentTaskStatusSchema,
  AssetKeySchema,
  SessionAccessSchema,
  SessionOwnerSchema,
  SessionSharesSchema,
  SessionSharesUpdateSchema,
  SteerModeSchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { canMutateTaskNamespace } from "./assets";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { resolveSessionActor, type SessionActor, sessionAccessFor } from "./session-access";
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
  readState: z.enum(["unread", "read", "later", "done"]).optional(),
  snoozeUntil: z.string().nullable().optional(),
  needsYou: z.boolean().optional(),
  groupKey: z.string().optional(),
  shared: z.boolean().optional(),
  people: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  peopleCount: z.number().int().optional(),
  preview: z.string().nullable().optional(),
  /** Active shares with their access level. `userId` null means everyone on the swarm. */
  shares: z
    .array(
      z.object({
        userId: z.string().nullable(),
        name: z.string().nullable(),
        access: z.enum(["read", "write"]),
      }),
    )
    .optional(),
});

const SessionSectionCountsSchema = z.object({
  total: z.number().int(),
  unread: z.number().int(),
  running: z.number().int(),
  needsYou: z.number().int(),
});
const SessionTreeGroupSchema = SessionSectionCountsSchema.extend({
  key: z.string(),
  lastActivityAt: z.string(),
});
const SessionTreeResponseSchema = z.object({
  labels: z.record(z.string(), z.string()).optional(),
  groups: z.array(SessionTreeGroupSchema),
  inbox: SessionSectionCountsSchema,
  later: SessionSectionCountsSchema,
  done: SessionSectionCountsSchema,
  noGroup: SessionSectionCountsSchema,
  sources: z
    .array(z.object({ source: z.string(), total: z.number().int() }))
    .describe("Each root source in this view with its session count, hidden sources included."),
});

const SessionApprovalSchema = z.object({
  id: z.string(),
  status: z.literal("pending"),
  sourceTaskId: z.string(),
  title: z.string(),
});

const SessionKeyFilterSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeAssetKey(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid asset key",
    });
    return z.NEVER;
  }
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

const SessionShowSchema = z
  .enum(["mine", "all"])
  .optional()
  .describe(
    "Sessions v2 view, for a user viewer with tree scope. mine (default): roots the user started from a human channel (not workflow, schedule, or system) plus sessions shared with the user. all: every tree session. Lists only: access is unchanged.",
  );

const SessionHideSourceSchema = z
  .string()
  // The same cap as the `hideSource` body field of `POST /api/session-triage`.
  .refine((value) => value.split(",").length <= 32, "hideSource takes at most 32 sources.")
  .optional()
  .transform((value) =>
    value
      ?.split(",")
      .map((source) => source.trim())
      .filter(Boolean),
  )
  .describe(
    "Comma-separated root sources to leave out, e.g. `slack,chat`. Older sessions v2 clients send this; `showSource` replaces it.",
  );

const SessionShowSourceSchema = z
  .string()
  // The same cap as the `showSource` body field of `POST /api/session-triage`.
  .refine((value) => value.split(",").length <= 32, "showSource takes at most 32 sources.")
  .optional()
  .transform((value) =>
    value
      ?.split(",")
      .map((source) => source.trim())
      .filter(Boolean),
  )
  .describe(
    "Comma-separated root sources to keep (the sessions v2 source filter), e.g. `ui,slack`. Present and empty keeps none; omit to keep every source.",
  );

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
    /** Literal asset key prefix, including nested groups. */
    keyPrefix: SessionKeyFilterSchema.optional(),
    /** Exact asset group, including direct resource leaves. */
    groupKey: SessionKeyFilterSchema.optional(),
    /** Shared and viewer-personal namespace roots and direct resource leaves. */
    noGroup: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    /** Chain-wide read state or Inbox section. */
    triage: z.enum(["inbox", "later", "done", "unread"]).optional(),
    /** Latest chain status or pending human attention. */
    status: z.enum(["running", "failed", "needs"]).optional(),
    /** Requester anywhere in the chain or active share recipient. */
    withUserId: z.string().min(1).optional(),
    /** `full` restores the legacy shape (full root `AgentTask`); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
    /**
     * `mine`: sessions the caller owns. `shared`: sessions someone else owns
     * with an active share to the caller or to everyone. Omit for every
     * session the caller can open. Callers that act for no user (agents, the
     * operator key with no picked dashboard user) see every session, and
     * an empty list for mine or shared.
     * tree: Sessions that GET /api/session-tree counts: mine plus shared with me,
     * no ownerless roots. A bypass actor sees every root.
     */
    scope: z
      .enum(["mine", "shared", "tree"])
      .optional()
      .describe(
        "mine: owned sessions. shared: sessions shared with me. tree: Sessions that GET /api/session-tree counts: mine plus shared with me, no ownerless roots. A bypass actor sees every root with tree scope.",
      ),
    /** With `scope=tree`: `mine` (default) or `all`. Must match the tree's `show`. */
    show: SessionShowSchema,
    /** Root sources to leave out. Must match the tree's `hideSource`. */
    hideSource: SessionHideSourceSchema,
    /** Root sources to keep. Must match the tree's `showSource`. */
    showSource: SessionShowSourceSchema,
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

const sessionTree = route({
  method: "get",
  path: "/api/session-tree",
  pattern: ["api", "session-tree"],
  summary: "Get session groups and triage counts",
  tags: ["Sessions"],
  query: z.object({
    show: SessionShowSchema,
    hideSource: SessionHideSourceSchema,
    showSource: SessionShowSourceSchema,
  }),
  responses: {
    200: { description: "Visible groups and section counts", schema: SessionTreeResponseSchema },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const triageSessionListRoute = route({
  method: "post",
  path: "/api/session-triage",
  pattern: ["api", "session-triage"],
  summary: "Triage every session of one sidebar list",
  description:
    "The bulk bar's 'Select all N': Done, back to the Inbox, read, or unread for every session that one sessions v2 list shows the caller (the `GET /api/sessions?scope=tree` filters). Needs a picked user.",
  tags: ["Sessions"],
  body: z
    .object({
      action: z.enum(["done", "inbox", "read", "unread"]),
      /** The list: one of Inbox, Later, Done, No group, or a group. */
      triage: z.enum(["inbox", "later", "done"]).optional(),
      noGroup: z.boolean().optional(),
      groupKey: SessionKeyFilterSchema.optional(),
      show: SessionShowSchema,
      hideSource: z.array(z.string().min(1)).max(32).optional(),
      /** Root sources to keep; an empty array keeps none. */
      showSource: z.array(z.string().min(1)).max(32).optional(),
    })
    .refine((body) => [body.triage, body.noGroup, body.groupKey].filter(Boolean).length === 1, {
      message: "Name exactly one list: triage, noGroup, or groupKey",
    }),
  responses: {
    200: {
      description: "The number of sessions written",
      schema: z.object({ updated: z.number().int() }),
    },
    400: { description: "Validation error, or no picked user" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
  rbac: { ungated: "per-user inbox UI state, same posture as PATCH /api/inbox-state" },
});

const SESSION_MOVE_LIMIT = 200;
const SESSION_MOVE_OWNER_ONLY = "Only the session owner can move this group";
const SESSION_MOVE_UNAVAILABLE = "Session not found or not accessible";

const SessionMoveResultSchema = z.object({
  moved: z.array(z.string()),
  skipped: z.array(z.object({ rootTaskId: z.string(), reason: z.string() })),
});
const sessionMoveRbac = {
  ungated:
    "per-session access, per-task task.fs.mutate, and asset-key write checks in the handler, as PATCH /api/assets/task/{id}/key",
};
const sessionMoveResponses = {
  400: { description: "Invalid namespace or request" },
  403: { description: "Personal destination not authorized" },
  409: { description: "Moves blocked until audit warnings are repaired" },
};

const moveSessions = route({
  method: "post",
  path: "/api/session-moves",
  pattern: ["api", "session-moves"],
  summary: "Move sessions into a group or reset their keys",
  tags: ["Sessions"],
  session: { none: "The handler checks each root and reports denied roots as skipped" },
  body: z.object({
    rootTaskIds: z.array(z.string().min(1)).min(1).max(SESSION_MOVE_LIMIT),
    groupKey: AssetKeySchema.nullable(),
  }),
  responses: {
    200: { description: "Moved and skipped sessions", schema: SessionMoveResultSchema },
    ...sessionMoveResponses,
  },
  auth: { apiKey: true },
  rbac: sessionMoveRbac,
});

const moveSessionPrefix = route({
  method: "post",
  path: "/api/session-moves/prefix",
  pattern: ["api", "session-moves", "prefix"],
  summary: "Rename or delete a session group",
  tags: ["Sessions"],
  body: z.object({ from: AssetKeySchema, to: AssetKeySchema.nullable() }),
  responses: {
    200: {
      description: "Moved and skipped sessions and remaining movable roots",
      schema: SessionMoveResultSchema.extend({ remaining: z.number().int().min(0) }),
    },
    ...sessionMoveResponses,
  },
  auth: { apiKey: true },
  rbac: sessionMoveRbac,
});

async function withSessionMove(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  destination: string | null,
  run: (context: { actor: SessionActor; changedBy?: string; key: string | null }) => Promise<void>,
): Promise<void> {
  try {
    const changedBy = await resolveHttpAuditUserId(req, myAgentId);
    const actor = await resolveSessionActor(req, myAgentId);
    const key = destination === null ? null : await authorizeAssetKeyWrite(destination, changedBy);
    await assertAssetKeyMovesAllowed();
    await run({ actor, changedBy: changedBy ?? undefined, key });
  } catch (error) {
    if (error instanceof AssetKeyAuthorizationError) {
      jsonError(res, error.message, error.statusCode);
    } else if (error instanceof AssetKeyMovesBlockedError) {
      jsonError(res, error.message, 409);
    } else {
      throw error;
    }
  }
}

async function checkSessionMove(
  rootTaskId: string,
  actor: SessionActor,
  req: IncomingMessage,
  myAgentId: string | undefined,
  options: { ownerOnly?: boolean; destination?: string | null } = {},
): Promise<{ reason: string } | { taskIds: string[] }> {
  const root = await getTaskById(rootTaskId);
  if (!root) return { reason: SESSION_MOVE_UNAVAILABLE };
  if (options.ownerOnly) {
    if (actor.kind === "user" && (!actor.userId || root.requestedByUserId !== actor.userId)) {
      return { reason: SESSION_MOVE_OWNER_ONLY };
    }
  } else {
    const access = await sessionAccessFor(actor, root.id);
    if (access === "none") return { reason: SESSION_MOVE_UNAVAILABLE };
    if (!hasSessionAccess(access, "write")) return { reason: "Session write access required" };
  }
  if (root.parentTaskId) return { reason: "Task is not a session root" };
  const sourceError = sourceMoveError(options.destination ?? null, root);
  if (sourceError) return { reason: sourceError };
  const tasks = await getRootTaskChain(root.id);
  for (const task of tasks) {
    if (!(await canMutateTaskNamespace(task, myAgentId, req))) {
      return { reason: "Not authorized to move this task namespace" };
    }
  }
  return { taskIds: tasks.map((task) => task.id) };
}

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
        /** The group of `root` with the list's rule: a source thread with two or more roots is its own group. */
        groupKey: z.string(),
        approvals: z.array(SessionApprovalSchema).optional(),
        /** The viewer's read state, with the list's rule. Omitted for callers that act for no user. */
        readState: z.enum(["unread", "read", "later", "done"]).optional(),
        /** Newest chain activity: the read cursor that "mark read" writes. With `readState`. */
        lastActivityAt: z.string().optional(),
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
    const limit = Math.min(200, Math.max(0, parsed.query.limit ?? 25));
    if (actor.kind === "bypass" && parsed.query.scope && parsed.query.scope !== "tree") {
      // No user to own or receive a share.
      listSessions.respond(res, 200, {
        sessions: [],
        total: 0,
        limit,
        offset: parsed.query.offset ?? 0,
      });
      return true;
    }
    const filterOpts = {
      source: sources,
      hideSource: parsed.query.hideSource,
      showSource: parsed.query.showSource,
      q: parsed.query.q,
      requestedByUserId: parsed.query.requestedByUserId,
      contextKeyPrefix: parsed.query.contextKeyPrefix,
      keyPrefix: parsed.query.keyPrefix,
      groupKey: parsed.query.groupKey,
      noGroup: parsed.query.noGroup,
      triage: parsed.query.triage,
      status: parsed.query.status,
      withUserId: parsed.query.withUserId,
      now: new Date().toISOString(),
      tree: parsed.query.scope === "tree",
      mine: parsed.query.scope === "tree" && parsed.query.show !== "all",
      ...(actor.kind === "user"
        ? {
            viewer: {
              userId: actor.userId,
              scope: parsed.query.scope === "tree" ? "all" : (parsed.query.scope ?? "all"),
            } as const,
          }
        : {}),
    };
    const baseOpts = {
      ...filterOpts,
      limit,
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
      limit,
      offset: parsed.query.offset ?? 0,
    });
    return true;
  }

  if (sessionTree.match(req.method, pathSegments)) {
    const parsed = await sessionTree.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = await resolveSessionActor(req, myAgentId);
    const tree = await getSessionTree(actor, undefined, {
      mine: parsed.query.show !== "all",
      hideSource: parsed.query.hideSource,
      showSource: parsed.query.showSource,
    });
    // Labels cover hidden sources too: a pane or tab of a hidden source still names its group.
    const { sourceGroups, slackChannels, threadLabels, ...counts } = tree;
    const labels = { ...threadLabels, ...(await getSessionLabels(sourceGroups)) };
    warmSlackChannelLabels(
      slackChannels.map((id) => `shared/slack/${id}/`).filter((key) => labels[key] === undefined),
    );
    sessionTree.respond(res, 200, { ...counts, labels });
    return true;
  }

  if (triageSessionListRoute.match(req.method, pathSegments)) {
    const parsed = await triageSessionListRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = await resolveSessionActor(req, myAgentId);
    if (actor.kind !== "user" || !actor.userId) {
      jsonError(res, "Pick a user to triage sessions", 400);
      return true;
    }
    const { action, show, ...list } = parsed.body;
    const updated = await triageSessionList(
      actor.userId,
      { ...list, mine: show !== "all" },
      action,
    );
    triageSessionListRoute.respond(res, 200, { updated });
    return true;
  }

  if (moveSessions.match(req.method, pathSegments)) {
    const parsed = await moveSessions.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    await withSessionMove(
      req,
      res,
      myAgentId,
      parsed.body.groupKey,
      async ({ actor, changedBy, key }) => {
        const skipped: { rootTaskId: string; reason: string }[] = [];
        const moves: SessionKeyMove[] = [];
        for (const rootId of new Set(parsed.body.rootTaskIds)) {
          const checked = await checkSessionMove(rootId, actor, req, myAgentId, {
            destination: key,
          });
          if ("reason" in checked) {
            skipped.push({ rootTaskId: rootId, reason: checked.reason });
          } else {
            moves.push({
              rootId,
              taskIds: checked.taskIds,
              key: key ?? defaultAssetKey("task", rootId),
            });
          }
        }
        const moved = await moveSessionChains({ moves, changedBy });
        moveSessions.respond(res, 200, { moved, skipped });
      },
    );
    return true;
  }

  if (moveSessionPrefix.match(req.method, pathSegments)) {
    const parsed = await moveSessionPrefix.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const from = normalizeAssetKey(parsed.body.from);
    if (sourceOfKey(from) || (parsed.body.to && sourceOfKey(normalizeAssetKey(parsed.body.to)))) {
      jsonError(res, SOURCE_GROUPS_READ_ONLY, 400);
      return true;
    }
    if (parseAssetKey(from).relativeSegments.length === 0) {
      jsonError(res, "Cannot move a namespace root", 400);
      return true;
    }
    await withSessionMove(
      req,
      res,
      myAgentId,
      parsed.body.to,
      async ({ actor, changedBy, key }) => {
        if (key?.startsWith(from)) {
          jsonError(res, "Destination must be outside the source prefix", 400);
          return;
        }
        const skipped =
          actor.kind === "user"
            ? (await listSharedPrefixRoots({ from, userId: actor.userId })).map((root) => ({
                rootTaskId: root.id,
                reason: SESSION_MOVE_OWNER_ONLY,
              }))
            : [];
        const moves: SessionKeyMove[] = [];
        let remaining = 0;
        // Scan before moving so offsets stay stable. Only owned roots need chain authorization.
        for (let offset = 0; ; offset += SESSION_MOVE_LIMIT) {
          const roots = await listPrefixRoots({
            from,
            userId: actor.kind === "user" ? actor.userId : undefined,
            limit: SESSION_MOVE_LIMIT,
            offset,
          });
          for (const root of roots) {
            const nextKey =
              key === null ? defaultAssetKey("task", root.id) : key + root.key.slice(from.length);
            if (nextKey.startsWith(from)) {
              skipped.push({
                rootTaskId: root.id,
                reason: "The new key stays inside the source group",
              });
              continue;
            }
            if (nextKey.length > ASSET_KEY_MAX_LENGTH) {
              skipped.push({
                rootTaskId: root.id,
                reason: `Asset key cannot exceed ${ASSET_KEY_MAX_LENGTH} characters`,
              });
              continue;
            }
            const checked = await checkSessionMove(root.id, actor, req, myAgentId, {
              ownerOnly: true,
              destination: nextKey,
            });
            if ("reason" in checked) {
              skipped.push({ rootTaskId: root.id, reason: checked.reason });
            } else if (moves.length < SESSION_MOVE_LIMIT) {
              moves.push({ rootId: root.id, taskIds: checked.taskIds, key: nextKey });
            } else {
              remaining++;
            }
          }
          if (roots.length < SESSION_MOVE_LIMIT) break;
        }
        const moved = await moveSessionChains({ moves, changedBy });
        moveSessionPrefix.respond(res, 200, { moved, skipped, remaining });
      },
    );
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
    const actor = await resolveSessionActor(req, myAgentId);
    const access = await accessForRoot(actor, sessionRoot);
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
    // Load steering, citations and pending approvals for the already loaded chain.
    const tasks = [root, ...chain];
    const [steering, citations, approvals, read, groupKey] = await Promise.all([
      getTaskSteeringFieldsForTasks(tasks),
      getTaskCitationsForTasks(tasks.map((task) => task.id)),
      getPendingApprovalsForTasks(tasks.map((task) => task.id)),
      // The viewer's read state, so a client marks a session read on open
      // without the list row (the same rule as `GET /api/sessions`).
      actor.kind === "user" && actor.userId
        ? getSessionReadState(sessionRoot.id, actor.userId)
        : Promise.resolve(null),
      getSessionGroupKey(root),
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
      groupKey,
      ...(approvals.length ? { approvals } : {}),
      ...(read ?? {}),
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

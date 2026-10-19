import type { IncomingMessage } from "node:http";
import { getSteeringMessageById } from "../be/db";
import { getActiveSessionById } from "../be/db/active-sessions";
import { getUserGrant } from "../be/rbac-roles";
import {
  getSessionRoot,
  hasSessionAccess,
  type SessionAccess,
  sessionAccess,
  sessionAccessForRoot,
} from "../be/session-shares";
import { findUserById } from "../be/users";
import { isRbacEnabled } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { dashboardUserIdHeader } from "./favorite-owner";
import { type RouteDef, routePathParams } from "./route-def";

/**
 * Who a request acts for when it touches a session.
 *
 * - `bypass`: no session check. Agents (an `aseph_` token, or the operator key
 *   with `X-Agent-ID`) continue chains through `POST /api/tasks` all the time,
 *   and an operator-key call with no picked dashboard user is a script or the
 *   CLI. Both keep the access they had before sharing existed.
 * - `user`: an `aswt_` user token, or an operator-key dashboard tab naming an
 *   active user in `X-Swarm-User-Id`. On the shared key that identity is
 *   honor-system, the same trust the dashboard already gives favorites.
 *   `userId: null` is a guest page session, which has no user at all.
 */
export type SessionActor = { kind: "bypass" } | { kind: "user"; userId: string | null };

const BYPASS: SessionActor = { kind: "bypass" };

export async function resolveSessionActor(
  req: IncomingMessage,
  myAgentId: string | undefined,
): Promise<SessionActor> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  if (auth?.kind === "guest") return { kind: "user", userId: null };
  if (auth?.kind === "operator" && !myAgentId && !auth.page) {
    const picked = dashboardUserIdHeader(req);
    if (!picked) return BYPASS;
    const user = await findUserById(picked);
    return user?.status === "active" ? { kind: "user", userId: user.id } : BYPASS;
  }
  return BYPASS;
}

/** The actor's access to the session holding `taskId`; `owner` for a bypass actor. */
export async function sessionAccessFor(
  actor: SessionActor,
  taskId: string,
): Promise<SessionAccess> {
  return actor.kind === "bypass" ? "owner" : sessionAccess(actor.userId, taskId);
}

export const SESSION_READ_DENIED =
  "You don't have access to this session. Ask the owner to share it.";

/** True unless the request acts for a user who lacks read access to the task's session. */
export async function canReadSession(
  req: IncomingMessage,
  myAgentId: string | undefined,
  taskId: string,
): Promise<boolean> {
  const access = await sessionAccessFor(await resolveSessionActor(req, myAgentId), taskId);
  return hasSessionAccess(access, "read");
}

/** The SQL list filter (`readableSessionCondition`) for an actor; none for a bypass actor. */
export function readableByFor(actor: SessionActor): { userId: string | null } | undefined {
  return actor.kind === "user" ? { userId: actor.userId } : undefined;
}

export const SESSION_WRITE_DENIED =
  "You can't write in this session. Ask the owner to share it with edit access.";

/**
 * The denial for an actor lacking `needed` access to the session holding
 * `taskId`, or null. An unknown task passes, so the handler still answers 404.
 */
async function denialFor(
  actor: SessionActor,
  taskId: string,
  needed: "read" | "write",
): Promise<string | null> {
  if (actor.kind === "bypass") return null;
  const root = await getSessionRoot(taskId);
  if (!root) return null;
  if (hasSessionAccess(await sessionAccessForRoot(actor.userId, root), needed)) return null;
  return needed === "read" ? SESSION_READ_DENIED : SESSION_WRITE_DENIED;
}

export const SESSION_AGENT_WIDE_DENIED =
  "This changes sessions across a whole agent. Only the agent or the operator can call it.";

/**
 * Enforces a route's path session posture (`taskParam`, `steeringParam`,
 * `activeSessionParam`, `agentWide`) before any handler runs: a GET needs read
 * access, every other method write access.
 */
export async function pathSessionDenial(
  req: IncomingMessage,
  myAgentId: string | undefined,
  def: RouteDef,
  pathSegments: string[],
): Promise<string | null> {
  const posture = def.session;
  if (!posture || "bodyTaskIds" in posture || "none" in posture) return null;
  const actor = await resolveSessionActor(req, myAgentId);
  if (actor.kind === "bypass") return null;
  if ("agentWide" in posture) return SESSION_AGENT_WIDE_DENIED;
  const needed = def.method === "get" ? "read" : "write";
  const params = routePathParams(def, pathSegments);
  let taskId: string | undefined;
  if ("taskParam" in posture) {
    taskId = params[posture.taskParam];
  } else if ("steeringParam" in posture) {
    const message = await getSteeringMessageById(params[posture.steeringParam] ?? "");
    taskId = message?.taskId;
  } else {
    const row = await getActiveSessionById(params[posture.activeSessionParam] ?? "");
    // An unknown row passes so the handler answers; a row with no task is the agent's own.
    if (!row) return null;
    if (!row.taskId) return needed === "read" ? SESSION_READ_DENIED : SESSION_WRITE_DENIED;
    taskId = row.taskId;
  }
  if (!taskId) return null;
  return denialFor(actor, taskId, needed);
}

/** Enforces a `bodyTaskIds` posture: every task the body names needs write access. */
export async function bodySessionDenial(
  req: IncomingMessage,
  taskIds: readonly unknown[],
): Promise<string | null> {
  const ids = [...new Set(taskIds.filter((id): id is string => typeof id === "string" && !!id))];
  if (ids.length === 0) return null;
  const actor = await resolveSessionActor(req, headerAgentId(req));
  for (const id of ids) {
    const denial = await denialFor(actor, id, "write");
    if (denial) return denial;
  }
  return null;
}

function headerAgentId(req: IncomingMessage): string | undefined {
  const header = req.headers["x-agent-id"];
  return Array.isArray(header) ? header[0] : header;
}

export const USER_AGENT_HEADER_DENIED =
  "A user token cannot act as an agent. Drop X-Agent-ID, or call with the agent's own credential.";

/**
 * Refuses a user or guest token that claims agent identity: any X-Agent-ID,
 * and the agent MCP transport at all (`/mcp-user` is the user transport).
 * Runs once in `handleCore`, before any handler reads or changes state. A
 * route that sets `auth.userNamesAgent` (the dashboard script playground)
 * admits the pair for a user holding `agent.act.any`, an authorization of the
 * user, never of the named agent.
 */
export async function userAgentIdentityDenial(
  req: IncomingMessage,
  def: RouteDef | undefined,
  pathSegments: string[],
): Promise<string | null> {
  const auth = getRequestAuth(req);
  if (auth?.kind !== "user" && auth?.kind !== "guest") return null;
  if (pathSegments.length === 1 && pathSegments[0] === "mcp") return USER_AGENT_HEADER_DENIED;
  if (req.headers["x-agent-id"] === undefined) return null;
  if (auth.kind === "user" && def?.auth?.userNamesAgent) {
    if (!isRbacEnabled()) return null;
    const grant = await getUserGrant(auth.userId);
    if (grant.grantsAll || grant.verbs.has("agent.act.any")) return null;
  }
  return USER_AGENT_HEADER_DENIED;
}

import type { IncomingMessage } from "node:http";
import { hasSessionAccess, type SessionAccess, sessionAccess } from "../be/session-shares";
import { findUserById } from "../be/users";
import { getRequestAuth } from "../utils/request-auth-context";
import { dashboardUserIdHeader } from "./favorite-owner";

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

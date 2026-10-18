import type { IncomingMessage } from "node:http";
import {
  getSessionRoots,
  type SessionAccess,
  sessionAccess,
  sessionAccessForRoot,
} from "../be/session-shares";
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

/**
 * The tasks whose session the actor may read, in order. A bypass actor keeps
 * every task; a user loses the tasks of sessions not shared with them.
 */
export async function filterReadableTasks<T extends { id: string }>(
  actor: SessionActor,
  tasks: T[],
): Promise<T[]> {
  if (actor.kind === "bypass" || tasks.length === 0) return tasks;
  const roots = await getSessionRoots(tasks.map((task) => task.id));
  const readable = new Map<string, boolean>();
  for (const root of roots.values()) {
    if (readable.has(root.id)) continue;
    readable.set(root.id, (await sessionAccessForRoot(actor.userId, root)) !== "none");
  }
  return tasks.filter((task) => {
    const root = roots.get(task.id);
    return root ? readable.get(root.id) === true : false;
  });
}

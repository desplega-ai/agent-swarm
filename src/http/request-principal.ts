import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentById } from "../be/db";
import type { RbacPrincipal } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { jsonError } from "./utils";

/**
 * The RBAC principal of an HTTP request, for a handler-side `can()` check.
 * Operator and user request auth win over the X-Agent-ID header (an operator
 * bearer with any agent id stays the operator). An agent id that is not
 * registered is a non-lead agent. Null when the request has neither.
 */
export async function requestPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
): Promise<RbacPrincipal | null> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") return { kind: "operator" };
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  if (auth?.kind === "guest") return { kind: "guest" };
  if (!myAgentId) return null;
  const agent = await getAgentById(myAgentId);
  return { kind: "agent", agentId: myAgentId, isLead: agent?.isLead ?? false };
}

/**
 * The principal of a keyed HTTP request that may act as an agent. Workers share the swarm API
 * key, so the key alone authenticates as the operator. An X-Agent-ID, or an `aseph_` session
 * token, names the agent on top of it, and its lead flag is read live. A user token stays the
 * user. A request with no agent identity is the operator, as for the dashboard and the runner.
 * Unlike `requestPrincipal`, an agent identity wins over the operator key.
 */
export async function agentFirstPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
): Promise<RbacPrincipal> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  if (auth?.kind === "guest") return { kind: "guest" };
  const agentId = auth?.kind === "agent" ? auth.agentId : myAgentId;
  if (!agentId) return { kind: "operator" };
  const agent = await getAgentById(agentId);
  return { kind: "agent", agentId, isLead: agent?.isLead === true };
}

/**
 * Refuse a guest page session on a handler that has no per-route guest rule.
 * Writes a 403 and returns true when the request is a guest's.
 */
export function rejectGuest(req: IncomingMessage, res: ServerResponse): boolean {
  if (getRequestAuth(req)?.kind !== "guest") return false;
  jsonError(res, "Forbidden", 403);
  return true;
}

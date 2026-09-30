import type { IncomingMessage } from "node:http";
import { getAgentById } from "../be/db";
import type { RbacPrincipal } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";

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
  if (!myAgentId) return null;
  const agent = await getAgentById(myAgentId);
  return { kind: "agent", agentId: myAgentId, isLead: agent?.isLead ?? false };
}

import { getAgentById } from "@/be/db";
import { pageExecutionPrincipal } from "@/http/request-principal";
import { can, type PermissionVerb, type RbacPrincipal } from "@/rbac";
import { getCurrentRequestAuth } from "@/utils/request-auth-context";
import { type RequestInfo, type SwarmToolResult, toolErr } from "./utils";

/**
 * The principal behind an MCP tool call, for tools that change the shared catalog
 * (workflows and the like).
 *
 * - A page session (user or operator viewer) is the agent that owns the page.
 * - A user token is the user. A guest or controller token is a guest (every gate denies it).
 * - A session token (`aseph_`) is the agent it names; its lead flag is read from the database.
 * - The shared API key with no agent, or with an agent id that is not registered, is the
 *   operator. System runs (workflow and schedule script steps) use such ids.
 * - The shared API key with a registered agent id acts as that agent, as in `set-config`.
 * - A call with no request auth (an in-process extension call) is the agent it names.
 */
export async function catalogPrincipal(
  requestInfo: Pick<RequestInfo, "agentId">,
): Promise<RbacPrincipal> {
  const auth = getCurrentRequestAuth();
  // A page session acts as the agent that owns the page, whoever views it.
  const pagePrincipal = await pageExecutionPrincipal(auth);
  if (pagePrincipal) return pagePrincipal;
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  if (auth?.kind === "guest" || auth?.kind === "controller") return { kind: "guest" };

  const agentId = (auth?.kind === "agent" ? auth.agentId : "") || requestInfo.agentId || "";
  const agent = agentId ? await getAgentById(agentId) : null;
  if (auth?.kind === "operator" && !agent) return { kind: "operator" };
  return { kind: "agent", agentId, isLead: agent?.isLead === true };
}

/** A `toolErr` when the caller may not use `verb`, otherwise null. */
export async function denyCatalog(
  requestInfo: Pick<RequestInfo, "agentId">,
  verb: PermissionVerb,
  message: string,
): Promise<SwarmToolResult | null> {
  const principal = await catalogPrincipal(requestInfo);
  const decision = can({ principal, verb, resource: { kind: "none" }, source: "mcp" });
  if (decision.allow) return null;
  return toolErr(message, { data: { yourAgentId: requestInfo.agentId } });
}

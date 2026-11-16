import type { IncomingMessage } from "node:http";
import { getUserGrant } from "../be/rbac-roles";
import { findUserById } from "../be/users";
import { can, isRbacEnabled, type PermissionVerb } from "../rbac";
import type { User } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { agentFirstPrincipal, authUser } from "./request-principal";

export type ApprovalResponder = { kind: "user"; user: User } | { kind: "operator" };

const AGENT_RESPONSE_REFUSED =
  "Agents cannot answer approval requests. A person must respond with a user token or the dashboard.";

/**
 * The person answering an approval request, taken from the credential and
 * never from the request body. Every agent identity is refused: an `aseph_`
 * session token, the shared key with an `X-Agent-ID`, and a page session with
 * no signed-in user (page code is agent-authored, so it cannot vouch for a
 * person). The shared key alone is the operator.
 *
 * `verb` and `refusedMessage` let other person-gated actions reuse the check
 * with their own permission and wording. With RBAC on, a user must also hold
 * `verb` through a role: route admission checks only the route's own verb, and
 * a route admitted on another verb can still reach this check.
 */
export async function approvalResponder(
  req: IncomingMessage,
  options?: { verb?: PermissionVerb; refusedMessage?: string; pageMessage?: string },
): Promise<{ ok: true; responder: ApprovalResponder } | { ok: false; message: string }> {
  const auth = getRequestAuth(req);
  const rawAgentId = req.headers["x-agent-id"];
  const headerAgentId = Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId;
  const principal = await agentFirstPrincipal(req, headerAgentId);

  if (principal.kind !== "user" && principal.kind !== "agent" && auth?.page) {
    return {
      ok: false,
      message:
        options?.pageMessage ??
        "A page session without a signed-in user cannot answer approval requests.",
    };
  }
  const user = authUser(auth);
  const responder: ApprovalResponder | null =
    principal.kind === "user" && user
      ? { kind: "user", user }
      : principal.kind === "operator"
        ? { kind: "operator" }
        : null;

  const verb = options?.verb ?? "approval.respond";
  const refused = {
    ok: false as const,
    message: options?.refusedMessage ?? AGENT_RESPONSE_REFUSED,
  };
  const decision = can({ principal, verb, source: "http" });
  if (!decision.allow || !responder) return refused;
  if (responder.kind === "user" && isRbacEnabled()) {
    const grant = await getUserGrant(responder.user.id);
    if (!grant.grantsAll && !grant.verbs.has(verb)) return refused;
  }
  return { ok: true, responder };
}

export function responderKey(responder: ApprovalResponder): string {
  return responder.kind === "user" ? responder.user.id : "operator";
}

/**
 * The responder for a person identified outside HTTP, such as a chat user
 * mapped through `user_external_ids`. Applies the checks `approvalResponder`
 * applies to a user credential: an active, unmerged account (what credential
 * resolution requires), the `approval.respond` verb and, with RBAC on, a role
 * that grants it.
 */
export async function userApprovalResponder(
  userId: string,
): Promise<{ ok: true; responder: ApprovalResponder } | { ok: false; message: string }> {
  const refused = {
    ok: false as const,
    message: "You are not allowed to answer approval requests.",
  };
  const user = await findUserById(userId);
  // Credential resolution refuses invited, suspended and merged-away users, so
  // a chat identity mapped to one must not answer either.
  if (!user || user.status !== "active" || user.mergedIntoUserId) return refused;
  const verb: PermissionVerb = "approval.respond";
  if (!can({ principal: { kind: "user", userId }, verb, source: "http" }).allow) return refused;
  if (isRbacEnabled()) {
    const grant = await getUserGrant(userId);
    if (!grant.grantsAll && !grant.verbs.has(verb)) return refused;
  }
  return { ok: true, responder: { kind: "user", user } };
}

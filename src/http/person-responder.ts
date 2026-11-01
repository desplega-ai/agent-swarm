import type { IncomingMessage } from "node:http";
import { can, type PermissionVerb } from "../rbac";
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
 * with their own permission and wording.
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

  const decision = can({ principal, verb: options?.verb ?? "approval.respond", source: "http" });
  if (!decision.allow || !responder) {
    return { ok: false, message: options?.refusedMessage ?? AGENT_RESPONSE_REFUSED };
  }
  return { ok: true, responder };
}

export function responderKey(responder: ApprovalResponder): string {
  return responder.kind === "user" ? responder.user.id : "operator";
}

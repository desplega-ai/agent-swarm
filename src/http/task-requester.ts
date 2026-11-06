import type { IncomingMessage } from "node:http";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { findUserById } from "../be/users";
import { can } from "../rbac";
import { agentFirstPrincipal } from "./request-principal";

/**
 * Requester for a new task. Prefer trusted server-side identity: an
 * authenticated request user, or the caller's own ownership-gated task context
 * (`X-Source-Task-Id` / ambient current task), the upstream #939 anti-spoofing
 * behavior.
 *
 * TRUST_BODY_REQUESTED_BY_USER_ID (default ON) accepts a body-supplied
 * `requestedByUserId` as a last resort, only when the caller could not be
 * bound to a user (shared operator key), and only after validating it names a
 * real user. Typical single-tenant deployments share ONE operator key, so
 * without this the UI and API callers can never attribute tasks. Set
 * TRUST_BODY_REQUESTED_BY_USER_ID=false anywhere holders of the shared/global
 * key are NOT all equally trusted: with it on, any such caller can attribute
 * a task to any user.
 *
 * Pass `trustedUserId` when the caller already resolved it.
 *
 * Lives outside `tasks.ts` so route modules can share it without importing the
 * task routes, which would change route registration order (and `openapi.json`).
 */
export async function resolveTaskRequester(
  req: IncomingMessage,
  myAgentId: string | undefined,
  bodyUserId: string | undefined,
  trustedUserId?: string | null,
): Promise<string | undefined> {
  const trusted =
    trustedUserId === undefined ? await resolveHttpAuditUserId(req, myAgentId) : trustedUserId;
  if (trusted) return trusted;
  if (process.env.TRUST_BODY_REQUESTED_BY_USER_ID === "false" || !bodyUserId) return undefined;
  // A worker on the shared key is not the operator: its X-Agent-ID names it, so the body
  // hint is dropped like it is when the worker has a requester of its own.
  const mayAssign = can({
    principal: await agentFirstPrincipal(req, myAgentId),
    verb: "task.requester.assign",
    resource: { kind: "none" },
    source: "http",
  }).allow;
  return mayAssign ? (await findUserById(bodyUserId))?.id : undefined;
}

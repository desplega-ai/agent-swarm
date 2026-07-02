import type { IncomingMessage } from "node:http";
import { getRequestAuth } from "../utils/request-auth-context";
import { getTaskById } from "./db";

/**
 * Resolve the trusted audit-actor user id for a write to an audited table
 * (`scripts` / `workflows` / `scheduled_tasks`).
 *
 * Audit attribution MUST NOT be spoofable by a client-supplied header. The
 * `X-Source-Task-Id` header names the task on whose behalf a write happens, but
 * on its own a caller could name ANY task id and inherit that task's requester
 * as the audit actor. We close that hole by only trusting the source task when
 * it is actually assigned to the calling agent: a caller can then only ever
 * attribute a write to a task they already own, whose requester is legitimately
 * theirs.
 *
 * Returns `null` when no trusted actor can be established — which leaves the
 * audit column untouched on updates and NULL on inserts.
 */
export function resolveTaskAuditUserId(
  sourceTaskId: string | undefined,
  callerAgentId: string | undefined,
): string | null {
  if (!sourceTaskId || !callerAgentId) return null;
  const task = getTaskById(sourceTaskId);
  if (!task) return null;
  // Bind the header to the caller's own task — otherwise it is just a
  // client-chosen value and its requester cannot be trusted.
  if (task.agentId !== callerAgentId) return null;
  return task.requestedByUserId ?? null;
}

/**
 * HTTP variant of {@link resolveTaskAuditUserId}.
 *
 * Resolves the audit actor from trusted server-side request context first (an
 * authenticated request user is never client-controlled), then falls back to
 * the ownership-validated `X-Source-Task-Id` resolution.
 */
export function resolveHttpAuditUserId(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): string | null {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") return auth.userId;
  const header = req.headers["x-source-task-id"];
  const sourceTaskId = Array.isArray(header) ? header[0] : header;
  return resolveTaskAuditUserId(sourceTaskId, callerAgentId);
}

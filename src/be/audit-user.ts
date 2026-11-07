import type { IncomingMessage } from "node:http";
import { authUserId, getRequestAuth } from "../utils/request-auth-context";
import { getAgentCurrentTask, getTaskById } from "./db";
import { findUserByExternalId } from "./users";

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
 * Two fallbacks layer on top of the header, both still gated by ownership:
 *   1. No header at all → the caller's own current in-progress task (never a
 *      client-supplied id, so this can't be spoofed).
 *   2. The resolved task has no `requestedByUserId` but carries a
 *      machine-recorded provider external id (today: the Slack user field) →
 *      the same generic reverse lookup used everywhere else.
 *
 * Returns `null` when no trusted actor can be established — which leaves the
 * audit column untouched on updates and NULL on inserts.
 */
export async function resolveTaskAuditUserId(
  sourceTaskId: string | undefined,
  callerAgentId: string | undefined,
): Promise<string | null> {
  if (!callerAgentId) return null;

  let resolvedSourceTaskId = sourceTaskId;
  if (!resolvedSourceTaskId) {
    const currentTask = await getAgentCurrentTask(callerAgentId);
    if (currentTask) resolvedSourceTaskId = currentTask.id;
  }
  if (!resolvedSourceTaskId) return null;

  const task = await getTaskById(resolvedSourceTaskId);
  if (!task) return null;
  // Bind the header to the caller's own task — otherwise it is just a
  // client-chosen value and its requester cannot be trusted.
  if (task.agentId !== callerAgentId) return null;

  if (task.requestedByUserId) return task.requestedByUserId;

  if (task.slackUserId) {
    const user = await findUserByExternalId("slack", task.slackUserId);
    if (user) return user.id;
  }

  return null;
}

const firstHeader = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);

/**
 * The person an HTTP request acts for, for identity and authorization: a
 * workflow run's or task's requester, asset-key and OAuth ownership, tracker
 * authorization. Trusted request user first, else the ownership-validated
 * `X-Source-Task-Id` task (or the caller's current task).
 *
 * Never reads `X-Audit-Source-Task-Id`: a script run's task attributes its
 * writes, but must not hand its requester to the workflows, tasks or grants
 * the script creates.
 */
export async function resolveHttpRequesterUserId(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): Promise<string | null> {
  const userId = authUserId(getRequestAuth(req));
  if (userId) return userId;
  return resolveTaskAuditUserId(firstHeader(req.headers["x-source-task-id"]), callerAgentId);
}

/**
 * The person to record in a `created_by` / `updated_by` audit column. Same as
 * {@link resolveHttpRequesterUserId}, plus the audit-only
 * `X-Audit-Source-Task-Id` that script `ctx.swarm` calls send (same ownership
 * gate). Use it for audit attribution only; identity and authorization use
 * {@link resolveHttpRequesterUserId}.
 */
export async function resolveHttpAuditUserId(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): Promise<string | null> {
  const userId = authUserId(getRequestAuth(req));
  if (userId) return userId;
  const sourceTaskId =
    firstHeader(req.headers["x-source-task-id"]) ??
    firstHeader(req.headers["x-audit-source-task-id"]);
  return resolveTaskAuditUserId(sourceTaskId, callerAgentId);
}

/**
 * Who made a write: the calling agent (NULL for a human or system write) and
 * the person behind it. Audited tables store it as `createdByAgentId` /
 * `created_by` on insert and `updatedByAgentId` / `updated_by` on update.
 */
export type AuditActor = { agentId: string | null; userId: string | null };

/** {@link resolveHttpAuditUserId} plus the calling agent, for HTTP routes. */
export async function resolveHttpAuditActor(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): Promise<AuditActor> {
  return {
    agentId: callerAgentId ?? null,
    userId: await resolveHttpAuditUserId(req, callerAgentId),
  };
}

import type { IncomingMessage } from "node:http";
import { isGroupKey } from "../assets/key";
import { sourceOfKey } from "../assets/source-key";
import { authUserId, getRequestAuth } from "../utils/request-auth-context";
import { getAgentCurrentTask, getTaskById } from "./db";
import { findUserByExternalId } from "./users";

/** Resolve a source task only when the calling agent owns it. */
async function resolveCallerTask(
  sourceTaskId: string | undefined,
  callerAgentId: string | undefined,
) {
  if (!callerAgentId) return null;
  const task = sourceTaskId
    ? await getTaskById(sourceTaskId)
    : await getAgentCurrentTask(callerAgentId);
  return task?.agentId === callerAgentId ? task : null;
}

/**
 * Return the calling task's group key, excluding namespace roots, resource
 * leaves and source groups (a Slack channel or chat thread is not a user group).
 */
export async function resolveTaskGroupKey(
  sourceTaskId: string | undefined,
  callerAgentId: string | undefined,
): Promise<string | undefined> {
  const task = await resolveCallerTask(sourceTaskId, callerAgentId);
  return task && isGroupKey(task.key) && !sourceOfKey(task.key) ? task.key : undefined;
}

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
  const task = await resolveCallerTask(sourceTaskId, callerAgentId);
  if (!task) return null;

  if (task.requestedByUserId) return task.requestedByUserId;

  if (task.slackUserId) {
    const user = await findUserByExternalId("slack", task.slackUserId);
    if (user) return user.id;
  }

  return null;
}

/**
 * HTTP variant of {@link resolveTaskAuditUserId}.
 *
 * Resolves the audit actor from trusted server-side request context first (an
 * authenticated request user is never client-controlled), then falls back to
 * the ownership-validated `X-Source-Task-Id` resolution.
 */
export async function resolveHttpAuditUserId(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): Promise<string | null> {
  const userId = authUserId(getRequestAuth(req));
  if (userId) return userId;
  const header = req.headers["x-source-task-id"];
  const sourceTaskId = Array.isArray(header) ? header[0] : header;
  return resolveTaskAuditUserId(sourceTaskId, callerAgentId);
}

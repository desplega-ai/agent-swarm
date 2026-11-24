import { TERMINAL_TASK_STATUSES } from "../../types";
import { getStorage } from "../storage";

/**
 * `session_summaries` and `session_members` (migration 253) store the session
 * chain walk: one row per root with its chain aggregates, and the root of
 * every chain task. Triggers keep them exact on every task, steering and
 * approval write. The one exception is a deleted task's descendants: a
 * trigger body cannot walk the chain, so `deleteTask` calls
 * {@link dropSessionDescendants} before the DELETE.
 */

/**
 * Drop the members rows of a task's descendants. Once the task is gone, the
 * chain walk no longer reaches them, so they belong to no session. Call it in
 * the delete's transaction, before the DELETE; the delete trigger then
 * recomputes the chain's summary.
 */
export async function dropSessionDescendants(taskId: string): Promise<void> {
  await getStorage().repos.sessions.dropSessionDescendants(taskId);
}

export interface SessionSummaryDrift {
  rootId: string;
  /** The field that differs, or `member` for a chain task whose members row is wrong. */
  field:
    | "summary-missing"
    | "summary-extra"
    | "chainCount"
    | "lastActivityAt"
    | "latestStatus"
    | "pendingApproval"
    | "openTasks"
    | "lastHumanAt"
    | "member";
  expected: string | number | null;
  stored: string | number | null;
}

/**
 * Read-only drift check: compares the stored summaries and members with a
 * fresh chain walk (the rule `legacySessionSummaryQuery` applies). Returns one
 * row per mismatch, so an empty result means the tables are exact. With
 * `since`, only roots whose chain activity is at or after it are compared.
 * `latestStatus` is skipped when two chain tasks tie on the newest
 * `lastUpdatedAt`: the walk then picks an arbitrary one.
 */
export async function findSessionSummaryDrift(
  since: string | null = null,
): Promise<SessionSummaryDrift[]> {
  const rows = await getStorage().repos.sessions.findSessionSummaryDrift(
    since,
    TERMINAL_TASK_STATUSES,
  );
  return rows as SessionSummaryDrift[];
}

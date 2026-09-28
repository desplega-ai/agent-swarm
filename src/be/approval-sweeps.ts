import {
  createApprovalFollowUpTask,
  postApprovalCancellationUpdates,
} from "../workflows/approval-notifications";
import { cancelWorkflowRun } from "../workflows/resume";
import {
  type ApprovalRequest,
  cancelApprovalRequestById,
  getExpiredPendingApprovals,
  getStaleApprovalRequests,
  getWorkflowRun,
  resolveApprovalRequest,
} from "./db";

export const DEFAULT_APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS = 7;

// Days a pending approval request with no explicit expiresAt may wait before
// the heartbeat sweep cancels it. 0 turns auto-cancellation off.
//
// Read DYNAMICALLY, not captured at module load: this module is imported by
// the heartbeat before `loadGlobalConfigsIntoEnv()` hydrates swarm_config
// into `process.env`, so a module-level capture would leave a
// dashboard-saved override permanently inert (even across restarts).
export function approvalRequestAutoCancellationDays(): number {
  const raw = process.env.APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS;
  if (raw != null && /^\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return DEFAULT_APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS;
}

const LIVE_RUN_STATUSES = new Set(["running", "waiting"]);

/**
 * Cancel every pending request with no explicit expiresAt that is older than
 * APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS. A request that gates a live
 * workflow run cancels that run too. Creates no follow-up task and emits no
 * workflow event.
 */
export async function autoCancelStaleApprovalRequests(
  now = new Date(),
): Promise<{ cancelled: ApprovalRequest[]; runsCancelled: string[] }> {
  const days = approvalRequestAutoCancellationDays();
  if (days === 0) return { cancelled: [], runsCancelled: [] };

  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const stale = await getStaleApprovalRequests({ cutoff });
  const reason = `Auto-cancelled by the approval sweep after ${days} days with no response`;

  const cancelled: ApprovalRequest[] = [];
  for (const row of stale) {
    const updated = await cancelApprovalRequestById(row.id, { reason, resolvedBy: null });
    if (updated) cancelled.push(updated);
  }

  // Cancel the request first so it keeps the sweep's reason; the run cancel
  // then skips it because it is no longer pending.
  const runsCancelled: string[] = [];
  for (const row of cancelled) {
    const runId = row.workflowRunId;
    if (!runId || runsCancelled.includes(runId)) continue;
    const run = await getWorkflowRun(runId);
    if (!run || !LIVE_RUN_STATUSES.has(run.status)) continue;
    try {
      await cancelWorkflowRun(runId, reason);
      runsCancelled.push(runId);
    } catch (err) {
      console.error(
        `[approval-sweep] could not cancel workflow run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await postApprovalCancellationUpdates(cancelled, "auto-cancelled with no response");

  if (cancelled.length > 0) {
    console.log(
      `[approval-sweep] auto-cancelled ${cancelled.length} stale approval requests and ${runsCancelled.length} workflow runs`,
    );
  }
  return { cancelled, runsCancelled };
}

/**
 * Set `timeout` on every pending request whose explicit expiresAt passed,
 * whatever the state of its workflow run. A standalone request whose source
 * task is still active gets a `hitl.timeout` follow-up task.
 */
export async function timeoutExpiredApprovalRequests(
  now = new Date(),
): Promise<{ timedOut: ApprovalRequest[] }> {
  const expired = await getExpiredPendingApprovals({ now: now.toISOString() });
  const timedOut: ApprovalRequest[] = [];
  for (const row of expired) {
    const updated = await resolveApprovalRequest(row.id, {
      status: "timeout",
      resolutionReason: `Timed out by the approval sweep: no answer before ${row.expiresAt}`,
    });
    if (updated) timedOut.push(updated);
  }
  for (const row of timedOut) {
    await createApprovalFollowUpTask(row, "hitl.timeout");
  }

  if (timedOut.length > 0) {
    console.log(`[approval-sweep] timed out ${timedOut.length} expired approval requests`);
  }
  return { timedOut };
}

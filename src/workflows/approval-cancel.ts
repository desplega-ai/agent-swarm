import {
  type ApprovalRequest,
  cancelApprovalRequestById,
  getApprovalRequestById,
  getDbClient,
  getTaskById,
  getWorkflowRun,
  listCancelledApprovalRequestsForRun,
} from "../be/db";
import { can, type RbacPrincipal } from "../rbac";
import { postApprovalCancellationUpdates } from "./approval-notifications";
import { cancelWorkflowRunRows } from "./resume";

export type CancelApprovalRequestResult =
  | { ok: true; request: ApprovalRequest; alreadyCancelled: boolean; runCancelled: boolean }
  | { ok: false; status: 403 | 404 | 409; message: string };

const LIVE_RUN_STATUSES = new Set(["running", "waiting"]);

/**
 * Cancel 1 pending approval request. Shared by the HTTP route, the MCP tool,
 * and the dashboard Discard button. A request that gates a live workflow run
 * cancels that run too.
 */
export async function cancelApprovalRequest(input: {
  id: string;
  reason?: string;
  principal: RbacPrincipal;
  resolvedBy: string | null;
  source?: "http" | "mcp";
}): Promise<CancelApprovalRequestResult> {
  const finalReason = input.reason ?? "Cancelled through the API";
  let authorized = false;

  // A null write means a concurrent change; re-read and apply the rules again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getApprovalRequestById(input.id);
    if (!existing) return { ok: false, status: 404, message: "Approval request not found" };
    if (existing.status === "cancelled") {
      return { ok: true, request: existing, alreadyCancelled: true, runCancelled: false };
    }
    if (existing.status !== "pending") {
      return {
        ok: false,
        status: 409,
        message: `Approval request already resolved with status: ${existing.status}`,
      };
    }

    if (!authorized) {
      const ownerAgentId = existing.sourceTaskId
        ? ((await getTaskById(existing.sourceTaskId))?.agentId ?? null)
        : null;
      const decision = can({
        principal: input.principal,
        verb: "approval.cancel.any",
        resource: { kind: "owned", ownerAgentId },
        source: input.source ?? "http",
      });
      if (!decision.allow) return { ok: false, status: 403, message: decision.reason };
      authorized = true;
    }

    const result = await cancelApprovalRequestAndRun(input.id, {
      reason: finalReason,
      resolvedBy: input.resolvedBy,
    });
    if (!result) continue;
    return {
      ok: true,
      request: result.request,
      alreadyCancelled: false,
      runCancelled: result.runCancelled,
    };
  }

  return { ok: false, status: 409, message: "Approval request changed during cancellation" };
}

/**
 * Cancel 1 pending request and its live workflow run in 1 transaction: both
 * commit, or neither does. The Slack thread updates run after COMMIT.
 * Returns null when the request was not pending.
 */
export async function cancelApprovalRequestAndRun(
  id: string,
  data: { reason: string; resolvedBy: string | null; slackReason?: string },
): Promise<{ request: ApprovalRequest; runCancelled: boolean } | null> {
  const client = getDbClient();
  return await client.transaction(async () => {
    const request = await cancelApprovalRequestById(id, {
      reason: data.reason,
      resolvedBy: data.resolvedBy,
    });
    if (!request) return null;

    // The request is cancelled first so it keeps this reason; the run cancel
    // then skips it because it is no longer pending.
    let runCancelled = false;
    const runId = request.workflowRunId;
    if (runId) {
      const run = await getWorkflowRun(runId);
      if (run && LIVE_RUN_STATUSES.has(run.status)) {
        runCancelled = await cancelWorkflowRunRows(runId, data.reason);
      }
    }

    const slackReason = data.slackReason ?? data.reason;
    client.afterCommit(async () => {
      await postApprovalCancellationUpdates([request], slackReason);
      if (runCancelled && runId) {
        // Other requests the run cancel closed get the run's reason.
        const others = (await listCancelledApprovalRequestsForRun(runId)).filter(
          (row) => row.id !== request.id,
        );
        await postApprovalCancellationUpdates(others, data.reason);
      }
    });
    return { request, runCancelled };
  });
}

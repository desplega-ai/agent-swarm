import {
  type ApprovalRequest,
  cancelApprovalRequestById,
  getApprovalRequestById,
  getTaskById,
  getWorkflowRun,
} from "../be/db";
import { can, type RbacPrincipal } from "../rbac";
import { postApprovalCancellationUpdates } from "./approval-notifications";
import { cancelWorkflowRun } from "./resume";

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

    const cancelled = await cancelApprovalRequestById(input.id, {
      reason: finalReason,
      resolvedBy: input.resolvedBy,
    });
    if (!cancelled) continue;

    let runCancelled = false;
    if (cancelled.workflowRunId) {
      const run = await getWorkflowRun(cancelled.workflowRunId);
      if (run && LIVE_RUN_STATUSES.has(run.status)) {
        try {
          await cancelWorkflowRun(cancelled.workflowRunId, finalReason);
          runCancelled = true;
        } catch (err) {
          console.error(
            `[approval-cancel] could not cancel workflow run ${cancelled.workflowRunId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await postApprovalCancellationUpdates([cancelled], finalReason);
    return { ok: true, request: cancelled, alreadyCancelled: false, runCancelled };
  }

  return { ok: false, status: 409, message: "Approval request changed during cancellation" };
}

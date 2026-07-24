import { hasNonTerminalRerouteDecisionChild } from "../be/db";
import {
  type CreateRoutingBlockDecisionResult,
  createRoutingBlockDecisionTaskForExistingTask,
} from "../tasks/worker-follow-up";
import type { AgentTask } from "../types";
import { buildRoutingCtx } from "./ctx";
import { runBeforeAssign } from "./engine";

export type ClaimRoutingResult =
  | { kind: "proceed" }
  | { kind: "redirected"; agentId: string }
  | {
      kind: "blocked";
      reason: string;
      decision: CreateRoutingBlockDecisionResult;
    }
  /** A prior block already produced a live Lead reroute-decision — skip without re-running handlers. */
  | { kind: "pending-decision" };

/**
 * Evaluate an existing pooled task for one proposed claimant. Callers must run
 * this before entering their claim transaction; the later atomic claim UPDATE
 * remains the race-safe final arbiter.
 *
 * Claim-time mutations/directives are traced by the engine but intentionally
 * not persisted: there is no existing synchronous helper for updating all
 * supported routing mutation fields on an existing task row.
 */
export async function runClaimRouting(
  task: AgentTask,
  proposedAgentId: string,
): Promise<ClaimRoutingResult> {
  // A blocked pooled task stays unassigned and gets re-fed to every poller and
  // heartbeat sweep; once its Lead reroute-decision exists, skip without
  // spawning handler subprocesses again.
  if (hasNonTerminalRerouteDecisionChild(task.id)) {
    return { kind: "pending-decision" };
  }
  const decision = await runBeforeAssign(
    buildRoutingCtx("claim", task, {
      proposedAgentId,
    }),
  );

  if (decision.final?.block) {
    return {
      kind: "blocked",
      reason: decision.final.block.reason,
      decision: createRoutingBlockDecisionTaskForExistingTask({
        task,
        reason: decision.final.block.reason,
        proposedAgentId,
      }),
    };
  }

  if (decision.final?.assignTo && decision.final.assignTo !== proposedAgentId) {
    return { kind: "redirected", agentId: decision.final.assignTo };
  }

  return { kind: "proceed" };
}

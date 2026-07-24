import { hasNonTerminalRerouteDecisionChild, updateTaskRoutingDirectives } from "../be/db";
import {
  type CreateRoutingBlockDecisionResult,
  createRoutingBlockDecisionTaskForExistingTask,
} from "../tasks/worker-follow-up";
import type { AgentTask } from "../types";
import { buildRoutingCtx } from "./ctx";
import { runBeforeAssign } from "./engine";

const MAX_STORED_DIRECTIVES = 20;

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
 * Claim-time directives are persisted before the atomic claim UPDATE. Other
 * mutations remain intentionally unsupported for existing rows.
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

  if (decision.promptDirectives.length > 0 || decision.suggestions.length > 0) {
    // Pooled tasks are re-evaluated on every poll until claimed (e.g. while a
    // redirect target hasn't polled yet), so persistence must be idempotent:
    // dedupe against what's already stored and cap growth, and skip the write
    // entirely when nothing new arrived.
    const existing = task.routingDirectives;
    const directives = [
      ...new Set([...(existing?.directives ?? []), ...decision.promptDirectives]),
    ].slice(0, MAX_STORED_DIRECTIVES);
    const suggestionKey = (s: { handlerName: string; assignTo?: string }) =>
      `${s.handlerName}|${s.assignTo ?? ""}`;
    const seen = new Set((existing?.suggestions ?? []).map(suggestionKey));
    const suggestions = [
      ...(existing?.suggestions ?? []),
      ...decision.suggestions.filter((s) => !seen.has(suggestionKey(s))),
    ].slice(0, MAX_STORED_DIRECTIVES);
    const changed =
      directives.length !== (existing?.directives?.length ?? 0) ||
      suggestions.length !== (existing?.suggestions?.length ?? 0);
    if (changed) {
      updateTaskRoutingDirectives(task.id, {
        directives,
        suggestions,
        routingRunId: decision.routingRunId,
      });
    }
  }

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

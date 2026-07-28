import { createTaskExtended, resolveEffectiveTaskOptions } from "../be/db";
import { backfillTraceTaskId } from "../be/routing-trace-db";
import { applyRoutingDecisionToOptions, type RoutedCreateTaskOptions } from "../routing/apply";
import { buildRoutingCtx } from "../routing/ctx";
import { runBeforeAssign } from "../routing/engine";
import { validateRoutingAssignTarget } from "../routing/target";
import type { AgentTask } from "../types";
import { tryCreateRoutingBlockDecisionTask } from "./worker-follow-up";

export { applyRoutingDecisionToOptions, type RoutedCreateTaskOptions };

/**
 * Discriminated creation outcome: callers must not report a routing block as a
 * normal create. On `blocked`, the requested work task was intentionally NOT
 * created; `blocked.decisionTask` is the Lead reroute-decision task, absent
 * when no Lead exists to adjudicate (a structured outcome, not an exception —
 * this surfaces through Slack ingestion and MCP tool responses).
 */
export type CreateTaskRoutedResult =
  | { task: AgentTask; blocked?: undefined }
  | { task?: undefined; blocked: { reason: string; decisionTask?: AgentTask } };

/**
 * Hook-enabled task creation pilot. Slack ingestion, send-task, and task-action
 * use this wrapper; workflows, schedules, heartbeat, and VCS ingresses remain
 * deliberately unhooked on createTaskExtended until later routing phases.
 */
export async function createTaskRouted(
  description: string,
  options: RoutedCreateTaskOptions = {},
): Promise<CreateTaskRoutedResult> {
  if (options._routingDone) {
    return { task: createTaskExtended(description, options) };
  }

  const settled = resolveEffectiveTaskOptions(description, { ...options });
  const settledOptions = settled.options ?? {};
  const ctx = buildRoutingCtx("creation", settled, {
    proposedAgentId: settledOptions.agentId ?? undefined,
  });
  const decision = await runBeforeAssign(ctx);

  // Fail open on bogus hard-assign targets: an unknown or lead agentId from a
  // handler must not break (or misroute) task creation.
  if (
    decision.final?.assignTo &&
    !validateRoutingAssignTarget(decision.final.assignTo, "creation")
  ) {
    decision.final = decision.final.block ? { ...decision.final, assignTo: undefined } : undefined;
  }

  const finalOptions = applyRoutingDecisionToOptions(settledOptions, decision);

  if (decision.final?.block) {
    const reason = decision.final.block.reason;
    const decisionTask = tryCreateRoutingBlockDecisionTask({
      description: settled.description,
      reason,
      options: finalOptions,
    });
    if (!decisionTask) return { blocked: { reason } };
    backfillTraceTaskId(decision.routingRunId, decisionTask.id);
    return { blocked: { reason, decisionTask } };
  }

  const task = createTaskExtended(settled.description, finalOptions);
  backfillTraceTaskId(decision.routingRunId, task.id);
  return { task };
}

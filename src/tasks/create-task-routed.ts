import { createTaskExtended, getAgentById, resolveEffectiveTaskOptions } from "../be/db";
import { backfillTraceTaskId } from "../be/routing-trace-db";
import { applyRoutingDecisionToOptions, type RoutedCreateTaskOptions } from "../routing/apply";
import { buildRoutingCtx } from "../routing/ctx";
import { runBeforeAssign } from "../routing/engine";
import type { AgentTask } from "../types";
import { createRoutingBlockDecisionTask } from "./worker-follow-up";

export { applyRoutingDecisionToOptions, type RoutedCreateTaskOptions };

/**
 * Discriminated creation outcome: callers must not report a routing block as a
 * normal create. On `blocked`, `task` is the Lead reroute-decision task, NOT
 * the requested work task (which was intentionally not created).
 */
export type CreateTaskRoutedResult = {
  task: AgentTask;
  blocked?: { reason: string };
};

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
  if (decision.final?.assignTo) {
    const target = getAgentById(decision.final.assignTo);
    if (!target || target.isLead) {
      console.warn(
        `[routing] Ignoring handler assignTo "${decision.final.assignTo}" (${
          target ? "lead agent" : "unknown agent"
        }) — falling back to default assignment`,
      );
      decision.final = decision.final.block
        ? { ...decision.final, assignTo: undefined }
        : undefined;
    }
  }

  const finalOptions = applyRoutingDecisionToOptions(settledOptions, decision);

  if (decision.final?.block) {
    const reason = decision.final.block.reason;
    const decisionTask = createRoutingBlockDecisionTask({
      description: settled.description,
      reason,
      options: finalOptions,
    });
    backfillTraceTaskId(decision.routingRunId, decisionTask.id);
    return { task: decisionTask, blocked: { reason } };
  }

  const task = createTaskExtended(settled.description, finalOptions);
  backfillTraceTaskId(decision.routingRunId, task.id);
  return { task };
}

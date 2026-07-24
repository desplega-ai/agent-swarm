import {
  type CreateTaskOptions,
  createTaskExtended,
  getAgentById,
  resolveEffectiveTaskOptions,
} from "../be/db";
import { backfillTraceTaskId } from "../be/routing-trace-db";
import { buildRoutingCtx } from "../routing/ctx";
import { runBeforeAssign } from "../routing/engine";
import type { RoutingDecision, RoutingSuggestion } from "../routing/types";
import type { AgentTask } from "../types";
import { createRoutingBlockDecisionTask } from "./worker-follow-up";

export type RoutedCreateTaskOptions = CreateTaskOptions & {
  /**
   * Internal, non-persisted double-fire guard. Delegation runs the engine with
   * via=delegation, then stamps the downstream creation wrapper so it does not
   * run the same task through via=creation as well.
   */
  _routingDone?: boolean;
};

type Phase6RoutingCarrier = {
  promptDirectives?: string[];
  routingSuggestions?: RoutingSuggestion[];
};

export function applyRoutingDecisionToOptions(
  options: RoutedCreateTaskOptions,
  decision: RoutingDecision,
): RoutedCreateTaskOptions {
  const finalOptions: RoutedCreateTaskOptions = { ...options };
  if (decision.final?.assignTo) {
    finalOptions.agentId = decision.final.assignTo;
  }
  if (decision.mutations.tags) {
    finalOptions.tags = [...new Set([...(finalOptions.tags ?? []), ...decision.mutations.tags])];
  }
  if (decision.mutations.routingAffinity) {
    finalOptions.routingAffinity = decision.mutations.routingAffinity;
  }
  if (decision.mutations.modelTier) finalOptions.modelTier = decision.mutations.modelTier;
  if (decision.mutations.priority !== undefined) {
    finalOptions.priority = decision.mutations.priority;
  }

  // Phase 6 adds durable prompt-routing fields. Until then, preserve these
  // values only for callers that already supplied in-memory carrier fields;
  // do not invent or persist a new task column here.
  const carrier = finalOptions as RoutedCreateTaskOptions & Phase6RoutingCarrier;
  if (Object.hasOwn(finalOptions, "promptDirectives")) {
    carrier.promptDirectives = [...(carrier.promptDirectives ?? []), ...decision.promptDirectives];
  }
  if (Object.hasOwn(finalOptions, "routingSuggestions")) {
    carrier.routingSuggestions = [...(carrier.routingSuggestions ?? []), ...decision.suggestions];
  }
  return finalOptions;
}

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

import type { CreateTaskOptions } from "../be/db";
import type { RoutingDecision } from "./types";

export type RoutedCreateTaskOptions = CreateTaskOptions & {
  /**
   * Internal, non-persisted double-fire guard. A lifecycle via can run the
   * engine, then stamp downstream creation so via=creation does not fire too.
   */
  _routingDone?: boolean;
};

export function applyRoutingDecisionToOptions(
  options: RoutedCreateTaskOptions,
  decision: RoutingDecision,
): RoutedCreateTaskOptions {
  const finalOptions: RoutedCreateTaskOptions = { ...options };
  if (decision.final?.assignTo) {
    finalOptions.agentId = decision.final.assignTo;
  } else if (decision.final?.unassign) {
    // Drop the caller's pre-routing pin (e.g. send-task's parent-worker
    // default) so the task lands in the unassigned pool instead.
    finalOptions.agentId = undefined;
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

  if (decision.promptDirectives.length > 0 || decision.suggestions.length > 0) {
    finalOptions.routingDirectives = {
      directives: [
        ...(finalOptions.routingDirectives?.directives ?? []),
        ...decision.promptDirectives,
      ],
      suggestions: [
        ...(finalOptions.routingDirectives?.suggestions ?? []),
        ...decision.suggestions,
      ],
      routingRunId: decision.routingRunId,
    };
  }
  return finalOptions;
}

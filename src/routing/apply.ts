import type { CreateTaskOptions } from "../be/db";
import type { RoutingDecision, RoutingSuggestion } from "./types";

export type RoutedCreateTaskOptions = CreateTaskOptions & {
  /**
   * Internal, non-persisted double-fire guard. A lifecycle via can run the
   * engine, then stamp downstream creation so via=creation does not fire too.
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

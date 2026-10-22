import type { WorkflowDefinition } from "../types";
import type { ApprovalOutcome, ResolvedApproval } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";
import { resolveStepNode } from "./foreach-body";

/**
 * Step output and output port for a step whose approval request resolved.
 *
 * Both resume paths (the live `approval.resolved` event and the recovery sweep)
 * go through here so they cannot disagree. A `human-in-the-loop` step gets its
 * own output on the port named after the status. An executor that parked on the
 * same approval machinery (`system-one-decision` with `humanReview`) shapes its
 * own output from what it stored before it parked.
 */
export function shapeApprovalResolution(
  registry: ExecutorRegistry,
  definition: Pick<WorkflowDefinition, "nodes">,
  nodeId: string,
  parkedOutput: unknown,
  approval: ResolvedApproval,
): ApprovalOutcome {
  // A foreach child resolves to its body node, so a system-one-decision body
  // keeps its own shaping.
  const node = resolveStepNode(definition, nodeId);
  if (node && registry.has(node.type)) {
    const shaped = registry.get(node.type).resolveApproval(parkedOutput, approval);
    if (shaped) return shaped;
  }
  return {
    output: {
      requestId: approval.requestId,
      status: approval.status,
      responses: approval.responses,
    },
    nextPort:
      approval.status === "timeout"
        ? "timeout"
        : approval.status === "rejected"
          ? "rejected"
          : "approved",
  };
}

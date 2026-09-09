import { getLatestStepForNode } from "../be/db";
import type { WorkflowDefinition } from "../types";
import { getSuccessors } from "./definition";
import { resolveForeachParent } from "./foreach-join";

type CompletedStep = NonNullable<Awaited<ReturnType<typeof getLatestStepForNode>>>;

export async function loadCompletedStepRouting(
  def: WorkflowDefinition,
  runId: string,
  completedNodeIds: Set<string>,
): Promise<{ activeEdges: Set<string>; stepsByNodeId: Map<string, CompletedStep> }> {
  const activeEdges = new Set<string>();
  const stepsByNodeId = new Map<string, CompletedStep>();

  for (const nodeId of completedNodeIds) {
    if (resolveForeachParent(def, nodeId)) continue;

    const step = await getLatestStepForNode(runId, nodeId);
    if (step) stepsByNodeId.set(nodeId, step);

    const successors = step?.nextPort
      ? getSuccessors(def, nodeId, step.nextPort)
      : getSuccessors(def, nodeId);
    for (const successor of successors) {
      activeEdges.add(`${nodeId}→${successor.id}`);
    }
  }

  return { activeEdges, stepsByNodeId };
}

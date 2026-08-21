import { getLatestStepForNode, getWorkflowRunStepsByRunId } from "../be/db";
import type { WorkflowDefinition, WorkflowNode, WorkflowRunStep } from "../types";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import type { ForeachOutput } from "./executors/foreach";

export const FOREACH_TERMINAL_STEP_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

export interface SyntheticNodeId {
  parentNodeId: string;
  itemKey: string;
}

export function parseSyntheticNodeId(nodeId: string): SyntheticNodeId | null {
  // Keep this parser aligned with `apps/ui/src/lib/synthetic-step-id.ts`. This side
  // stays permissive because every caller verifies the parsed parent is a real
  // `foreach` node (resolveForeachParent / the executor's meta.nodeId match); the UI
  // variant takes the foreach-id set explicitly for the same guarantee.
  const separatorIndex = nodeId.indexOf("#");
  if (separatorIndex <= 0 || separatorIndex === nodeId.length - 1) return null;
  return {
    parentNodeId: nodeId.slice(0, separatorIndex),
    itemKey: nodeId.slice(separatorIndex + 1),
  };
}

export function resolveForeachParent(def: WorkflowDefinition, nodeId: string): WorkflowNode | null {
  const parsed = parseSyntheticNodeId(nodeId);
  if (!parsed) return null;
  const parent = def.nodes.find((node) => node.id === parsed.parentNodeId);
  return parent?.type === "foreach" ? parent : null;
}

export interface ForeachJoinResult {
  joined: boolean;
  parentNodeId: string;
  successors: WorkflowNode[];
}

export async function joinForeach(
  def: WorkflowDefinition,
  runId: string,
  childStep: WorkflowRunStep,
  ctx: Record<string, unknown>,
): Promise<ForeachJoinResult> {
  const parent = resolveForeachParent(def, childStep.nodeId);
  if (!parent) {
    throw new Error(`Step "${childStep.nodeId}" is not a foreach child`);
  }

  const children = (await getWorkflowRunStepsByRunId(runId))
    .filter((step) => resolveForeachParent(def, step.nodeId)?.id === parent.id)
    .sort((a, b) => childIndex(a) - childIndex(b));

  if (children.some((step) => !FOREACH_TERMINAL_STEP_STATUSES.has(step.status))) {
    return { joined: false, parentNodeId: parent.id, successors: [] };
  }

  const parentStep = await getLatestStepForNode(runId, parent.id);
  if (!parentStep) {
    throw new Error(`Waiting foreach parent step "${parent.id}" was not found`);
  }
  if (parentStep.status === "completed") {
    // A run re-walk reconstructs successors from completed parent steps. A
    // second closer must not mint another successor iteration here.
    return { joined: false, parentNodeId: parent.id, successors: [] };
  }

  const aggregate = buildForeachAggregate(children);

  await checkpointStep(runId, parentStep.id, parent.id, { output: aggregate }, ctx);
  return {
    joined: true,
    parentNodeId: parent.id,
    successors: getSuccessors(def, parent.id),
  };
}

export function buildForeachAggregate(children: WorkflowRunStep[]): ForeachOutput {
  const orderedChildren = [...children].sort((a, b) => childIndex(a) - childIndex(b));
  const results: ForeachOutput["results"] = orderedChildren.map((step) => {
    const parsed = parseSyntheticNodeId(step.nodeId)!;
    const status = resultStatus(step);
    return {
      itemKey: parsed.itemKey,
      status,
      output: step.output,
    };
  });
  const failedCount = results.filter((result) => result.status !== "completed").length;
  const aggregate: ForeachOutput = {
    results,
    okCount: results.length - failedCount,
    failedCount,
  };
  return aggregate;
}

function childIndex(step: WorkflowRunStep): number {
  if (typeof step.input !== "object" || step.input === null) return Number.MAX_SAFE_INTEGER;
  const index = (step.input as Record<string, unknown>).index;
  return typeof index === "number" ? index : Number.MAX_SAFE_INTEGER;
}

function resultStatus(step: WorkflowRunStep): ForeachOutput["results"][number]["status"] {
  if (step.status !== "completed") return step.status as "failed" | "cancelled" | "skipped";
  // An onNodeFailure:"continue" completion persists its failure reason on
  // step.error (completeTaskStepAndResolveSuccessors). Classify on that explicit
  // metadata — a successful child whose OUTPUT merely begins with "[FAILED:"
  // (e.g. an agent quoting a log line) is user-controlled text, not a failure.
  return step.error ? "failed" : "completed";
}

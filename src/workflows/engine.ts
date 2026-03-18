import {
  createWorkflowRun,
  createWorkflowRunStep,
  getWorkflowRun,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowNode } from "../types";

export interface NodeResult {
  mode: "instant" | "async";
  nextPort: string;
  output: unknown;
}

/**
 * Find entry nodes — nodes that no other node references via `next`.
 */
export function findEntryNodes(def: WorkflowDefinition): WorkflowNode[] {
  const targets = new Set<string>();
  for (const node of def.nodes) {
    if (!node.next) continue;
    if (typeof node.next === "string") {
      targets.add(node.next);
    } else {
      for (const targetId of Object.values(node.next)) {
        targets.add(targetId);
      }
    }
  }
  return def.nodes.filter((n) => !targets.has(n.id));
}

/**
 * Get successor nodes for a given port.
 * With nodes-with-next schema, we resolve the `next` field on the source node.
 */
export function getSuccessors(
  def: WorkflowDefinition,
  nodeId: string,
  port: string,
): WorkflowNode[] {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node?.next) return [];

  const targetIds: string[] = [];
  if (typeof node.next === "string") {
    // Single next — any port matches
    targetIds.push(node.next);
  } else {
    // Port-based — look up the specific port
    const targetId = node.next[port];
    if (targetId) targetIds.push(targetId);
  }

  return targetIds
    .map((id) => def.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => n != null);
}

export async function startWorkflowExecution(
  workflow: Workflow,
  triggerData: unknown,
): Promise<string> {
  const runId = crypto.randomUUID();
  createWorkflowRun({ id: runId, workflowId: workflow.id, triggerData });
  const ctx: Record<string, unknown> = { trigger: triggerData };
  const entryNodes = findEntryNodes(workflow.definition);
  await walkDag(workflow.definition, runId, ctx, entryNodes);
  return runId;
}

export async function walkDag(
  def: WorkflowDefinition,
  runId: string,
  ctx: Record<string, unknown>,
  startNodes: WorkflowNode[],
): Promise<void> {
  const visited = new Set<string>();
  const queue = [...startNodes];

  while (queue.length > 0) {
    const node = queue.shift()!;

    // Cycle guard: if we've already visited this node, stop traversal
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    const stepId = crypto.randomUUID();
    createWorkflowRunStep({
      id: stepId,
      runId,
      nodeId: node.id,
      nodeType: node.type,
      input: ctx,
    });

    try {
      const result = await executeNode(node, ctx, runId, stepId);

      if (result.mode === "async") {
        // Async node: pause the run. Step stays as 'waiting'.
        updateWorkflowRunStep(stepId, { status: "waiting", output: result.output });
        updateWorkflowRun(runId, {
          status: "waiting",
          context: ctx as Record<string, unknown>,
        });
        return; // Execution stops — resumed by event bus
      }

      // Instant node: mark completed, add output to context, continue
      updateWorkflowRunStep(stepId, {
        status: "completed",
        output: result.output,
        finishedAt: new Date().toISOString(),
      });
      ctx[node.id] = result.output;

      const successors = getSuccessors(def, node.id, result.nextPort);
      queue.push(...successors);
    } catch (err) {
      updateWorkflowRunStep(stepId, {
        status: "failed",
        error: String(err),
        finishedAt: new Date().toISOString(),
      });
      updateWorkflowRun(runId, {
        status: "failed",
        error: String(err),
        finishedAt: new Date().toISOString(),
      });
      return;
    }
  }

  // No more nodes — workflow complete
  const run = getWorkflowRun(runId);
  if (run && run.status === "running") {
    updateWorkflowRun(runId, {
      status: "completed",
      context: ctx as Record<string, unknown>,
      finishedAt: new Date().toISOString(),
    });
  }
}

// Stub executeNode — will be replaced by executor registry in Phase 3
async function executeNode(
  _node: WorkflowNode,
  _ctx: Record<string, unknown>,
  _runId: string,
  _stepId: string,
): Promise<NodeResult> {
  throw new Error(
    `executeNode is a stub — executor registry not yet wired (Phase 3). Node type: ${_node.type}`,
  );
}

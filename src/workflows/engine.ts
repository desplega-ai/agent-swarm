import {
  createWorkflowRun,
  createWorkflowRunStep,
  getWorkflowRun,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowNode } from "../types";
import { type CodeMatchConfig, executeCodeMatch } from "./nodes/code-match";
import { type CreateTaskConfig, executeCreateTask } from "./nodes/create-task";
import { type DelegateToAgentConfig, executeDelegateToAgent } from "./nodes/delegate-to-agent";
import { executeLlmClassify, type LlmClassifyConfig } from "./nodes/llm-classify";
import { executePropertyMatch, type PropertyMatchConfig } from "./nodes/property-match";
import { executeSendMessage, type SendMessageConfig } from "./nodes/send-message";

export interface NodeResult {
  mode: "instant" | "async";
  nextPort: string;
  output: unknown;
}

export function findEntryNodes(def: WorkflowDefinition): WorkflowNode[] {
  const targets = new Set(def.edges.map((e) => e.target));
  return def.nodes.filter((n) => !targets.has(n.id));
}

export function getSuccessors(
  def: WorkflowDefinition,
  nodeId: string,
  port: string,
): WorkflowNode[] {
  const edgesFromPort = def.edges.filter((e) => e.source === nodeId && e.sourcePort === port);
  return edgesFromPort
    .map((e) => def.nodes.find((n) => n.id === e.target))
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

async function executeNode(
  node: WorkflowNode,
  ctx: Record<string, unknown>,
  runId: string,
  stepId: string,
): Promise<NodeResult> {
  switch (node.type) {
    // Trigger nodes pass through — they match during subscription, not execution
    case "trigger-new-task":
    case "trigger-task-completed":
    case "trigger-webhook":
    case "trigger-email":
    case "trigger-slack-message":
    case "trigger-github-event":
    case "trigger-gitlab-event":
      return { mode: "instant", nextPort: "default", output: ctx.trigger };

    case "property-match":
      return executePropertyMatch(node.config as unknown as PropertyMatchConfig, ctx);

    case "create-task":
      return executeCreateTask(node.config as unknown as CreateTaskConfig, ctx, runId, stepId);

    case "llm-classify":
      return executeLlmClassify(node.config as unknown as LlmClassifyConfig, ctx);

    case "send-message":
      return executeSendMessage(node.config as unknown as SendMessageConfig, ctx);

    case "delegate-to-agent":
      return executeDelegateToAgent(
        node.config as unknown as DelegateToAgentConfig,
        ctx,
        runId,
        stepId,
      );

    case "code-match":
      return executeCodeMatch(node.config as unknown as CodeMatchConfig, ctx);

    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

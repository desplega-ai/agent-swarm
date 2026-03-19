import {
  createWorkflowRun,
  createWorkflowRunStep,
  getCompletedStepNodeIds,
  getStepByIdempotencyKey,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowNode } from "../types";
import { checkpointStep, checkpointStepFailure, checkpointStepWaiting } from "./checkpoint";
import { shouldSkipCooldown } from "./cooldown";
import { findEntryNodes, getSuccessors } from "./definition";
import type { AsyncExecutorResult } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";
import { resolveInputs } from "./input";
import { deepInterpolate } from "./template";
import { runStepValidation } from "./validation";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = Number(process.env.WORKFLOW_MAX_ITERATIONS) || 100;

// ─── Public API ────────────────────────────────────────────

/**
 * Start executing a workflow from scratch.
 *
 * 1. Check cooldown
 * 2. Create workflow run
 * 3. Resolve inputs
 * 4. Find entry nodes
 * 5. Walk the graph
 */
export async function startWorkflowExecution(
  workflow: Workflow,
  triggerData: unknown,
  registry: ExecutorRegistry,
): Promise<string> {
  // Cooldown check
  if (workflow.cooldown && shouldSkipCooldown(workflow.id, workflow.cooldown)) {
    const runId = crypto.randomUUID();
    createWorkflowRun({ id: runId, workflowId: workflow.id, triggerData });
    updateWorkflowRun(runId, {
      status: "skipped",
      error: "cooldown",
      finishedAt: new Date().toISOString(),
    });
    return runId;
  }

  const runId = crypto.randomUUID();
  createWorkflowRun({ id: runId, workflowId: workflow.id, triggerData });

  // Resolve inputs and merge into initial context
  const ctx: Record<string, unknown> = { trigger: triggerData };
  if (workflow.input) {
    try {
      const resolved = resolveInputs(workflow.input);
      Object.assign(ctx, { input: resolved });
    } catch (err) {
      updateWorkflowRun(runId, {
        status: "failed",
        error: `Input resolution failed: ${err}`,
        finishedAt: new Date().toISOString(),
      });
      return runId;
    }
  }

  const entryNodes = findEntryNodes(workflow.definition);
  await walkGraph(workflow.definition, runId, ctx, entryNodes, registry, workflow.id);
  return runId;
}

// ─── Graph Walker ──────────────────────────────────────────

/**
 * Step execution result — includes the successors to queue next.
 */
interface StepResult {
  outcome: "completed" | "waiting" | "failed";
  successors: WorkflowNode[];
}

/**
 * Event-loop style graph walker.
 *
 * Executes start nodes, collects successor nodes from each completed step's
 * port-based routing, deduplicates convergence nodes (waiting for all
 * predecessors), then executes the next batch. Repeats until done.
 */
export async function walkGraph(
  def: WorkflowDefinition,
  runId: string,
  ctx: Record<string, unknown>,
  startNodes: WorkflowNode[],
  registry: ExecutorRegistry,
  workflowId?: string,
): Promise<void> {
  let iterationCount = 0;
  const completedNodeIds = new Set(getCompletedStepNodeIds(runId));

  // For memoized re-walks, inject stored outputs into context
  if (completedNodeIds.size > 0) {
    for (const nodeId of completedNodeIds) {
      const key = `${runId}:${nodeId}`;
      const step = getStepByIdempotencyKey(key);
      if (step?.output !== undefined) {
        ctx[nodeId] = step.output;
      }
    }
  }

  // Seed with start nodes that haven't been completed yet
  let pendingNodes = startNodes.filter((n) => !completedNodeIds.has(n.id));

  while (pendingNodes.length > 0) {
    iterationCount++;
    if (iterationCount > MAX_ITERATIONS) {
      updateWorkflowRun(runId, {
        status: "failed",
        error: `Max iterations (${MAX_ITERATIONS}) exceeded — possible infinite loop`,
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    // Execute all pending nodes in parallel
    const results = await Promise.all(
      pendingNodes.map((node) =>
        executeStep(def, runId, ctx, node, registry, workflowId).catch(
          (_err): StepResult => ({
            outcome: "failed",
            successors: [],
          }),
        ),
      ),
    );

    // Collect successors and check for errors/pauses
    const nextBatch = new Map<string, WorkflowNode>();
    let hasWaiting = false;
    let hasFailed = false;

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.outcome === "failed") {
        hasFailed = true;
        break;
      }
      if (result.outcome === "waiting") {
        hasWaiting = true;
        continue;
      }
      // Mark this node as completed
      completedNodeIds.add(pendingNodes[i]!.id);
      // Queue successors, deduplicating by node ID
      for (const succ of result.successors) {
        nextBatch.set(succ.id, succ);
      }
    }

    if (hasFailed) return; // Run already marked failed in executeStep
    if (hasWaiting) return; // Run paused, will be resumed by event

    // For convergence nodes (multiple predecessors pointing to same node),
    // only execute if all predecessors that reference this node have completed.
    // For non-convergence nodes, they're ready immediately.
    const readyNext: WorkflowNode[] = [];
    for (const [nodeId, node] of nextBatch) {
      if (completedNodeIds.has(nodeId)) continue; // Already done

      const allPreds = getAllPredecessors(def, nodeId);
      const allPredsCompleted = allPreds.every((p) => completedNodeIds.has(p));
      if (allPredsCompleted) {
        readyNext.push(node);
      }
    }

    pendingNodes = readyNext;
  }

  // No more nodes to execute — check if the run should be completed.
  // If any step has a pending retry (failed with nextRetryAt), the run
  // should stay in "running" state for the retry poller to pick up.
  const run = getWorkflowRun(runId);
  if (run && run.status === "running") {
    const allSteps = getWorkflowRunStepsByRunId(runId);
    const hasPendingRetries = allSteps.some((s) => s.status === "failed" && s.nextRetryAt != null);

    if (!hasPendingRetries) {
      updateWorkflowRun(runId, {
        status: "completed",
        context: ctx,
        finishedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Get all predecessor node IDs for a given node.
 * A predecessor is any node that references this node via its `next` field.
 */
function getAllPredecessors(def: WorkflowDefinition, nodeId: string): string[] {
  const preds: string[] = [];
  for (const node of def.nodes) {
    if (!node.next) continue;
    const targets = typeof node.next === "string" ? [node.next] : Object.values(node.next);
    if (targets.includes(nodeId)) {
      preds.push(node.id);
    }
  }
  return preds;
}

// ─── Step Execution ────────────────────────────────────────

/**
 * Execute a single node step:
 * 1. Check memoization (idempotency)
 * 2. Create step record
 * 3. Interpolate config
 * 4. Run executor with timeout
 * 5. Handle result (checkpoint, validation, or async)
 *
 * Returns the outcome and list of successor nodes to queue.
 */
async function executeStep(
  def: WorkflowDefinition,
  runId: string,
  ctx: Record<string, unknown>,
  node: WorkflowNode,
  registry: ExecutorRegistry,
  workflowId?: string,
): Promise<StepResult> {
  const idempotencyKey = `${runId}:${node.id}`;

  // 1. Memoization check
  const existingStep = getStepByIdempotencyKey(idempotencyKey);
  if (existingStep && existingStep.status === "completed") {
    // Inject stored output into context
    ctx[node.id] = existingStep.output;
    // For memoized steps, return all successors (no port — use default)
    const successors = getSuccessors(def, node.id);
    return { outcome: "completed", successors };
  }

  // 2. Create step
  const stepId = crypto.randomUUID();
  createWorkflowRunStep({
    id: stepId,
    runId,
    nodeId: node.id,
    nodeType: node.type,
    input: ctx,
  });

  // Set idempotency key
  updateWorkflowRunStep(stepId, { idempotencyKey });

  // 3. Get executor
  const executor = registry.get(node.type);

  // 4. Deep-interpolate config (handles nested objects, arrays, etc.)
  const { value: interpolatedValue, unresolved } = deepInterpolate(node.config, ctx);
  const interpolatedConfig = interpolatedValue as Record<string, unknown>;

  if (unresolved.length > 0) {
    console.warn(
      `[workflow] Step ${node.id}: unresolved interpolation tokens: ${unresolved.join(", ")}`,
    );
    updateWorkflowRunStep(stepId, {
      diagnostics: JSON.stringify({ unresolvedTokens: unresolved }),
    });
  }

  // 5. Execute with timeout
  const meta = {
    runId,
    stepId,
    nodeId: node.id,
    workflowId: workflowId || "",
    dryRun: false,
  };

  const timeoutMs = DEFAULT_TIMEOUT_MS;

  let result: Awaited<ReturnType<typeof executor.run>>;
  try {
    result = await Promise.race([
      executor.run({
        config: interpolatedConfig,
        context: ctx,
        meta,
      }),
      timeoutPromise(timeoutMs),
    ]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Apply retry policy if configured
    const retryPolicy = node.retry || executor.retryPolicy;
    const currentRetryCount = existingStep?.retryCount || 0;
    const { shouldRetry } = checkpointStepFailure(
      runId,
      stepId,
      errorMsg,
      currentRetryCount,
      retryPolicy,
    );

    if (!shouldRetry) {
      throw err; // Will be caught by walkGraph
    }
    // Retry will be handled by the retry poller
    return { outcome: "completed", successors: [] };
  }

  // 6. Handle result
  if (result.status === "failed") {
    const retryPolicy = node.retry || executor.retryPolicy;
    const currentRetryCount = existingStep?.retryCount || 0;
    const { shouldRetry } = checkpointStepFailure(
      runId,
      stepId,
      result.error || "Executor returned failed status",
      currentRetryCount,
      retryPolicy,
    );

    if (!shouldRetry) {
      throw new Error(result.error || "Step execution failed");
    }
    return { outcome: "completed", successors: [] }; // Retry handled by poller
  }

  // Check for async result
  if ("async" in result && (result as AsyncExecutorResult).async) {
    checkpointStepWaiting(runId, stepId, ctx);
    return { outcome: "waiting", successors: [] };
  }

  // 7. Run validation if configured
  if (node.validation) {
    const validationResult = await runStepValidation(registry, node, result.output, ctx, meta);

    if (validationResult.outcome === "halt") {
      const errorMsg = "Validation failed (mustPass)";
      checkpointStepFailure(runId, stepId, errorMsg, 0);
      throw new Error(errorMsg);
    }

    if (validationResult.outcome === "retry") {
      // Inject validation context and mark as failed for retry
      if (validationResult.retryContext) {
        Object.assign(ctx, { [`${node.id}_validation`]: validationResult.retryContext });
      }
      const retryPolicy = node.validation.retry || node.retry;
      const currentRetryCount = existingStep?.retryCount || 0;
      checkpointStepFailure(
        runId,
        stepId,
        "Validation failed, retrying",
        currentRetryCount,
        retryPolicy,
      );
      return { outcome: "completed", successors: [] }; // Retry handled by poller
    }
  }

  // 8. Checkpoint success
  checkpointStep(runId, stepId, node.id, result, ctx);

  // 9. Determine successors based on nextPort
  const port = result.nextPort || "default";
  const successors = getSuccessors(def, node.id, port);
  return { outcome: "completed", successors };
}

// ─── Ready Node Detection ──────────────────────────────────

/**
 * Find nodes that are ready to execute (used for recovery/resume).
 * A node is ready when all its predecessors (nodes that reference it via `next`)
 * have been completed.
 */
export function findReadyNodes(
  def: WorkflowDefinition,
  completedNodeIds: Set<string>,
): WorkflowNode[] {
  // Build predecessor map: nodeId -> set of nodes that must complete before it
  const predecessors = new Map<string, Set<string>>();
  for (const node of def.nodes) {
    if (!predecessors.has(node.id)) {
      predecessors.set(node.id, new Set());
    }
  }

  for (const node of def.nodes) {
    if (!node.next) continue;
    const targets = typeof node.next === "string" ? [node.next] : Object.values(node.next);
    for (const target of targets) {
      if (!predecessors.has(target)) {
        predecessors.set(target, new Set());
      }
      predecessors.get(target)!.add(node.id);
    }
  }

  // A node is ready if:
  // 1. It hasn't been completed yet
  // 2. All its predecessors are completed
  return def.nodes.filter((node) => {
    if (completedNodeIds.has(node.id)) return false;
    const preds = predecessors.get(node.id);
    if (!preds || preds.size === 0) return true; // Entry node
    for (const pred of preds) {
      if (!completedNodeIds.has(pred)) return false;
    }
    return true;
  });
}

// ─── Helpers ───────────────────────────────────────────────

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Step timed out after ${ms}ms`)), ms);
  });
}

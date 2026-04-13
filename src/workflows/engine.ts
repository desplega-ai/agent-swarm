import {
  createWorkflowRun,
  createWorkflowRunStep,
  getCompletedStepNodeIds,
  getLatestStepForNode,
  getStepByIdempotencyKey,
  getStepCountForNode,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowNode } from "../types";
import { checkpointStep, checkpointStepFailure, checkpointStepWaiting } from "./checkpoint";
import { shouldSkipCooldown } from "./cooldown";
import { findEntryNodes, getNextTargets, getSuccessors } from "./definition";
import type { AsyncExecutorResult } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";
import { resolveInputs } from "./input";
import { validateJsonSchema } from "./json-schema-validator";
import { deepInterpolate } from "./template";
import { runStepValidation, type ValidationRunResult } from "./validation";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = Number(process.env.WORKFLOW_MAX_ITERATIONS) || 100;
const MAX_STEPS_PER_RUN = Number(process.env.WORKFLOW_MAX_STEPS_PER_RUN) || 500;

/**
 * Error thrown when trigger data fails validation against a workflow's triggerSchema.
 */
export class TriggerSchemaError extends Error {
  constructor(public readonly validationErrors: string[]) {
    super(`Trigger schema validation failed: ${validationErrors.join("; ")}`);
    this.name = "TriggerSchemaError";
  }
}

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
  // Validate trigger data against triggerSchema (before any DB writes)
  if (workflow.triggerSchema) {
    const validationErrors = validateJsonSchema(workflow.triggerSchema, triggerData);
    if (validationErrors.length > 0) {
      throw new TriggerSchemaError(validationErrors);
    }
  }

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

  // Inject workflow-level metadata for interpolation ({{workflow.dir}}, {{workflow.vcsRepo}})
  if (workflow.dir || workflow.vcsRepo) {
    ctx.workflow = { dir: workflow.dir, vcsRepo: workflow.vcsRepo };
  }

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
  let nodeExecutionCount = 0;
  const completedNodeIds = new Set(getCompletedStepNodeIds(runId));

  // Track active edges: "sourceId→targetId" — only edges on actually-taken
  // execution paths, not all structural edges in the definition.
  const activeEdges = new Set<string>();

  // For memoized re-walks, inject stored outputs into context and
  // reconstruct active edges from completed steps' stored nextPort.
  // Use the LATEST step per node to support loops (a node may have
  // multiple completed steps from different iterations).
  if (completedNodeIds.size > 0) {
    for (const nodeId of completedNodeIds) {
      const step = getLatestStepForNode(runId, nodeId);
      if (step?.output !== undefined) {
        // Bug 5 fix: Validate stored output against executor schema on recovery
        const node = def.nodes.find((n) => n.id === nodeId);
        if (node && registry.has(node.type)) {
          const executor = registry.get(node.type);
          const parseResult = executor.outputSchema.safeParse(step.output);
          if (!parseResult.success) {
            console.warn(
              `[workflow] Recovery: step ${nodeId} output failed validation: ${parseResult.error.message}`,
            );
            continue; // Skip corrupted output
          }
        }
        ctx[nodeId] = step.output;
      }
      // Reconstruct active edges from the stored nextPort.
      // If nextPort is set, use it for port-specific routing.
      // If not set, get all successors (fan-out).
      const successors = step?.nextPort
        ? getSuccessors(def, nodeId, step.nextPort)
        : getSuccessors(def, nodeId);
      for (const succ of successors) {
        activeEdges.add(`${nodeId}→${succ.id}`);
      }
    }
  }

  // Circuit breaker: fail the run if total steps exceed the per-run limit.
  // This prevents runaway workflows (e.g. infinite loop-backs) from consuming
  // unbounded resources. Checked here so it covers initial walks AND async
  // resumes (resumeFromTaskCompletion, handleTaskFailure, retry-poller).
  const allSteps = getWorkflowRunStepsByRunId(runId);
  if (allSteps.length >= MAX_STEPS_PER_RUN) {
    updateWorkflowRun(runId, {
      status: "failed",
      error: `Circuit breaker: run exceeded ${MAX_STEPS_PER_RUN} total steps (WORKFLOW_MAX_STEPS_PER_RUN)`,
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  // Also reconstruct active edges from "waiting" steps. A waiting step
  // means the node was reached (its predecessor completed and routed to it),
  // so its structural outgoing edges are active paths that convergence
  // nodes must wait for. Without this, fan-out convergence gates fire
  // prematurely — e.g. if 1-of-3 parallel tasks completes, the merge node
  // would see only 1 active predecessor and trigger immediately.
  for (const step of allSteps) {
    if (step.status !== "waiting") continue;
    const successors = getSuccessors(def, step.nodeId);
    for (const succ of successors) {
      activeEdges.add(`${step.nodeId}→${succ.id}`);
    }
  }

  // Seed with start nodes whose predecessors are all completed (convergence gate).
  // For entry nodes (no predecessors), skip if already completed — these are
  // re-walk/recovery scenarios where memoization should apply.
  // For non-entry nodes, allow re-execution even if completed — these are loop
  // targets from port-based routing that need new iterations.
  let pendingNodes = startNodes.filter((n) => {
    const preds = getAllPredecessors(def, n.id);
    if (preds.length === 0) {
      // True entry node — skip if already completed (memoization on re-walk)
      return !completedNodeIds.has(n.id);
    }
    // Non-entry node — allow through even if completed (loop target).
    // Check predecessors are ready.
    const activePreds = preds.filter((predId) => activeEdges.has(`${predId}→${n.id}`));
    // If no active edges yet (first walk), check ALL structural predecessors
    const predsToCheck = activePreds.length > 0 ? activePreds : preds;
    return predsToCheck.every((p) => completedNodeIds.has(p));
  });

  // Track nodes executed in THIS walk to prevent re-execution within the same
  // walkGraph call, while still allowing loop targets from prior walks.
  const executedInThisWalk = new Set<string>();

  while (pendingNodes.length > 0) {
    nodeExecutionCount += pendingNodes.length;
    if (nodeExecutionCount > MAX_ITERATIONS) {
      updateWorkflowRun(runId, {
        status: "failed",
        error: `Max node executions (${MAX_ITERATIONS}) exceeded — possible infinite loop`,
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

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.outcome === "failed") {
        // Check if the run was already marked failed in DB (e.g., executor error).
        // If so, stop immediately. If not (mustPass validation), skip this
        // node's successors but continue processing other branches.
        const currentRun = getWorkflowRun(runId);
        if (currentRun?.status === "failed") return;
        continue;
      }
      if (result.outcome === "waiting") {
        hasWaiting = true;
        continue;
      }
      // Mark this node as completed
      const sourceNodeId = pendingNodes[i]!.id;
      completedNodeIds.add(sourceNodeId);
      executedInThisWalk.add(sourceNodeId);
      // Record active edges and queue successors
      for (const succ of result.successors) {
        activeEdges.add(`${sourceNodeId}→${succ.id}`);
        nextBatch.set(succ.id, succ);
      }
    }

    if (hasWaiting) return; // Run paused, will be resumed by event

    // Convergence check — only wait for predecessors with active edges to
    // this node, not all structural predecessors. This prevents deadlocks
    // when conditional branches skip nodes.
    // Use executedInThisWalk (not completedNodeIds) to gate dedup — this
    // allows loop targets from prior walks to re-execute while preventing
    // double execution within the same walk.
    const readyNext: WorkflowNode[] = [];
    for (const [nodeId, node] of nextBatch) {
      if (executedInThisWalk.has(nodeId)) continue; // Already done in this walk

      const allPreds = getAllPredecessors(def, nodeId);
      const activePreds = allPreds.filter((predId) => activeEdges.has(`${predId}→${nodeId}`));
      const allActivePredsCompleted = activePreds.every((p) => completedNodeIds.has(p));

      if (allActivePredsCompleted) {
        readyNext.push(node);
      }
    }

    pendingNodes = readyNext;
  }

  // No more nodes to execute — check if the run should be completed.
  // Stay in current state if any steps are still waiting (async tasks
  // pending) or have pending retries.
  const run = getWorkflowRun(runId);
  if (run && run.status === "running") {
    const finalSteps = getWorkflowRunStepsByRunId(runId);
    const hasWaitingSteps = finalSteps.some((s) => s.status === "waiting");
    const hasPendingRetries = finalSteps.some(
      (s) => s.status === "failed" && s.nextRetryAt != null,
    );
    const failedSteps = finalSteps.filter((s) => s.status === "failed" && s.nextRetryAt == null);
    // Exclude entry/trigger nodes when checking for completed steps — a trigger
    // completing doesn't mean a meaningful branch succeeded. Without this filter,
    // a linear workflow (trigger → mustPass validator → action) would be marked
    // as partial-failure instead of failed when the validator fails.
    const entryNodeIds = new Set(findEntryNodes(def).map((n) => n.id));
    const hasCompletedSteps = finalSteps.some(
      (s) => s.status === "completed" && !entryNodeIds.has(s.nodeId),
    );

    if (hasWaitingSteps) {
      // Async tasks still in progress — set back to waiting for next event
      updateWorkflowRun(runId, { status: "waiting" });
    } else if (!hasPendingRetries) {
      if (failedSteps.length > 0 && !hasCompletedSteps) {
        // All branches failed — mark run as failed
        const failedNodeIds = failedSteps.map((s) => s.nodeId).join(", ");
        updateWorkflowRun(runId, {
          status: "failed",
          error: `All branches failed. Failed nodes: ${failedNodeIds}`,
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      } else if (failedSteps.length > 0) {
        // Partial failure — some branches succeeded, some failed.
        // Mark as completed with error noting partial failure.
        const failedNodeIds = failedSteps.map((s) => s.nodeId).join(", ");
        updateWorkflowRun(runId, {
          status: "completed",
          error: `Partial failure: nodes [${failedNodeIds}] failed (mustPass validation), but other branches completed successfully`,
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      } else {
        updateWorkflowRun(runId, {
          status: "completed",
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      }
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
    if (getNextTargets(node.next).includes(nodeId)) {
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
  // Use iteration-aware idempotency key to support loops.
  // Count existing steps for this node to determine the current iteration.
  const iteration = getStepCountForNode(runId, node.id);
  const idempotencyKey = `${runId}:${node.id}:${iteration}`;

  // 1. Memoization / deduplication check (within same iteration)
  const existingStep = getStepByIdempotencyKey(idempotencyKey);
  if (existingStep) {
    if (existingStep.status === "completed") {
      // Inject stored output into context
      ctx[node.id] = existingStep.output;
      // For memoized steps, return all successors (no port — use default)
      const successors = getSuccessors(def, node.id);
      return { outcome: "completed", successors };
    }
    if (existingStep.status === "waiting") {
      // Step already exists and is waiting for async completion (e.g., agent-task).
      // Don't create a duplicate — just report as waiting.
      return { outcome: "waiting", successors: [] };
    }
    // For "pending" or "failed" steps, fall through to re-execute
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

  // 3b. Build local interpolation context from explicit inputs mapping
  let interpolationCtx: Record<string, unknown>;
  if (node.inputs) {
    interpolationCtx = {};
    // Always include built-in sources
    if (ctx.trigger !== undefined) interpolationCtx.trigger = ctx.trigger;
    if (ctx.input !== undefined) interpolationCtx.input = ctx.input;
    if (ctx.workflow !== undefined) interpolationCtx.workflow = ctx.workflow;
    // Resolve declared inputs
    for (const [localName, sourcePath] of Object.entries(node.inputs)) {
      const keys = sourcePath.split(".");
      let value: unknown = ctx;
      for (const key of keys) {
        if (value == null || typeof value !== "object") {
          value = undefined;
          break;
        }
        value = (value as Record<string, unknown>)[key];
      }
      interpolationCtx[localName] = value;
    }
  } else {
    // No inputs declared — only built-in sources available
    interpolationCtx = {};
    if (ctx.trigger !== undefined) interpolationCtx.trigger = ctx.trigger;
    if (ctx.input !== undefined) interpolationCtx.input = ctx.input;
    if (ctx.workflow !== undefined) interpolationCtx.workflow = ctx.workflow;
  }

  // 3c. Validate resolved inputs against inputSchema if defined
  if (node.inputSchema) {
    const inputErrors = validateJsonSchema(
      node.inputSchema as Record<string, unknown>,
      interpolationCtx,
    );
    if (inputErrors.length > 0) {
      const errorMsg = `Input schema validation failed: ${inputErrors.join("; ")}`;
      checkpointStepFailure(runId, stepId, errorMsg, 0);
      throw new Error(errorMsg);
    }
  }

  // 4. Deep-interpolate config using local context (not global ctx)
  const { value: interpolatedValue, unresolved } = deepInterpolate(node.config, interpolationCtx);
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

  const timeoutMs =
    typeof node.config?.timeoutMs === "number" ? node.config.timeoutMs : DEFAULT_TIMEOUT_MS;

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

  // 6b. Validate output against node-level outputSchema if defined
  if (node.outputSchema && result.status === "success") {
    const outputErrors = validateJsonSchema(
      node.outputSchema as Record<string, unknown>,
      result.output,
    );
    if (outputErrors.length > 0) {
      const errorMsg = `Output schema validation failed: ${outputErrors.join("; ")}`;
      checkpointStepFailure(runId, stepId, errorMsg, 0);
      throw new Error(errorMsg);
    }
  }

  // 7. Run validation if configured
  let validationResult: ValidationRunResult | undefined;
  if (node.validation) {
    validationResult = await runStepValidation(registry, node, result.output, ctx, meta);

    if (validationResult.outcome === "halt") {
      const errorMsg = "Validation failed (mustPass)";
      checkpointStepFailure(runId, stepId, errorMsg, 0, undefined, { markRunFailed: false });
      return { outcome: "failed", successors: [] };
    }

    if (validationResult.outcome === "retry") {
      // Bug 7 fix: Append validation context to history array instead of overwriting
      if (validationResult.retryContext) {
        const historyKey = `${node.id}_validations`;
        const existing = (ctx[historyKey] as unknown[]) || [];
        ctx[historyKey] = [...existing, validationResult.retryContext];
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

  // 8. Set nextPort from validation result for record-based routing
  // When validation determines pass/fail and the node uses port-based `next`,
  // route to the correct port instead of activating all ports.
  if (
    validationResult?.passed !== undefined &&
    !result.nextPort &&
    node.next &&
    typeof node.next === "object" &&
    !Array.isArray(node.next)
  ) {
    result.nextPort = validationResult.passed ? "pass" : "fail";
  }

  // 9. Checkpoint success
  checkpointStep(runId, stepId, node.id, result, ctx);

  // 10. Determine successors based on nextPort
  // If executor returned a specific port, use it. Otherwise, get all successors
  // (fan-out behavior for non-branching nodes with record-based `next`).
  const successors = result.nextPort
    ? getSuccessors(def, node.id, result.nextPort)
    : getSuccessors(def, node.id);
  return { outcome: "completed", successors };
}

// ─── Ready Node Detection ──────────────────────────────────

/**
 * Find nodes that are ready to execute (used for recovery/resume).
 * A node is ready when all its predecessors (nodes that reference it via `next`)
 * have been completed.
 *
 * When `activeEdges` is provided, only predecessors with an active edge to the
 * node are considered (prevents deadlocks on conditional branches where some
 * predecessors were never executed).
 */
export function findReadyNodes(
  def: WorkflowDefinition,
  completedNodeIds: Set<string>,
  activeEdges?: Set<string>,
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
    for (const target of getNextTargets(node.next)) {
      if (!predecessors.has(target)) {
        predecessors.set(target, new Set());
      }
      predecessors.get(target)!.add(node.id);
    }
  }

  // A node is ready if:
  // 1. It hasn't been completed yet (for non-loop discovery)
  // 2. All its relevant predecessors are completed
  // Note: Loop targets bypass findReadyNodes — they are passed directly
  // as startNodes to walkGraph via port-based routing.
  return def.nodes.filter((node) => {
    if (completedNodeIds.has(node.id)) return false;
    const preds = predecessors.get(node.id);
    if (!preds || preds.size === 0) return true; // Entry node

    if (activeEdges) {
      // Only consider predecessors with active edges to this node
      const activePreds = [...preds].filter((predId) => activeEdges.has(`${predId}→${node.id}`));
      // If no active edges point here, the node is not reachable yet
      if (activePreds.length === 0) return false;
      return activePreds.every((pred) => completedNodeIds.has(pred));
    }

    // Fallback: structural predecessors (backward compat)
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

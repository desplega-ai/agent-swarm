import {
  createWorkflowRun,
  createWorkflowRunStep,
  getCompletedStepNodeIds,
  getDbClient,
  getLatestStepForNode,
  getStepByIdempotencyKey,
  getStepCountForNode,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { telemetry } from "../telemetry";
import type { Workflow, WorkflowDefinition, WorkflowNode } from "../types";
import { checkpointStep, checkpointStepFailure, checkpointStepWaiting } from "./checkpoint";
import { loadCompletedStepRouting } from "./completed-step-routing";
import { shouldSkipCooldown } from "./cooldown";
import { findEntryNodes, getNextTargets, getSuccessors } from "./definition";
import type { AsyncExecutorResult } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";
import { FOREACH_TERMINAL_STEP_STATUSES } from "./foreach-join";
import { getSecretInputKeys, redactSecretsForStorage, resolveInputs } from "./input";
import { validateJsonSchema } from "./json-schema-validator";
import { getMaxWorkflowStepsPerRun } from "./limits";
import { deepInterpolate } from "./template";
import { runStepValidation, type ValidationRunResult } from "./validation";

const DEFAULT_TIMEOUT_MS = 30_000;
// Read dynamically, NOT captured at module load: `src/http/index.ts` imports
// this module before `loadGlobalConfigsIntoEnv()` hydrates `swarm_config` into
// `process.env`, so a module-level const would permanently ignore DB-saved
// limits. Functions let a config reload take effect without a restart.
function maxIterations(): number {
  return Number(process.env.WORKFLOW_MAX_ITERATIONS) || 100;
}

export interface WorkflowExecutionOptions {
  requestedByUserId?: string;
  triggerType?: "schedule" | "manual" | "event" | "api";
}

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
  options: WorkflowExecutionOptions = {},
): Promise<string> {
  // Validate trigger data against triggerSchema (before any DB writes)
  if (workflow.triggerSchema) {
    const validationErrors = validateJsonSchema(workflow.triggerSchema, triggerData);
    if (validationErrors.length > 0) {
      throw new TriggerSchemaError(validationErrors);
    }
  }

  // Cooldown check
  if (workflow.cooldown && (await shouldSkipCooldown(workflow.id, workflow.cooldown))) {
    const runId = crypto.randomUUID();
    await createWorkflowRun({
      id: runId,
      workflowId: workflow.id,
      triggerType: options.triggerType ?? "manual",
      triggerData,
      createdBy: options.requestedByUserId,
    });
    await updateWorkflowRun(runId, {
      status: "skipped",
      error: "cooldown",
      finishedAt: new Date().toISOString(),
    });
    return runId;
  }

  const runId = crypto.randomUUID();
  await createWorkflowRun({
    id: runId,
    workflowId: workflow.id,
    triggerType: options.triggerType ?? "manual",
    triggerData,
    createdBy: options.requestedByUserId,
  });
  telemetry.workflow("started", {
    workflowId: workflow.id,
    nodeCount: workflow.definition.nodes.length,
    triggerType: options.triggerType ?? "manual",
  });

  // Resolve inputs and merge into initial context
  const ctx: Record<string, unknown> = { trigger: triggerData };
  if (options.requestedByUserId) {
    ctx.swarm = { requestedByUserId: options.requestedByUserId };
  }

  // Inject workflow-level metadata for interpolation ({{workflow.dir}}, {{workflow.vcsRepo}})
  if (workflow.dir || workflow.vcsRepo) {
    ctx.workflow = { dir: workflow.dir, vcsRepo: workflow.vcsRepo };
  }

  if (workflow.input) {
    try {
      const resolved = await resolveInputs(workflow.input);
      Object.assign(ctx, { input: resolved });
    } catch (err) {
      await updateWorkflowRun(runId, {
        status: "failed",
        error: `Input resolution failed: ${err}`,
        finishedAt: new Date().toISOString(),
      });
      return runId;
    }
  }

  const entryNodes = findEntryNodes(workflow.definition);
  const secretKeys = getSecretInputKeys(workflow.input);
  await walkGraph(
    workflow.definition,
    runId,
    ctx,
    entryNodes,
    registry,
    workflow.id,
    secretKeys,
    options,
  );
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
  secretKeys: Set<string> = new Set(),
  options: WorkflowExecutionOptions = {},
): Promise<void> {
  // Initial triggers carry the requester in options. Resumes, retries, and
  // recovery start from persisted state, so rehydrate it from the run.
  if (!options.requestedByUserId) {
    options = {
      ...options,
      requestedByUserId: (await getWorkflowRun(runId))?.createdBy,
    };
  }
  let nodeExecutionCount = 0;
  // `run.id` is a context builtin (like `trigger` / `input`) so nodes can reference
  // their own run — e.g. an audit/receipt node correlating its output with the run
  // that produced it. Hydrated here so every path (initial walk, resume, retry,
  // recovery) resolves it even when the stored context predates the builtin.
  if (!("run" in ctx)) {
    ctx.run = { id: runId };
  }
  const completedNodeIds = new Set(await getCompletedStepNodeIds(runId));

  // Track active edges: "sourceId→targetId" — only edges on actually-taken
  // execution paths, not all structural edges in the definition.
  const { activeEdges, stepsByNodeId } = await loadCompletedStepRouting(
    def,
    runId,
    completedNodeIds,
  );

  // For memoized re-walks, inject stored outputs into context and
  // reconstruct active edges from completed steps' stored nextPort.
  // Use the LATEST step per node to support loops (a node may have
  // multiple completed steps from different iterations).
  if (completedNodeIds.size > 0) {
    for (const nodeId of completedNodeIds) {
      const step = stepsByNodeId.get(nodeId);
      // Synthetic foreach children persist their own step output for the join,
      // but only the parent aggregate belongs in workflow context or routing.
      if (!step) continue;
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
    }
  }

  // Circuit breaker: fail the run if total steps exceed the per-run limit.
  // This prevents runaway workflows (e.g. infinite loop-backs) from consuming
  // unbounded resources. Checked here so it covers initial walks AND async
  // resumes (resumeFromTaskCompletion, handleTaskFailure, retry-poller).
  const allSteps = await getWorkflowRunStepsByRunId(runId);
  if (allSteps.length >= getMaxWorkflowStepsPerRun()) {
    await updateWorkflowRun(runId, {
      status: "failed",
      error: `Circuit breaker: run exceeded ${getMaxWorkflowStepsPerRun()} total steps (WORKFLOW_MAX_STEPS_PER_RUN)`,
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
    if (nodeExecutionCount > maxIterations()) {
      await updateWorkflowRun(runId, {
        status: "failed",
        error: `Max node executions (${maxIterations()}) exceeded — possible infinite loop`,
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    // Execute all pending nodes in parallel
    const results = await Promise.all(
      pendingNodes.map((node) =>
        executeStep(def, runId, ctx, node, registry, workflowId, secretKeys, options).catch(
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
        const currentRun = await getWorkflowRun(runId);
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
  //
  // Read, guard, step snapshot and write share one transaction (same shape as
  // finalizeOrWait): a cancel committing in between would otherwise be
  // overwritten from a stale snapshot, resurrecting the run as `completed` or
  // parking it in `waiting` with no waiting step left to ever finalize it.
  await getDbClient().transaction(async () => {
    const run = await getWorkflowRun(runId);
    if (!run || run.status !== "running") return;

    const finalSteps = await getWorkflowRunStepsByRunId(runId);
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
      await updateWorkflowRun(runId, { status: "waiting" });
    } else if (!hasPendingRetries) {
      if (failedSteps.length > 0 && !hasCompletedSteps) {
        // All branches failed — mark run as failed
        const failedNodeIds = failedSteps.map((s) => s.nodeId).join(", ");
        await updateWorkflowRun(runId, {
          status: "failed",
          error: `All branches failed. Failed nodes: ${failedNodeIds}`,
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      } else if (failedSteps.length > 0) {
        // Partial failure — some branches succeeded, some failed.
        // Mark as completed with error noting partial failure.
        const failedNodeIds = failedSteps.map((s) => s.nodeId).join(", ");
        await updateWorkflowRun(runId, {
          status: "completed",
          error: `Partial failure: nodes [${failedNodeIds}] failed (mustPass validation), but other branches completed successfully`,
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      } else {
        await updateWorkflowRun(runId, {
          status: "completed",
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      }
    }
  });
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
  secretKeys: Set<string> = new Set(),
  options: WorkflowExecutionOptions = {},
): Promise<StepResult> {
  // Use iteration-aware idempotency key to support loops. The iteration
  // count, the dedup read, and the step insert commit together — and the key
  // rides the INSERT itself — so the UNIQUE(idempotencyKey) index arbitrates
  // concurrent executions of the same node instead of an orphan step row
  // committing before a follow-up key UPDATE throws.
  const dedup = await getDbClient().transaction(async () => {
    // Count existing steps for this node to determine the current iteration.
    const iteration = await getStepCountForNode(runId, node.id);
    const idempotencyKey = `${runId}:${node.id}:${iteration}`;

    // 1. Memoization / deduplication check (within same iteration)
    const existingStep = await getStepByIdempotencyKey(idempotencyKey);
    if (
      existingStep &&
      (existingStep.status === "completed" || existingStep.status === "waiting")
    ) {
      return { existingStep, stepId: existingStep.id, deduped: true };
    }
    // For "pending" or "failed" steps, fall through to re-execute

    // 2. Create step
    // Redact resolved secret values from the persisted input so credentials
    // stored in `ctx.input` (resolved via `secret.*` or sensitive `${ENV}`
    // references) don't leak through `get-workflow-run` or any other reader of
    // the `workflow_run_steps` table. The live `ctx` is untouched — executors
    // still see real values.
    const latestForeachStep =
      node.type === "foreach" ? await getLatestStepForNode(runId, node.id) : undefined;
    const reusableForeachStep =
      latestForeachStep && !FOREACH_TERMINAL_STEP_STATUSES.has(latestForeachStep.status)
        ? latestForeachStep
        : undefined;
    const stepId = reusableForeachStep?.id ?? crypto.randomUUID();
    if (!reusableForeachStep) {
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: node.id,
        nodeType: node.type,
        input: redactSecretsForStorage(ctx, secretKeys),
        idempotencyKey,
      });
    }
    return { existingStep, stepId, deduped: false };
  });

  if (dedup.deduped && dedup.existingStep) {
    if (dedup.existingStep.status === "completed") {
      // Inject stored output into context
      ctx[node.id] = dedup.existingStep.output;
      // For memoized steps, return all successors (no port — use default)
      const successors = getSuccessors(def, node.id);
      return { outcome: "completed", successors };
    }
    // Step already exists and is waiting for async completion (e.g., agent-task).
    // Don't create a duplicate — just report as waiting.
    return { outcome: "waiting", successors: [] };
  }
  const existingStep = dedup.existingStep;
  const stepId = dedup.stepId;

  // 3. Get executor
  const executor = registry.get(node.type);

  // 3b. Build local interpolation context from explicit inputs mapping
  const interpolationCtx = buildNodeInterpolationCtx(node, ctx);

  // 3c. Validate resolved inputs against inputSchema if defined
  if (node.inputSchema) {
    const inputErrors = validateJsonSchema(
      node.inputSchema as Record<string, unknown>,
      interpolationCtx,
    );
    if (inputErrors.length > 0) {
      const errorMsg = `Input schema validation failed: ${inputErrors.join("; ")}`;
      await checkpointStepFailure(runId, stepId, errorMsg, 0);
      throw new Error(errorMsg);
    }
  }

  // 4. Deep-interpolate config using local context (not global ctx)
  const {
    value: interpolatedValue,
    unresolved,
    scriptBodyUnresolved,
  } = interpolateNodeConfig(node, interpolationCtx);
  const interpolatedConfig = interpolatedValue as Record<string, unknown>;
  const executionCtx: Record<string, unknown> = { ...ctx, ...interpolationCtx };

  if (scriptBodyUnresolved && scriptBodyUnresolved.length > 0) {
    const errorMsg = scriptBodyInterpolationError(node.id, scriptBodyUnresolved);
    await checkpointStepFailure(runId, stepId, errorMsg, 0);
    return { outcome: "failed", successors: [] };
  }

  if (unresolved.length > 0) {
    console.warn(
      `[workflow] Step ${node.id}: unresolved interpolation tokens: ${unresolved.join(", ")}`,
    );
    await updateWorkflowRunStep(stepId, {
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
    requestedByUserId: options.requestedByUserId,
    inputCtx: interpolationCtx,
  };

  // Inline script nodes historically expose their wall-clock budget as
  // `config.timeout`, while the workflow watchdog reads `config.timeoutMs` for
  // every other executor. Keep the outer watchdog aligned with the script
  // executor so a script configured for (for example) 90s is not killed by the
  // engine's 30s default first.
  const configuredTimeoutMs =
    typeof node.config?.timeoutMs === "number"
      ? node.config.timeoutMs
      : node.type === "script" && typeof node.config?.timeout === "number"
        ? node.config.timeout
        : undefined;
  const timeoutMs = configuredTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: Awaited<ReturnType<typeof executor.run>>;
  try {
    result = await Promise.race([
      executor.run({
        config: interpolatedConfig,
        context: executionCtx,
        meta,
      }),
      timeoutPromise(timeoutMs),
    ]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Apply retry policy if configured
    const retryPolicy = node.retry || executor.retryPolicy;
    const currentRetryCount = existingStep?.retryCount || 0;
    const { shouldRetry } = await checkpointStepFailure(
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
    const { shouldRetry } = await checkpointStepFailure(
      runId,
      stepId,
      result.error || "Executor returned failed status",
      currentRetryCount,
      retryPolicy,
    );

    // Persist output for observability even on failure (e.g. script nodes keep {exitCode, stdout, stderr})
    if (result.output !== undefined) {
      await updateWorkflowRunStep(stepId, { output: result.output });
    }

    if (!shouldRetry) {
      throw new Error(result.error || "Step execution failed");
    }
    return { outcome: "completed", successors: [] }; // Retry handled by poller
  }

  // Check for async result
  if ("async" in result && (result as AsyncExecutorResult).async) {
    await checkpointStepWaiting(runId, stepId, ctx);
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
      await checkpointStepFailure(runId, stepId, errorMsg, 0);
      throw new Error(errorMsg);
    }
  }

  // 7. Run validation if configured
  let validationResult: ValidationRunResult | undefined;
  if (node.validation) {
    validationResult = await runStepValidation(registry, node, result.output, executionCtx, meta);

    if (validationResult.outcome === "halt") {
      const errorMsg = "Validation failed (mustPass)";
      await checkpointStepFailure(runId, stepId, errorMsg, 0, undefined, { markRunFailed: false });
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
      await checkpointStepFailure(
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
  await checkpointStep(runId, stepId, node.id, result, ctx);

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

/**
 * Build a node's interpolation context: the built-in sources plus its declared
 * `inputs` aliases resolved against the run context. This is THE dataflow
 * boundary for node config — every path that interpolates a node's config
 * (initial execution AND the retry poller) must resolve aliases through this,
 * or `{{alias}}` tokens silently resolve to empty strings on that path.
 */
export function buildNodeInterpolationCtx(
  node: Pick<WorkflowNode, "inputs">,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const interpolationCtx: Record<string, unknown> = {};
  // Always include built-in sources
  if (ctx.trigger !== undefined) interpolationCtx.trigger = ctx.trigger;
  if (ctx.input !== undefined) interpolationCtx.input = ctx.input;
  if (ctx.workflow !== undefined) interpolationCtx.workflow = ctx.workflow;
  if (ctx.swarm !== undefined) interpolationCtx.swarm = ctx.swarm;
  if (ctx.run !== undefined) interpolationCtx.run = ctx.run;
  if (!node.inputs) return interpolationCtx;
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
  return interpolationCtx;
}

/**
 * Context roots a `script` node's BODY may interpolate from. Everything here is
 * operator- or system-authored: `input` comes from the workflow definition
 * (resolving `secret.` / `${ENV}` refs), `workflow`/`run`/`swarm` are engine
 * metadata. Deliberately excluded: `trigger` (webhook payloads — attacker
 * controlled), upstream node outputs (`{{someNode.field}}` — LLM- or
 * script-generated text), and any declared `inputs` alias rooted at one of
 * those. See `buildScriptBodyCtx`.
 */
const SCRIPT_BODY_ALLOWED_SOURCES = new Set(["input", "workflow", "swarm", "run"]);

/**
 * Project `interpolationCtx` down to the sources a script body is allowed to
 * read. Aliases are classified by the ROOT of their declared source path, not
 * by their local name, so `inputs: { payload: "trigger.payload" }` is excluded
 * even though it is called `payload`, and a builtin name shadowed by an unsafe
 * alias (`inputs: { input: "trigger.body" }`) is excluded too.
 */
function buildScriptBodyCtx(
  node: Pick<WorkflowNode, "inputs">,
  interpolationCtx: Record<string, unknown>,
): Record<string, unknown> {
  const aliases = node.inputs ?? {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(interpolationCtx)) {
    const sourcePath = aliases[key];
    // A key with no declared alias is a builtin source and is judged by its own
    // name; an aliased key is judged by the root of what it points at.
    const root = sourcePath === undefined ? key : (sourcePath.split(".")[0] ?? "");
    if (SCRIPT_BODY_ALLOWED_SOURCES.has(root)) safe[key] = value;
  }
  return safe;
}

export function interpolateNodeConfig(
  node: Pick<WorkflowNode, "type" | "config" | "inputs">,
  interpolationCtx: Record<string, unknown>,
): { value: unknown; unresolved: string[]; scriptBodyUnresolved?: string[] } {
  if (node.type === "foreach" && Object.hasOwn(node.config, "over")) {
    const { over, body, ...configWithoutOverAndBody } = node.config;
    const configResult = deepInterpolate(configWithoutOverAndBody, interpolationCtx);
    const overResult = deepInterpolate(over, interpolationCtx, { preserveRawTokens: true });

    return {
      value: {
        ...(configResult.value as Record<string, unknown>),
        over: overResult.value,
        // {{item.*}} and {{index}} do not exist until the foreach executor
        // materializes a child, so preserve the body for that per-item pass.
        body,
      },
      unresolved: [...configResult.unresolved, ...overResult.unresolved],
    };
  }

  if (node.type === "script" && typeof node.config.script === "string") {
    const { script, ...configWithoutScript } = node.config;
    const restResult = deepInterpolate(configWithoutScript, interpolationCtx);

    // The interpolated script body is handed straight to `bash -c` / `bun -e` /
    // `python3 -c` (ScriptExecutor.runScript), so string-substituting untrusted
    // text into it is a direct shell/code injection vector. Restrict the body to
    // an ALLOWLIST of operator/system-authored sources rather than blocking
    // `trigger` alone: excluding only the literal `trigger` key would still let
    // a declared alias (`inputs: { payload: "trigger.payload" }` used as
    // `{{payload}}`) carry webhook data into the body, and upstream node outputs
    // (`{{someNode.stdout}}`) are LLM- or script-generated text with the same
    // problem. Dynamic per-run values must flow through `args` instead, which
    // are passed as separate argv elements (data), not spliced into source text.
    // Preserve the original source when a body token cannot be resolved. The
    // caller fails the node before execution and reports the token explicitly;
    // returning partially blanked source here would recreate the silent-green
    // failure this guard is intended to prevent.
    const scriptResult = deepInterpolate(script, buildScriptBodyCtx(node, interpolationCtx));

    return {
      value: {
        ...(restResult.value as Record<string, unknown>),
        script: scriptResult.unresolved.length > 0 ? script : scriptResult.value,
      },
      unresolved: [...restResult.unresolved, ...scriptResult.unresolved],
      scriptBodyUnresolved: scriptResult.unresolved,
    };
  }

  if (node.type !== "swarm-script" || !Object.hasOwn(node.config, "args")) {
    return deepInterpolate(node.config, interpolationCtx);
  }

  const { args, ...configWithoutArgs } = node.config;
  const configResult = deepInterpolate(configWithoutArgs, interpolationCtx);
  const argsResult = deepInterpolate(args, interpolationCtx, { preserveRawTokens: true });

  return {
    value: {
      ...(configResult.value as Record<string, unknown>),
      args: argsResult.value,
    },
    unresolved: [...configResult.unresolved, ...argsResult.unresolved],
  };
}

export function scriptBodyInterpolationError(nodeId: string, tokens: string[]): string {
  const renderedTokens = [...new Set(tokens)].map((token) => `{{${token}}}`).join(", ");
  return (
    `Script body interpolation failed for node "${nodeId}": unresolved or disallowed token(s): ${renderedTokens}. ` +
    "Executable source may interpolate only input, workflow, swarm, or run values. " +
    "Pass dynamic trigger or upstream values through config.args and read them from argv."
  );
}

// ─── Helpers ───────────────────────────────────────────────

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Step timed out after ${ms}ms`)), ms);
  });
}

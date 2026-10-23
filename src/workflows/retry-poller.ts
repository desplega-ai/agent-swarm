import {
  getDbClient,
  getRetryableSteps,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
} from "../be/db";
import type { RetryPolicy } from "../types";
import { checkpointStep, checkpointStepFailure, checkpointStepWaiting } from "./checkpoint";
import { getSuccessors, resolveValidationPort } from "./definition";
import {
  failRunOnUnreadableReplay,
  holdWorkflowRun,
  scriptBodyInterpolationError,
  walkGraph,
} from "./engine";
import type { AsyncExecutorResult } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";
import { FOREACH_ITEMS_WAIT_FOR, parkAndDriveForeach } from "./foreach-driver";
import { rebuildNodeExecutionInput } from "./step-input";
import { runStepValidation } from "./validation";

let pollerTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the retry poller.
 *
 * Uses setTimeout chaining (not setInterval) to prevent overlap —
 * the next tick is scheduled only after the current one completes.
 */
export function startRetryPoller(registry: ExecutorRegistry, intervalMs = 5000): void {
  if (pollerTimeout !== null) return; // Already running

  async function poll(): Promise<void> {
    try {
      const retryableSteps = await getRetryableSteps();

      for (const step of retryableSteps) {
        let release: (() => void) | undefined;
        try {
          const run = await getWorkflowRun(step.runId);
          if (!run) continue;

          const workflow = await getWorkflow(run.workflowId);
          if (!workflow) continue;

          // Find the node definition for this step
          const node = workflow.definition.nodes.find((n) => n.id === step.nodeId);
          if (!node) continue;

          console.log(
            `[workflows] Retrying step ${step.nodeId} (attempt ${step.retryCount}) for run ${step.runId}`,
          );

          // Own the run while this step executes, so heartbeat recovery does
          // not walk the same node alongside the retry.
          release = holdWorkflowRun(run.id);

          // Claim the retry and revive the run in one transaction. The row and
          // the run were read outside it: a cancel committing in between must
          // win, or the step re-executes inside a cancelled run.
          if (!(await claimRetry(run.id, step.id))) continue;
          // Every result write below is fenced on this claim, so a cancel or
          // another settle that commits while the executor runs wins.
          const fence = { retryCount: step.retryCount };

          // Rebuild `run.id`, upstream outputs and the node's declared-inputs
          // context the way the original execution saw them. Without the alias
          // context a retried foreach with `over: "{{items}}"` burns all its
          // retries on schema rejections without ever re-dispatching.
          const {
            ctx,
            inputCtx,
            config: interpolatedConfig,
            scriptBodyUnresolved,
          } = await rebuildNodeExecutionInput(workflow.definition, run, node, registry);
          if (scriptBodyUnresolved && scriptBodyUnresolved.length > 0) {
            await checkpointStepFailure(
              run.id,
              step.id,
              scriptBodyInterpolationError(node.id, scriptBodyUnresolved),
              step.retryCount,
              undefined,
              { fence },
            );
            continue;
          }

          // Get executor and re-run
          const executor = registry.get(node.type);
          const meta = {
            runId: run.id,
            stepId: step.id,
            nodeId: step.nodeId,
            workflowId: workflow.id,
            dryRun: false,
            requestedByUserId: run.createdBy,
            inputCtx,
          };

          try {
            const result = await executor.run({
              config: interpolatedConfig,
              context: ctx,
              meta,
            });

            if (result.status === "failed") {
              // Re-failed — use the EXISTING retryCount from the step.
              // checkpointStepFailure handles marking run as failed if no retries left,
              // or setting nextRetryAt for the next poll cycle. A non-retryable
              // failure skips the policy, as in executeStep.
              const retryPolicy =
                result.retryable === false ? undefined : node.retry || executor.retryPolicy;
              await checkpointStepFailure(
                run.id,
                step.id,
                result.error || "Retry failed",
                step.retryCount,
                retryPolicy,
                { fence, output: result.output },
              );
            } else if (
              "async" in result &&
              (result as AsyncExecutorResult).async &&
              (result as AsyncExecutorResult).waitFor === FOREACH_ITEMS_WAIT_FOR
            ) {
              // A retried foreach materialized its children: park it and start
              // them, as executeStep does. An all-inline fan-out can close its
              // join inside the drive; route the successors here then.
              const drive = await parkAndDriveForeach({
                runId: run.id,
                stepId: step.id,
                parentNodeId: node.id,
                ctx,
                registry,
              });
              if (!drive.joined) continue;
              if (drive.successors.length > 0) {
                await walkGraph(
                  workflow.definition,
                  run.id,
                  ctx,
                  drive.successors,
                  registry,
                  workflow.id,
                );
              } else {
                await completeRunIfSettled(run.id, ctx);
              }
            } else if ("async" in result && (result as AsyncExecutorResult).async) {
              // An async executor (agent-task, foreach) re-dispatched its work —
              // the step is waiting on task events again, exactly like the
              // executeStep async path. Checkpointing the async marker as a
              // completed output would route successors while the re-dispatched
              // work is still running, and the eventual completion/join would
              // find the parent already advanced.
              const waiting = await checkpointStepWaiting(run.id, step.id, ctx);
              if (!waiting) continue;
              // As in executeStep: a child run that finished before the step
              // parked had its event dropped.
              if ((result as AsyncExecutorResult).waitFor === "workflow.child.finished") {
                const { resumeFromChildRun } = await import("./resume");
                await resumeFromChildRun(step.id, registry);
              }
            } else {
              // Success! Re-run validation if configured before checkpointing.
              let validationPassed: boolean | undefined;
              if (node.validation) {
                const validationResult = await runStepValidation(
                  registry,
                  node,
                  result.output,
                  ctx,
                  meta,
                );

                if (validationResult.outcome === "halt") {
                  await checkpointStepFailure(
                    run.id,
                    step.id,
                    "Validation failed (mustPass)",
                    step.retryCount,
                    undefined,
                    { fence },
                  );
                  continue;
                }

                if (validationResult.outcome === "retry") {
                  // Append validation context to history
                  if (validationResult.retryContext) {
                    const historyKey = `${node.id}_validations`;
                    const existing = (ctx[historyKey] as unknown[]) || [];
                    ctx[historyKey] = [...existing, validationResult.retryContext];
                  }
                  const retryPolicy = node.validation.retry || node.retry;
                  await checkpointStepFailure(
                    run.id,
                    step.id,
                    "Validation failed, retrying",
                    step.retryCount,
                    retryPolicy,
                    { fence },
                  );
                  continue;
                }
                validationPassed = validationResult.passed;
              }

              // Same port rule as executeStep step 8, so a retried script node
              // with `next: { pass, fail }` does not dead-end on "success".
              result.nextPort = resolveValidationPort(node.next, result.nextPort, validationPassed);

              // Validation passed (or no validation) — checkpoint and continue
              if (!(await checkpointStep(run.id, step.id, step.nodeId, result, ctx, { fence }))) {
                continue;
              }

              const port = result.nextPort || "default";
              const successors = getSuccessors(workflow.definition, step.nodeId, port);
              if (successors.length > 0) {
                await walkGraph(
                  workflow.definition,
                  run.id,
                  ctx,
                  successors,
                  registry,
                  workflow.id,
                );
              } else {
                await completeRunIfSettled(run.id, ctx);
              }
            }
          } catch (err) {
            // Execution threw — treat as failure
            if (await failRunOnUnreadableReplay(run.id, err, step.id)) continue;
            const errorMsg = err instanceof Error ? err.message : String(err);
            const retryPolicy = node.retry || executor.retryPolicy;
            await checkpointStepFailure(run.id, step.id, errorMsg, step.retryCount, retryPolicy, {
              fence,
            });
          }
        } catch (err) {
          if (await failRunOnUnreadableReplay(step.runId, err, step.id)) continue;
          console.error(`[workflows] Retry failed for step ${step.id}:`, err);
        } finally {
          release?.();
        }
      }
    } catch (err) {
      console.error("[workflows] Retry poller error:", err);
    }

    // Schedule next tick after completion
    pollerTimeout = setTimeout(poll, intervalMs);
  }

  // Start the first tick
  pollerTimeout = setTimeout(poll, intervalMs);
}

/**
 * Flip a retry-pending step to `running` only while it is still retry-pending
 * and its run is live, and revive a run failed by this step.
 */
async function claimRetry(runId: string, stepId: string): Promise<boolean> {
  return getDbClient().transaction(async () => {
    const run = await getWorkflowRun(runId);
    if (!run || !RETRYABLE_RUN_STATUSES.has(run.status)) return false;
    const claimed = await getDbClient().get<{ id: string }>(
      `UPDATE workflow_run_steps
          SET status = 'running', nextRetryAt = NULL
        WHERE id = ? AND runId = ? AND status = 'failed' AND nextRetryAt IS NOT NULL
        RETURNING id`,
      [stepId, runId],
    );
    if (!claimed) return false;
    if (run.status === "failed") {
      await updateWorkflowRun(runId, { status: "running", error: undefined });
    }
    return true;
  });
}

/**
 * A retried leaf succeeded. Complete the run only if it is still live and no
 * other step is running, waiting, or pending a retry — the same rule as the
 * walkGraph finalizer.
 */
async function completeRunIfSettled(runId: string, ctx: Record<string, unknown>): Promise<void> {
  await getDbClient().transaction(async () => {
    const run = await getWorkflowRun(runId);
    if (!run || (run.status !== "running" && run.status !== "waiting")) return;
    const steps = await getWorkflowRunStepsByRunId(runId);
    const live = steps.some(
      (s) =>
        s.status === "running" ||
        s.status === "waiting" ||
        (s.status === "failed" && s.nextRetryAt != null),
    );
    if (live) return;
    await updateWorkflowRun(runId, {
      status: "completed",
      context: ctx,
      finishedAt: new Date().toISOString(),
    });
  });
}

const RETRYABLE_RUN_STATUSES = new Set(["running", "waiting", "failed"]);

/**
 * Stop the retry poller (for clean shutdown).
 */
export function stopRetryPoller(): void {
  if (pollerTimeout !== null) {
    clearTimeout(pollerTimeout);
    pollerTimeout = null;
  }
}

/**
 * Calculate retry delay based on policy and attempt number.
 */
export function calculateDelay(policy: RetryPolicy, attempt: number): number {
  let delay: number;

  switch (policy.strategy) {
    case "exponential": {
      // Exponential with full jitter
      const base = policy.baseDelayMs * 2 ** attempt;
      delay = Math.random() * Math.min(base, policy.maxDelayMs);
      break;
    }
    case "linear":
      delay = policy.baseDelayMs * (attempt + 1);
      break;
    case "static":
      delay = policy.baseDelayMs;
      break;
    default:
      delay = policy.baseDelayMs;
  }

  return Math.min(delay, policy.maxDelayMs);
}

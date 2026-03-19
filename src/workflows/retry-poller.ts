import {
  getRetryableSteps,
  getWorkflow,
  getWorkflowRun,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { RetryPolicy } from "../types";
import { checkpointStep, checkpointStepFailure } from "./checkpoint";
import { getSuccessors } from "./definition";
import { walkGraph } from "./engine";
import type { ExecutorRegistry } from "./executors/registry";
import { interpolate } from "./template";

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
      const retryableSteps = getRetryableSteps();

      for (const step of retryableSteps) {
        try {
          const run = getWorkflowRun(step.runId);
          if (!run) continue;

          const workflow = getWorkflow(run.workflowId);
          if (!workflow) continue;

          // Find the node definition for this step
          const node = workflow.definition.nodes.find((n) => n.id === step.nodeId);
          if (!node) continue;

          console.log(
            `[workflows] Retrying step ${step.nodeId} (attempt ${step.retryCount}) for run ${step.runId}`,
          );

          // If the run was failed (due to this step), set it back to running
          if (run.status === "failed") {
            updateWorkflowRun(run.id, {
              status: "running",
              error: undefined,
            });
          }

          // Clear the retry marker so this step isn't picked up again
          updateWorkflowRunStep(step.id, {
            status: "running",
            error: undefined,
            nextRetryAt: undefined,
          });

          const ctx = (run.context ?? {}) as Record<string, unknown>;

          // Interpolate config
          const interpolatedConfig: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(node.config)) {
            if (typeof value === "string") {
              interpolatedConfig[key] = interpolate(value, ctx);
            } else {
              interpolatedConfig[key] = value;
            }
          }

          // Get executor and re-run
          const executor = registry.get(node.type);
          const meta = {
            runId: run.id,
            stepId: step.id,
            nodeId: step.nodeId,
            workflowId: workflow.id,
            dryRun: false,
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
              // or setting nextRetryAt for the next poll cycle.
              const retryPolicy = node.retry || executor.retryPolicy;
              checkpointStepFailure(
                run.id,
                step.id,
                result.error || "Retry failed",
                step.retryCount,
                retryPolicy,
              );
            } else {
              // Success! Checkpoint and continue the graph
              checkpointStep(run.id, step.id, step.nodeId, result, ctx);

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
                // No successors — check if run is complete
                updateWorkflowRun(run.id, {
                  status: "completed",
                  context: ctx,
                  finishedAt: new Date().toISOString(),
                });
              }
            }
          } catch (err) {
            // Execution threw — treat as failure
            const errorMsg = err instanceof Error ? err.message : String(err);
            const retryPolicy = node.retry || executor.retryPolicy;
            checkpointStepFailure(run.id, step.id, errorMsg, step.retryCount, retryPolicy);
          }
        } catch (err) {
          console.error(`[workflows] Retry failed for step ${step.id}:`, err);
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

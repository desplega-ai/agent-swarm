import { getDbClient, getWorkflowRun, updateWorkflowRun, updateWorkflowRunStep } from "../be/db";
import { getRunLineageBlock } from "../be/db/workflow-runs";
import type { RetryPolicy } from "../types";

/**
 * The execution a checkpoint belongs to: the step attempt (`retryCount`) that
 * claimed the row. A fenced checkpoint writes only while that attempt still
 * owns the row: the step is `running` with that `retryCount` in a `running` or
 * `waiting` run with no cancelled ancestor. A cancel, a newer attempt or
 * another settle that committed meanwhile wins, and the stale execution
 * writes nothing.
 */
export type StepFence = { retryCount: number };

async function holdsFence(runId: string, stepId: string, fence: StepFence): Promise<boolean> {
  const row = await getDbClient().get<{ found: number }>(
    `SELECT 1 AS found
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.runId
      WHERE s.id = ? AND s.runId = ? AND s.status = 'running' AND s.retryCount = ?
        AND r.status IN ('running', 'waiting')`,
    [stepId, runId, fence.retryCount],
  );
  return row != null && (await getRunLineageBlock(runId)) == null;
}

/**
 * Checkpoint a successful step — atomic DB write of step result + run context.
 * Returns false, writing nothing, when `fence` no longer holds.
 */
export async function checkpointStep(
  runId: string,
  stepId: string,
  nodeId: string,
  result: { output?: unknown; nextPort?: string },
  ctx: Record<string, unknown>,
  options: { fence?: StepFence } = {},
): Promise<boolean> {
  return getDbClient().transaction(async () => {
    if (options.fence && !(await holdsFence(runId, stepId, options.fence))) return false;
    await updateWorkflowRunStep(stepId, {
      status: "completed",
      output: result.output,
      nextPort: result.nextPort || undefined,
      finishedAt: new Date().toISOString(),
    });

    // Merge step output into run context
    ctx[nodeId] = result.output;
    await updateWorkflowRun(runId, {
      context: ctx,
    });
    return true;
  });
}

/**
 * Checkpoint a step failure — marks step failed, calculates retry if applicable.
 * With `fence`, a stale execution writes nothing and gets `stale: true`.
 * `output` is kept on the failed step for observability, in the same write.
 */
export async function checkpointStepFailure(
  runId: string,
  stepId: string,
  error: string,
  retryCount: number,
  retryPolicy?: RetryPolicy,
  options?: { markRunFailed?: boolean; fence?: StepFence; output?: unknown },
): Promise<{ shouldRetry: boolean; stale?: true }> {
  const now = new Date().toISOString();

  return getDbClient().transaction(async () => {
    if (options?.fence && !(await holdsFence(runId, stepId, options.fence))) {
      return { shouldRetry: false, stale: true as const };
    }

    if (retryPolicy && retryCount < retryPolicy.maxRetries) {
      const delay = calculateBackoff(retryPolicy, retryCount);
      const nextRetryAt = new Date(Date.now() + delay).toISOString();

      await updateWorkflowRunStep(stepId, {
        status: "failed",
        error,
        output: options?.output,
        retryCount: retryCount + 1,
        maxRetries: retryPolicy.maxRetries,
        nextRetryAt,
      });

      return { shouldRetry: true };
    }

    // No retries left — mark step failed, and optionally the run too
    // Clear nextRetryAt so the poller stops picking this step up
    await updateWorkflowRunStep(stepId, {
      status: "failed",
      error,
      output: options?.output,
      finishedAt: now,
      nextRetryAt: null,
    });

    const markRunFailed = options?.markRunFailed ?? true;
    if (markRunFailed) {
      // A cancel or finalization that committed while the step ran wins.
      const run = await getWorkflowRun(runId);
      if (run?.status === "running" || run?.status === "waiting") {
        await updateWorkflowRun(runId, {
          status: "failed",
          error: `Step failed: ${error}`,
          finishedAt: now,
        });
      }
    }

    return { shouldRetry: false };
  });
}

/**
 * Checkpoint a step entering waiting state (async executor).
 *
 * `keepRunStatus` parks the step and persists the context but leaves the run
 * `running`: a foreach parent parks before its driver starts the children, and
 * the run must not read as `waiting` until they are dispatched.
 */
export async function checkpointStepWaiting(
  runId: string,
  stepId: string,
  ctx: Record<string, unknown>,
  options: { keepRunStatus?: boolean } = {},
): Promise<boolean> {
  return getDbClient().transaction(async () => {
    if (await getRunLineageBlock(runId)) return false;
    const step = await getDbClient().get<{ id: string }>(
      `UPDATE workflow_run_steps
         SET status = 'waiting'
       WHERE id = ? AND runId = ? AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM workflow_runs
           WHERE id = ? AND status IN ('running', 'waiting')
         )
       RETURNING id`,
      [stepId, runId, runId],
    );
    if (!step) return false;

    await updateWorkflowRun(
      runId,
      options.keepRunStatus ? { context: ctx } : { status: "waiting", context: ctx },
    );
    return true;
  });
}

/**
 * Calculate backoff delay based on retry policy and current attempt.
 */
function calculateBackoff(policy: RetryPolicy, attempt: number): number {
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

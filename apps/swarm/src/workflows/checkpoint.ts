import { getDb, updateWorkflowRun, updateWorkflowRunStep } from "../be/db";
import type { RetryPolicy } from "../types";

/**
 * Checkpoint a successful step — atomic DB write of step result + run context.
 */
export function checkpointStep(
  runId: string,
  stepId: string,
  nodeId: string,
  result: { output?: unknown; nextPort?: string },
  ctx: Record<string, unknown>,
): void {
  const txn = getDb().transaction(() => {
    updateWorkflowRunStep(stepId, {
      status: "completed",
      output: result.output,
      nextPort: result.nextPort || undefined,
      finishedAt: new Date().toISOString(),
    });

    // Merge step output into run context
    ctx[nodeId] = result.output;
    updateWorkflowRun(runId, {
      context: ctx,
    });
  });
  txn();
}

/**
 * Checkpoint a step failure — marks step failed, calculates retry if applicable.
 */
export function checkpointStepFailure(
  runId: string,
  stepId: string,
  error: string,
  retryCount: number,
  retryPolicy?: RetryPolicy,
  options?: { markRunFailed?: boolean },
): { shouldRetry: boolean } {
  const now = new Date().toISOString();

  if (retryPolicy && retryCount < retryPolicy.maxRetries) {
    const delay = calculateBackoff(retryPolicy, retryCount);
    const nextRetryAt = new Date(Date.now() + delay).toISOString();

    updateWorkflowRunStep(stepId, {
      status: "failed",
      error,
      retryCount: retryCount + 1,
      maxRetries: retryPolicy.maxRetries,
      nextRetryAt,
    });

    return { shouldRetry: true };
  }

  // No retries left — mark step failed, and optionally the run too
  // Clear nextRetryAt so the poller stops picking this step up
  updateWorkflowRunStep(stepId, {
    status: "failed",
    error,
    finishedAt: now,
    nextRetryAt: null,
  });

  const markRunFailed = options?.markRunFailed ?? true;
  if (markRunFailed) {
    updateWorkflowRun(runId, {
      status: "failed",
      error: `Step failed: ${error}`,
      finishedAt: now,
    });
  }

  return { shouldRetry: false };
}

/**
 * Checkpoint a step entering waiting state (async executor).
 */
export function checkpointStepWaiting(
  runId: string,
  stepId: string,
  ctx: Record<string, unknown>,
): void {
  const txn = getDb().transaction(() => {
    updateWorkflowRunStep(stepId, {
      status: "waiting",
    });

    updateWorkflowRun(runId, {
      status: "waiting",
      context: ctx,
    });
  });
  txn();
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

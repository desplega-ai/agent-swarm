import type { ExecutorMeta, WorkflowDefinition, WorkflowNode } from "../types";
import { checkpointStep, checkpointStepFailure, type StepFence } from "./checkpoint";
import { getSuccessors, resolveValidationPort } from "./definition";
import type { ExecutorResult } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";
import { runStepValidation, type ValidationRunResult, validateOutputSchema } from "./validation";

/** Settle an awaited or durable result through the same validation and checkpoint rules. */
export async function settleStepResult(input: {
  runId: string;
  stepId: string;
  node: WorkflowNode;
  def: WorkflowDefinition;
  result: ExecutorResult;
  ctx: Record<string, unknown>;
  executionCtx: Record<string, unknown>;
  meta: ExecutorMeta;
  registry: ExecutorRegistry;
  fence: StepFence;
  retryCount: number;
}): Promise<{ outcome: "completed" | "failed"; successors: string[] }> {
  const { runId, stepId, node, def, result, ctx, executionCtx, meta, registry, fence } = input;
  const stale = { outcome: "completed" as const, successors: [] as string[] };
  if (result.status === "failed") {
    const executor = registry.get(node.type);
    const policy = result.retryable === false ? undefined : node.retry || executor?.retryPolicy;
    const failure = await checkpointStepFailure(
      runId,
      stepId,
      result.error || "Executor returned failed status",
      input.retryCount,
      policy,
      { fence, output: result.output },
    );
    if (failure.stale || failure.shouldRetry) return stale;
    throw new Error(result.error || "Step execution failed");
  }
  // 6b. Validate output against node-level outputSchema if defined
  const outputSchemaError = validateOutputSchema(node, result);
  if (outputSchemaError) {
    const { stale: lost } = await checkpointStepFailure(
      runId,
      stepId,
      outputSchemaError,
      0,
      undefined,
      {
        fence,
      },
    );
    if (lost) return stale;
    throw new Error(outputSchemaError);
  }

  // 7. Run validation if configured
  let validationResult: ValidationRunResult | undefined;
  if (node.validation) {
    validationResult = await runStepValidation(registry, node, result.output, executionCtx, meta);

    if (validationResult.outcome === "halt") {
      const errorMsg = "Validation failed (mustPass)";
      await checkpointStepFailure(runId, stepId, errorMsg, 0, undefined, {
        markRunFailed: false,
        fence,
      });
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
      const currentRetryCount = input.retryCount;
      const { stale: lost } = await checkpointStepFailure(
        runId,
        stepId,
        "Validation failed, retrying",
        currentRetryCount,
        retryPolicy,
        { fence },
      );
      if (lost) return stale;
      return { outcome: "completed", successors: [] }; // Retry handled by poller
    }
  }

  // 8. Set nextPort from validation result for record-based routing
  // When validation determines pass/fail and the node uses port-based `next`,
  // route to the correct port instead of activating all ports. An executor port
  // that `next` does not declare (script's "success" vs `{ pass, fail }`) is
  // overridden too, otherwise the branch would dead-end.
  result.nextPort = resolveValidationPort(node.next, result.nextPort, validationResult?.passed);

  // 9. Checkpoint success
  if (!(await checkpointStep(runId, stepId, node.id, result, ctx, { fence }))) return stale;

  // 10. Determine successors based on nextPort
  // If executor returned a specific port, use it. Otherwise, get all successors
  // (fan-out behavior for non-branching nodes with record-based `next`).
  const successors = result.nextPort
    ? getSuccessors(def, node.id, result.nextPort)
    : getSuccessors(def, node.id);
  return { outcome: "completed", successors };
}

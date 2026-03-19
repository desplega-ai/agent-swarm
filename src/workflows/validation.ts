import type { ExecutorMeta, WorkflowNode } from "../types";
import type { ExecutorRegistry } from "./executors/registry";

export type ValidationOutcome = "pass" | "halt" | "retry";

export interface ValidationRunResult {
  outcome: ValidationOutcome;
  /** Context additions if retry is needed */
  retryContext?: Record<string, unknown>;
}

/**
 * Run per-step validation after a step completes.
 *
 * If the node has no validation config, returns "pass" immediately.
 * Otherwise runs the validation executor and returns the outcome.
 */
export async function runStepValidation(
  registry: ExecutorRegistry,
  stepNode: WorkflowNode,
  stepOutput: unknown,
  context: Record<string, unknown>,
  meta: ExecutorMeta,
): Promise<ValidationRunResult> {
  if (!stepNode.validation) {
    return { outcome: "pass" };
  }

  const validation = stepNode.validation;
  const executorType = validation.executor || "validate";

  const executor = registry.get(executorType);
  const validationConfig = {
    targetNodeId: meta.nodeId,
    ...validation.config,
  };

  // Build a context that includes the step output under its nodeId
  const validationContext: Record<string, unknown> = {
    ...context,
    [meta.nodeId]: stepOutput,
  };

  const result = await executor.run({
    config: validationConfig,
    context: validationContext,
    meta: {
      ...meta,
      stepId: crypto.randomUUID(), // Validation gets its own step ID
    },
  });

  const passed =
    result.status === "success" &&
    result.output &&
    (result.output as { pass?: boolean }).pass === true;

  if (passed) {
    return { outcome: "pass" };
  }

  // Validation failed
  if (validation.mustPass) {
    if (validation.retry) {
      return {
        outcome: "retry",
        retryContext: {
          previousOutput: stepOutput,
          validationResult: result.output,
        },
      };
    }
    return { outcome: "halt" };
  }

  // mustPass is false — treat failure as pass (advisory validation)
  return { outcome: "pass" };
}

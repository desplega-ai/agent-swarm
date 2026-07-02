import type { ExecutorMeta, WorkflowNode } from "../types";
import type { ExecutorRegistry } from "./executors/registry";

export type ValidationOutcome = "pass" | "halt" | "retry";

export interface ValidationRunResult {
  outcome: ValidationOutcome;
  /** Whether the validation actually passed (true) or failed (false). */
  passed?: boolean;
  /** Context additions if retry is needed */
  retryContext?: Record<string, unknown>;
}

/**
 * Normalize executor output to a pass/fail boolean.
 *
 * Different executors use different output shapes to indicate success.
 * This adapter maps each executor type's convention to a uniform boolean.
 */
export function extractPassResult(executorType: string, output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;

  switch (executorType) {
    case "validate":
      return o.pass === true;
    case "script":
      return o.exitCode === 0;
    case "property-match":
      return o.passed === true;
    case "raw-llm":
      // For raw-llm used as validator, check if the LLM output contains a structured pass result
      if (typeof o.result === "object" && o.result !== null) {
        return (o.result as Record<string, unknown>).pass === true;
      }
      return false;
    default:
      // Generic fallback: check for common pass indicators
      return o.pass === true || o.passed === true || o.exitCode === 0;
  }
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

  const passed = result.status === "success" && extractPassResult(executorType, result.output);

  if (passed) {
    return { outcome: "pass", passed: true };
  }

  // Validation failed
  if (validation.mustPass) {
    if (validation.retry) {
      return {
        outcome: "retry",
        passed: false,
        retryContext: {
          previousOutput: stepOutput,
          validationResult: result.output,
        },
      };
    }
    return { outcome: "halt", passed: false };
  }

  // mustPass is false — treat failure as pass (advisory validation)
  return { outcome: "pass", passed: false };
}

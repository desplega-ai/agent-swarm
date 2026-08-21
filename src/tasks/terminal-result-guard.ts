import { overwriteTerminalTaskResultText } from "../be/db";
import type { AgentTask } from "../types";
import { isTerminalTaskStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { validateJsonSchema } from "../workflows/json-schema-validator";

export type TerminalResultWrite = {
  status?: "completed" | "failed";
  output?: string;
  failureReason?: string;
  force?: boolean;
};

export type TerminalResultGuardResult =
  | { handled: false }
  | {
      handled: true;
      success: boolean;
      message: string;
      task: AgentTask;
      wasNoOp?: boolean;
      wasForcedOverwrite?: boolean;
    };

export function getTaskOutputValidationError(outputSchema: unknown, output: string | undefined) {
  if (!outputSchema || typeof outputSchema !== "object") return undefined;

  const schema = outputSchema as Record<string, unknown>;
  if (!output) {
    return `Task has an outputSchema but no output was provided. You must call store-progress with a valid JSON output matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return `Task output must be valid JSON matching the outputSchema. Got invalid JSON. Schema:\n${JSON.stringify(schema, null, 2)}`;
  }

  const validationErrors = validateJsonSchema(schema, parsed);
  if (validationErrors.length > 0) {
    return `Task output does not match the outputSchema. Errors:\n${validationErrors.join("\n")}\n\nExpected schema:\n${JSON.stringify(schema, null, 2)}\n\nPlease fix your output and retry.`;
  }

  return undefined;
}

/**
 * Enforce first-call-wins for terminal task result text across every server
 * surface. A forced correction updates only the explicitly provided text
 * fields; lifecycle state and terminal side effects remain untouched.
 */
export async function guardTerminalTaskResultWrite(
  task: AgentTask,
  write: TerminalResultWrite,
): Promise<TerminalResultGuardResult> {
  if (!isTerminalTaskStatus(task.status) || (!write.status && !write.force)) {
    return { handled: false };
  }

  const scrubbedOutput = write.output !== undefined ? scrubSecrets(write.output) : undefined;
  const scrubbedFailureReason =
    write.failureReason !== undefined ? scrubSecrets(write.failureReason) : undefined;
  const hasDifferingOutput = scrubbedOutput !== undefined && scrubbedOutput !== task.output;
  const hasDifferingFailureReason =
    scrubbedFailureReason !== undefined && scrubbedFailureReason !== task.failureReason;
  const hasDifferingResultText = hasDifferingOutput || hasDifferingFailureReason;

  if (hasDifferingResultText && write.force) {
    const outputValidationError = hasDifferingOutput
      ? getTaskOutputValidationError(task.outputSchema, write.output)
      : undefined;
    if (outputValidationError) {
      return { handled: true, success: false, message: outputValidationError, task };
    }

    const overwrittenTask = await overwriteTerminalTaskResultText(task.id, {
      ...(write.output !== undefined ? { output: write.output } : {}),
      ...(write.failureReason !== undefined ? { failureReason: write.failureReason } : {}),
    });
    if (!overwrittenTask) {
      return {
        handled: true,
        success: false,
        message: `Task "${task.id}" terminal result text could not be overwritten.`,
        task,
      };
    }
    return {
      handled: true,
      success: true,
      message:
        `Task "${task.id}" is already ${task.status}; force-overwrote terminal result text ` +
        "without replaying completion side effects.",
      task: overwrittenTask,
      wasForcedOverwrite: true,
    };
  }

  if (hasDifferingResultText) {
    return {
      handled: true,
      success: false,
      message:
        `Discarded write for already-${task.status} task "${task.id}"; ` +
        "existing output/failureReason and finishedAt were preserved. Retry with force: true " +
        "to overwrite terminal result text without replaying completion side effects.",
      task,
    };
  }

  return {
    handled: true,
    success: true,
    message:
      `Task "${task.id}" is already ${task.status}; treating as no-op. ` +
      "Existing output preserved (first-call-wins).",
    task,
    wasNoOp: true,
  };
}

import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { deepInterpolate } from "../../utils/template";
import {
  buildForeachAggregate,
  FOREACH_TERMINAL_STEP_STATUSES,
  parseSyntheticNodeId,
} from "../foreach-join";
import { getMaxWorkflowStepsPerRun } from "../limits";
import { AgentTaskExecutor } from "./agent-task";
import type { AsyncExecutorResult, ExecutorResult } from "./base";
import { BaseExecutor } from "./base";

const ForeachBodySchema = z.object({
  type: z.literal("agent-task"),
  config: z.record(z.string(), z.unknown()),
});

export const ForeachConfigSchema = z.object({
  over: z.array(z.record(z.string(), z.unknown())),
  itemKey: z.string().min(1),
  body: ForeachBodySchema,
  concurrency: z.never().optional(),
});

const ForeachResultSchema = z.object({
  itemKey: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "skipped"]),
  output: z.unknown().optional(),
});

export const ForeachOutputSchema = z.object({
  results: z.array(ForeachResultSchema),
  okCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});

export type ForeachOutput = z.infer<typeof ForeachOutputSchema>;

export class ForeachExecutor extends BaseExecutor<
  typeof ForeachConfigSchema,
  typeof ForeachOutputSchema
> {
  readonly type = "foreach";
  readonly mode = "async" as const;
  readonly configSchema = ForeachConfigSchema;
  readonly outputSchema = ForeachOutputSchema;

  protected async execute(
    config: z.infer<typeof ForeachConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<ForeachOutput>> {
    if (config.over.length === 0) {
      return {
        status: "success",
        output: { results: [], okCount: 0, failedCount: 0 },
      };
    }

    const items = config.over.map((item, index) => {
      const rawItemKey = item[config.itemKey];
      if (typeof rawItemKey !== "string" || rawItemKey.length === 0) {
        throw new Error(
          `foreach item at index ${index} is missing non-empty string itemKey property "${config.itemKey}"`,
        );
      }
      return { item, index, itemKey: rawItemKey };
    });

    const seenItemKeys = new Set<string>();
    for (const { itemKey } of items) {
      if (seenItemKeys.has(itemKey)) {
        throw new Error(`foreach itemKey "${itemKey}" is duplicated`);
      }
      seenItemKeys.add(itemKey);
    }

    const agentTaskExecutor = new AgentTaskExecutor(this.deps);
    const runSteps = this.deps.db.getWorkflowRunStepsByRunId(meta.runId);
    const childStepsByNodeId = new Map(
      runSteps
        .filter((step) => parseSyntheticNodeId(step.nodeId)?.parentNodeId === meta.nodeId)
        .map((step) => [step.nodeId, step]),
    );
    const childCountToCreate = items.filter(
      ({ itemKey }) => !childStepsByNodeId.has(`${meta.nodeId}#${itemKey}`),
    ).length;
    const maxSteps = getMaxWorkflowStepsPerRun();
    if (runSteps.length + childCountToCreate > maxSteps) {
      return {
        status: "failed",
        error: `foreach would exceed ${maxSteps} total steps (WORKFLOW_MAX_STEPS_PER_RUN): ${runSteps.length} existing + ${childCountToCreate} children`,
      };
    }

    for (const { item, index, itemKey } of items) {
      const childNodeId = `${meta.nodeId}#${itemKey}`;
      let childStep = childStepsByNodeId.get(childNodeId);
      if (!childStep) {
        const childStepId = crypto.randomUUID();
        childStep = this.deps.db.createWorkflowRunStep({
          id: childStepId,
          runId: meta.runId,
          nodeId: childNodeId,
          nodeType: "agent-task",
          input: { itemKey, index },
        });
        this.deps.db.updateWorkflowRunStep(childStepId, {
          idempotencyKey: `${meta.runId}:${childNodeId}:0`,
        });
        childStepsByNodeId.set(childNodeId, childStep);
      }

      // Re-walks must not regress terminal children or disturb their aggregate
      // inputs. Retry resets only the failed child to pending before arriving here.
      if (FOREACH_TERMINAL_STEP_STATUSES.has(childStep.status)) continue;

      const childInterpolation = deepInterpolate(config.body.config, { ...context, item, index });
      if (childInterpolation.unresolved.length > 0) {
        console.warn(
          `[workflow] Step ${childNodeId}: unresolved interpolation tokens: ${childInterpolation.unresolved.join(", ")}`,
        );
        this.deps.db.updateWorkflowRunStep(childStep.id, {
          diagnostics: JSON.stringify({ unresolvedTokens: childInterpolation.unresolved }),
        });
      }

      const linkedTask = this.deps.db.getTaskByWorkflowRunStepId(childStep.id);
      if (linkedTask?.status === "failed" || linkedTask?.status === "cancelled") {
        // A retry needs a fresh task. Detaching the stale terminal task keeps the
        // executor's one-task-per-step de-duplication deterministic and scoped.
        this.deps.db.detachTaskFromWorkflowRunStep(linkedTask.id);
      }

      const childResult = await agentTaskExecutor.run({
        config: childInterpolation.value as Record<string, unknown>,
        context,
        meta: {
          ...meta,
          stepId: childStep.id,
          nodeId: childNodeId,
        },
      });
      if (childResult.status !== "success") {
        throw new Error(childResult.error ?? `foreach child "${itemKey}" failed to start`);
      }
      if ("async" in childResult) {
        this.deps.db.updateWorkflowRunStep(childStep.id, { status: "waiting" });
      } else {
        this.deps.db.updateWorkflowRunStep(childStep.id, {
          status: "completed",
          output: normalizeExistingTaskOutput(childResult.output),
          finishedAt: new Date().toISOString(),
        });
      }
    }

    const childSteps = this.deps.db
      .getWorkflowRunStepsByRunId(meta.runId)
      .filter((step) => parseSyntheticNodeId(step.nodeId)?.parentNodeId === meta.nodeId);
    if (childSteps.every((step) => FOREACH_TERMINAL_STEP_STATUSES.has(step.status))) {
      return { status: "success", output: buildForeachAggregate(childSteps) };
    }

    return {
      status: "success",
      async: true,
      waitFor: "task.completed",
      correlationId: meta.stepId,
    } as AsyncExecutorResult<ForeachOutput>;
  }
}

function normalizeExistingTaskOutput(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return output;
  const record = output as Record<string, unknown>;
  if (typeof record.taskOutput !== "string") return output;
  try {
    const parsed = JSON.parse(record.taskOutput);
    if (typeof parsed === "object" && parsed !== null) {
      return { ...record, taskOutput: parsed };
    }
  } catch {
    // Non-structured task output remains a string.
  }
  return output;
}

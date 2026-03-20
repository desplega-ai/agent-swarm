import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import type { ExecutorResult } from "./base";
import { BaseExecutor } from "./base";

// ─── Config / Output Schemas ────────────────────────────────

const AgentTaskConfigSchema = z.object({
  template: z.string(),
  agentId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  offerMode: z.boolean().optional(),
});

const AgentTaskOutputSchema = z.object({
  taskId: z.string().uuid(),
  taskOutput: z.unknown(),
});

type AgentTaskOutput = z.infer<typeof AgentTaskOutputSchema>;

// ─── Executor ───────────────────────────────────────────────

export class AgentTaskExecutor extends BaseExecutor<
  typeof AgentTaskConfigSchema,
  typeof AgentTaskOutputSchema
> {
  readonly type = "agent-task";
  readonly mode = "async" as const;
  readonly configSchema = AgentTaskConfigSchema;
  readonly outputSchema = AgentTaskOutputSchema;

  protected async execute(
    config: z.infer<typeof AgentTaskConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<AgentTaskOutput>> {
    const { db } = this.deps;

    // 1. Idempotency: check if a task was already created for this step
    const existingTask = db.getTaskByWorkflowRunStepId(meta.stepId);
    if (existingTask) {
      if (existingTask.status === "completed") {
        return {
          status: "success",
          output: {
            taskId: existingTask.id,
            taskOutput: existingTask.output,
          },
        };
      }
      // Task exists but not yet completed — return async marker to keep waiting.
      // The engine detects async results via `"async" in result`.
      return {
        status: "success",
        async: true,
        waitFor: "task.completed",
        correlationId: existingTask.id,
      } as unknown as ExecutorResult<AgentTaskOutput>;
    }

    // 2. Create the task (config is already deep-interpolated by the engine)
    const task = db.createTaskExtended(config.template, {
      agentId: config.agentId ?? null,
      source: "workflow",
      tags: config.tags,
      priority: config.priority,
      offeredTo: config.offerMode ? config.agentId : undefined,
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
    });

    // 4. Return async result — engine will pause the workflow
    return {
      status: "success",
      async: true,
      waitFor: "task.completed",
      correlationId: task.id,
    } as unknown as ExecutorResult<AgentTaskOutput>;
  }
}

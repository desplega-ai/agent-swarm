import { z } from "zod";
import {
  modelGroupRefError,
  modelProfileRefError,
  taskProfileError,
} from "../../be/db/model-profiles";
import { explicitModelErrorForAgent } from "../../be/model-validation";
import { applyPreTaskCreate } from "../../extensions/apply-task-create";
import { workflowContextKey } from "../../tasks/context-key";
import { TaskCreationBlockedError } from "../../tasks/errors";
import type { ExecutorMeta } from "../../types";
import {
  FollowUpConfigSchema,
  ModelTierSchema,
  ReasoningEffortSchema,
  RoutingReasonSchema,
  splitLegacyModelAlias,
} from "../../types";
import { getNodeEnv } from "../../utils/node-env";
import type { ExecutorResult } from "./base";
import { BaseExecutor } from "./base";

// ─── Config / Output Schemas ────────────────────────────────

export const AgentTaskConfigSchema = z.object({
  template: z.string(),
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), so a UUID filter would reject legitimate agents.
  agentId: z.string().optional(),
  routingReason: RoutingReasonSchema.optional(),
  routingNote: z.string().max(200).optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  offerMode: z.boolean().optional(),
  dir: z.string().min(1).optional(),
  vcsRepo: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  modelTier: ModelTierSchema.optional(),
  /** Accept a `model` the catalog does not list (a custom id). Without it an unknown id fails the node. */
  allowCustomModel: z.boolean().optional(),
  effort: ReasoningEffortSchema.optional(),
  /** Model profile name (see list-model-profiles). Exclusive with model/modelTier; checked against `agentId` at run. */
  profile: z.string().min(1).optional(),
  /** Model group name (GET /api/model-groups). Exclusive with model/modelTier/profile; with `agentId`, a member must run there. */
  modelGroup: z.string().min(1).optional(),
  parentTaskId: z.string().uuid().optional(),
  requestedByUserId: z.string().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  followUpConfig: FollowUpConfigSchema.optional(),
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
    const existingTask = await db.getTaskByWorkflowRunStepId(meta.stepId);
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
      } as ExecutorResult<AgentTaskOutput>;
    }

    // 2. Inherit workflow-level dir/vcsRepo when node config doesn't specify them
    let effectiveDir = config.dir;
    let effectiveVcsRepo = config.vcsRepo;
    let effectiveKey: string | undefined;
    if (meta.workflowId) {
      const workflow = await db.getRunWorkflow({ id: meta.runId, workflowId: meta.workflowId });
      if (workflow) {
        if (!effectiveDir && workflow.dir) effectiveDir = workflow.dir;
        if (!effectiveVcsRepo && workflow.vcsRepo) effectiveVcsRepo = workflow.vcsRepo;
        effectiveKey = workflow.key;
      }
    }

    // 3. Create the task (config is already deep-interpolated by the engine)
    const modelError = await explicitModelErrorForAgent({
      model: splitLegacyModelAlias({ model: config.model, modelTier: config.modelTier }).model,
      allowCustomModel: config.allowCustomModel,
      agentId: config.agentId,
    });
    if (modelError) return { status: "failed", error: modelError };
    const profileError = await taskProfileError({
      profile: config.profile,
      model: config.model,
      modelTier: config.modelTier,
      modelGroup: config.modelGroup,
      agentId: config.agentId,
      vcsRepo: effectiveVcsRepo,
    });
    if (profileError) return { status: "failed", error: profileError };
    const preCreate = await applyPreTaskCreate({
      description: config.template,
      options: {
        key: effectiveKey,
        agentId: config.agentId ?? null,
        // A configured workflow target is an author pin, including existing definitions.
        routingReason: config.routingReason ?? (config.agentId ? "human_pinned" : undefined),
        routingNote: config.routingNote,
        routingSource: config.routingReason
          ? "declared"
          : config.agentId
            ? "engine_default"
            : undefined,
        source: "workflow",
        tags: config.tags,
        priority: config.priority,
        offeredTo: config.offerMode ? config.agentId : undefined,
        workflowRunId: meta.runId,
        workflowRunStepId: meta.stepId,
        dir: effectiveDir,
        vcsRepo: effectiveVcsRepo,
        ...splitLegacyModelAlias({ model: config.model, modelTier: config.modelTier }),
        effort: config.effort,
        profile: config.profile?.trim() || undefined,
        modelGroup: config.modelGroup?.trim() || undefined,
        parentTaskId: config.parentTaskId,
        requestedByUserId: config.requestedByUserId ?? meta.requestedByUserId,
        outputSchema: config.outputSchema,
        followUpConfig: config.followUpConfig,
        contextKey: workflowContextKey({ workflowRunId: meta.runId }),
      },
      origin: "workflow",
      allowCustomModel: config.allowCustomModel,
    });
    if (preCreate.kind === "blocked") {
      throw new TaskCreationBlockedError(preCreate.reason, preCreate.extension);
    }
    // No sibling awareness: every task of a run shares this contextKey, so its
    // siblings are the engine's own parallel steps, not new user input. The
    // block handed each child its siblings' task ids, and one child completed
    // a sibling's task with its own report. It would also wire parentTaskId to
    // a concurrent same-agent sibling's session.
    let task: Awaited<ReturnType<typeof db.createTaskExtended>>;
    try {
      task = await db.createTaskExtended(preCreate.description, preCreate.options);
    } catch (error) {
      // The profile or group was deleted between taskProfileError and the insert.
      if (modelGroupRefError(error)) {
        return { status: "failed", error: `Unknown model group "${config.modelGroup}".` };
      }
      if (modelProfileRefError(error) !== "missing") throw error;
      return { status: "failed", error: `Unknown model profile "${config.profile}".` };
    }
    crashAfterTaskInsertForTest(preCreate.description);

    // 4. Return async result — engine will pause the workflow
    return {
      status: "success",
      async: true,
      waitFor: "task.completed",
      correlationId: task.id,
    } as ExecutorResult<AgentTaskOutput>;
  }
}

/**
 * Test-only crash point: kill the API between the task insert and the step
 * parking, the window a real crash can hit. Fires only under NODE_ENV=test
 * for a task whose text contains E2E_CRASH_AFTER_WORKFLOW_TASK_INSERT. The
 * e2e scenario workflow-agent-task-crash-window sets it for one restart.
 */
function crashAfterTaskInsertForTest(description: string): void {
  if (getNodeEnv() !== "test") return;
  const marker = process.env.E2E_CRASH_AFTER_WORKFLOW_TASK_INSERT;
  if (marker && description.includes(marker)) process.kill(process.pid, "SIGKILL");
}

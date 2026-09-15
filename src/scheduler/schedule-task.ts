import { createTaskExtended, getDbClient } from "@/be/db";
import { scheduleContextKey } from "@/tasks/context-key";
import {
  type PreparedTaskCreate,
  prepareTaskWithSiblingAwareness,
} from "@/tasks/sibling-awareness";
import type { AgentTask, ScheduledTask } from "@/types";

/**
 * Run the `pre.task.create` extension hooks for a schedule firing. Call this OUTSIDE
 * the transaction that creates the task: the dispatcher skips hooks while a
 * transaction is open. Throws `TaskCreationBlockedError` when a hook blocks.
 */
export async function prepareStandaloneScheduleTask(
  schedule: ScheduledTask,
  extraTags: string[] = [],
): Promise<PreparedTaskCreate> {
  if (!schedule.taskTemplate) {
    throw new Error(`Schedule "${schedule.name}" has no taskTemplate (targetType=agent-task)`);
  }
  return await prepareTaskWithSiblingAwareness(
    schedule.taskTemplate,
    {
      key: schedule.key,
      creatorAgentId: schedule.createdByAgentId,
      taskType: schedule.taskType,
      tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, ...extraTags],
      priority: schedule.priority,
      agentId: schedule.targetAgentId,
      routingReason: schedule.targetAgentId ? "human_pinned" : undefined,
      model: schedule.model,
      modelTier: schedule.modelTier,
      scheduleId: schedule.id,
      source: "schedule",
      requestedByUserId: schedule.createdBy,
      contextKey: scheduleContextKey({ scheduleId: schedule.id }),
      // Set only by `defer-task`. An explicit parent wins over the sibling-awareness
      // auto-wiring (see withSiblingAwareness in src/tasks/sibling-awareness.ts), so
      // the wake-up run continues the deferred task rather than a random sibling.
      parentTaskId: schedule.parentTaskId,
    },
    { origin: "schedule" },
  );
}

/**
 * Insert the schedule's task. Pass the result of `prepareStandaloneScheduleTask`
 * when calling from inside a transaction; without it the hooks run here.
 */
export async function createStandaloneScheduleTask(
  schedule: ScheduledTask,
  extraTags: string[] = [],
  prepared?: PreparedTaskCreate,
): Promise<AgentTask> {
  const { description, options } =
    prepared ?? (await prepareStandaloneScheduleTask(schedule, extraTags));
  const task = await createTaskExtended(description, options);
  // Both timer and event dispatch wrap this helper in a transaction. Transfer
  // pending watchers before the resume task becomes visible or its schedule is
  // disabled; their own schedules retain the original ceilings.
  if (schedule.taskType === "deferred" && schedule.parentTaskId) {
    await getDbClient().run(
      "UPDATE deferred_task_waits SET taskId = ?, updated_at = ? WHERE status = 'pending' AND taskId = ?",
      [task.id, new Date().toISOString(), schedule.parentTaskId],
    );
  }
  return task;
}

import { getDbClient } from "@/be/db";
import { scheduleContextKey } from "@/tasks/context-key";
import { createTaskWithSiblingAwareness } from "@/tasks/sibling-awareness";
import type { AgentTask, ScheduledTask } from "@/types";

export async function createStandaloneScheduleTask(
  schedule: ScheduledTask,
  extraTags: string[] = [],
): Promise<AgentTask> {
  if (!schedule.taskTemplate) {
    throw new Error(`Schedule "${schedule.name}" has no taskTemplate (targetType=agent-task)`);
  }
  const task = await createTaskWithSiblingAwareness(schedule.taskTemplate, {
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
  });
  // Both timer and event dispatch wrap this helper in a transaction. Transfer
  // pending watchers before the resume task becomes visible or its schedule is
  // disabled; their own schedules retain the original ceilings.
  if (schedule.taskType === "deferred" && schedule.parentTaskId) {
    await getDbClient().run(
      `UPDATE deferred_task_wait_members SET taskId = ?, updated_at = ?
       WHERE taskId = ? AND scheduleId IN (
         SELECT scheduleId FROM deferred_task_waits WHERE status = 'pending'
       )`,
      [task.id, new Date().toISOString(), schedule.parentTaskId],
    );
  }
  return task;
}

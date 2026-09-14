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
  return await createTaskWithSiblingAwareness(schedule.taskTemplate, {
    key: schedule.key,
    creatorAgentId: schedule.createdByAgentId,
    taskType: schedule.taskType,
    tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, ...extraTags],
    priority: schedule.priority,
    agentId: schedule.targetAgentId,
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
}

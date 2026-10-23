import { createTaskExtended, getAgentById, getDbClient, getTaskById } from "@/be/db";
import { carryUnhandledSteering } from "@/be/steering";
import { chatThreadOfContextKey, scheduleContextKey } from "@/tasks/context-key";
import {
  type PreparedTaskCreate,
  prepareTaskWithSiblingAwareness,
} from "@/tasks/sibling-awareness";
import type { AgentTask, ScheduledTask } from "@/types";

/**
 * Whether the task's own answer is posted to its chat thread. Mirrors the
 * relay triggers (migration 235): a delegated worker task, or its resume,
 * reports through the Lead follow-up instead.
 */
async function answersInChat(task: AgentTask): Promise<boolean> {
  if (task.source === "chat") return true;
  if (task.source === "system" && task.taskType === "follow-up") return true;
  // Only a wake-up that passed `scheduleTaskContextKey` has a chat key.
  if (task.source === "schedule" && task.taskType === "deferred") return true;
  if (task.source === "system" && task.taskType === "resume" && task.agentId) {
    return (await getAgentById(task.agentId))?.isLead === true;
  }
  return false;
}

/**
 * A defer-task wake-up of a chat task stays in its chat thread, so the chat
 * relay posts the real answer there (and `/status` and `/cancel` see it).
 * Only the deferring agent continuing its own task gets the thread: a schedule
 * re-targeted or re-owned after the deferral, or the deferral of a task that
 * never answered in chat, fires like any other schedule. Every other firing
 * gets the schedule's own key.
 */
async function scheduleTaskContextKey(schedule: ScheduledTask): Promise<string> {
  if (schedule.taskType === "deferred" && schedule.parentTaskId) {
    const parent = await getTaskById(schedule.parentTaskId);
    if (
      parent?.contextKey &&
      chatThreadOfContextKey(parent.contextKey) &&
      parent.agentId &&
      schedule.targetAgentId === parent.agentId &&
      schedule.createdByAgentId === parent.agentId &&
      (await answersInChat(parent))
    ) {
      return parent.contextKey;
    }
  }
  return scheduleContextKey({ scheduleId: schedule.id });
}

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
      routingSource: schedule.targetAgentId ? "engine_default" : undefined,
      model: schedule.model,
      modelTier: schedule.modelTier,
      scheduleId: schedule.id,
      source: "schedule",
      requestedByUserId: schedule.createdBy,
      contextKey: await scheduleTaskContextKey(schedule),
      // Set only by `defer-task`. An explicit parent wins over the sibling-awareness
      // auto-wiring (see withSiblingAwareness in src/tasks/sibling-awareness.ts), so
      // the wake-up run continues the deferred task rather than a random sibling.
      parentTaskId: schedule.parentTaskId,
      // A defer-task wake-up continues the deferred work, so it keeps the
      // creator's onCompleted/onFailed. Other schedules start new work.
      inheritParentFollowUpConfig: schedule.taskType === "deferred" && !!schedule.parentTaskId,
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
      `UPDATE deferred_task_wait_members SET taskId = ?, updated_at = ?
       WHERE taskId = ? AND scheduleId IN (
         SELECT scheduleId FROM deferred_task_waits WHERE status = 'pending'
       )`,
      [task.id, new Date().toISOString(), schedule.parentTaskId],
    );
    // The wake-up continues the deferred task, so it takes over steering the
    // deferred task received but never accepted.
    await carryUnhandledSteering(schedule.parentTaskId, task.id);
  }
  return task;
}

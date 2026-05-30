const SCHEDULE_TAG_PREFIX = "schedule:";
const AUTOMATIC_TASK_TYPES = new Set([
  "boot-triage",
  "heartbeat",
  "heartbeat-checklist",
  "health-check",
  "health-probe",
  "monitor",
  "monitoring",
]);

export interface MemoryGateTask {
  source?: string | null;
  taskType?: string | null;
  tags?: string[] | null;
}

export function isScheduledTaskCompletion(task: { tags?: string[] | null }): boolean {
  return task.tags?.some((tag) => tag.startsWith(SCHEDULE_TAG_PREFIX)) ?? false;
}

export function isAutomaticOrRecurringTaskCompletion(task: MemoryGateTask): boolean {
  const tags = task.tags ?? [];
  const taskType = task.taskType?.toLowerCase();

  return (
    task.source === "schedule" ||
    task.source === "system" ||
    tags.includes("scheduled") ||
    tags.includes("auto-generated") ||
    tags.some((tag) => tag.startsWith(SCHEDULE_TAG_PREFIX)) ||
    (taskType !== undefined &&
      (AUTOMATIC_TASK_TYPES.has(taskType) ||
        taskType.endsWith("-monitor") ||
        taskType.endsWith("-digest")))
  );
}

export function shouldPersistAutomaticTaskMemory(
  task: MemoryGateTask,
  persistMemory?: boolean,
): boolean {
  if (persistMemory) return true;
  return !isAutomaticOrRecurringTaskCompletion(task);
}

export const shouldPersistTaskCompletionMemory = shouldPersistAutomaticTaskMemory;

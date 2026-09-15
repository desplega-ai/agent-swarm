import { getDbClient, getScheduledTaskById, getUserById, updateScheduledTask } from "@/be/db";
import type { AgentTask } from "@/types";
import { workflowEventBus } from "@/workflows/event-bus";
import { createStandaloneScheduleTask } from "./schedule-task";

export type TaskWakeEvent = "task.completed" | "task.failed" | "settled";

type TaskWait = {
  scheduleId: string;
  eventName: TaskWakeEvent;
  mode: "all" | "any";
  status: "pending" | "fired";
};

/** Undefined means a normal schedule; an empty result means another caller won. */
export async function dispatchDeferredTaskWait(
  scheduleId: string,
  reason: "ceiling" | "task.completed" | "task.failed",
  extraTags: string[] = [],
): Promise<{ task?: AgentTask } | undefined> {
  const client = getDbClient();
  // Keep ordinary schedule dispatch off the write-lock path.
  if (
    !(await client.get<TaskWait>("SELECT * FROM deferred_task_waits WHERE scheduleId = ?", [
      scheduleId,
    ]))
  )
    return undefined;
  return client.transaction(async () => {
    const wait = await client.get<TaskWait>(
      "SELECT * FROM deferred_task_waits WHERE scheduleId = ?",
      [scheduleId],
    );
    if (!wait || wait.status !== "pending") return {};
    if (reason !== "ceiling" && wait.eventName !== "settled" && wait.eventName !== reason)
      return {};
    let schedule = await getScheduledTaskById(scheduleId);
    if (!schedule?.enabled) return {};
    // Re-read the entire set under the same write lock as the claim. An event
    // only identifies a candidate wait; it never proves the set is ready.
    let cause = "ceiling expired";
    if (reason !== "ceiling") {
      const members = await client.query<{
        taskId: string;
        taskStatus: string | null;
        deferred: number;
      }>(
        `SELECT m.taskId, t.status AS taskStatus, EXISTS (
           SELECT 1 FROM scheduled_tasks d
           WHERE d.parentTaskId = t.id AND d.taskType = 'deferred' AND d.enabled = 1
         ) AS deferred
         FROM deferred_task_wait_members m LEFT JOIN agent_tasks t ON t.id = m.taskId
         WHERE m.scheduleId = ?`,
        [scheduleId],
      );
      const matched = members.filter(
        (member) =>
          !member.deferred &&
          (member.taskStatus === "completed" || member.taskStatus === "failed") &&
          (wait.eventName === "settled" || wait.eventName === `task.${member.taskStatus}`),
      );
      if (!matched.length || (wait.mode === "all" && matched.length !== members.length)) return {};
      cause =
        members.length === 1
          ? `task.${matched[0]!.taskStatus} for task ${matched[0]!.taskId}`
          : `${wait.mode} tasks matched ${wait.eventName}: ${matched.map((member) => `${member.taskId} (${member.taskStatus})`).join(", ")}`;
    }
    const now = new Date().toISOString();
    const claimed = await client.run(
      "UPDATE deferred_task_waits SET status = 'fired', firedBy = ?, resolvedAt = ?, updated_at = ? WHERE scheduleId = ? AND status = 'pending'",
      [reason, now, now, scheduleId],
    );
    if (!claimed.changes) return {};
    if (schedule.createdBy && !(await getUserById(schedule.createdBy))) {
      schedule = { ...schedule, createdBy: undefined };
    }
    if (!schedule.taskTemplate) throw new Error(`Schedule "${schedule.name}" has no taskTemplate`);
    const task = await createStandaloneScheduleTask(
      {
        ...schedule,
        taskTemplate: `${schedule.taskTemplate}\n\nWake-up cause: ${cause}.`,
      },
      extraTags,
    );
    await client.run("UPDATE deferred_task_waits SET childTaskId = ? WHERE scheduleId = ?", [
      task.id,
      scheduleId,
    ]);
    await updateScheduledTask(scheduleId, {
      enabled: false,
      nextRunAt: null,
      lastRunAt: now,
      lastUpdatedAt: now,
      consecutiveErrors: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
    });
    return { task };
  });
}

/** Reconcile durable producer state, including terminal transitions missed by this process. */
export async function reconcileDeferredTaskWaits(taskId?: string): Promise<void> {
  const rows = await getDbClient().query<TaskWait & { taskStatus: "completed" | "failed" }>(
    `SELECT DISTINCT w.*, t.status AS taskStatus FROM deferred_task_waits w
     JOIN deferred_task_wait_members m ON m.scheduleId = w.scheduleId
     JOIN agent_tasks t ON t.id = m.taskId
     JOIN scheduled_tasks s ON s.id = w.scheduleId
     WHERE w.status = 'pending' AND s.enabled = 1 AND t.status IN ('completed', 'failed')
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_tasks d
         WHERE d.parentTaskId = t.id AND d.taskType = 'deferred' AND d.enabled = 1
       )
       AND (w.eventName = 'settled' OR w.eventName = 'task.' || t.status)
       ${taskId ? "AND m.taskId = ?" : ""}`,
    taskId ? [taskId] : [],
  );
  for (const row of rows) {
    try {
      await dispatchDeferredTaskWait(row.scheduleId, `task.${row.taskStatus}`);
    } catch (err) {
      // A broken wait must not stop other event wakes or the ceiling poller.
      console.error(`[Scheduler] Deferred task wake failed for ${row.scheduleId}:`, err);
    }
  }
}

function onTaskTerminal(payload: unknown): void {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("taskId" in payload) ||
    typeof payload.taskId !== "string"
  )
    return;
  void reconcileDeferredTaskWaits(payload.taskId).catch((err) => {
    console.error("[Scheduler] Deferred task event wake failed:", err);
  });
}

/** Two fixed listeners read durable waits, so boot needs no per-wait in-memory registry. */
export async function initDeferredTaskWaits(): Promise<void> {
  stopDeferredTaskWaits();
  workflowEventBus.on("task.completed", onTaskTerminal);
  workflowEventBus.on("task.failed", onTaskTerminal);
  await reconcileDeferredTaskWaits();
}

export function stopDeferredTaskWaits(): void {
  workflowEventBus.off("task.completed", onTaskTerminal);
  workflowEventBus.off("task.failed", onTaskTerminal);
}

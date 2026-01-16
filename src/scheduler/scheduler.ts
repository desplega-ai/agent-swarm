import { CronExpressionParser } from "cron-parser";
import {
  createTaskExtended,
  getDb,
  getDueScheduledTasks,
  getScheduledTaskById,
  updateScheduledTask,
} from "@/be/db";
import type { ScheduledTask } from "@/types";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Calculate next run time based on cron expression or interval.
 * @param schedule The scheduled task
 * @param fromTime The time to calculate from (defaults to now)
 * @returns ISO string of next run time
 */
export function calculateNextRun(schedule: ScheduledTask, fromTime: Date = new Date()): string {
  if (schedule.cronExpression) {
    const interval = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: fromTime,
      tz: schedule.timezone || "UTC",
    });
    const nextDate = interval.next();
    const isoString = nextDate.toISOString();
    if (!isoString) {
      throw new Error("Failed to calculate next run time from cron expression");
    }
    return isoString;
  }

  if (schedule.intervalMs) {
    return new Date(fromTime.getTime() + schedule.intervalMs).toISOString();
  }

  throw new Error("Schedule must have cronExpression or intervalMs");
}

/**
 * Execute a single scheduled task by creating an agent task.
 */
async function executeSchedule(schedule: ScheduledTask): Promise<void> {
  // Wrap in transaction to ensure atomicity of task creation and schedule update
  const tx = getDb().transaction(() => {
    const now = new Date().toISOString();

    // Create the actual task
    createTaskExtended(schedule.taskTemplate, {
      creatorAgentId: schedule.createdByAgentId,
      taskType: schedule.taskType,
      tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`],
      priority: schedule.priority,
      agentId: schedule.targetAgentId, // null goes to pool
    });

    // Update lastRunAt and nextRunAt
    const nextRun = calculateNextRun(schedule, new Date());
    updateScheduledTask(schedule.id, {
      lastRunAt: now,
      nextRunAt: nextRun,
      lastUpdatedAt: now,
    });

    return nextRun;
  });

  const nextRun = tx();
  console.log(`[Scheduler] Executed schedule "${schedule.name}", next run: ${nextRun}`);
}

/**
 * Start the scheduler polling loop.
 * @param intervalMs Polling interval in milliseconds (default: 10000)
 */
export function startScheduler(intervalMs = 10000): void {
  if (schedulerInterval) {
    console.log("[Scheduler] Already running");
    return;
  }

  console.log(`[Scheduler] Starting with ${intervalMs}ms polling interval`);

  // Run immediately once, then start interval
  void processSchedules();

  schedulerInterval = setInterval(async () => {
    await processSchedules();
  }, intervalMs);
}

/**
 * Process all due schedules (called by interval).
 */
async function processSchedules(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const dueSchedules = getDueScheduledTasks();

    for (const schedule of dueSchedules) {
      try {
        await executeSchedule(schedule);
      } catch (err) {
        console.error(`[Scheduler] Error executing "${schedule.name}":`, err);
      }
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Stop the scheduler polling loop.
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    isProcessing = false;
    console.log("[Scheduler] Stopped");
  }
}

/**
 * Run a schedule immediately (manual trigger).
 * Does NOT update nextRunAt - the regular schedule continues unaffected.
 * @param scheduleId The ID of the schedule to run
 */
export async function runScheduleNow(scheduleId: string): Promise<void> {
  const schedule = getScheduledTaskById(scheduleId);
  if (!schedule) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }
  if (!schedule.enabled) {
    throw new Error(`Schedule is disabled: ${schedule.name}`);
  }

  // Wrap in transaction to ensure atomicity of task creation and schedule update
  const tx = getDb().transaction(() => {
    const now = new Date().toISOString();

    // Create the actual task
    createTaskExtended(schedule.taskTemplate, {
      creatorAgentId: schedule.createdByAgentId,
      taskType: schedule.taskType,
      tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, "manual-run"],
      priority: schedule.priority,
      agentId: schedule.targetAgentId,
    });

    // Only update lastRunAt, not nextRunAt (to not affect regular schedule)
    updateScheduledTask(schedule.id, {
      lastRunAt: now,
      lastUpdatedAt: now,
    });
  });

  tx();

  console.log(`[Scheduler] Manually executed schedule "${schedule.name}"`);
}

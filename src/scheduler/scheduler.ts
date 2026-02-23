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
 * Recover missed scheduled task runs from downtime.
 * Fires ONE catch-up run per schedule (not N missed runs).
 * Tags the task with "recovered" so it's distinguishable.
 */
async function recoverMissedSchedules(): Promise<void> {
  const now = new Date();
  const dueSchedules = getDueScheduledTasks();

  for (const schedule of dueSchedules) {
    if (!schedule.nextRunAt) continue;
    const missedBy = now.getTime() - new Date(schedule.nextRunAt).getTime();
    if (missedBy < 15000) continue; // Less than 15s — normal timing jitter

    console.log(
      `[Scheduler] Recovering missed schedule "${schedule.name}" ` +
        `(was due ${Math.round(missedBy / 1000)}s ago)`,
    );

    try {
      const tx = getDb().transaction(() => {
        createTaskExtended(schedule.taskTemplate, {
          creatorAgentId: schedule.createdByAgentId,
          taskType: schedule.taskType,
          tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, "recovered"],
          priority: schedule.priority,
          agentId: schedule.targetAgentId,
        });

        const nextRun = calculateNextRun(schedule, now);
        updateScheduledTask(schedule.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: nextRun,
          lastUpdatedAt: now.toISOString(),
        });
      });
      tx();
    } catch (err) {
      console.error(`[Scheduler] Error recovering "${schedule.name}":`, err);
    }
  }
}

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

// Exponential backoff schedule for consecutive errors (in ms)
const ERROR_BACKOFF_MS = [
  60_000, // 1 minute
  300_000, // 5 minutes
  900_000, // 15 minutes
  1_800_000, // 30 minutes
  3_600_000, // 1 hour (cap)
];

const MAX_CONSECUTIVE_ERRORS = 5;

function getBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1);
  return ERROR_BACKOFF_MS[Math.max(0, idx)] ?? ERROR_BACKOFF_MS[0]!;
}

/**
 * Execute a single scheduled task by creating an agent task.
 * Tracks consecutive errors and applies exponential backoff on failure.
 */
async function executeSchedule(schedule: ScheduledTask): Promise<void> {
  try {
    const tx = getDb().transaction(() => {
      const now = new Date().toISOString();

      createTaskExtended(schedule.taskTemplate, {
        creatorAgentId: schedule.createdByAgentId,
        taskType: schedule.taskType,
        tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`],
        priority: schedule.priority,
        agentId: schedule.targetAgentId,
      });

      const nextRun = calculateNextRun(schedule, new Date());
      updateScheduledTask(schedule.id, {
        lastRunAt: now,
        nextRunAt: nextRun,
        lastUpdatedAt: now,
        // Reset error tracking on success
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
      });

      return nextRun;
    });

    const nextRun = tx();
    console.log(`[Scheduler] Executed schedule "${schedule.name}", next run: ${nextRun}`);
  } catch (err) {
    const errorCount = (schedule.consecutiveErrors ?? 0) + 1;
    const now = new Date();
    const errorMsg = err instanceof Error ? err.message : String(err);

    console.error(
      `[Scheduler] Error executing "${schedule.name}" (${errorCount} consecutive):`,
      errorMsg,
    );

    const updates: {
      consecutiveErrors: number;
      lastErrorAt: string;
      lastErrorMessage: string;
      lastUpdatedAt: string;
      enabled?: boolean;
      nextRunAt?: string;
    } = {
      consecutiveErrors: errorCount,
      lastErrorAt: now.toISOString(),
      lastErrorMessage: errorMsg.slice(0, 500),
      lastUpdatedAt: now.toISOString(),
    };

    if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
      updates.enabled = false;
      console.warn(
        `[Scheduler] Auto-disabled "${schedule.name}" after ${errorCount} consecutive errors`,
      );
    } else {
      const backoff = getBackoffMs(errorCount);
      updates.nextRunAt = new Date(now.getTime() + backoff).toISOString();
      console.log(`[Scheduler] Backing off "${schedule.name}" for ${backoff / 1000}s`);
    }

    updateScheduledTask(schedule.id, updates);
  }
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

  // Recover missed schedules from downtime, then run normal processing
  void recoverMissedSchedules().then(() => processSchedules());

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

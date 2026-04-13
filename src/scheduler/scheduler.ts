import { ensure } from "@desplega.ai/business-use";
import { CronExpressionParser } from "cron-parser";
import {
  createTaskExtended,
  getDb,
  getDueScheduledTasks,
  getScheduledTaskById,
  updateScheduledTask,
} from "@/be/db";
import type { ScheduledTask } from "@/types";
import type { ExecutorRegistry } from "@/workflows/executors/registry";
import { handleScheduleTrigger } from "@/workflows/triggers";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
let executorRegistry: ExecutorRegistry | null = null;

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
      // Check if any workflows are linked to this schedule
      let triggeredWorkflows = false;
      if (executorRegistry) {
        const runIds = await handleScheduleTrigger(schedule.id, schedule, executorRegistry);
        if (runIds.length > 0) {
          triggeredWorkflows = true;
          console.log(
            `[Scheduler] Recovered schedule "${schedule.name}" → triggered ${runIds.length} workflow(s)`,
          );
        }
      }

      if (!triggeredWorkflows) {
        const tx = getDb().transaction(() => {
          createTaskExtended(schedule.taskTemplate, {
            creatorAgentId: schedule.createdByAgentId,
            taskType: schedule.taskType,
            tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, "recovered"],
            priority: schedule.priority,
            agentId: schedule.targetAgentId,
            model: schedule.model,
            scheduleId: schedule.id,
            source: "schedule",
          });
        });
        tx();
      }

      // Update schedule state regardless of workflow/task path
      if (schedule.scheduleType === "one_time") {
        updateScheduledTask(schedule.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: null,
          enabled: false,
          lastUpdatedAt: now.toISOString(),
        });
      } else {
        const nextRun = calculateNextRun(schedule, now);
        updateScheduledTask(schedule.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: nextRun,
          lastUpdatedAt: now.toISOString(),
        });
      }

      if (schedule.scheduleType === "one_time") {
        console.log(`[Scheduler] One-time schedule "${schedule.name}" recovered and auto-disabled`);
      }
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
    // Check if any workflows are linked to this schedule
    let triggeredWorkflows = false;
    if (executorRegistry) {
      const runIds = await handleScheduleTrigger(schedule.id, schedule, executorRegistry);
      if (runIds.length > 0) {
        triggeredWorkflows = true;
        console.log(
          `[Scheduler] Schedule "${schedule.name}" → triggered ${runIds.length} workflow(s)`,
        );
      }
    }

    if (!triggeredWorkflows) {
      // No workflows linked — create standalone task (existing behavior)
      getDb().transaction(() => {
        createTaskExtended(schedule.taskTemplate, {
          creatorAgentId: schedule.createdByAgentId,
          taskType: schedule.taskType,
          tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`],
          priority: schedule.priority,
          agentId: schedule.targetAgentId,
          model: schedule.model,
          scheduleId: schedule.id,
          source: "schedule",
        });
      })();
    }

    // Update schedule state regardless of workflow/task path
    const now = new Date().toISOString();
    if (schedule.scheduleType === "one_time") {
      updateScheduledTask(schedule.id, {
        lastRunAt: now,
        nextRunAt: null,
        enabled: false,
        lastUpdatedAt: now,
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
      });
      console.log(`[Scheduler] Executed one-time schedule "${schedule.name}", auto-disabled`);
    } else {
      const nextRun = calculateNextRun(schedule, new Date());
      updateScheduledTask(schedule.id, {
        lastRunAt: now,
        nextRunAt: nextRun,
        lastUpdatedAt: now,
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
      });
      console.log(`[Scheduler] Executed schedule "${schedule.name}", next run: ${nextRun}`);
    }
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

    if (schedule.scheduleType === "one_time") {
      updates.enabled = false;
      console.warn(
        `[Scheduler] One-time schedule "${schedule.name}" failed, auto-disabled: ${errorMsg}`,
      );
    } else if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
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
 * @param registry ExecutorRegistry for triggering workflows linked to schedules
 * @param intervalMs Polling interval in milliseconds (default: 10000)
 */
export function startScheduler(
  registry: ExecutorRegistry,
  intervalMs = 10000,
  opts?: { runId?: string },
): void {
  if (schedulerInterval) {
    console.log("[Scheduler] Already running");
    return;
  }

  executorRegistry = registry;
  console.log(`[Scheduler] Starting with ${intervalMs}ms polling interval`);

  // Recover missed schedules from downtime, then run normal processing
  void recoverMissedSchedules().then(() => processSchedules());

  schedulerInterval = setInterval(async () => {
    await processSchedules();
  }, intervalMs);

  ensure({
    id: "scheduler_started",
    flow: "api",
    runId: opts?.runId ?? "",
    depIds: ["listen"],
    data: {},
    // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
    filter: ({}, ctx) => {
      const start = ctx.deps.find((d) => d.id === "listen");
      return !!start && start.data?.capabilities?.includes("scheduling");
    },
    // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
    validator: ({}, ctx) => {
      const start = ctx.deps.find((d) => d.id === "listen");
      return !!start && start.data?.capabilities?.includes("scheduling");
    },
    conditions: [{ timeout_ms: 10_000 }], // 10s: scheduler starts immediately after listen
  });
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

  // Check if any workflows are linked to this schedule
  let triggeredWorkflows = false;
  if (executorRegistry) {
    const runIds = await handleScheduleTrigger(scheduleId, schedule, executorRegistry);
    if (runIds.length > 0) {
      triggeredWorkflows = true;
      console.log(
        `[Scheduler] Manual run of "${schedule.name}" → triggered ${runIds.length} workflow(s)`,
      );
    }
  }

  if (!triggeredWorkflows) {
    // No workflows linked — create standalone task (existing behavior)
    getDb().transaction(() => {
      createTaskExtended(schedule.taskTemplate, {
        creatorAgentId: schedule.createdByAgentId,
        taskType: schedule.taskType,
        tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, "manual-run"],
        priority: schedule.priority,
        agentId: schedule.targetAgentId,
        model: schedule.model,
        scheduleId: schedule.id,
        source: "schedule",
      });
    })();
  }

  // Update schedule state
  const now = new Date().toISOString();
  if (schedule.scheduleType === "one_time") {
    updateScheduledTask(schedule.id, {
      lastRunAt: now,
      nextRunAt: null,
      enabled: false,
      lastUpdatedAt: now,
    });
    console.log(
      `[Scheduler] Manually executed one-time schedule "${schedule.name}", auto-disabled`,
    );
  } else {
    // Only update lastRunAt, not nextRunAt (to not affect regular schedule)
    updateScheduledTask(schedule.id, {
      lastRunAt: now,
      lastUpdatedAt: now,
    });
    console.log(`[Scheduler] Manually executed schedule "${schedule.name}"`);
  }
}

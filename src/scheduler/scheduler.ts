import { ensure } from "@desplega.ai/business-use";
import { CronExpressionParser } from "cron-parser";
import {
  getDb,
  getDueScheduledTasks,
  getScheduledTaskById,
  getWorkflow,
  updateScheduledTask,
} from "@/be/db";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "@/be/script-connections";
import { buildScriptCredentialBindings } from "@/be/script-credential-broker";
import { getScript } from "@/be/scripts/db";
import { runScript } from "@/scripts-runtime/loader";
import { scheduleContextKey } from "@/tasks/context-key";
import { createTaskWithSiblingAwareness } from "@/tasks/sibling-awareness";
import { telemetry } from "@/telemetry";
import type { AgentTask, ScheduledTask } from "@/types";
import { getExecutorRegistry as getWorkflowExecutorRegistry } from "@/workflows";
import { startWorkflowExecution } from "@/workflows/engine";
import type { ExecutorRegistry } from "@/workflows/executors/registry";
import { handleScheduleTrigger } from "@/workflows/triggers";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
let executorRegistry: ExecutorRegistry | null = null;

/**
 * Resolve the executor registry for schedule dispatch. Prefers the registry
 * handed to `startScheduler()`; falls back to the workflows-module singleton
 * so callers that don't run the scheduler poller on this node (e.g. the HTTP
 * `/api/schedules/{id}/run` route on a non-scheduling node) can still dispatch
 * `targetType='workflow'` schedules and check implicit workflow bindings.
 */
function resolveExecutorRegistry(): ExecutorRegistry | null {
  if (executorRegistry) return executorRegistry;
  try {
    return getWorkflowExecutorRegistry();
  } catch {
    return null;
  }
}

export function createStandaloneScheduleTask(
  schedule: ScheduledTask,
  extraTags: string[] = [],
): AgentTask {
  if (!schedule.taskTemplate) {
    throw new Error(`Schedule "${schedule.name}" has no taskTemplate (targetType=agent-task)`);
  }
  return createTaskWithSiblingAwareness(schedule.taskTemplate, {
    creatorAgentId: schedule.createdByAgentId,
    taskType: schedule.taskType,
    tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, ...extraTags],
    priority: schedule.priority,
    agentId: schedule.targetAgentId,
    model: schedule.model,
    modelTier: schedule.modelTier,
    scheduleId: schedule.id,
    source: "schedule",
    contextKey: scheduleContextKey({ scheduleId: schedule.id }),
  });
}

/**
 * Execute a schedule's `targetType='script'` target directly via the
 * scripts-runtime — no agent/LLM in the loop. Reuses the same `runScript()`
 * path as the `swarm-script` workflow executor.
 */
async function executeScheduleScript(schedule: ScheduledTask): Promise<void> {
  if (!schedule.scriptName) {
    throw new Error(`Schedule "${schedule.name}" has no scriptName (targetType=script)`);
  }

  const script = getScript({ name: schedule.scriptName, scope: "global" });
  if (!script) {
    throw new Error(`Script '${schedule.scriptName}' not found`);
  }

  const agentId = schedule.createdByAgentId ?? "schedule";
  const output = await runScript({
    source: script.source,
    args: schedule.scriptArgs ?? {},
    fsMode: "none",
    agentId,
    egressSecrets: await buildScriptCredentialBindings({ agentId }),
    apiConnections: getScriptApiConnectionDescriptors({ agentId }),
    mcpConnections: getScriptMcpConnectionDescriptors({ agentId }),
    timeoutMs: 60_000,
  });

  if (output.exitCode !== 0 || output.error) {
    throw new Error(
      output.stderr ||
        `Script '${schedule.scriptName}' exited with code ${output.exitCode}${
          output.error ? ` (${output.error})` : ""
        }`,
    );
  }
}

/**
 * Dispatch a schedule to its configured target. Explicit switch on
 * `targetType` — `workflow` and `script` run their target directly;
 * `agent-task` (default) preserves the legacy implicit-workflow-binding
 * check followed by a standalone-task fallback, so existing schedules that
 * bind a workflow via `workflows.triggers[].scheduleId` keep working
 * unchanged.
 */
export interface DispatchScheduleResult {
  triggeredWorkflows: boolean;
  workflowRunIds?: string[];
  task?: AgentTask;
}

export async function dispatchScheduleTarget(
  schedule: ScheduledTask,
  extraTags: string[] = [],
): Promise<DispatchScheduleResult> {
  switch (schedule.targetType) {
    case "workflow": {
      if (!schedule.workflowId) {
        throw new Error(`Schedule "${schedule.name}" has no workflowId (targetType=workflow)`);
      }
      const workflow = getWorkflow(schedule.workflowId);
      if (!workflow) {
        throw new Error(`Workflow ${schedule.workflowId} not found`);
      }
      if (!workflow.enabled) {
        throw new Error(`Workflow ${schedule.workflowId} is disabled`);
      }
      const registry = resolveExecutorRegistry();
      if (!registry) {
        throw new Error("Workflow engine not initialized — cannot dispatch schedule to workflow");
      }
      const triggerData = {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        firedAt: new Date().toISOString(),
      };
      const runId = await startWorkflowExecution(workflow, triggerData, registry, {
        triggerType: "schedule",
      });
      console.log(
        `[Scheduler] Schedule "${schedule.name}" → triggered workflow "${workflow.name}"`,
      );
      return { triggeredWorkflows: true, workflowRunIds: [runId] };
    }
    case "script": {
      await executeScheduleScript(schedule);
      return { triggeredWorkflows: false };
    }
    default: {
      // Legacy path: check implicit workflow bindings, fall back to a standalone task.
      let triggeredWorkflows = false;
      let workflowRunIds: string[] | undefined;
      const registry = resolveExecutorRegistry();
      if (registry) {
        const runIds = await handleScheduleTrigger(schedule.id, schedule, registry);
        if (runIds.length > 0) {
          triggeredWorkflows = true;
          workflowRunIds = runIds;
          console.log(
            `[Scheduler] Schedule "${schedule.name}" → triggered ${runIds.length} workflow(s)`,
          );
        }
      }
      if (!triggeredWorkflows) {
        const task = getDb().transaction(() => createStandaloneScheduleTask(schedule, extraTags))();
        return { triggeredWorkflows, task };
      }
      return { triggeredWorkflows, workflowRunIds };
    }
  }
}

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

    let triggeredWorkflows = false;
    try {
      ({ triggeredWorkflows } = await dispatchScheduleTarget(schedule, ["recovered"]));

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
      telemetry.schedule("executed", {
        scheduleType: schedule.scheduleType,
        triggeredWorkflows,
        wasRecovered: true,
      });
    } catch (err) {
      telemetry.schedule("error", {
        scheduleType: schedule.scheduleType,
        triggeredWorkflows,
        wasRecovered: true,
        consecutiveErrors: schedule.consecutiveErrors ?? 0,
      });
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
  let triggeredWorkflows = false;
  try {
    ({ triggeredWorkflows } = await dispatchScheduleTarget(schedule));

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
    telemetry.schedule("executed", {
      scheduleType: schedule.scheduleType,
      triggeredWorkflows,
      wasRecovered: false,
    });
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
    telemetry.schedule("error", {
      scheduleType: schedule.scheduleType,
      triggeredWorkflows,
      wasRecovered: false,
      consecutiveErrors: errorCount,
    });
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

  await dispatchScheduleTarget(schedule, ["manual-run"]);

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

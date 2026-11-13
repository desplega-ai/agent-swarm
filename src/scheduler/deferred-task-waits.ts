import {
  createLogEntry,
  getDbClient,
  getScheduledTaskById,
  getUserById,
  updateScheduledTask,
} from "@/be/db";
import {
  describeEventWait,
  type EventMatch,
  EXTERNAL_EVENT_ADAPTERS,
  type ExternalEvent,
  type ExternalEventAdapter,
  getExternalEventAdapter,
  matchKeyOf,
} from "@/event-waits";
import type { PreparedTaskCreate } from "@/tasks/sibling-awareness";
import { type AgentTask, type ScheduledTask, SUPERSEDED_WORKFLOW_TASK_REASON } from "@/types";
import { type PrefixHandler, workflowEventBus } from "@/workflows/event-bus";
import { createStandaloneScheduleTask, prepareStandaloneScheduleTask } from "./schedule-task";

export type TaskWakeEvent = "task.completed" | "task.failed" | "settled";

type TaskWait = {
  scheduleId: string;
  eventName: TaskWakeEvent;
  mode: "all" | "any";
  status: "pending" | "fired";
};

type WaitMember = { taskId: string; taskStatus: string | null; deferred: number };

type WakeReason =
  | "ceiling"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.skipped"
  | `external:${string}`;

type WaitTable = "deferred_task_waits" | "deferred_event_waits";

/** An external-event wait: the sibling of a task wait, keyed by the same one-time schedule. */
type EventWait = {
  scheduleId: string;
  source: string;
  event: string;
  matchKey: string;
  matchJson: string;
  status: "pending" | "fired";
};

/** The wake reason for an external event; it is also what the wait row records as `firedBy`. */
export function externalWakeReason(source: string, event: string): WakeReason {
  return `external:${source}:${event}`;
}

/** Pending external waits one agent may hold, so a runaway agent cannot flood the webhook fan-out. */
export const MAX_PENDING_EVENT_WAITS_PER_AGENT = 20;

/**
 * A member's status as waits see it. A workflow step cut by a supersede is
 * `failed` first and moves to `superseded` once its retry is queued. It has no
 * resume child (the retry is a fresh task the wait never named), so it keeps
 * reading as the failure it settled as. Reading it from the row, not the
 * event, keeps restart reconciliation and either commit order of the retry
 * move and the wait's reconcile on the same answer.
 */
const WAIT_MEMBER_STATUS_SQL = `CASE
  WHEN t.status = 'superseded' AND t.failureReason = '${SUPERSEDED_WORKFLOW_TASK_REASON}' THEN 'failed'
  ELSE t.status END`;

/**
 * Read the wait row and its member set and decide whether the wait is ready.
 * Returns the wake-up cause text, or undefined when the wait is absent, already
 * fired, not addressed by `reason`, or its member set has not matched yet.
 * Pure reads: callers run it once outside the transaction (to build the task
 * through the extension pre-hooks) and once more under the write lock, where
 * the answer is authoritative. An event only identifies a candidate wait; it
 * never proves the set is ready. An external wait reads no provider here (no network
 * under the write lock): its caller confirms the event first, then dispatches.
 */
async function resolveWaitCause(
  scheduleId: string,
  reason: WakeReason,
): Promise<
  { table: WaitTable; mode?: "all" | "any"; cause: string; matchedTaskIds: string[] } | undefined
> {
  const client = getDbClient();
  const wait = await client.get<TaskWait>(
    "SELECT * FROM deferred_task_waits WHERE scheduleId = ?",
    [scheduleId],
  );
  if (!wait) {
    const eventWait = await client.get<EventWait>(
      "SELECT * FROM deferred_event_waits WHERE scheduleId = ?",
      [scheduleId],
    );
    if (!eventWait || eventWait.status !== "pending") return undefined;
    if (reason === "ceiling")
      return { table: "deferred_event_waits", cause: "ceiling expired", matchedTaskIds: [] };
    if (reason !== externalWakeReason(eventWait.source, eventWait.event)) return undefined;
    return {
      table: "deferred_event_waits",
      cause: describeEventWait(
        eventWait.source,
        eventWait.event,
        JSON.parse(eventWait.matchJson) as EventMatch,
      ),
      matchedTaskIds: [],
    };
  }
  if (wait.status !== "pending") return undefined;
  if (reason !== "ceiling" && wait.eventName !== "settled" && wait.eventName !== reason)
    return undefined;
  if (reason === "ceiling")
    return {
      table: "deferred_task_waits",
      mode: wait.mode,
      cause: "ceiling expired",
      matchedTaskIds: [],
    };
  const members = await client.query<WaitMember>(
    `SELECT m.taskId, ${WAIT_MEMBER_STATUS_SQL} AS taskStatus, EXISTS (
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
      (member.taskStatus === "completed" ||
        member.taskStatus === "failed" ||
        member.taskStatus === "cancelled" ||
        member.taskStatus === "skipped") &&
      (wait.eventName === "settled" || wait.eventName === `task.${member.taskStatus}`),
  );
  if (!matched.length || (wait.mode === "all" && matched.length !== members.length))
    return undefined;
  const cause =
    members.length === 1
      ? `task.${matched[0]!.taskStatus} for task ${matched[0]!.taskId}`
      : `${wait.mode} tasks matched ${wait.eventName}: ${matched.map((member) => `${member.taskId} (${member.taskStatus})`).join(", ")}`;
  return {
    table: "deferred_task_waits",
    mode: wait.mode,
    cause,
    matchedTaskIds: matched.map((member) => member.taskId),
  };
}

function wakeSchedule(schedule: ScheduledTask, cause: string): ScheduledTask {
  return { ...schedule, taskTemplate: `${schedule.taskTemplate}\n\nWake-up cause: ${cause}.` };
}

async function prepareDeferredWakeTask(
  scheduleId: string,
  reason: WakeReason,
  extraTags: string[],
): Promise<PreparedTaskCreate | undefined> {
  const resolved = await resolveWaitCause(scheduleId, reason);
  if (!resolved) return undefined;
  let schedule = await getScheduledTaskById(scheduleId);
  if (!schedule?.enabled) return undefined;
  if (schedule.createdBy && !(await getUserById(schedule.createdBy))) {
    schedule = { ...schedule, createdBy: undefined };
  }
  if (!schedule.taskTemplate) throw new Error(`Schedule "${schedule.name}" has no taskTemplate`);
  return await prepareStandaloneScheduleTask(wakeSchedule(schedule, resolved.cause), extraTags);
}

/**
 * Log event written on a settled member task when its settlement is the one
 * that fires a wait. `createWorkerTaskFollowUp` reads it to skip the lead
 * follow-up the woken waiter would duplicate.
 */
export const DEFERRED_WAIT_WOKE_EVENT = "task_deferred_wait_woke";

/** Undefined means a normal schedule; an empty preparation means the wait is not ready. */
export async function prepareDeferredTaskWait(
  scheduleId: string,
  reason: WakeReason,
  extraTags: string[] = [],
): Promise<{ task?: PreparedTaskCreate } | undefined> {
  const client = getDbClient();
  // Keep ordinary schedule dispatch off the write-lock path.
  if (
    !(await client.get(
      `SELECT 1 AS found FROM deferred_task_waits WHERE scheduleId = ?
       UNION ALL SELECT 1 FROM deferred_event_waits WHERE scheduleId = ?`,
      [scheduleId, scheduleId],
    ))
  )
    return undefined;
  // Extension pre-hooks must run outside the transaction, so build the wake-up task
  // first; the transaction below re-reads the wait and its member set before claiming.
  // The prepared description carries the cause seen here; for an `any` wait a member
  // that settles between this read and the claim is missing from that text only.
  return { task: await prepareDeferredWakeTask(scheduleId, reason, extraTags) };
}

/** Undefined means a normal schedule; an empty result means another caller won. */
export async function dispatchDeferredTaskWait(
  scheduleId: string,
  reason: WakeReason,
  extraTags: string[] = [],
  triggerTaskId?: string,
  prepared?: { task?: PreparedTaskCreate },
): Promise<{ task?: AgentTask } | undefined> {
  const preparation = prepared ?? (await prepareDeferredTaskWait(scheduleId, reason, extraTags));
  if (!preparation) return undefined;
  const preparedForWait = preparation.task;
  if (!preparedForWait) return {};
  const client = getDbClient();
  return client.transaction(async () => {
    const resolved = await resolveWaitCause(scheduleId, reason);
    if (!resolved) return {};
    let schedule = await getScheduledTaskById(scheduleId);
    if (!schedule?.enabled) return {};
    const now = new Date().toISOString();
    const claimed = await client.run(
      `UPDATE ${resolved.table} SET status = 'fired', firedBy = ?, resolvedAt = ?, updated_at = ? WHERE scheduleId = ? AND status = 'pending'`,
      [reason, now, now, scheduleId],
    );
    if (!claimed.changes) return {};
    if (schedule.createdBy && !(await getUserById(schedule.createdBy))) {
      schedule = { ...schedule, createdBy: undefined };
    }
    if (!schedule.taskTemplate) throw new Error(`Schedule "${schedule.name}" has no taskTemplate`);
    const task = await createStandaloneScheduleTask(
      wakeSchedule(schedule, resolved.cause),
      extraTags,
      preparedForWait,
    );
    await client.run(`UPDATE ${resolved.table} SET childTaskId = ? WHERE scheduleId = ?`, [
      task.id,
      scheduleId,
    ]);
    // Attribute the wake to the settlement that triggered this claim, in the
    // claim's own transaction. Only the trigger is attributed: an `all` sibling
    // that settled earlier already got its follow-up, and a member that settles
    // concurrently keeps its follow-up rather than risk a silent drop.
    if (triggerTaskId && resolved.matchedTaskIds.includes(triggerTaskId)) {
      await createLogEntry({
        eventType: DEFERRED_WAIT_WOKE_EVENT,
        taskId: triggerTaskId,
        agentId: task.agentId ?? undefined,
        metadata: {
          scheduleId,
          waiterTaskId: schedule.parentTaskId ?? null,
          wakeTaskId: task.id,
          wakeAgentId: task.agentId ?? null,
          mode: resolved.mode,
        },
      });
    }
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

/**
 * Reconcile durable producer state, including terminal transitions missed by this process.
 * With `taskId`, the wakes it fires are attributed to that task's settlement.
 */
export async function reconcileDeferredTaskWaits(taskId?: string): Promise<void> {
  const client = getDbClient();
  const replacements = await client.query<{ taskId: string; resumeTaskId: string }>(
    `SELECT DISTINCT m.taskId, (
       SELECT r.id FROM agent_tasks r
       WHERE r.parentTaskId = t.id AND r.taskType = 'resume'
       ORDER BY r.createdAt, r.id LIMIT 1
     ) AS resumeTaskId
     FROM deferred_task_wait_members m
     JOIN deferred_task_waits w ON w.scheduleId = m.scheduleId
     JOIN agent_tasks t ON t.id = m.taskId
     WHERE w.status = 'pending' AND t.status = 'superseded'
       AND resumeTaskId IS NOT NULL`,
  );
  if (replacements.length) {
    await client.transaction(async () => {
      for (const replacement of replacements) {
        // Collapse members that now watch the same child. Fired waits and their
        // original ceilings stay untouched. No resume child (including skipped
        // recovery) means hold to the ceiling, never wake on supersession.
        await client.run(
          `UPDATE OR REPLACE deferred_task_wait_members SET taskId = ?, updated_at = ?
           WHERE taskId = ? AND scheduleId IN (
             SELECT scheduleId FROM deferred_task_waits WHERE status = 'pending'
           )`,
          [replacement.resumeTaskId, new Date().toISOString(), replacement.taskId],
        );
      }
    });
    // Catch up through a chain missed while stopped, and check the replacements
    // even when the triggering event named their superseded parent.
    return reconcileDeferredTaskWaits();
  }
  const rows = await client.query<
    TaskWait & { taskStatus: "completed" | "failed" | "cancelled" | "skipped" }
  >(
    `SELECT DISTINCT w.*, ${WAIT_MEMBER_STATUS_SQL} AS taskStatus FROM deferred_task_waits w
     JOIN deferred_task_wait_members m ON m.scheduleId = w.scheduleId
     JOIN agent_tasks t ON t.id = m.taskId
     JOIN scheduled_tasks s ON s.id = w.scheduleId
     WHERE w.status = 'pending' AND s.enabled = 1
       AND ${WAIT_MEMBER_STATUS_SQL} IN ('completed', 'failed', 'cancelled', 'skipped')
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_tasks d
         WHERE d.parentTaskId = t.id AND d.taskType = 'deferred' AND d.enabled = 1
       )
       AND (w.eventName = 'settled' OR w.eventName = 'task.' || ${WAIT_MEMBER_STATUS_SQL})
       ${taskId ? "AND m.taskId = ?" : ""}`,
    taskId ? [taskId] : [],
  );
  for (const row of rows) {
    try {
      await dispatchDeferredTaskWait(row.scheduleId, `task.${row.taskStatus}`, [], taskId);
    } catch (err) {
      // A broken wait must not stop other event wakes or the ceiling poller.
      console.error(`[Scheduler] Deferred task wake failed for ${row.scheduleId}:`, err);
    }
  }
}

/**
 * How long a spent deferral timer is kept. Its `requestedDelayMs` /
 * `requestedRunAt` provenance and its wait outcome live only on this row.
 */
export const SPENT_DEFERRED_SCHEDULE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete deferral timers that fired, by ceiling or by event, before the
 * retention window. Nothing reads a spent timer: waits only consult enabled
 * rows, and the wake-up task's `scheduleId` has no foreign key, so it keeps the
 * id. The wait and its members cascade. A timer that never fired (auto-disabled
 * on a dispatch failure) has no `lastRunAt` and is kept as evidence.
 */
export async function reapSpentDeferredSchedules(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SPENT_DEFERRED_SCHEDULE_RETENTION_MS).toISOString();
  const result = await getDbClient().run(
    `DELETE FROM scheduled_tasks
     WHERE taskType = 'deferred' AND scheduleType = 'one_time' AND enabled = 0
       AND lastRunAt IS NOT NULL AND lastRunAt < ?
       AND NOT EXISTS (
         SELECT 1 FROM deferred_task_waits w
         WHERE w.scheduleId = scheduled_tasks.id AND w.status = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1 FROM deferred_event_waits e
         WHERE e.scheduleId = scheduled_tasks.id AND e.status = 'pending'
       )`,
    [cutoff],
  );
  return result.changes;
}

/**
 * Fire pending external-event waits. A webhook names the candidate target (`only`)
 * and sets `trustEvent`: an adapter without `confirm` fires on it, one with `confirm`
 * still has to read the provider first. With no `trustEvent` (boot, and the recheck
 * after a wait is created, which catches a delivery missed while the API was down or
 * before the wait existed) only adapters that can `confirm` are checked. A read that
 * fails leaves the wait pending: the ceiling still wakes the agent.
 */
export async function reconcileDeferredEventWaits(
  only?: { source: string; event: string; matchKey: string },
  trustEvent = false,
): Promise<void> {
  const waits = await getDbClient().query<
    Pick<EventWait, "scheduleId" | "source" | "event" | "matchKey" | "matchJson">
  >(
    `SELECT w.scheduleId, w.source, w.event, w.matchKey, w.matchJson FROM deferred_event_waits w
     JOIN scheduled_tasks s ON s.id = w.scheduleId
     WHERE w.status = 'pending' AND s.enabled = 1
       ${only ? "AND w.source = ? AND w.event = ? AND w.matchKey = ?" : ""}`,
    only ? [only.source, only.event, only.matchKey] : [],
  );
  const satisfied = new Map<string, boolean>();
  for (const wait of waits) {
    const adapter = getExternalEventAdapter(wait.source);
    if (!adapter || (!adapter.confirm && !trustEvent)) continue;
    const key = `${wait.source}|${wait.event}|${wait.matchKey}`;
    try {
      if (!satisfied.has(key))
        satisfied.set(
          key,
          adapter.confirm
            ? await adapter.confirm(wait.event, JSON.parse(wait.matchJson) as EventMatch)
            : true,
        );
      if (satisfied.get(key))
        await dispatchDeferredTaskWait(
          wait.scheduleId,
          externalWakeReason(wait.source, wait.event),
        );
    } catch (err) {
      // A broken wait must not stop the others or the ceiling poller.
      console.error(`[Scheduler] External event wake failed for ${wait.scheduleId}:`, err);
    }
  }
}

/** One bus listener per adapter, kept so `stop` can detach exactly what `init` attached. */
const externalEventListeners = new Map<ExternalEventAdapter, PrefixHandler>();

function externalEventListener(adapter: ExternalEventAdapter): PrefixHandler {
  return (busEvent, payload) => {
    // The bus emit loop has no guard: a throwing adapter must not 500 the webhook or skip later handlers.
    let events: ExternalEvent[];
    try {
      events = adapter.fromBusEvent(busEvent, payload);
    } catch (err) {
      console.error(`[Scheduler] ${adapter.source} adapter failed to read ${busEvent}:`, err);
      return;
    }
    for (const { event, match } of events) {
      void reconcileDeferredEventWaits(
        { source: adapter.source, event, matchKey: matchKeyOf(match) },
        true,
      ).catch((err) => {
        console.error("[Scheduler] External event wake failed:", err);
      });
    }
  };
}

function onTaskEvent(payload: unknown): void {
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

/** Fixed listeners read durable waits, so boot needs no per-wait in-memory registry. */
export async function initDeferredTaskWaits(): Promise<void> {
  stopDeferredTaskWaits();
  workflowEventBus.on("task.completed", onTaskEvent);
  workflowEventBus.on("task.failed", onTaskEvent);
  workflowEventBus.on("task.cancelled", onTaskEvent);
  workflowEventBus.on("task.skipped", onTaskEvent);
  workflowEventBus.on("task.superseded", onTaskEvent);
  // The resume may be committed after its parent's supersede event.
  workflowEventBus.on("task.created", onTaskEvent);
  for (const adapter of EXTERNAL_EVENT_ADAPTERS) {
    const listener = externalEventListener(adapter);
    externalEventListeners.set(adapter, listener);
    workflowEventBus.onPrefix(adapter.busPrefix, listener);
  }
  await reconcileDeferredTaskWaits();
  // Provider reads can be slow or down: never hold boot on them.
  void reconcileDeferredEventWaits().catch((err) => {
    console.error("[Scheduler] External event boot reconcile failed:", err);
  });
}

export function stopDeferredTaskWaits(): void {
  workflowEventBus.off("task.completed", onTaskEvent);
  workflowEventBus.off("task.failed", onTaskEvent);
  workflowEventBus.off("task.cancelled", onTaskEvent);
  workflowEventBus.off("task.skipped", onTaskEvent);
  workflowEventBus.off("task.superseded", onTaskEvent);
  workflowEventBus.off("task.created", onTaskEvent);
  for (const [adapter, listener] of externalEventListeners) {
    workflowEventBus.offPrefix(adapter.busPrefix, listener);
  }
  externalEventListeners.clear();
}

import * as z from "zod";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { TaskUiSpec } from "../utils/task-ui-spec";
import { getDbClient } from "./db";
import { scrubJsonValue } from "./scrub-json";

/** The stored task UI spec, as task and session payloads return it. */
export const TaskUiSpecSchema = z.object({
  spec: z.object({
    root: z.string(),
    elements: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
  }),
  actions: z
    .record(
      z.string(),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("follow_up"), prompt: z.string() }),
        z.object({
          kind: z.literal("script"),
          script: z.string(),
          args: z.record(z.string(), z.unknown()).optional(),
        }),
      ]),
    )
    .optional(),
  fallbackText: z.string(),
});

export type TaskUiActionSurface = "slack" | "web";

type TaskUiSpecRow = {
  taskId: string;
  spec: string;
  actions: string | null;
  fallbackText: string;
};

function rowToTaskUiSpec(row: TaskUiSpecRow): TaskUiSpec {
  const value: TaskUiSpec = { spec: JSON.parse(row.spec), fallbackText: row.fallbackText };
  if (row.actions !== null) value.actions = JSON.parse(row.actions);
  return value;
}

export async function getTaskUiSpec(taskId: string): Promise<TaskUiSpec | null> {
  const row = await getDbClient().get<TaskUiSpecRow>(
    `SELECT task_id AS taskId, spec, actions, fallback_text AS fallbackText
    FROM task_ui_specs WHERE task_id = ?`,
    [taskId],
  );
  return row ? rowToTaskUiSpec(row) : null;
}

/** Bound-parameter chunk for `IN (...)`, well under SQLite's variable limit. */
const TASK_ID_CHUNK = 500;

/**
 * Batched {@link getTaskUiSpec}: one query per 500 task ids. Every requested
 * id is a key; a task with no spec maps to `null`.
 */
export async function getTaskUiSpecsForTasks(
  taskIds: string[],
): Promise<Map<string, TaskUiSpec | null>> {
  const ids = [...new Set(taskIds)];
  const byTask = new Map<string, TaskUiSpec | null>(ids.map((id) => [id, null]));
  for (let i = 0; i < ids.length; i += TASK_ID_CHUNK) {
    const chunk = ids.slice(i, i + TASK_ID_CHUNK);
    const rows = await getDbClient().query<TaskUiSpecRow>(
      `SELECT task_id AS taskId, spec, actions, fallback_text AS fallbackText
      FROM task_ui_specs WHERE task_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const row of rows) byTask.set(row.taskId, rowToTaskUiSpec(row));
  }
  return byTask;
}

/**
 * One spec per task: a second upsert replaces the first. Secrets are
 * redacted before the write, so Slack, Linear and Jira, which read the
 * stored row, never see them.
 */
export async function upsertTaskUiSpec(
  taskId: string,
  value: TaskUiSpec,
  userId?: string,
): Promise<void> {
  await getDbClient().run(
    `INSERT INTO task_ui_specs (task_id, spec, actions, fallback_text, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      spec=excluded.spec, actions=excluded.actions, fallback_text=excluded.fallback_text,
      updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [
      taskId,
      scrubJsonValue(value.spec),
      value.actions === undefined ? null : scrubJsonValue(value.actions),
      scrubSecrets(value.fallbackText),
      userId ?? null,
      userId ?? null,
    ],
  );
}

/**
 * Reserves the one run of an action before its side effect. Returns
 * `"exists"` when the action already ran (or is running) for this task.
 */
export async function reserveTaskUiActionRun({
  taskId,
  actionId,
  surface,
  slackUserId,
  userId,
}: {
  taskId: string;
  actionId: string;
  surface: TaskUiActionSurface;
  slackUserId?: string | null;
  userId?: string | null;
}): Promise<"reserved" | "exists"> {
  const { changes } = await getDbClient().run(
    `INSERT INTO task_ui_action_runs
    (task_id, action_id, surface, slack_user_id, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, action_id) DO NOTHING`,
    [taskId, actionId, surface, slackUserId ?? null, userId ?? null, userId ?? null],
  );
  return changes === 1 ? "reserved" : "exists";
}

/**
 * Drops a reservation whose follow-up task never started, so the button can
 * run again. A finished run (with a result task) stays.
 */
export async function releaseTaskUiActionRun(taskId: string, actionId: string): Promise<void> {
  await getDbClient().run(
    `DELETE FROM task_ui_action_runs
    WHERE task_id = ? AND action_id = ? AND result_task_id IS NULL`,
    [taskId, actionId],
  );
}

export async function setTaskUiActionResult(
  taskId: string,
  actionId: string,
  resultTaskId: string,
): Promise<void> {
  await getDbClient().run(
    `UPDATE task_ui_action_runs SET result_task_id = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE task_id = ? AND action_id = ?`,
    [resultTaskId, taskId, actionId],
  );
}

export type TaskUiScriptActionLock =
  | { status: "acquired" }
  | { status: "running" | "rate_limited"; retryAfterSec: number };

/**
 * Takes the lease of a repeatable `script` action in one statement, so it
 * holds across API processes that share the DB file. Refuses while another
 * run holds an unexpired lease, or inside the cooldown after the last run.
 * A follow-up row (with a result task) is never taken over.
 */
export async function acquireTaskUiScriptActionRun({
  taskId,
  actionId,
  surface,
  slackUserId,
  userId,
  leaseMs,
  cooldownMs,
  nowMs = Date.now(),
}: {
  taskId: string;
  actionId: string;
  surface: TaskUiActionSurface;
  slackUserId?: string | null;
  userId?: string | null;
  leaseMs: number;
  cooldownMs: number;
  nowMs?: number;
}): Promise<TaskUiScriptActionLock> {
  // ISO strings in the strftime('%Y-%m-%dT%H:%M:%fZ') shape compare as text.
  const now = new Date(nowMs).toISOString();
  const lockedUntil = new Date(nowMs + leaseMs).toISOString();
  const cooldownCutoff = new Date(nowMs - cooldownMs).toISOString();
  const { changes } = await getDbClient().run(
    `INSERT INTO task_ui_action_runs
    (task_id, action_id, surface, slack_user_id, created_by, updated_by, locked_until)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, action_id) DO UPDATE SET
      locked_until = excluded.locked_until, surface = excluded.surface,
      slack_user_id = excluded.slack_user_id, updated_by = excluded.updated_by, updated_at = ?
    WHERE task_ui_action_runs.result_task_id IS NULL
      AND (task_ui_action_runs.locked_until IS NULL OR task_ui_action_runs.locked_until < ?)
      AND (task_ui_action_runs.last_run_at IS NULL OR task_ui_action_runs.last_run_at < ?)`,
    [
      taskId,
      actionId,
      surface,
      slackUserId ?? null,
      userId ?? null,
      userId ?? null,
      lockedUntil,
      now,
      now,
      cooldownCutoff,
    ],
  );
  if (changes === 1) return { status: "acquired" };

  const row = await getDbClient().get<{ lockedUntil: string | null; lastRunAt: string | null }>(
    `SELECT locked_until AS lockedUntil, last_run_at AS lastRunAt
    FROM task_ui_action_runs WHERE task_id = ? AND action_id = ?`,
    [taskId, actionId],
  );
  const secondsUntil = (ms: number) => Math.max(1, Math.ceil((ms - nowMs) / 1000));
  if (row?.lockedUntil && row.lockedUntil >= now) {
    return { status: "running", retryAfterSec: secondsUntil(Date.parse(row.lockedUntil)) };
  }
  if (row?.lastRunAt && row.lastRunAt >= cooldownCutoff) {
    return {
      status: "rate_limited",
      retryAfterSec: secondsUntil(Date.parse(row.lastRunAt) + cooldownMs),
    };
  }
  return { status: "running", retryAfterSec: 1 };
}

/** Ends a script run: frees the lease and records when it ran and how. */
export async function finishTaskUiScriptActionRun(
  taskId: string,
  actionId: string,
  error: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `UPDATE task_ui_action_runs SET locked_until = NULL, last_run_at = ?,
      run_count = run_count + 1, last_error = ?, updated_at = ?
    WHERE task_id = ? AND action_id = ?`,
    [now, error === null ? null : scrubSecrets(error), now, taskId, actionId],
  );
}

/**
 * The completion uiSpec check refuses at most once per task. The refusal is
 * an `agent_log` row, so it also shows in the task's activity timeline.
 */
export async function hasTaskUiSpecCheckRefusal(taskId: string): Promise<boolean> {
  return Boolean(
    await getDbClient().get<{ id: string }>(
      "SELECT id FROM agent_log WHERE taskId = ? AND eventType = 'task_ui_spec_check_refused' LIMIT 1",
      [taskId],
    ),
  );
}

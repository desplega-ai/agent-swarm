import * as z from "zod";
import type { TaskUiSpec } from "../utils/task-ui-spec";
import { getDbClient } from "./db";

/** The stored task UI spec, as task and session payloads return it. */
export const TaskUiSpecSchema = z.object({
  spec: z.object({
    root: z.string(),
    elements: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
  }),
  actions: z
    .record(z.string(), z.object({ kind: z.literal("follow_up"), prompt: z.string() }))
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

/** One spec per task: a second upsert replaces the first. */
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
      JSON.stringify(value.spec),
      value.actions === undefined ? null : JSON.stringify(value.actions),
      value.fallbackText,
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

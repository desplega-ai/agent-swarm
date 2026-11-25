import * as z from "zod";
import { getScriptRun } from "../be/db";
import { listScriptRunTree } from "../be/db/script-runs";
import { getTaskById } from "../be/db/tasks/read";
import { MAX_SCRIPT_WALL_CLOCK_MS } from "../scripts-runtime/executors/types";
import { TERMINAL_SCRIPT_RUN_STATUSES } from "../types";
import { scrubObject } from "../utils/secret-scrubber";

/** Longest bounded wait `app-action-run` and `app-action-status` hold a call open for. */
export const MAX_ACTION_RUN_WAIT_SECONDS = 25;
/** Rows read per run tree; a bigger tree reports `truncated: true`. */
const RUN_TREE_MAX_ROWS = 2000;
const POLL_INTERVAL_MS = 500;
/** Slack past the script wall cap before a still-running action root reads as lost. */
const LOST_ROOT_GRACE_MS = 60_000;

const SETTLED_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "skipped"]);
const FAILED_RUN_STATUSES = new Set(["failed", "cancelled", "aborted_limit"]);
const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_SCRIPT_RUN_STATUSES);

export const ActionRunStateSchema = z.object({
  id: z.string(),
  /** Task-kind actions: the created task. */
  taskId: z.string().optional(),
  state: z.enum(["running", "succeeded", "failed"]),
  settled: z.boolean(),
  /** Script actions: the action's run plus every run its script launched or called. */
  runs: z
    .object({
      total: z.number(),
      running: z.number(),
      completed: z.number(),
      failed: z.number(),
      truncated: z.boolean(),
    })
    .optional(),
  /** First three failed runs of the tree. */
  failures: z
    .array(
      z.object({ id: z.string(), scriptName: z.string().nullable(), error: z.string().nullable() }),
    )
    .optional(),
  /** Task-kind actions: the task status. */
  status: z.string().optional(),
  elapsedMs: z.number(),
  /** The call that continues the wait, while `settled` is false. */
  next: z.string().optional(),
});
export type ActionRunState = z.infer<typeof ActionRunStateSchema>;

function belongsToApp(args: unknown, appId: string): boolean {
  const app = (args as { app?: { id?: unknown } } | null)?.app;
  return app?.id === appId;
}

/**
 * One read of an app action run: a script action's run tree, or a task
 * action's task. `null` when the id names no run or task of this app; a run of
 * another app reads as not found, so an id never leaks across apps.
 */
async function readActionRun(appId: string, id: string): Promise<ActionRunState | null> {
  const root = await getScriptRun(id);
  if (root) {
    if (!belongsToApp(root.args, appId)) return null;
    const tree = await listScriptRunTree(id, RUN_TREE_MAX_ROWS + 1);
    const truncated = tree.length > RUN_TREE_MAX_ROWS;
    const rows = tree.slice(0, RUN_TREE_MAX_ROWS);
    // An in-process action root still `running` past the script wall cap lost its
    // process (a server restart mid-action): read it as failed, not running forever.
    if (
      root.kind === "inline" &&
      root.status === "running" &&
      Date.now() - Date.parse(root.startedAt) > MAX_SCRIPT_WALL_CLOCK_MS + LOST_ROOT_GRACE_MS &&
      rows[0]?.id === id
    ) {
      rows[0] = { ...rows[0], status: "failed", error: "the action run stopped without a result" };
    }
    // `paused` is not terminal: it resumes, so the tree is still running.
    const running = rows.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status)).length;
    const failedRows = rows.filter((r) => FAILED_RUN_STATUSES.has(r.status));
    const lastFinished = rows.reduce(
      (max, r) => (r.finishedAt && Date.parse(r.finishedAt) > max ? Date.parse(r.finishedAt) : max),
      0,
    );
    const startedAt = Date.parse(root.startedAt);
    const settled = running === 0;
    return {
      id,
      state: !settled ? "running" : failedRows.length > 0 ? "failed" : "succeeded",
      settled,
      runs: {
        total: rows.length,
        running,
        completed: rows.filter((r) => r.status === "completed").length,
        failed: failedRows.length,
        truncated,
      },
      ...(failedRows.length > 0
        ? {
            failures: failedRows
              .slice(0, 3)
              .map((r) => ({ id: r.id, scriptName: r.scriptName, error: r.error })),
          }
        : {}),
      elapsedMs: (settled && lastFinished ? lastFinished : Date.now()) - startedAt,
    };
  }

  const task = await getTaskById(id);
  if (!task?.key?.startsWith(`shared/app:${appId.toLowerCase()}/`)) return null;
  const settled = SETTLED_TASK_STATUSES.has(task.status);
  const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : 0;
  return {
    id,
    taskId: id,
    state: !settled
      ? "running"
      : task.status === "failed" || task.status === "cancelled"
        ? "failed"
        : "succeeded",
    settled,
    status: task.status,
    elapsedMs: (settled && finishedAt ? finishedAt : Date.now()) - Date.parse(task.createdAt),
  };
}

/**
 * Read an app action run, waiting up to `waitSeconds` (capped at 25) for it to
 * settle. A run that is still going when the wait ends carries `next`.
 */
export async function resolveActionRunState(
  appId: string,
  id: string,
  waitSeconds = 0,
): Promise<ActionRunState | null> {
  const deadline =
    Date.now() + Math.min(Math.max(waitSeconds, 0), MAX_ACTION_RUN_WAIT_SECONDS) * 1000;
  let state = await readActionRun(appId, id);
  // shortcut: DB re-read every 500 ms; switch to a script-run finished bus event when one exists.
  while (state && !state.settled && Date.now() + POLL_INTERVAL_MS <= deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    state = await readActionRun(appId, id);
  }
  if (!state) return null;
  return scrubObject(
    state.settled
      ? state
      : {
          ...state,
          next: `app-action-status {"appId":"${appId}","runId":"${id}","waitSeconds":${MAX_ACTION_RUN_WAIT_SECONDS}}`,
        },
  );
}

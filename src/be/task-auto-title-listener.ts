/**
 * Automatic task titles.
 *
 * Listens for `task.created` (emitted after commit by `createTaskExtended`),
 * asks the cheapest configured model for a short title, and stores it on the
 * task when nobody set one first. The sessions sidebar and task lists read
 * `title` and fall back to the prompt, so a failed or skipped generation
 * changes nothing visible.
 *
 * `TASK_AUTO_TITLE_ENABLED=false` turns the listener off at the next event;
 * `TASK_AUTO_TITLE_MODEL` pins one model (see `buildTaskTitlePlan`).
 */

import { getApiKey } from "../utils/api-key";
import { getMcpBaseUrl } from "../utils/constants";
import { parseEnvFlag } from "../utils/env-flag";
import { generateTaskTitle, TASK_TITLE_TIMEOUT_MS } from "../utils/internal-ai/task-title";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { getTaskById } from "./db/tasks/read";
import { setTaskTitleIfUnset } from "./db/tasks/write";

/** Titles generated at once. Bursts (a workflow fan-out) queue behind this. */
export const TASK_AUTO_TITLE_CONCURRENCY = 3;

export function isTaskAutoTitleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.TASK_AUTO_TITLE_ENABLED, true);
}

export interface TaskAutoTitleListenerOptions {
  /** Defaults to `process.env`; read on every event so a config reload applies. */
  env?: NodeJS.ProcessEnv;
  /** Test injection: replaces the model call. */
  generate?: typeof generateTaskTitle;
}

export interface TaskAutoTitleListener {
  stop(): void;
  /** Resolves once every queued task has been processed. */
  idle(): Promise<void>;
}

export function startTaskAutoTitleListener(
  options: TaskAutoTitleListenerOptions = {},
): TaskAutoTitleListener {
  const env = options.env ?? process.env;
  const generate = options.generate ?? generateTaskTitle;
  const queue: string[] = [];
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (active > 0 || queue.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const pump = () => {
    while (active < TASK_AUTO_TITLE_CONCURRENCY) {
      const taskId = queue.shift();
      if (!taskId) break;
      active++;
      void titleTask(taskId, env, generate)
        .catch((error) => console.error("[task-title] Failed:", scrubSecrets(String(error))))
        .finally(() => {
          active--;
          pump();
          settleIdle();
        });
    }
  };

  const onTaskCreated = (data: unknown) => {
    if (!isTaskAutoTitleEnabled(env)) return;
    const taskId = (data as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string" || !taskId) return;
    queue.push(taskId);
    pump();
  };

  workflowEventBus.on("task.created", onTaskCreated);
  return {
    stop: () => workflowEventBus.off("task.created", onTaskCreated),
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      }),
  };
}

async function titleTask(
  taskId: string,
  env: NodeJS.ProcessEnv,
  generate: typeof generateTaskTitle,
): Promise<void> {
  const task = await getTaskById(taskId);
  if (!task || task.title) return;
  const shortId = taskId.slice(0, 8);
  const startedAt = Date.now();
  const result = await generate({
    task: task.task,
    env,
    // Loopback context for the codex OAuth probe; only used when no API key is set.
    apiUrl: getMcpBaseUrl(),
    apiKey: getApiKey(),
    callerTag: `task-title:${task.source}`,
    signal: AbortSignal.timeout(TASK_TITLE_TIMEOUT_MS),
  });
  if (!result.ok) {
    if (result.reason !== "short-task") {
      console.log(`[task-title] ${shortId}: no title (${result.reason})`);
    }
    return;
  }
  const updated = await setTaskTitleIfUnset(taskId, result.title);
  const elapsed = Date.now() - startedAt;
  // The title derives from task text, so a pasted token could reach the log.
  console.log(
    scrubSecrets(
      `[task-title] ${shortId}: "${result.title}" via ${result.model} in ${elapsed}ms${
        updated ? "" : " (kept the existing title)"
      }`,
    ),
  );
}

import type { AgentTask } from "../types";

/**
 * Minimal in-process task-lifecycle event emitter.
 *
 * This exists to invert a layering dependency: the data layer (`be/db`) used to
 * import a GitHub integration (`github/task-reactions`) so it could add an 👀
 * reaction when a task started. Instead, `be/db` now emits a `task-started`
 * event and the GitHub integration subscribes at API-server boot. The data layer
 * no longer depends on any integration.
 *
 * Handlers run synchronously in registration order. Each is wrapped in try/catch
 * so a throwing handler never breaks task processing. Handlers may return a
 * promise; it is ignored (fire-and-forget), but any async rejection is swallowed
 * so it never surfaces as an unhandled rejection. This preserves the original
 * `addEyesReactionOnTaskStart(result).catch(() => {})` semantics exactly.
 */

type TaskStartedHandler = (task: AgentTask) => void | Promise<void>;

const taskStartedHandlers: TaskStartedHandler[] = [];

/** Register a handler invoked whenever a task transitions to `in_progress`. */
export function onTaskStarted(handler: TaskStartedHandler): void {
  taskStartedHandlers.push(handler);
}

/** Emit the task-started event. Never throws. */
export function emitTaskStarted(task: AgentTask): void {
  for (const handler of taskStartedHandlers) {
    try {
      const result = handler(task);
      // Fire-and-forget: ignore the returned promise but swallow async
      // rejections so a failing handler never crashes the process.
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // A throwing handler must never break task processing.
    }
  }
}

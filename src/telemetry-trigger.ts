/**
 * `trigger_surface` for task and session telemetry: the surface that started
 * the whole chain of work, resolved at the root of the `parentTaskId` chain.
 *
 * A Slack ask that the lead splits into 5 worker tasks (`send-task` writes
 * `source: "mcp"`, follow-ups write `system`) is 6 Slack tasks, not 1 Slack
 * task and 5 MCP ones. The raw per-task value is kept as `task_source`.
 *
 * API server only: it reads `agent_tasks`. Workers receive the resolved value
 * from the poll response.
 */
import type { PropsFor, TriggerSurface } from "@desplega/telemetry-contract";
import { getDbClient } from "./be/db/runtime";
import { isTelemetryEnabled, telemetry } from "./telemetry";
import { mapTriggerSurface } from "./telemetry-context";
import { primeUserRole } from "./telemetry-identity";
import { scrubSecrets } from "./utils/secret-scrubber";

const MAX_CHAIN_DEPTH = 50;
const CACHE_LIMIT = 10_000;

/** Task ID -> root surface. A task's root is fixed at creation, because `parentTaskId` is set once. */
const rootSurfaceCache = new Map<string, TriggerSurface>();

function remember(taskId: string, surface: TriggerSurface): void {
  rootSurfaceCache.delete(taskId); // re-insert so the Map order is least-recently-used first
  rootSurfaceCache.set(taskId, surface);
  if (rootSurfaceCache.size > CACHE_LIMIT) {
    const oldest = rootSurfaceCache.keys().next().value;
    if (oldest !== undefined) rootSurfaceCache.delete(oldest);
  }
}

/**
 * The surface of the root task above `taskId`.
 *
 * One recursive CTE walks `parentTaskId` (depth capped at 50) and the deepest
 * row wins, so an orphan whose parent row was deleted reports the deepest row
 * that still exists. When the task itself is gone, `fallbackSource` (the
 * caller's own task source) is used and nothing is cached.
 */
export async function resolveTriggerSurface(
  taskId: string,
  fallbackSource?: string | null,
): Promise<TriggerSurface> {
  const cached = rootSurfaceCache.get(taskId);
  if (cached) {
    remember(taskId, cached);
    return cached;
  }
  const row = await getDbClient().get<{ source: string | null }>(
    `WITH RECURSIVE chain(id, parentTaskId, source, depth) AS (
       SELECT id, parentTaskId, source, 0 FROM agent_tasks WHERE id = ?
       UNION ALL
       SELECT t.id, t.parentTaskId, t.source, c.depth + 1
         FROM agent_tasks t JOIN chain c ON t.id = c.parentTaskId
        WHERE c.depth < ?
     )
     SELECT source FROM chain ORDER BY depth DESC LIMIT 1`,
    [taskId, MAX_CHAIN_DEPTH],
  );
  if (!row) return mapTriggerSurface(fallbackSource);
  const surface = mapTriggerSurface(row.source);
  remember(taskId, surface);
  return surface;
}

export type TaskTelemetryEvent =
  | "created"
  | "started"
  | "claimed"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

/**
 * A task lifecycle event as call sites build it: the catalog properties minus
 * the two derived ones, plus the task's own `source`. `emitTaskTelemetry`
 * renames `source` to `task_source` and adds `trigger_surface`, in one place.
 */
export type TaskTelemetryInput<S extends TaskTelemetryEvent = TaskTelemetryEvent> =
  S extends TaskTelemetryEvent
    ? Omit<PropsFor<`task.${S}`>, "task_source" | "trigger_surface"> & {
        source?: string | null;
      }
    : never;

/**
 * Send a `task.*` lifecycle event with `trigger_surface` and `task_source`.
 * Every lifecycle event of a task resolves the same task ID, so `completed`
 * reports exactly the `trigger_surface` its `created` reported. Never throws.
 */
export async function emitTaskTelemetry<S extends TaskTelemetryEvent>(
  event: S,
  input: TaskTelemetryInput<S>,
  actorUserId?: string | null,
): Promise<void> {
  if (!isTelemetryEnabled()) return;
  try {
    const { source, ...rest } = input as TaskTelemetryInput & { taskId: string };
    const triggerSurface = await resolveTriggerSurface(rest.taskId, source);
    if (actorUserId) await primeUserRole(actorUserId);
    telemetry.taskEvent(
      event,
      {
        ...rest,
        task_source: mapTriggerSurface(source),
        trigger_surface: triggerSurface,
      } as never,
      actorUserId ? { userId: actorUserId } : undefined,
    );
  } catch (err) {
    console.error(
      "[telemetry] task event failed:",
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Test-only: clear the memo so a test can re-shape the task tree. */
export function _resetTriggerSurfaceCacheForTests(): void {
  rootSurfaceCache.clear();
}

/**
 * API drain: what the API does between SIGTERM and closing its HTTP server.
 *
 * On a deploy the orchestrator stops the API and the workers together, and the
 * workers' own SIGTERM handoff (`POST /api/tasks/:id/supersede`) lands after the
 * API is gone, so every in-flight task falls through to the heartbeat sweep.
 * Draining flips that order: the API keeps serving, dispatches no new work,
 * marks every response with `X-Swarm-Draining: 1` (see `src/utils/api-drain.ts`),
 * and waits, bounded, until the tasks it saw in flight have been handed off.
 *
 * The state is process-local. A new API process starts not draining.
 */

import { API_DRAIN_MAX_MS_LIMIT } from "../utils/api-drain";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";

/**
 * Default cap on the wait for worker handoffs: `0`, the drain is off. It is
 * opt-in because it makes every live worker supersede its in-flight tasks on
 * any API SIGTERM, including an API-only restart where those tasks would
 * otherwise keep running. A deploy that stops the API and the workers together
 * sets `API_DRAIN_MAX_MS` (e.g. `30000`) to turn it on.
 */
export const DEFAULT_API_DRAIN_MAX_MS = 0;
const DRAIN_CHECK_INTERVAL_MS = 500;
/**
 * A worker pings every few seconds. One silent for longer than this is not
 * expected to hand anything off; the heartbeat sweep owns its tasks.
 */
const LIVE_WORKER_WINDOW_MS = 30_000;

let drainStartedAt: number | null = null;

export function isApiDraining(): boolean {
  return drainStartedAt !== null;
}

/** Enter the draining state. Returns false when already draining. */
export function beginApiDrain(now: number = Date.now()): boolean {
  if (drainStartedAt !== null) return false;
  drainStartedAt = now;
  return true;
}

/** Test seam: the state is module-level, so tests reset it between cases. */
export function resetApiDrainForTesting(): void {
  drainStartedAt = null;
}

/**
 * `API_DRAIN_MAX_MS`, capped at `API_DRAIN_MAX_MS_LIMIT`. Unset, empty, or
 * invalid means `DEFAULT_API_DRAIN_MAX_MS` (`0`, the drain is off).
 */
export function resolveApiDrainMaxMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.API_DRAIN_MAX_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_API_DRAIN_MAX_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_API_DRAIN_MAX_MS;
  return Math.min(Math.floor(parsed), API_DRAIN_MAX_MS_LIMIT);
}

/** `in_progress` tasks held by an agent that pinged recently, i.e. one that can still hand off. */
export async function listLiveInFlightTaskIds(now: number = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - LIVE_WORKER_WINDOW_MS).toISOString();
  const rows = await getDbClient().query<{ id: string }>(
    `SELECT t.id AS id
       FROM agent_tasks t
       JOIN agents a ON a.id = t.agentId
      WHERE t.status = 'in_progress' AND a.status != 'offline' AND a.lastUpdatedAt >= ?`,
    [cutoff],
  );
  return rows.map((row) => row.id);
}

/** How many of `taskIds` are still `in_progress`. */
export async function countStillInProgress(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  const row = await getDbClient().get<{ n: number }>(
    `SELECT count(*) AS n FROM agent_tasks
      WHERE status = 'in_progress' AND id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(taskIds)],
  );
  return row?.n ?? 0;
}

export interface ApiDrainDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  listInFlight?: () => Promise<string[]>;
  countRemaining?: (taskIds: string[]) => Promise<number>;
  log?: (message: string) => void;
}

export interface ApiDrainOutcome {
  /** False when the cap is `0` (the default): the API did not enter the draining state. */
  enabled: boolean;
  /** Live in-flight tasks seen when the drain began. */
  inFlight: number;
  /** Of those, still `in_progress` when the wait ended. */
  remaining: number;
  waitedMs: number;
  timedOut: boolean;
}

/**
 * Enter the draining state, then wait until the live in-flight tasks are handed
 * off or the cap passes. Never throws: a failed read ends the wait, because a
 * shutdown that cannot finish is worse than one that skips the drain.
 */
export async function drainApi(deps: ApiDrainDeps = {}): Promise<ApiDrainOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = deps.log ?? ((message: string) => console.log(message));
  const listInFlight = deps.listInFlight ?? (() => listLiveInFlightTaskIds(now()));
  const countRemaining = deps.countRemaining ?? countStillInProgress;
  const maxMs = resolveApiDrainMaxMs(deps.env);
  const startedAt = now();

  if (maxMs === 0) {
    log("[drain] off (API_DRAIN_MAX_MS is 0 or unset): closing without waiting for handoffs");
    return { enabled: false, inFlight: 0, remaining: 0, waitedMs: 0, timedOut: false };
  }

  beginApiDrain(startedAt);

  let taskIds: string[];
  try {
    taskIds = await listInFlight();
  } catch (err) {
    log(`[drain] could not read in-flight tasks, closing without waiting: ${describe(err)}`);
    return {
      enabled: true,
      inFlight: 0,
      remaining: 0,
      waitedMs: now() - startedAt,
      timedOut: false,
    };
  }

  if (taskIds.length === 0) {
    log("[drain] draining: no in-flight tasks on live workers");
    return {
      enabled: true,
      inFlight: 0,
      remaining: 0,
      waitedMs: now() - startedAt,
      timedOut: false,
    };
  }

  log(
    `[drain] draining: waiting up to ${maxMs}ms for ${taskIds.length} in-flight task(s) to be handed off`,
  );

  const deadline = startedAt + maxMs;
  let remaining = taskIds.length;
  while (true) {
    try {
      remaining = await countRemaining(taskIds);
    } catch (err) {
      log(`[drain] could not re-read in-flight tasks, closing now: ${describe(err)}`);
      break;
    }
    if (remaining === 0 || now() >= deadline) break;
    await sleep(Math.min(DRAIN_CHECK_INTERVAL_MS, Math.max(0, deadline - now())));
  }

  const waitedMs = now() - startedAt;
  const timedOut = remaining > 0;
  log(
    timedOut
      ? `[drain] timed out after ${waitedMs}ms with ${remaining} of ${taskIds.length} task(s) still in_progress`
      : `[drain] all ${taskIds.length} in-flight task(s) handed off after ${waitedMs}ms`,
  );
  return { enabled: true, inFlight: taskIds.length, remaining, waitedMs, timedOut };
}

function describe(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}

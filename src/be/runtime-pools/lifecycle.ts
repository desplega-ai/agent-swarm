import { isTerminalTaskStatus, type RuntimeInstance, type RuntimePool } from "../../types";
import { getDbClient, getTaskById } from "../db";

export async function rotatingRuntimes(
  poolId: string,
  expiresBy: string,
  now: Date,
  maxContinuousSec?: number,
): Promise<Set<string>> {
  const configured = Number(process.env.RUNTIME_ROTATE_BEFORE_SEC);
  const beforeSec = Number.isInteger(configured) && configured > 0 ? configured : 600;
  const rotateAt =
    maxContinuousSec === undefined
      ? null
      : new Date(now.getTime() - Math.max(0, maxContinuousSec - beforeSec) * 1000).toISOString();
  const rows = await getDbClient().query<{ runtimeId: string }>(
    `SELECT DISTINCT r.id AS runtimeId FROM runtime_instances r
     LEFT JOIN session_tokens t ON r.id = t.runtimeId
     WHERE r.pool_id = ? AND ((t.revokedAt IS NULL AND t.expiresAt <= ?)
       OR (? IS NOT NULL AND r.created_at <= ?))`,
    [poolId, expiresBy, rotateAt, rotateAt],
  );
  return new Set(rows.map((row) => row.runtimeId));
}

export async function isRuntimeWanted(
  pool: RuntimePool,
  runtime: RuntimeInstance,
  rotating: boolean,
  remaining: number,
  now: Date,
): Promise<boolean> {
  if (!pool.enabled || runtime.draining || rotating) return false;
  if (
    pool.lifecycle === "idle" &&
    pool.idleMinutes !== null &&
    runtime.idleSince &&
    now.getTime() - Date.parse(runtime.idleSince) >= pool.idleMinutes * 60_000 &&
    remaining > pool.minRuntimes
  )
    return false;
  const task = runtime.taskId ? await getTaskById(runtime.taskId) : null;
  return !(pool.lifecycle === "per-task" && task && isTerminalTaskStatus(task.status));
}

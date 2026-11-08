import { ResourceOperationSchema } from "../../types";
import { getDbClient } from "../db";

export const OPERATION_LEASE_MS = 30_000;
export function resourceRetryDelayMs(attempt: number) {
  return Math.min(60_000, 5000 * 2 ** Math.min(attempt, 4));
}
export async function getOperation(id: string) {
  const row = await getDbClient().get("SELECT * FROM resource_operations WHERE id=?", [id]);
  return row ? ResourceOperationSchema.parse(row) : null;
}

/** The conditional resource lease serializes independent API processes. */
export async function claimOperation(id: string, now: Date, owner: string) {
  return getDbClient().transaction(async (tx) => {
    const op = await getOperation(id);
    if (!op || !["pending", "running", "uncertain"].includes(op.status)) return null;
    const retry = await tx.get<{ nextAttemptAt: string | null }>(
      "SELECT nextAttemptAt FROM resource_operations WHERE id=?",
      [id],
    );
    if (retry?.nextAttemptAt && retry.nextAttemptAt > now.toISOString()) return null;
    const current = await tx.get<{ generation: number; state: string }>(
      "SELECT generation,state FROM resources WHERE id=?",
      [op.resourceId],
    );
    if (!current || current.generation !== op.generation || current.state === "destroyed") {
      await tx.run(
        "UPDATE resource_operations SET status='failed',lastError='The resource generation is no longer current.',finishedAt=?,updatedAt=? WHERE id=?",
        [now.toISOString(), now.toISOString(), id],
      );
      return null;
    }
    const timestamp = now.toISOString();
    const expiry = new Date(now.getTime() + OPERATION_LEASE_MS).toISOString();
    const lock = await tx.run(
      `UPDATE resources SET leaseOwner=?,leaseExpiresAt=? WHERE id=? AND generation=? AND state<>'destroyed' AND (leaseOwner IS NULL OR leaseExpiresAt<=?)`,
      [owner, expiry, op.resourceId, op.generation, timestamp],
    );
    if (!lock.changes) return null;
    const claimed = await tx.run(
      `UPDATE resource_operations SET status='running',leaseOwner=?,leaseExpiresAt=?,startedAt=COALESCE(startedAt,?),updatedAt=? WHERE id=? AND (leaseOwner IS NULL OR leaseExpiresAt<=?) AND status IN ('pending','running','uncertain')`,
      [owner, expiry, timestamp, timestamp, id, timestamp],
    );
    if (!claimed.changes) throw new Error("The operation lease is unavailable.");
    return { op, owner, leaseExpiresAt: expiry, recover: op.status !== "pending" };
  });
}

export async function finishOperation(
  id: string,
  owner: string,
  status: "succeeded" | "failed" | "uncertain",
  now: Date,
  error: string | null = null,
) {
  const retry = await getDbClient().get<{ retryCount: number }>(
    "SELECT retryCount FROM resource_operations WHERE id=?",
    [id],
  );
  const next =
    status === "uncertain"
      ? new Date(now.getTime() + resourceRetryDelayMs(retry?.retryCount ?? 0)).toISOString()
      : null;
  await getDbClient().run(
    "UPDATE resource_operations SET nextAttemptAt=?,retryCount=retryCount+?,status=?,lastError=?,finishedAt=?,updatedAt=?,leaseOwner=NULL,leaseExpiresAt=NULL WHERE id=? AND leaseOwner=?",
    [
      next,
      status === "uncertain" ? 1 : 0,
      status,
      error,
      now.toISOString(),
      now.toISOString(),
      id,
      owner,
    ],
  );
}

import { getCurrentRequestUserId } from "../../utils/request-auth-context";
import { getDbClient } from "./runtime";
import { IdempotencyKeyTakenError, sha256 } from "./workflow-idempotency";

/**
 * Server-side `Idempotency-Key` records for `POST /api/tasks`. A record is
 * written in the transaction that inserts the task, so it exists if and only
 * if the task committed. A retry under the same key gets that task back.
 */

/** One caller's key, plus the fingerprint of the request it was sent with. */
export interface TaskIdempotencyClaim {
  /** Stable caller identity, e.g. `user:<id>`; never a credential value. */
  principal: string;
  /** The client's `Idempotency-Key` value. Stored only as a hash. */
  key: string;
  fingerprint: string;
}

export async function findAcceptedTaskCreate(
  claim: TaskIdempotencyClaim,
): Promise<{ fingerprint: string; taskId: string } | null> {
  const row = await getDbClient().get<{ requestFingerprint: string; taskId: string }>(
    "SELECT requestFingerprint, taskId FROM task_idempotency_keys WHERE principal = ? AND keyHash = ?",
    [claim.principal, sha256(claim.key)],
  );
  return row ? { fingerprint: row.requestFingerprint, taskId: row.taskId } : null;
}

/**
 * Record the created task. Call it inside the transaction that inserts the
 * task: a rollback drops both. Throws `IdempotencyKeyTakenError` when a
 * concurrent request with the same key committed first (the unique index backs
 * this across processes).
 */
export async function recordAcceptedTaskCreate(
  claim: TaskIdempotencyClaim,
  taskId: string,
): Promise<void> {
  const actor = getCurrentRequestUserId() ?? null;
  try {
    await getDbClient().run(
      `INSERT INTO task_idempotency_keys
         (id, principal, keyHash, requestFingerprint, taskId, createdAt, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        claim.principal,
        sha256(claim.key),
        claim.fingerprint,
        taskId,
        new Date().toISOString(),
        actor,
        actor,
      ],
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new IdempotencyKeyTakenError();
    }
    throw err;
  }
}

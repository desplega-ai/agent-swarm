import { getCurrentRequestUserId } from "../../utils/request-auth-context";
import { getStorage } from "../storage";
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
  const row = await getStorage().repos.tasks.findTaskIdempotencyKey(
    claim.principal,
    sha256(claim.key),
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
    await getStorage().repos.tasks.insertTaskIdempotencyKey({
      id: crypto.randomUUID(),
      principal: claim.principal,
      keyHash: sha256(claim.key),
      requestFingerprint: claim.fingerprint,
      taskId,
      createdAt: new Date().toISOString(),
      created_by: actor,
      updated_by: actor,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new IdempotencyKeyTakenError();
    }
    throw err;
  }
}

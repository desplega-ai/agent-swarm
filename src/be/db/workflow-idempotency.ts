import { getCurrentRequestUserId } from "../../utils/request-auth-context";
import { openSealedJson, sealJson } from "../sealed-json";
import { getDbClient } from "./runtime";

/**
 * Server-side `Idempotency-Key` records for workflow create and trigger.
 *
 * A record is written in the transaction that accepts the operation (the
 * workflow insert, or the run insert with its initial state), so it exists if
 * and only if the operation committed. Readers look it up before re-running
 * any check that can change between attempts (enabled, cooldown, readiness,
 * trigger schema) and replay the stored response instead.
 */

export type WorkflowIdempotencyOperation = "workflow.create" | "workflow.trigger";

/** Who may replay a record: one caller, one operation, one target, one key. */
export interface WorkflowIdempotencyScope {
  /** Stable caller identity, e.g. `user:<id>`; never a credential value. */
  principal: string;
  operation: WorkflowIdempotencyOperation;
  /** The triggered workflow id; empty for create. */
  targetId: string;
  /** The client's `Idempotency-Key` value. Stored only as a hash. */
  key: string;
}

/** A claim for one request: its scope plus the fingerprint of what it asked for. */
export interface WorkflowIdempotencyClaim extends WorkflowIdempotencyScope {
  fingerprint: string;
}

export interface AcceptedWorkflowOperation {
  fingerprint: string;
  status: number;
  /** The original response body; null once the workflow it names was deleted. */
  body: unknown;
  resourceDeletedAt: string | null;
}

/**
 * The key was accepted for another request while this one was getting ready.
 * Thrown inside the accepting transaction, so this request commits nothing;
 * the caller looks the record up again and answers from it.
 */
export class IdempotencyKeyTakenError extends Error {
  constructor() {
    super("Idempotency-Key was accepted by a concurrent request");
    this.name = "IdempotencyKeyTakenError";
  }
}

type AcceptedRow = {
  requestFingerprint: string;
  responseStatus: number;
  responseBody: string | null;
  resourceDeletedAt: string | null;
};

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  // Code-unit order, not localeCompare: the fingerprint must not depend on the
  // server's locale.
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

/**
 * Fingerprint of an accepted request body. Object key order does not matter,
 * array order does, and every value counts as sent (nothing is redacted first,
 * so two requests that differ only in a secret never match). Only the hash is
 * stored.
 */
export function workflowRequestFingerprint(
  operation: WorkflowIdempotencyOperation,
  body: unknown,
): string {
  return sha256(`${operation}\n${JSON.stringify(sortKeys(body ?? null))}`);
}

const SCOPE_WHERE = "principal = ? AND operation = ? AND targetId = ? AND keyHash = ?";

function scopeParams(scope: WorkflowIdempotencyScope): string[] {
  return [scope.principal, scope.operation, scope.targetId, sha256(scope.key)];
}

export async function findAcceptedWorkflowOperation(
  scope: WorkflowIdempotencyScope,
): Promise<AcceptedWorkflowOperation | null> {
  const row = await getDbClient().get<AcceptedRow>(
    `SELECT requestFingerprint, responseStatus, responseBody, resourceDeletedAt
       FROM workflow_idempotency_keys WHERE ${SCOPE_WHERE}`,
    scopeParams(scope),
  );
  if (!row) return null;
  return {
    fingerprint: row.requestFingerprint,
    status: row.responseStatus,
    body: row.responseBody === null ? null : openSealedJson(row.responseBody),
    resourceDeletedAt: row.resourceDeletedAt,
  };
}

/**
 * Throw `IdempotencyKeyTakenError` when the scope already has a record. Inside
 * the accepting transaction, call it before writing a resource whose insert
 * could collide with the concurrent winner's (a unique workflow name), so the
 * loser replays instead of failing on that constraint.
 */
export async function assertWorkflowIdempotencyKeyUnused(
  scope: WorkflowIdempotencyScope,
): Promise<void> {
  const taken = await getDbClient().get(
    `SELECT 1 FROM workflow_idempotency_keys WHERE ${SCOPE_WHERE}`,
    scopeParams(scope),
  );
  if (taken) throw new IdempotencyKeyTakenError();
}

/**
 * Record the accepted operation. Call it inside the transaction that creates
 * the resource: a rollback drops both. Throws `IdempotencyKeyTakenError` when
 * the scope already has a record (a concurrent request committed first); the
 * unique index backs this across processes.
 */
export async function recordAcceptedWorkflowOperation(
  claim: WorkflowIdempotencyClaim,
  accepted: { workflowId: string; runId?: string; status: number; body: unknown },
): Promise<void> {
  await assertWorkflowIdempotencyKeyUnused(claim);
  const actor = getCurrentRequestUserId() ?? null;
  try {
    await getDbClient().run(
      `INSERT INTO workflow_idempotency_keys
         (id, principal, operation, targetId, keyHash, requestFingerprint, workflowId, runId,
          responseStatus, responseBody, createdAt, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        ...scopeParams(claim),
        claim.fingerprint,
        accepted.workflowId,
        accepted.runId ?? null,
        accepted.status,
        sealJson(accepted.body),
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

/**
 * Turn every record naming `workflowId` into a tombstone: the stored response
 * (which may carry the deleted workflow's definition) is cleared and the key
 * stays taken, so a retry is told the resource is gone instead of creating or
 * triggering anything again. Runs in the delete's transaction.
 */
export async function tombstoneWorkflowIdempotencyKeys(workflowId: string): Promise<void> {
  await getDbClient().run(
    `UPDATE workflow_idempotency_keys
        SET responseBody = NULL, resourceDeletedAt = ?, updated_by = ?
      WHERE workflowId = ? AND resourceDeletedAt IS NULL`,
    [new Date().toISOString(), getCurrentRequestUserId() ?? null, workflowId],
  );
}

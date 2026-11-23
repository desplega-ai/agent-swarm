import { OWNER_FENCE_KEY, PROCESS_LOCK_KEY } from "./boot";

export { OWNER_FENCE_KEY };

/**
 * The write fence of the one-process lock (decision D16).
 *
 * The owner holds `PROCESS_LOCK_KEY` on its lock session. Each read-write
 * transaction first takes `OWNER_FENCE_KEY` in shared mode for the rest of the
 * transaction, then checks that the lock session of its own process still holds
 * `PROCESS_LOCK_KEY`. A new owner takes `OWNER_FENCE_KEY` exclusively once,
 * right after it gets `PROCESS_LOCK_KEY` and before its first write: that waits
 * for every transaction the old owner started before the takeover. A
 * transaction the old owner starts after the takeover fails the check. So no
 * write of the old owner commits after the new owner starts writing.
 */
export type OwnerFence = {
  /** Backend pid of the lock session that holds `PROCESS_LOCK_KEY` for this process. */
  ownerPid: number;
};

/** Thrown in a write transaction of a process that no longer owns the database. */
export class OwnershipLostError extends Error {
  constructor() {
    super(
      "[storage] this API process no longer holds the one-process lock of the Postgres database: " +
        "another process owns it now, so this write was refused",
    );
    this.name = "OwnershipLostError";
  }
}

type Unsafe = { unsafe(text: string, params?: unknown[]): Promise<Record<string, unknown>[]> };

/** Run at the start of a read-write transaction, on its connection. Two statements, in this order. */
export async function checkOwnerFence(handle: Unsafe, fence: OwnerFence): Promise<void> {
  await handle.unsafe("SELECT pg_advisory_xact_lock_shared($1)", [OWNER_FENCE_KEY]);
  const rows = await handle.unsafe(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND pid = $1 AND granted AND objsubid = 1
          AND ((classid::bigint << 32) | objid::bigint) = $2) AS owned`,
    [fence.ownerPid, PROCESS_LOCK_KEY],
  );
  if (rows[0]?.owned !== true) throw new OwnershipLostError();
}

/** A statement outside a transaction that may write: it runs in a fenced transaction. */
export function mayWrite(text: string): boolean {
  if (!/^\s*(SELECT|WITH|SHOW|EXPLAIN|VALUES|TABLE)\b/i.test(text)) return true;
  return /\b(INSERT|UPDATE|DELETE|MERGE|nextval|setval)\b/i.test(text);
}

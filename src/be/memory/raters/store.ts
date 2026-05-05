import { getDb } from "@/be/db";
import type { RatingEvent } from "./types";

/**
 * Single chokepoint for posterior updates and audit-log writes.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-1.md §3
 *
 * For every event in `events`:
 *   - alphaDelta = max(0,  signal) * weight   (rewards usefulness)
 *   - betaDelta  = max(0, -signal) * weight   (rewards anti-usefulness)
 *   - UPDATE agent_memory SET alpha = alpha + ?, beta = beta + ? WHERE id = ?
 *   - INSERT INTO memory_rating (...) VALUES (...)
 *
 * The whole batch runs in a single transaction so partial failure rolls back
 * (commutativity of the Beta update means no idempotency check is needed —
 * duplicate batches just shift the posterior further; the partial unique index
 * on `(taskId, memoryId) WHERE source='explicit-self'` is the spam guard).
 *
 * Rejection semantics — events that fail validation are RETURNED in `rejected`,
 * not thrown. This lets HTTP/MCP layers surface partial success cleanly.
 */
export type ApplyRatingResult = {
  applied: number;
  rejected: { event: RatingEvent; reason: string }[];
};

export type ApplyRatingContext = {
  taskId?: string;
};

export class ExplicitSelfDuplicateError extends Error {
  constructor(
    message: string,
    public readonly event: RatingEvent,
  ) {
    super(message);
    this.name = "ExplicitSelfDuplicateError";
  }
}

export function applyRating(
  events: RatingEvent[],
  ctx: ApplyRatingContext = {},
): ApplyRatingResult {
  if (events.length === 0) {
    return { applied: 0, rejected: [] };
  }

  const db = getDb();
  const accepted: RatingEvent[] = [];
  const rejected: ApplyRatingResult["rejected"] = [];

  for (const event of events) {
    const reason = validate(event);
    if (reason) {
      rejected.push({ event, reason });
      continue;
    }
    accepted.push(event);
  }

  if (accepted.length === 0) {
    return { applied: 0, rejected };
  }

  // One transaction for the whole batch. SQLite WAL handles concurrent
  // writers — Beta updates are commutative, so racing applies converge.
  const updateMemory = db.prepare(
    "UPDATE agent_memory SET alpha = alpha + ?, beta = beta + ? WHERE id = ?",
  );
  const checkExists = db.prepare<{ id: string }, [string]>(
    "SELECT id FROM agent_memory WHERE id = ?",
  );
  const insertRating = db.prepare(
    `INSERT INTO memory_rating
       (id, memoryId, taskId, source, signal, weight, reasoning, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const applyTx = db.transaction(() => {
    let applied = 0;
    const lateRejects: ApplyRatingResult["rejected"] = [];
    for (const event of accepted) {
      const exists = checkExists.get(event.memoryId);
      if (!exists) {
        lateRejects.push({ event, reason: "memoryId not found in agent_memory" });
        continue;
      }
      const alphaDelta = Math.max(0, event.signal) * event.weight;
      const betaDelta = Math.max(0, -event.signal) * event.weight;
      updateMemory.run(alphaDelta, betaDelta, event.memoryId);
      try {
        insertRating.run(
          crypto.randomUUID(),
          event.memoryId,
          ctx.taskId ?? null,
          event.source,
          event.signal,
          event.weight,
          event.reasoning ?? null,
          new Date().toISOString(),
        );
      } catch (err) {
        // Partial unique index on (taskId, memoryId) WHERE source='explicit-self'
        // is the only constraint that can fire here.
        if (isUniqueConstraintError(err)) {
          throw new ExplicitSelfDuplicateError(
            `duplicate explicit-self rating for memoryId=${event.memoryId} taskId=${ctx.taskId}`,
            event,
          );
        }
        throw err;
      }
      applied += 1;
    }
    return { applied, lateRejects };
  });

  const { applied, lateRejects } = applyTx();
  return { applied, rejected: [...rejected, ...lateRejects] };
}

function validate(event: RatingEvent): string | null {
  if (!event.source || event.source.trim() === "") {
    return "source is required";
  }
  if (!Number.isFinite(event.signal) || event.signal < -1 || event.signal > 1) {
    return "signal must be in [-1, +1]";
  }
  if (!Number.isFinite(event.weight) || event.weight < 0 || event.weight > 1) {
    return "weight must be in [0, 1]";
  }
  if (!event.memoryId) {
    return "memoryId is required";
  }
  return null;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // bun:sqlite surfaces SQLITE_CONSTRAINT_UNIQUE in the message.
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(err.message);
}

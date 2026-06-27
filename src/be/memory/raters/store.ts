import { ensure } from "@desplega.ai/business-use";
import { getDb } from "@/be/db";
import { type RatingEvent, REFERENCES_SOURCE_MAX_LENGTH, sanitizeReferencesSource } from "./types";

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
 *   - When `referencesSource` is present (step-6 §3): UPSERT into
 *     agent_memory_edge with the SAME (alphaDelta, betaDelta) so the edge's
 *     own posterior tracks evidence the same way the memory's does.
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
  contextKey?: string;
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
  const accepted: { event: RatingEvent; sanitizedReferencesSource: string | null }[] = [];
  const rejected: ApplyRatingResult["rejected"] = [];

  for (const event of events) {
    const reason = validate(event);
    if (reason) {
      rejected.push({ event, reason });
      continue;
    }
    let sanitizedReferencesSource: string | null = null;
    if (event.referencesSource !== undefined) {
      if (event.referencesSource.length === 0) {
        rejected.push({ event, reason: "referencesSource must be non-empty" });
        continue;
      }
      if (event.referencesSource.length > REFERENCES_SOURCE_MAX_LENGTH) {
        rejected.push({
          event,
          reason: `referencesSource exceeds ${REFERENCES_SOURCE_MAX_LENGTH} chars`,
        });
        continue;
      }
      sanitizedReferencesSource = sanitizeReferencesSource(event.referencesSource);
      if (sanitizedReferencesSource === null) {
        rejected.push({
          event,
          reason: "referencesSource contains a NUL byte or strips to empty",
        });
        continue;
      }
    }
    accepted.push({ event, sanitizedReferencesSource });
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
       (id, memoryId, taskId, source, signal, weight, reasoning, createdAt, contextKey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Step-6 §3 — UPSERT the edge with the SAME deltas as the memory row.
  // The `- 1.0` corrections in DO UPDATE undo the default-prior offset that
  // the INSERT arm baked into excluded.alpha/excluded.beta. Net effect: on
  // insert, alpha/beta start at `1 + delta`; on update, the existing
  // (alpha, beta) simply gain (delta_alpha, delta_beta).
  const upsertEdge = db.prepare(
    `INSERT INTO agent_memory_edge (from_id, to_id, type, alpha, beta, createdAt)
     VALUES (?, ?, 'references-source', ?, ?, ?)
     ON CONFLICT(from_id, to_id, type) DO UPDATE SET
       alpha = alpha + excluded.alpha - 1.0,
       beta  = beta  + excluded.beta  - 1.0`,
  );

  type AppliedEntry = { event: RatingEvent; sanitizedReferencesSource: string | null };

  const applyTx = db.transaction(() => {
    let applied = 0;
    const lateRejects: ApplyRatingResult["rejected"] = [];
    const appliedEvents: AppliedEntry[] = [];
    for (const { event, sanitizedReferencesSource } of accepted) {
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
          ctx.contextKey ?? null,
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
      if (sanitizedReferencesSource !== null) {
        upsertEdge.run(
          event.memoryId,
          sanitizedReferencesSource,
          1.0 + alphaDelta,
          1.0 + betaDelta,
          new Date().toISOString(),
        );
      }
      appliedEvents.push({ event, sanitizedReferencesSource });
      applied += 1;
    }
    return { applied, lateRejects, appliedEvents };
  });

  const { applied, lateRejects, appliedEvents } = applyTx();

  // Business-use instrumentation — emit ONE `memory_rated` event in the `task`
  // flow per applied rating. Placed OUTSIDE the transaction (per CLAUDE.md BU
  // block), validator self-contained (references only `data`). Skipped when
  // `ctx.taskId` is absent because the `task` flow is keyed on taskId.
  if (ctx.taskId && appliedEvents.length > 0) {
    for (const { event, sanitizedReferencesSource } of appliedEvents) {
      ensure({
        id: "memory_rated",
        flow: "task",
        runId: ctx.taskId,
        data: {
          memoryId: event.memoryId,
          source: event.source,
          signal: event.signal,
          weight: event.weight,
          hasReferencesSource: sanitizedReferencesSource !== null,
        },
        validator: (data) =>
          typeof data.memoryId === "string" &&
          data.memoryId.length > 0 &&
          typeof data.source === "string" &&
          data.source.length > 0 &&
          typeof data.signal === "number" &&
          data.signal >= -1 &&
          data.signal <= 1 &&
          typeof data.weight === "number" &&
          data.weight >= 0 &&
          data.weight <= 1,
      });
    }
  }

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

import { ensure } from "@desplega.ai/business-use";
import { getDb } from "@/be/db";

/**
 * Retrieval-bridge helper — appends `memory_retrieval` audit rows so
 * server-side raters (currently `ImplicitCitationRater`) can correlate the
 * memories surfaced to a task with the evidence emitted during that task.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §1, §3
 *
 * Both call sites — `POST /api/memory/search` (HTTP) and the in-process
 * `memory-search` MCP tool — call this helper post-rerank when a
 * `X-Source-Task-ID` header is present. When `taskId` is absent or the
 * results array is empty, the function is a no-op so the existing search
 * paths stay byte-identical to today.
 *
 * Best-effort by design: a retrieval-bridge failure must NOT poison search.
 * Callers wrap this in their own try/catch and return search results either
 * way (see `src/http/memory.ts` and `src/tools/memory-search.ts`).
 */

export type RetrievalRecord = {
  memoryId: string;
  similarity: number;
};

export function recordRetrievals(
  taskId: string | undefined,
  agentId: string,
  results: RetrievalRecord[],
  sessionId?: string,
): void {
  if (!taskId || results.length === 0) return;

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO memory_retrieval
       (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();

  // Single transaction: even on a 100-row paginated search this is one
  // commit, not N. No-op when results is empty.
  db.transaction(() => {
    for (const r of results) {
      insert.run(
        crypto.randomUUID(),
        taskId,
        agentId,
        sessionId ?? null,
        r.memoryId,
        r.similarity,
        now,
      );
    }
  })();

  // Business-use instrumentation — one `memory_retrieved` event per call,
  // OUTSIDE the transaction. Validator self-contained.
  ensure({
    id: "memory_retrieved",
    flow: "task",
    runId: taskId,
    data: {
      count: results.length,
      taskId,
      agentId,
    },
    validator: (data) =>
      typeof data.count === "number" &&
      data.count > 0 &&
      typeof data.taskId === "string" &&
      data.taskId.length > 0 &&
      typeof data.agentId === "string" &&
      data.agentId.length > 0,
  });
}

export function getRetrievalsForTask(
  taskId: string,
): { memoryId: string; similarity: number | null }[] {
  return getDb()
    .prepare<{ memoryId: string; similarity: number | null }, [string]>(
      "SELECT memoryId, similarity FROM memory_retrieval WHERE taskId = ?",
    )
    .all(taskId);
}

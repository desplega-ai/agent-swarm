import { ensure } from "@desplega.ai/business-use";
import { getDbClient } from "@/be/db";
import type { MemoryRetrievalSource } from "@/be/memory/types";
import type { AgentMemory } from "@/types";

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
  retrievalSource?: MemoryRetrievalSource;
};

export type RetrievalExtras = {
  intent?: string;
  contextKey?: string;
  eventType?: "search" | "get";
};

type MemoryDocumentRef = Pick<AgentMemory, "id" | "agentId" | "scope" | "sourcePath" | "key">;

/**
 * Select one search-result row per logical memory document.
 *
 * Memory content is stored one row per chunk. The document identity is scoped
 * by owner and visibility because two agents owning the same-named memory are
 * separate documents.
 */
export function dedupeMemoryDocumentIds(memories: MemoryDocumentRef[]): string[] {
  const documents = new Map<string, string>();

  for (const memory of memories) {
    const identity = memory.sourcePath ?? memory.key;
    if (identity == null) continue;

    const documentKey = JSON.stringify([memory.agentId, memory.scope, identity]);
    if (!documents.has(documentKey)) documents.set(documentKey, memory.id);
  }

  return [...documents.values()];
}

/** Count memory rows returned by agent recall as consumed. */
export async function recordMemoryAccesses(memoryIds: string[]): Promise<void> {
  const ids = [...new Set(memoryIds)].filter(Boolean);
  if (ids.length === 0) return;

  const now = new Date().toISOString();
  await getDbClient().transaction(async (tx) => {
    for (const id of ids) {
      await tx.run(
        "UPDATE agent_memory SET accessedAt = ?, accessCount = accessCount + 1 WHERE id = ?",
        [now, id],
      );
    }
  });
}

export async function recordRetrievals(
  taskId: string | undefined,
  agentId: string,
  results: RetrievalRecord[],
  sessionId?: string,
  extras?: RetrievalExtras,
): Promise<void> {
  if (!taskId || results.length === 0) return;

  const insertSql = `INSERT INTO memory_retrieval
       (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt, contextKey, intent, eventType, retrievalId, rank, retrievalSource)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const now = new Date().toISOString();
  const retrievalId = crypto.randomUUID();
  const contextKey = extras?.contextKey ?? null;
  const intent = extras?.intent ?? null;
  const eventType = extras?.eventType ?? "search";

  await getDbClient().transaction(async (tx) => {
    for (const [rank, r] of results.entries()) {
      await tx.run(insertSql, [
        crypto.randomUUID(),
        taskId,
        agentId,
        sessionId ?? null,
        r.memoryId,
        r.similarity,
        now,
        contextKey,
        intent,
        eventType,
        retrievalId,
        rank,
        r.retrievalSource ?? null,
      ]);
    }
  });

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

export async function getRetrievalsForTask(
  taskId: string,
): Promise<{ memoryId: string; similarity: number | null }[]> {
  return getDbClient().query<{ memoryId: string; similarity: number | null }>(
    "SELECT memoryId, similarity FROM memory_retrieval WHERE taskId = ?",
    [taskId],
  );
}

/**
 * Read-side query helpers for the `agent_memory_edge` table.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-6.md §7
 *
 * The write path lives in `src/be/memory/raters/store.ts` (`applyRating`
 * UPSERTs the edge atomically with the memory's posterior update). This
 * module surfaces reads to the GET `/api/memory/edges` endpoint that powers
 * the homepage demo ("this memory references PR #377").
 *
 * Server-side only.
 */
import { getDb } from "@/be/db";

const USEFULNESS_FLOOR = 1.0;
const USEFULNESS_CEILING = 2.0;

export type MemoryEdgeRow = {
  to: string;
  type: "references-source";
  alpha: number;
  beta: number;
  /** clamp(2 * α/(α+β), 1.0, 2.0) — same formula as the memory reranker. */
  usefulness: number;
  createdAt: string;
};

/**
 * List edges for a memory, with defence-in-depth: the joined `agent_memory`
 * row must either be swarm-scope or owned by the requesting agent. Returns
 * `[]` when the memory does not exist or is not visible to the agent — same
 * shape as a memory with no edges, since neither case has anything useful
 * to surface to the caller.
 */
export function listEdgesForAgent(agentId: string, memoryId: string): MemoryEdgeRow[] {
  const db = getDb();
  const memory = db
    .prepare<{ scope: string; agentId: string | null }, [string]>(
      "SELECT scope, agentId FROM agent_memory WHERE id = ?",
    )
    .get(memoryId);
  if (!memory) return [];
  if (memory.scope !== "swarm" && memory.agentId !== agentId) return [];

  const rows = db
    .prepare<{ to_id: string; alpha: number; beta: number; createdAt: string }, [string]>(
      `SELECT to_id, alpha, beta, createdAt
         FROM agent_memory_edge
        WHERE from_id = ? AND type = 'references-source'
        ORDER BY createdAt DESC`,
    )
    .all(memoryId);

  return rows.map((row) => ({
    to: row.to_id,
    type: "references-source" as const,
    alpha: row.alpha,
    beta: row.beta,
    usefulness: clampUsefulness(row.alpha, row.beta),
    createdAt: row.createdAt,
  }));
}

function clampUsefulness(alpha: number, beta: number): number {
  const denom = alpha + beta;
  if (denom <= 0) return USEFULNESS_FLOOR;
  const mean = alpha / denom;
  return Math.max(USEFULNESS_FLOOR, Math.min(USEFULNESS_CEILING, 2 * mean));
}

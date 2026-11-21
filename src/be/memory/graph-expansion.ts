/**
 * Graph candidate expansion (DES-639a) — the first READER of `memory_link`.
 *
 * Expands a search candidate set with 1-hop outgoing `memory_link` neighbors
 * (`targetKind='memory'` rows whose targetId resolves to a real, non-expired
 * memory), so a memory linked from a strong hit can surface in results it
 * would never reach by similarity alone.
 *
 * Runs at the seam between `store.search()` and `rerank()` at both call sites
 * (`POST /api/memory/search` and the `memory-search` MCP tool), so:
 * - all four retrieval arms (vec/fts/hybrid/fallback) get expansion,
 * - `rerank()` stays pure (no DB access),
 * - `recordRetrievals` downstream picks up `retrievalSource: "graph"` for free.
 *
 * Enabled by default; set `MEMORY_GRAPH_EXPANSION=0|false` to disable it.
 * With the flag off the input array is returned unchanged (same reference),
 * keeping results byte-identical to the vector/hybrid candidate set.
 *
 * Plan: thoughts/taras/plans/2026-07-02-memory-retrieval-v2-graph-and-measurement.md Phase 4
 */
import type { MemoryGraphNeighborRow } from "@desplega/storage";
import { getStorage } from "@/be/storage";
import type { AgentMemorySource } from "@/types";
import { isGraphExpansionEnabled } from "./constants";
import { rowToCandidate } from "./providers/storage-store";
import { computeScore } from "./reranker";
import type { MemoryCandidate } from "./types";

export interface GraphExpansionOptions {
  /** Max NEW candidates added (replacing an existing candidate doesn't count). Default 5. */
  cap?: number;
  /** Per-hop score damping: neighborSim = parentSim × link.strength × damping. Default 0.7. */
  damping?: number;
  /** Scope the search ran with — neighbor visibility mirrors the search ACL. Default "all". */
  scope?: "agent" | "swarm" | "all";
  /** Source filter the search ran with — expansion must not add off-filter rows. */
  source?: AgentMemorySource;
  /** Key prefix the search ran with — expansion must not add off-prefix rows. */
  keyPrefix?: string;
  isLead?: boolean;
}

type NeighborRow = MemoryGraphNeighborRow;

export async function expandCandidatesWithGraph(
  candidates: MemoryCandidate[],
  agentId: string,
  options: GraphExpansionOptions = {},
): Promise<MemoryCandidate[]> {
  if (!isGraphExpansionEnabled()) return candidates;
  const { cap = 5, damping = 0.7, scope = "all", source, keyPrefix, isLead = false } = options;
  if (candidates.length === 0 || cap <= 0) return candidates;

  const parentById = new Map(candidates.map((c) => [c.id, c]));
  const parentIds = [...parentById.keys()];

  // Outgoing memory→memory links whose targetId JOINs to a live agent_memory
  // row. Unresolved wikilinks keep the raw `[[Name]]` text as targetId
  // (link-resolver.ts) and therefore never match an id — the JOIN skips them.
  // Visibility mirrors the search ACL; the key prefix is literal.
  let rows: NeighborRow[];
  try {
    rows = await getStorage().repos.memory.listGraphNeighbors(parentIds, {
      agentId,
      scope,
      isLead,
      source,
      keyPrefix,
    });
  } catch (err) {
    // Best-effort: a graph-expansion failure must never poison search.
    console.warn("[memory-graph] expansion query failed:", (err as Error).message);
    return candidates;
  }
  if (rows.length === 0) return candidates;

  // Best derived score per neighbor (a neighbor may be linked from several parents).
  const neighbors = new Map<string, MemoryCandidate>();
  for (const row of rows) {
    const parent = parentById.get(row.fromMemoryId);
    if (!parent) continue;
    const strength = typeof row.linkStrength === "number" ? row.linkStrength : 1.0;
    // Derive from the parent's pre-decay match score on the shared [0,1]
    // scale (vec cosine, hybrid fused cosine, fts rank). The fts arm ships
    // `similarity` with the parent's recency decay already applied, and
    // rerank() will apply the NEIGHBOR's own decay to this candidate. Using
    // the decayed value would stack two decay factors on one score.
    const parentBase = parent.rawSimilarity ?? parent.similarity;
    const similarity = parentBase * strength * damping;
    const existing = neighbors.get(row.id);
    if (existing && existing.similarity >= similarity) continue;
    neighbors.set(row.id, {
      ...rowToCandidate(row, similarity),
      retrievalSource: "graph",
      graphParentId: parent.id,
      // The neighbor's own decay is applied exactly once by rerank().
      recencyDecayApplied: false,
    });
  }
  if (neighbors.size === 0) return candidates;

  const result = [...candidates];
  const indexById = new Map(result.map((c, i) => [c.id, i] as const));
  let added = 0;
  // Rank and compare via the reranker's composite score (recency decay,
  // source quality, access, usefulness), NOT the raw similarity: cap selection
  // by raw score would let stale low-value links crowd out neighbors the
  // reranker would place higher, and organic fts/hybrid duplicates carry an
  // already-decayed similarity that a raw comparison would mis-rank against
  // the graph entry's deliberately pre-decay score.
  const now = new Date();
  const ranked = [...neighbors.values()].sort(
    (a, b) => computeScore(b, now) - computeScore(a, now),
  );
  for (const neighbor of ranked) {
    const existingIndex = indexById.get(neighbor.id);
    if (existingIndex !== undefined) {
      // Dedupe against organic candidates: keep whichever entry the reranker
      // will score higher (same memory, so all non-similarity factors match).
      // rerank() caps a graph entry at its parent's composite, so compare the
      // capped graph score; otherwise a low-quality parent's link replaces a
      // stronger organic match and rerank() then demotes it below the parent.
      const parent = parentById.get(neighbor.graphParentId!)!;
      const graphScore = Math.min(computeScore(neighbor, now), computeScore(parent, now));
      if (graphScore > computeScore(result[existingIndex]!, now)) {
        result[existingIndex] = neighbor;
      }
      continue;
    }
    if (added >= cap) continue;
    result.push(neighbor);
    added += 1;
  }
  return result;
}

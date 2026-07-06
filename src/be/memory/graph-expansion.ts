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
 * Flag-gated: `MEMORY_GRAPH_EXPANSION=1|true` (default off — same rollout
 * pattern as MEMORY_HYBRID_SEARCH). With the flag off the input array is
 * returned unchanged (same reference), keeping results byte-identical.
 *
 * Plan: thoughts/taras/plans/2026-07-02-memory-retrieval-v2-graph-and-measurement.md Phase 4
 */
import { getDb } from "@/be/db";
import type { AgentMemorySource } from "@/types";
import { isGraphExpansionEnabled } from "./constants";
import { type AgentMemoryRow, rowToCandidate } from "./providers/sqlite-store";
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
  isLead?: boolean;
}

type NeighborRow = AgentMemoryRow & { fromMemoryId: string; linkStrength: number | null };

/**
 * Mirrors `SqliteMemoryStore.addScopeConditions` (private) for the `m` alias:
 * non-lead callers see own-agent rows + swarm-scoped rows; leads see all.
 */
function addNeighborScopeConditions(
  conditions: string[],
  params: (string | number)[],
  agentId: string,
  scope: "agent" | "swarm" | "all",
  isLead: boolean,
): void {
  if (!isLead) {
    if (scope === "agent") {
      conditions.push("m.agentId = ? AND m.scope = 'agent'");
      params.push(agentId);
    } else if (scope === "swarm") {
      conditions.push("m.scope = 'swarm'");
    } else {
      conditions.push("(m.agentId = ? OR m.scope = 'swarm')");
      params.push(agentId);
    }
  } else {
    if (scope === "agent") {
      conditions.push("m.scope = 'agent'");
    } else if (scope === "swarm") {
      conditions.push("m.scope = 'swarm'");
    }
  }
}

export function expandCandidatesWithGraph(
  candidates: MemoryCandidate[],
  agentId: string,
  options: GraphExpansionOptions = {},
): MemoryCandidate[] {
  if (!isGraphExpansionEnabled()) return candidates;
  const { cap = 5, damping = 0.7, scope = "all", source, isLead = false } = options;
  if (candidates.length === 0 || cap <= 0) return candidates;

  const parentById = new Map(candidates.map((c) => [c.id, c]));
  const parentIds = [...parentById.keys()];

  // Outgoing memory→memory links whose targetId JOINs to a live agent_memory
  // row. Unresolved wikilinks keep the raw `[[Name]]` text as targetId
  // (link-resolver.ts) and therefore never match an id — the JOIN skips them.
  const conditions: string[] = [
    `ml.from_memory_id IN (${parentIds.map(() => "?").join(", ")})`,
    "ml.targetKind = 'memory'",
    "(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))",
  ];
  const params: (string | number)[] = [...parentIds];
  addNeighborScopeConditions(conditions, params, agentId, scope, isLead);
  if (source) {
    conditions.push("m.source = ?");
    params.push(source);
  }

  let rows: NeighborRow[];
  try {
    rows = getDb()
      .prepare<NeighborRow, (string | number)[]>(
        `SELECT m.*, ml.from_memory_id AS fromMemoryId, ml.strength AS linkStrength
         FROM memory_link ml
         JOIN agent_memory m ON m.id = ml.targetId
         WHERE ${conditions.join(" AND ")}`,
      )
      .all(...params);
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
    // Derive from the parent's RAW (pre-decay) similarity — fts/hybrid arms
    // ship `similarity` with the parent's recency decay already applied, and
    // rerank() will apply the NEIGHBOR's own decay to this candidate. Using
    // the decayed value would stack two decay factors on one score.
    const parentBase = parent.rawSimilarity ?? parent.similarity;
    const similarity = parentBase * strength * damping;
    const existing = neighbors.get(row.id);
    if (existing && existing.similarity >= similarity) continue;
    neighbors.set(row.id, {
      ...rowToCandidate(row, similarity),
      retrievalSource: "graph",
      // The neighbor's own decay is applied exactly once by rerank().
      recencyDecayApplied: false,
    });
  }
  if (neighbors.size === 0) return candidates;

  const result = [...candidates];
  const indexById = new Map(result.map((c, i) => [c.id, i] as const));
  let added = 0;
  const ranked = [...neighbors.values()].sort((a, b) => b.similarity - a.similarity);
  for (const neighbor of ranked) {
    const existingIndex = indexById.get(neighbor.id);
    if (existingIndex !== undefined) {
      // Dedupe against organic candidates: keep the higher-scored entry.
      if (neighbor.similarity > result[existingIndex]!.similarity) {
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

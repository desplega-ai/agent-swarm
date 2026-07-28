import type { AgentMemorySource } from "@/types";

function numEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = Number(val);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// TTL defaults (in days) — null means no expiry
export const TTL_DEFAULTS: Record<AgentMemorySource, number | null> = {
  task_completion: 7,
  session_summary: 3,
  file_index: 30,
  manual: null,
};

// Per-source recency decay half-life (in days).
// manual = Infinity (no decay — curated knowledge stays relevant forever).
// A global MEMORY_RECENCY_HALF_LIFE_DAYS override forces ALL sources to the
// same value.
//
// Read DYNAMICALLY, not captured at module load: memory modules are imported
// by `src/http/index.ts` before `loadGlobalConfigsIntoEnv()` hydrates
// swarm_config into `process.env`, so a module-level capture would leave a
// dashboard-saved override permanently inert (even across restarts). Same
// reasoning for `minSimilarity()` / `accessBoostMaxMultiplier()` below.
const DEFAULT_RECENCY_DECAY_HALF_LIFE: Record<AgentMemorySource, number> = {
  manual: Number.POSITIVE_INFINITY,
  file_index: 180,
  task_completion: 14,
  session_summary: 7,
};

// Callers that don't have a source fall back to task_completion's value.
export function recencyDecayHalfLifeDays(source: AgentMemorySource = "task_completion"): number {
  const raw = process.env.MEMORY_RECENCY_HALF_LIFE_DAYS;
  if (raw != null && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_RECENCY_DECAY_HALF_LIFE[source];
}

// Source-quality multiplier for reranking.
// Curated manual memories rank higher; ephemeral session summaries rank lower.
export const SOURCE_QUALITY_MULTIPLIER: Record<AgentMemorySource, number> = {
  manual: 1.5,
  file_index: 1.0,
  task_completion: 0.7,
  session_summary: 0.5,
};

// Minimum raw cosine similarity to keep a candidate. Below this, the result is noise.
export function minSimilarity(): number {
  return numEnv("MEMORY_MIN_SIMILARITY", 0.1);
}

// Reranking parameters
export function accessBoostMaxMultiplier(): number {
  return numEnv("MEMORY_ACCESS_BOOST_MAX", 1.5);
}
export const ACCESS_BOOST_RECENCY_WINDOW_HOURS = numEnv("MEMORY_ACCESS_RECENCY_HOURS", 48);
export const CANDIDATE_SET_MULTIPLIER = numEnv("MEMORY_CANDIDATE_MULTIPLIER", 3);

// Feature flag: enable hybrid (FTS+vec) search. On by default; set
// MEMORY_HYBRID_SEARCH=0|false to fall back to vector-only search.
export function isHybridSearchEnabled(): boolean {
  const val = process.env.MEMORY_HYBRID_SEARCH?.trim().toLowerCase();
  return val !== "0" && val !== "false";
}

// Feature flag: expand search candidates with 1-hop memory_link graph neighbors
// (DES-639a). On by default; set MEMORY_GRAPH_EXPANSION=0|false to disable.
export function isGraphExpansionEnabled(): boolean {
  const val = process.env.MEMORY_GRAPH_EXPANSION?.trim().toLowerCase();
  return val !== "0" && val !== "false";
}

// Embedding defaults
export const EMBEDDING_DIMENSIONS = numEnv("EMBEDDING_DIMENSIONS", 512);
export const DEFAULT_EMBEDDING_DIMENSIONS = EMBEDDING_DIMENSIONS;
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

// Manual memories must NEVER be deleted by automated processes (curator, GC, etc.)
export const PROTECTED_SOURCES: ReadonlySet<AgentMemorySource> = new Set(["manual"]);

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

// Reranking parameters
export const RECENCY_DECAY_HALF_LIFE_DAYS = numEnv("MEMORY_RECENCY_HALF_LIFE_DAYS", 14);
export const ACCESS_BOOST_MAX_MULTIPLIER = numEnv("MEMORY_ACCESS_BOOST_MAX", 1.5);
export const ACCESS_BOOST_RECENCY_WINDOW_HOURS = numEnv("MEMORY_ACCESS_RECENCY_HOURS", 48);
export const CANDIDATE_SET_MULTIPLIER = numEnv("MEMORY_CANDIDATE_MULTIPLIER", 3);

// Embedding defaults
export const DEFAULT_EMBEDDING_DIMENSIONS = 512;
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

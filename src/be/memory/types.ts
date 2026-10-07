import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";

// ============================================================================
// EmbeddingProvider — text to vector, swappable
// ============================================================================

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
  /** True when the provider has a usable API key — no network call. */
  isConfigured(): boolean;
}

// ============================================================================
// MemoryStore — persist and retrieve memories, swappable
// ============================================================================

export interface MemoryStore {
  store(input: MemoryInput): Promise<AgentMemory>;
  storeBatch(inputs: MemoryInput[]): Promise<AgentMemory[]>;
  get(id: string): Promise<AgentMemory | null>;
  peek(id: string): Promise<AgentMemory | null>;
  search(
    embedding: Float32Array,
    agentId: string,
    options: MemorySearchOptions,
  ): Promise<MemoryCandidate[]>;
  edit(input: MemoryEditInput): Promise<MemoryEditResult>;
  list(agentId: string, options: MemoryListOptions): Promise<AgentMemory[]>;
  count(agentId: string, options: MemoryListOptions): Promise<number>;
  /** True when automated cleanup must skip the memory: a protected source, or any /longterm key. */
  isSourceProtected(source: AgentMemorySource, key?: string | null): boolean;
  listForCuration(
    agentId?: string,
  ): Promise<{ id: string; source: string; name: string; createdAt: string }[]>;
  listForReembedding(options?: { agentId?: string }): Promise<{ id: string; content: string }[]>;
  delete(id: string): Promise<boolean>;
  deleteBySourcePath(sourcePath: string, agentId: string): Promise<number>;
  purgeExpired(): Promise<number>;
  updateEmbedding(id: string, embedding: Float32Array, model: string): Promise<void>;
  /**
   * Redact a row in place (boot retro-sweep). Writes only if the row still
   * holds `before`; keeps FTS in sync and drops the embedding when the
   * content changed so the re-embed backfill regenerates it. Returns whether
   * the row was written.
   */
  rewriteForScrub(
    id: string,
    before: MemoryScrubFields,
    after: MemoryScrubFields,
  ): Promise<boolean>;
  getStats(agentId: string): Promise<MemoryStats>;
  getHealth(): MemoryHealth;
}

// ============================================================================
// Supporting types
// ============================================================================

/** The free-text `agent_memory` columns the boot retro-sweep redacts. */
export type MemoryScrubFields = { name: string; content: string; summary: string | null };

export interface MemoryInput {
  agentId: string | null;
  scope: AgentMemoryScope;
  name: string;
  content: string;
  summary?: string | null;
  source: AgentMemorySource;
  sourceTaskId?: string | null;
  sourcePath?: string | null;
  chunkIndex?: number;
  totalChunks?: number;
  tags?: string[];
  contextKey?: string | null;
  intent?: string | null;
  key?: string | null;
}

export interface MemoryCandidate extends AgentMemory {
  similarity: number;
  /** Raw cosine similarity before reranking (preserved for diagnostics). */
  rawSimilarity?: number;
  /** Final composite score after reranking (recency × source × usefulness × access). */
  compositeScore?: number;
  /** Search arm that surfaced the candidate. Memory `source` remains manual/file_index/etc. */
  retrievalSource?: MemoryRetrievalSource;
  /** Graph candidates only: the candidate whose link surfaced this one. rerank() never ranks it above that parent. */
  graphParentId?: string;
  /** True when `similarity` already includes source-aware recency decay. */
  recencyDecayApplied?: boolean;
  accessCount: number;
  expiresAt: string | null;
  embeddingModel: string | null;
  /** Beta-Binomial usefulness posterior. Default Beta(1,1) → reranker no-op. */
  alpha: number;
  beta: number;
}

export type MemoryRetrievalSource = "vec" | "fts" | "hybrid" | "fallback" | "graph";

export interface MemorySearchOptions {
  scope?: "agent" | "swarm" | "all";
  limit?: number;
  source?: AgentMemorySource;
  isLead?: boolean;
  includeExpired?: boolean;
  queryText?: string;
  /** Keep only memories whose `key` starts with this string. Applied inside each SQL arm, before top-K. */
  keyPrefix?: string;
}

/**
 * Memory edit modes:
 *
 * - **replace**: Overwrites the entire memory content with the new `content` field.
 *   Use when you want to rewrite the memory from scratch. Requires `content`.
 *
 * - **exact**: Performs a surgical find-and-replace within the existing content.
 *   Finds the first (and only) occurrence of `oldString` and replaces it with
 *   `newString`. Fails if `oldString` is not found or appears more than once
 *   (ambiguous). Use when you want to update a specific section without
 *   touching the rest.
 */
export type MemoryEditMode = "replace" | "exact";

export interface MemoryEditInput {
  id?: string;
  key?: string;
  scope?: AgentMemoryScope;
  agentId?: string | null;
  mode: MemoryEditMode;
  content?: string;
  oldString?: string;
  newString?: string;
  intent: string;
  expectedVersion?: number;
  changedByAgentId?: string | null;
  /**
   * Move the document to this key, on every chunk, in the same transaction.
   * Without content fields it is a pure move. Id, posteriors, access counters
   * and author are untouched.
   */
  newKey?: string;
}

export interface MemoryEditResult {
  memory: AgentMemory;
  changed: boolean;
  previousVersion: number;
  version: number;
  contentHash: string;
}

export interface MemoryListOptions {
  scope?: "agent" | "swarm" | "all";
  limit?: number;
  offset?: number;
  isLead?: boolean;
  ownerAgentId?: string;
  source?: AgentMemorySource;
  sourcePath?: string;
  /** Keep only memories whose `key` starts with this string. */
  keyPrefix?: string;
}

export interface MemoryStats {
  total: number;
  bySource: Record<string, number>;
  byScope: Record<string, number>;
  withEmbeddings: number;
  expired: number;
}

export interface MemoryHealth {
  sqliteVec: {
    extensionLoaded: boolean;
    tableExists: boolean;
    initialized: boolean;
    vectorDimensions: number;
    distanceMetric: "cosine";
    schema: string | null;
    lastPopulate: MemoryVecPopulateStats | null;
  };
  counts: {
    total: number;
    withEmbedding: number;
    validEmbedding: number;
    invalidEmbedding: number;
    searchable: number;
    memoryVec: number;
    missingFromVec: number;
    extraInVec: number;
  };
  retrievalMode: "vec" | "fallback";
  reasons: string[];
}

export interface MemoryVecPopulateStats {
  attempted: number;
  inserted: number;
  skippedInvalidDimensions: number;
  failed: number;
  beforeCount: number;
  afterCount: number;
}

export interface RerankOptions {
  limit: number;
  now?: Date;
}

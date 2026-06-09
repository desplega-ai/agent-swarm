import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";

// ============================================================================
// EmbeddingProvider — text to vector, swappable
// ============================================================================

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}

// ============================================================================
// MemoryStore — persist and retrieve memories, swappable
// ============================================================================

export interface MemoryStore {
  store(input: MemoryInput): AgentMemory;
  storeBatch(inputs: MemoryInput[]): AgentMemory[];
  get(id: string): AgentMemory | null;
  peek(id: string): AgentMemory | null;
  search(embedding: Float32Array, agentId: string, options: MemorySearchOptions): MemoryCandidate[];
  list(agentId: string, options: MemoryListOptions): AgentMemory[];
  count(agentId: string, options: MemoryListOptions): number;
  isSourceProtected(source: AgentMemorySource): boolean;
  listForCuration(
    agentId?: string,
  ): { id: string; source: string; name: string; createdAt: string }[];
  listForReembedding(options?: { agentId?: string }): { id: string; content: string }[];
  delete(id: string): boolean;
  deleteBySourcePath(sourcePath: string, agentId: string): number;
  purgeExpired(): number;
  updateEmbedding(id: string, embedding: Float32Array, model: string): void;
  getStats(agentId: string): MemoryStats;
  getHealth(): MemoryHealth;
}

// ============================================================================
// Supporting types
// ============================================================================

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
}

export interface MemoryCandidate extends AgentMemory {
  similarity: number;
  /** Raw cosine similarity before reranking (preserved for diagnostics). */
  rawSimilarity?: number;
  /** Final composite score after reranking (recency × source × usefulness × access). */
  compositeScore?: number;
  accessCount: number;
  expiresAt: string | null;
  embeddingModel: string | null;
  /** Beta-Binomial usefulness posterior. Default Beta(1,1) → reranker no-op. */
  alpha: number;
  beta: number;
}

export interface MemorySearchOptions {
  scope?: "agent" | "swarm" | "all";
  limit?: number;
  source?: AgentMemorySource;
  isLead?: boolean;
  includeExpired?: boolean;
}

export interface MemoryListOptions {
  scope?: "agent" | "swarm" | "all";
  limit?: number;
  offset?: number;
  isLead?: boolean;
  ownerAgentId?: string;
  source?: AgentMemorySource;
  sourcePath?: string;
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

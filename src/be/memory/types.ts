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
  store(input: MemoryInput): Promise<AgentMemory>;
  storeBatch(inputs: MemoryInput[]): Promise<AgentMemory[]>;
  get(id: string): Promise<AgentMemory | null>;
  peek(id: string): Promise<AgentMemory | null>;
  search(
    embedding: Float32Array,
    agentId: string,
    options: MemorySearchOptions,
  ): Promise<MemoryCandidate[]>;
  list(agentId: string, options: MemoryListOptions): Promise<AgentMemory[]>;
  listForReembedding(options?: { agentId?: string }): Promise<{ id: string; content: string }[]>;
  delete(id: string): Promise<boolean>;
  deleteBySourcePath(sourcePath: string, agentId: string): Promise<number>;
  updateEmbedding(id: string, embedding: Float32Array, model: string): Promise<void>;
  getStats(agentId: string): Promise<MemoryStats>;
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
}

export interface MemoryStats {
  total: number;
  bySource: Record<string, number>;
  byScope: Record<string, number>;
  withEmbeddings: number;
  expired: number;
}

export interface RerankOptions {
  limit: number;
  now?: Date;
}

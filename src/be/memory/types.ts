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
  listForReembedding(options?: { agentId?: string }): { id: string; content: string }[];
  delete(id: string): boolean;
  deleteBySourcePath(sourcePath: string, agentId: string): number;
  updateEmbedding(id: string, embedding: Float32Array, model: string): void;
  getStats(agentId: string): MemoryStats;
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

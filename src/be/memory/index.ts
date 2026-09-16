import type { EmbeddingProvider, MemoryStore } from "./types";

let embeddingProvider: EmbeddingProvider | null = null;
let memoryStore: MemoryStore | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!embeddingProvider) {
    const { OpenAIEmbeddingProvider } =
      require("./providers/openai-embedding") as typeof import("./providers/openai-embedding");
    embeddingProvider = new OpenAIEmbeddingProvider();
  }
  return embeddingProvider;
}

/**
 * Drop the memoized embedding provider so the next `getEmbeddingProvider()`
 * re-reads process.env. The provider captures its API key once at
 * construction (see OpenAIEmbeddingProvider), so without a reset here a key
 * set after boot (or after the first embed attempt) stays inert until the
 * process restarts. Called from the config reload path — mirrors
 * `resetFileStorageProvider` in src/fs/registry.ts.
 */
export function resetEmbeddingProvider(): void {
  embeddingProvider = null;
}

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    const { SqliteMemoryStore } =
      require("./providers/sqlite-store") as typeof import("./providers/sqlite-store");
    memoryStore = new SqliteMemoryStore();
  }
  return memoryStore;
}

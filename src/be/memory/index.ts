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

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    const { SqliteMemoryStore } =
      require("./providers/sqlite-store") as typeof import("./providers/sqlite-store");
    memoryStore = new SqliteMemoryStore();
  }
  return memoryStore;
}

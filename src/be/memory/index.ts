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
    const { StorageMemoryStore } =
      require("./providers/storage-store") as typeof import("./providers/storage-store");
    memoryStore = new StorageMemoryStore();
  }
  return memoryStore;
}

/**
 * Reads a key's deployment environment value, without stored config. Set by
 * each server entry (HTTP and stdio) at boot (http/core owns the env injection). Unset, no URL
 * counts as operator config, so every one gets the SSRF check.
 */
let readDeploymentEnv: (key: string) => string | undefined = () => undefined;

export function setDeploymentEnvReader(read: (key: string) => string | undefined): void {
  readDeploymentEnv = read;
}

/**
 * The base URL the embedding client sends to, in the SDK's precedence order,
 * and whether it is the deployment environment's own value. Null when neither
 * key is set (the SDK default, OpenAI). A provider passes the
 * EMBEDDING_API_BASE_URL value it captured (null for none), so the check covers
 * the URL its client uses even when a config reload changed the env since.
 */
export function embeddingEndpoint(
  embeddingBaseUrl: string | null = process.env.EMBEDDING_API_BASE_URL || null,
): { baseUrl: string; fromDeployment: boolean } | null {
  if (embeddingBaseUrl) {
    return {
      baseUrl: embeddingBaseUrl,
      fromDeployment: embeddingBaseUrl === readDeploymentEnv("EMBEDDING_API_BASE_URL"),
    };
  }
  const openAiBaseUrl = process.env.OPENAI_BASE_URL;
  if (!openAiBaseUrl) return null;
  return {
    baseUrl: openAiBaseUrl,
    fromDeployment: openAiBaseUrl === readDeploymentEnv("OPENAI_BASE_URL"),
  };
}

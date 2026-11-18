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

/**
 * Reads a key's deployment environment value, without stored config. Set by
 * the HTTP server at boot (http/core owns the env injection). Unset, no URL
 * counts as operator config, so every one gets the SSRF check.
 */
let readDeploymentEnv: (key: string) => string | undefined = () => undefined;

export function setDeploymentEnvReader(read: (key: string) => string | undefined): void {
  readDeploymentEnv = read;
}

/**
 * The base URL the embedding client sends to, in the SDK's precedence order,
 * and whether it is the deployment environment's own value. Null when neither
 * key is set (the SDK default, OpenAI).
 */
export function embeddingEndpoint(): { baseUrl: string; fromDeployment: boolean } | null {
  const key = process.env.EMBEDDING_API_BASE_URL
    ? "EMBEDDING_API_BASE_URL"
    : process.env.OPENAI_BASE_URL
      ? "OPENAI_BASE_URL"
      : null;
  if (!key) return null;
  const baseUrl = process.env[key] ?? "";
  return { baseUrl, fromDeployment: baseUrl === readDeploymentEnv(key) };
}

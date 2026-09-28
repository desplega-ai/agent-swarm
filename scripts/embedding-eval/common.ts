// Shared paths, types, and helpers for the embedding eval harness.
// Research-only code: not imported by the app, not part of CI.
import { createHash } from "node:crypto";

export const DATA_DIR = process.env.EMBED_EVAL_DIR ?? "/tmp/embedding-eval";

/** Docs above this length are cut before embedding (OpenAI rejects > 8192 tokens). */
export const MAX_DOC_CHARS = 24_000;

export type Memory = {
  id: string;
  agentId: string | null;
  scope: "agent" | "swarm";
  name: string;
  content: string;
  source: "manual" | "file_index" | "session_summary" | "task_completion";
  sourceTaskId: string | null;
  sourcePath: string | null;
  chunkIndex: number | null;
  totalChunks: number | null;
  createdAt: string;
  contentHash: string | null;
  hasEmbedding: number;
  embeddingModel: string | null;
};

/** One retrieval query with its relevance labels and prod-faithful filters. */
export type EvalQuery = {
  id: string;
  set: string;
  text: string;
  /** Agent whose scope applies: candidates = own agent rows OR swarm rows. */
  agentId: string | null;
  /** Only rows created strictly before this instant are candidates (null = no cutoff). */
  cutoff: string | null;
  /** Relevant row ids (or doc ids in the chunking experiment). */
  positives: string[];
  meta?: Record<string, unknown>;
};

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Mirrors OpenAIEmbeddingProvider input cleaning (newlines to spaces, trim). */
export function cleanForEmbedding(text: string): string {
  return text
    .slice(0, MAX_DOC_CHARS)
    .replace(/[\n\r]/g, " ")
    .trim();
}

export async function readJson<T>(name: string): Promise<T> {
  return (await Bun.file(`${DATA_DIR}/${name}`).json()) as T;
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await Bun.write(`${DATA_DIR}/${name}`, JSON.stringify(value));
}

/** Deterministic PRNG (mulberry32) so samples are reproducible. */
export function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Run `fn` over `items` with at most `concurrency` in flight. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

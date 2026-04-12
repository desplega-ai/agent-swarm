import OpenAI from "openai";
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from "../constants";
import type { EmbeddingProvider } from "../types";

interface OpenAIEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  private client: OpenAI | null = null;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(config?: OpenAIEmbeddingConfig) {
    this.apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = config?.model ?? "text-embedding-3-small";
    this.dimensions = config?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.name = config?.model ? `openai/${config.model}` : DEFAULT_EMBEDDING_MODEL;
  }

  private getClient(): OpenAI | null {
    if (!this.apiKey) return null;
    if (!this.client) this.client = new OpenAI({ apiKey: this.apiKey });
    return this.client;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const client = this.getClient();
    if (!client) return null;

    try {
      const cleaned = text.replace(/[\n\r]/g, " ").trim();
      if (!cleaned) return null;

      const response = await client.embeddings.create({
        model: this.model,
        input: cleaned,
        dimensions: this.dimensions,
      });

      const values = response.data[0]?.embedding;
      if (!values) return null;

      return new Float32Array(values);
    } catch (err) {
      console.error("[memory] Embedding failed:", (err as Error).message);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const client = this.getClient();
    if (!client) return texts.map(() => null);

    const cleaned = texts.map((t) => t.replace(/[\n\r]/g, " ").trim());
    const nonEmptyIndices: number[] = [];
    const nonEmptyTexts: string[] = [];

    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i]) {
        nonEmptyIndices.push(i);
        nonEmptyTexts.push(cleaned[i]!);
      }
    }

    if (nonEmptyTexts.length === 0) return texts.map(() => null);

    try {
      const response = await client.embeddings.create({
        model: this.model,
        input: nonEmptyTexts,
        dimensions: this.dimensions,
      });

      const results: (Float32Array | null)[] = texts.map(() => null);
      for (const item of response.data) {
        const originalIndex = nonEmptyIndices[item.index];
        if (originalIndex !== undefined && item.embedding) {
          results[originalIndex] = new Float32Array(item.embedding);
        }
      }

      return results;
    } catch (err) {
      console.error("[memory] Batch embedding failed:", (err as Error).message);
      return texts.map(() => null);
    }
  }
}

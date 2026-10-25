import OpenAI from "openai";
import { selectCredential } from "../../../utils/credentials";
import { getOpenRouterAttributionHeaders } from "../../../utils/openrouter-base-url";
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../constants";
import type { EmbeddingProvider } from "../types";

// text-embedding-3-* reject any input over 8,192 tokens with a 400, and one
// such input fails every input in its request. There is no tokenizer here, and
// dense text (UUIDs, hashes, CJK) measures 1.2-1.8 chars per token, so no char
// cap is safe by itself: start at ~3 chars per token and halve on rejection.
export const MAX_EMBEDDING_INPUT_CHARS = 24_000;
const MIN_EMBEDDING_INPUT_CHARS = 1_000;
// The API also caps one request at 300,000 tokens. Even at one char per token,
// this keeps a request under it.
const MAX_BATCH_REQUEST_CHARS = 200_000;

interface OpenAIEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

function cleanInput(text: string): string {
  return text
    .replace(/[\n\r]/g, " ")
    .trim()
    .slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/** A 400 is about the request's inputs, so the other inputs can still embed. */
function isInputRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400;
}

function isInputTooLong(err: unknown): boolean {
  return (
    isInputRejection(err) && /maximum (context|input) length/i.test((err as Error).message ?? "")
  );
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  private client: OpenAI | null = null;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(config?: OpenAIEmbeddingConfig) {
    const apiKey = config?.apiKey ?? process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;
    this.apiKey = apiKey
      ? selectCredential(apiKey, undefined, "EMBEDDING_API_KEY").selected
      : undefined;

    this.model = config?.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

    this.dimensions = config?.dimensions ?? EMBEDDING_DIMENSIONS;

    this.name = config?.model
      ? `openai/${config.model}`
      : (process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL);
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private getClient(): OpenAI | null {
    if (!this.apiKey) return null;
    if (!this.client) {
      const baseURL = process.env.EMBEDDING_API_BASE_URL; // Optional custom base URL
      this.client = new OpenAI({
        baseURL,
        apiKey: this.apiKey,
        // Only an openrouter.ai base URL gets attribution; OpenAI and gateways get none.
        defaultHeaders: getOpenRouterAttributionHeaders(baseURL ?? ""),
      });
    }
    return this.client;
  }

  private async request(client: OpenAI, input: string | string[]) {
    return client.embeddings.create({
      model: this.model,
      input,
      dimensions: this.dimensions,
      // Without it the SDK asks for base64 and decodes any reply as base64. A
      // gateway that answers with plain floats would then yield garbage.
      encoding_format: "float",
    });
  }

  private toVector(values: number[] | undefined, label: string): Float32Array | null {
    if (!values) return null;
    if (values.length !== this.dimensions) {
      console.error(
        `[memory] ${label} dimension mismatch: expected=${this.dimensions} got=${values.length}. Provider may not support the 'dimensions' parameter.`,
      );
      return null;
    }
    return new Float32Array(values);
  }

  /** Embed one cleaned input, cutting it in half each time the provider says it is too long. */
  private async embedOne(client: OpenAI, cleaned: string): Promise<Float32Array | null> {
    let input = cleaned;
    while (true) {
      try {
        const response = await this.request(client, input);
        return this.toVector(response.data[0]?.embedding, "Embedding");
      } catch (err) {
        const message = (err as Error).message;
        if (isInputTooLong(err) && input.length > MIN_EMBEDDING_INPUT_CHARS) {
          const next = Math.max(MIN_EMBEDDING_INPUT_CHARS, Math.floor(input.length / 2));
          console.warn(
            `[memory] Embedding input over the token cap at ${input.length} chars, retrying at ${next}: ${message}`,
          );
          input = input.slice(0, next);
          continue;
        }
        console.error("[memory] Embedding failed:", message);
        return null;
      }
    }
  }

  async embed(text: string): Promise<Float32Array | null> {
    const client = this.getClient();
    if (!client) return null;

    const cleaned = cleanInput(text);
    if (!cleaned) return null;
    return this.embedOne(client, cleaned);
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const results: (Float32Array | null)[] = texts.map(() => null);
    const client = this.getClient();
    if (!client) return results;

    const cleaned = texts.map(cleanInput);
    const groups: number[][] = [];
    let group: number[] = [];
    let groupChars = 0;
    for (let i = 0; i < cleaned.length; i++) {
      const length = cleaned[i]!.length;
      if (length === 0) continue;
      if (group.length > 0 && groupChars + length > MAX_BATCH_REQUEST_CHARS) {
        groups.push(group);
        group = [];
        groupChars = 0;
      }
      group.push(i);
      groupChars += length;
    }
    if (group.length > 0) groups.push(group);

    for (const indices of groups) {
      try {
        const response = await this.request(
          client,
          indices.map((i) => cleaned[i]!),
        );
        for (const item of response.data) {
          const originalIndex = indices[item.index];
          if (originalIndex === undefined) continue;
          results[originalIndex] = this.toVector(item.embedding, "Batch embedding");
        }
      } catch (err) {
        if (!isInputRejection(err)) {
          console.error("[memory] Batch embedding failed:", (err as Error).message);
          continue;
        }
        // One rejected input fails the whole request: embed each input alone so
        // only that input is cut down, and the rest embed as they are.
        console.warn(
          `[memory] Batch embedding rejected, embedding ${indices.length} inputs one by one: ${(err as Error).message}`,
        );
        for (const i of indices) {
          results[i] = await this.embedOne(client, cleaned[i]!);
        }
      }
    }

    return results;
  }
}

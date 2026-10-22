import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_EMBEDDING_INPUT_CHARS,
  OpenAIEmbeddingProvider,
} from "../be/memory/providers/openai-embedding";

// A gateway that rejects any input over REJECT_OVER chars the way the OpenAI
// API rejects an input over 8,192 tokens: a 400 for the whole request.
const REJECT_OVER = 10_000;
let server: ReturnType<typeof Bun.serve>;
const requests: string[][] = [];
const previousBaseUrl = process.env.EMBEDDING_API_BASE_URL;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      requests.push(inputs);
      const tooLong = inputs.findIndex((input) => input.length > REJECT_OVER);
      if (tooLong !== -1) {
        const param = Array.isArray(body.input) ? `input[${tooLong}]` : "input";
        return Response.json(
          {
            error: {
              message: `Invalid '${param}': maximum input length is 8192 tokens.`,
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          },
          { status: 400 },
        );
      }
      return Response.json({
        object: "list",
        data: inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: [input.length, 0, 0, 1],
        })),
        model: "test-embedding-model",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    },
  });
  process.env.EMBEDDING_API_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
  if (previousBaseUrl === undefined) delete process.env.EMBEDDING_API_BASE_URL;
  else process.env.EMBEDDING_API_BASE_URL = previousBaseUrl;
});

beforeEach(() => {
  requests.length = 0;
});

function provider(): OpenAIEmbeddingProvider {
  return new OpenAIEmbeddingProvider({
    apiKey: "test-key",
    model: "test-embedding-model",
    dimensions: 4,
  });
}

/** The embedded length, which the fake gateway echoes as the first component. */
function embeddedLength(vector: Float32Array | null): number | null {
  return vector ? vector[0]! : null;
}

describe("embedding input cap", () => {
  test("an over-cap input is cut down until the provider accepts it", async () => {
    const vector = await provider().embed("x".repeat(50_000));

    expect(embeddedLength(vector)).toBe(MAX_EMBEDDING_INPUT_CHARS / 4);
    expect(requests.map((r) => r[0]!.length)).toEqual([
      MAX_EMBEDDING_INPUT_CHARS,
      MAX_EMBEDDING_INPUT_CHARS / 2,
      MAX_EMBEDDING_INPUT_CHARS / 4,
    ]);
  });

  test("no input is ever sent over the char cap", async () => {
    await provider().embedBatch(["a".repeat(100_000), "b".repeat(30_000)]);
    for (const request of requests) {
      for (const input of request)
        expect(input.length).toBeLessThanOrEqual(MAX_EMBEDDING_INPUT_CHARS);
    }
  });

  test("one oversized input in a batch does not fail the other inputs", async () => {
    const vectors = await provider().embedBatch(["small one", "y".repeat(40_000), "small two"]);

    expect(vectors.map(embeddedLength)).toEqual([
      "small one".length,
      MAX_EMBEDDING_INPUT_CHARS / 4,
      "small two".length,
    ]);
    // The whole batch first, then each input alone after the rejection.
    expect(requests[0]).toHaveLength(3);
    expect(requests.slice(1).every((r) => r.length === 1)).toBe(true);
  });

  test("a batch with no oversized input goes out as one request", async () => {
    const vectors = await provider().embedBatch(["one", "", "three"]);

    expect(vectors.map(embeddedLength)).toEqual([3, null, 5]);
    expect(requests).toEqual([["one", "three"]]);
  });
});

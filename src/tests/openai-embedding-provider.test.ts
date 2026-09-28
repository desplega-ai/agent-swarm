import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAIEmbeddingProvider } from "../be/memory/providers/openai-embedding";

// A gateway that ignores `encoding_format` and always answers with plain floats.
let server: ReturnType<typeof Bun.serve>;
const bodies: Array<Record<string, unknown>> = [];
const previousBaseUrl = process.env.EMBEDDING_API_BASE_URL;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[] };
      bodies.push(body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({
        object: "list",
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding: [0.25, 0.5, 0.75, 1],
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

describe("OpenAIEmbeddingProvider", () => {
  test("requests float vectors, so a plain-float reply decodes correctly", async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      model: "test-embedding-model",
      dimensions: 4,
    });

    const single = await provider.embed("hello");
    const batch = await provider.embedBatch(["a", "b"]);

    expect(bodies.map((body) => body.encoding_format)).toEqual(["float", "float"]);
    expect(single ? Array.from(single) : null).toEqual([0.25, 0.5, 0.75, 1]);
    expect(batch.map((vector) => (vector ? Array.from(vector) : null))).toEqual([
      [0.25, 0.5, 0.75, 1],
      [0.25, 0.5, 0.75, 1],
    ]);
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
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

// A TEI server started with the default --max-client-batch-size 32. TEI answers
// a bigger request with a 422 and this body. TEI also answers 422 for other
// validation errors, such as a `dimensions` value the model cannot serve.
const TEI_MAX_BATCH = 32;
let teiServer: ReturnType<typeof Bun.serve>;
let teiBaseUrl: string;
let teiOtherError: string | null = null;
let teiPayloadTooLarge = false;
const teiRequests: string[][] = [];

function teiProvider(): OpenAIEmbeddingProvider {
  return new OpenAIEmbeddingProvider({
    apiKey: "local-tei",
    model: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: 4,
  });
}

describe("batch-size rejections", () => {
  let savedBaseUrl: string | undefined;

  beforeAll(() => {
    teiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        teiRequests.push(inputs);
        if (teiPayloadTooLarge && inputs.length > 1) {
          return new Response("payload too large", { status: 413 });
        }
        if (teiOtherError) {
          return Response.json({ error: teiOtherError, error_type: "Validation" }, { status: 422 });
        }
        if (inputs.length > TEI_MAX_BATCH) {
          return Response.json(
            {
              error: `batch size ${inputs.length} > maximum allowed batch size ${TEI_MAX_BATCH}`,
              error_type: "Validation",
            },
            { status: 422 },
          );
        }
        return Response.json({
          object: "list",
          data: inputs.map((input, index) => ({
            object: "embedding",
            index,
            embedding: [input.length, 0, 0, 1],
          })),
          model: "nomic-ai/nomic-embed-text-v1.5",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    teiBaseUrl = `http://127.0.0.1:${teiServer.port}/v1`;
  });

  afterAll(() => {
    teiServer.stop(true);
  });

  beforeEach(() => {
    teiRequests.length = 0;
    teiOtherError = null;
    teiPayloadTooLarge = false;
    savedBaseUrl = process.env.EMBEDDING_API_BASE_URL;
    process.env.EMBEDDING_API_BASE_URL = teiBaseUrl;
  });

  afterEach(() => {
    process.env.EMBEDDING_API_BASE_URL = savedBaseUrl;
  });

  test("a 422 for the batch size embeds every input one by one", async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `chunk ${i}`);
    const vectors = await teiProvider().embedBatch(texts);

    expect(vectors.map(embeddedLength)).toEqual(texts.map((text) => text.length));
    expect(teiRequests[0]).toHaveLength(70);
    expect(teiRequests.slice(1)).toHaveLength(70);
    expect(teiRequests.slice(1).every((r) => r.length === 1)).toBe(true);
  });

  test("a 413 also embeds every input one by one", async () => {
    teiPayloadTooLarge = true;

    const vectors = await teiProvider().embedBatch(["one", "three"]);
    expect(vectors.map(embeddedLength)).toEqual([3, 5]);
    expect(teiRequests).toEqual([["one", "three"], ["one"], ["three"]]);
  });

  test("a 422 with another message is one logged failure and no per-input calls", async () => {
    teiOtherError = "`dimensions` set to 4 but the model only supports 768, 512, 256, 128, 64";
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const texts = Array.from({ length: 70 }, (_, i) => `chunk ${i}`);
      const vectors = await teiProvider().embedBatch(texts);

      expect(vectors.every((vector) => vector === null)).toBe(true);
      expect(teiRequests).toHaveLength(1);
      const failures = errors.mock.calls.filter((call) =>
        String(call[0]).includes("Batch embedding failed"),
      );
      expect(failures).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });
});

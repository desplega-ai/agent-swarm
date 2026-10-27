import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_EMBEDDING_INPUT_CHARS,
  OpenAIEmbeddingProvider,
} from "../be/memory/providers/openai-embedding";

// A gateway that ignores `encoding_format` and always answers with plain floats.
let server: ReturnType<typeof Bun.serve>;
const bodies: Array<Record<string, unknown>> = [];
const previousBaseUrl = process.env.EMBEDDING_API_BASE_URL;
const PREFIX_ENVS = ["EMBEDDING_QUERY_PREFIX", "EMBEDDING_DOCUMENT_PREFIX"] as const;
const previousPrefixes = new Map(PREFIX_ENVS.map((key) => [key, process.env[key]]));

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

function clearPrefixes(): void {
  for (const key of PREFIX_ENVS) delete process.env[key];
}

beforeEach(() => {
  bodies.length = 0;
  clearPrefixes();
});

afterEach(() => {
  clearPrefixes();
  for (const [key, value] of previousPrefixes) {
    if (value !== undefined) process.env[key] = value;
  }
});

function makeProvider(): OpenAIEmbeddingProvider {
  return new OpenAIEmbeddingProvider({
    apiKey: "test-key",
    model: "test-embedding-model",
    dimensions: 4,
  });
}

function sentInputs(): string[] {
  return bodies.flatMap((body) =>
    Array.isArray(body.input) ? body.input : [body.input],
  ) as string[];
}

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

  describe("task prefixes", () => {
    function setNomicPrefixes(): void {
      process.env.EMBEDDING_QUERY_PREFIX = "search_query: ";
      process.env.EMBEDDING_DOCUMENT_PREFIX = "search_document: ";
    }

    test("kind query gets the query prefix", async () => {
      setNomicPrefixes();
      const provider = makeProvider();
      await provider.embed("who owns billing?", { kind: "query" });
      await provider.embedBatch(["a", "b"], { kind: "query" });

      expect(sentInputs()).toEqual([
        "search_query: who owns billing?",
        "search_query: a",
        "search_query: b",
      ]);
    });

    test("kind document gets the document prefix", async () => {
      setNomicPrefixes();
      const provider = makeProvider();
      await provider.embed("billing is owned by Ada", { kind: "document" });
      await provider.embedBatch(["a", "", "b"], { kind: "document" });

      // An empty input is skipped, never embedded as a bare prefix.
      expect(sentInputs()).toEqual([
        "search_document: billing is owned by Ada",
        "search_document: a",
        "search_document: b",
      ]);
    });

    test("no prefix when the envs are unset", async () => {
      const provider = makeProvider();
      await provider.embed("hello", { kind: "query" });
      await provider.embedBatch(["a"], { kind: "document" });

      expect(sentInputs()).toEqual(["hello", "a"]);
    });

    test("no prefix without a kind", async () => {
      setNomicPrefixes();
      const provider = makeProvider();
      await provider.embed("hello");
      await provider.embedBatch(["a"]);

      expect(sentInputs()).toEqual(["hello", "a"]);
    });

    test("the prefixes are read when the provider is constructed", async () => {
      const provider = makeProvider();
      setNomicPrefixes();
      await provider.embed("hello", { kind: "query" });

      expect(sentInputs()).toEqual(["hello"]);
    });

    test("prefix plus input stays within the char cap", async () => {
      setNomicPrefixes();
      await makeProvider().embed("x".repeat(MAX_EMBEDDING_INPUT_CHARS + 500), { kind: "document" });

      const [sent] = sentInputs();
      expect(sent!.startsWith("search_document: x")).toBe(true);
      expect(sent!.length).toBe(MAX_EMBEDDING_INPUT_CHARS);
    });
  });
});

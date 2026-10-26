// @ts-nocheck: spike code, not typechecked by the repo (imports resolve in the spike worktree only).
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { OpenAICompatEmbeddingProvider } from "../embeddings/openai-compat.js";
import { createEmbeddingProviderFromEnv } from "../embeddings/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { embeddingFormat } from "../embedding-migration.js";

type Seen = { auth: string | null; path: string; body: any };
let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

/** Deterministic 768-dim vector: slot 0 = text length, slot 1 = char-code sum. */
const vec = (t: string) => Object.assign(new Array(768).fill(0), { 0: t.length, 1: [...t].reduce((a, c) => a + c.charCodeAt(0), 0) });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      seen.push({ auth: req.headers.get("authorization"), path: new URL(req.url).pathname, body });
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
      // Out of order on purpose: the provider sorts by index.
      const data = inputs.map((t, index) => ({ object: "embedding", index, embedding: vec(t) })).reverse();
      return Response.json({ object: "list", data, model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});
afterAll(() => server.stop(true));
beforeEach(() => { seen = []; });

describe("OpenAICompatEmbeddingProvider", () => {
  test("query request: model, query prefix, float encoding, no dimensions, no auth without key", async () => {
    const p = new OpenAICompatEmbeddingProvider({ baseURL, model: "m1", queryPrefix: "search_query: " });
    expect(await p.embedQuery("hi")).toEqual(vec("search_query: hi"));
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/v1/embeddings");
    expect(seen[0].auth).toBeNull();
    expect(seen[0].body).toEqual({ model: "m1", input: "search_query: hi", encoding_format: "float" });
  });

  test("document request: prefix on every input, batches of at most 32, order kept", async () => {
    const p = new OpenAICompatEmbeddingProvider({ baseURL, model: "m1", documentPrefix: "search_document: " });
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const out = await p.embedDocuments(texts, { title: "f.md" });
    expect(out).toEqual(texts.map((t) => vec("search_document: " + t)));
    expect(seen.map((s) => s.body.input.length)).toEqual([32, 32, 6]);
    expect(seen[0].body.input[0]).toBe("search_document: t0");
    expect(seen.every((s) => s.body.encoding_format === "float" && !("dimensions" in s.body))).toBe(true);
  });

  test("sends a bearer token only when a key is set", async () => {
    const p = new OpenAICompatEmbeddingProvider({ baseURL, model: "m1", apiKey: "k-test" });
    await p.embedQuery("x");
    expect(seen[0].auth).toBe("Bearer k-test");
  });

  test("dimensions are 768, no mime or part support", () => {
    const p: EmbeddingProvider = new OpenAICompatEmbeddingProvider({ baseURL, model: "m1" });
    expect(p.dimensions).toBe(768);
    expect(p.supportsMime).toBeUndefined();
    expect(p.embedParts).toBeUndefined();
  });

  test("fingerprint changes with model or prefix, not with base URL", () => {
    const f = (o: Partial<ConstructorParameters<typeof OpenAICompatEmbeddingProvider>[0]> = {}) =>
      embeddingFormat(new OpenAICompatEmbeddingProvider({ baseURL, model: "m1", queryPrefix: "q", documentPrefix: "d", ...o }));
    expect(f({ baseURL: "http://other:1/v1" })).toBe(f());
    expect(f({ model: "m2" })).not.toBe(f());
    expect(f({ queryPrefix: "q2" })).not.toBe(f());
    expect(f({ documentPrefix: "d2" })).not.toBe(f());
    expect(f()).toMatch(/^openai-compat-[0-9a-f]{8}:v2$/);
  });
});

describe("factory wiring", () => {
  const keys = ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
    "AGENT_FS_EMBEDDING_BASE_URL", "AGENT_FS_EMBEDDING_QUERY_PREFIX", "AGENT_FS_EMBEDDING_DOCUMENT_PREFIX"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test("explicit EMBEDDING_PROVIDER=openai-compat builds the provider from env", async () => {
    process.env.EMBEDDING_PROVIDER = "openai-compat";
    process.env.AGENT_FS_EMBEDDING_BASE_URL = baseURL;
    process.env.AGENT_FS_EMBEDDING_QUERY_PREFIX = "search_query: ";
    const p = await createEmbeddingProviderFromEnv({ provider: "openai-compat", model: "m1", apiKey: "" });
    expect(p?.name).toMatch(/^openai-compat-/);
    await p!.embedQuery("z");
    expect(seen[0].body.input).toBe("search_query: z");
    expect(seen[0].auth).toBeNull();
  });

  test("missing base URL or model returns null", async () => {
    process.env.EMBEDDING_PROVIDER = "openai-compat";
    expect(await createEmbeddingProviderFromEnv({ provider: "openai-compat", model: "m1", apiKey: "" })).toBeNull();
    process.env.AGENT_FS_EMBEDDING_BASE_URL = baseURL;
    expect(await createEmbeddingProviderFromEnv({ provider: "openai-compat", model: "", apiKey: "" })).toBeNull();
  });
});

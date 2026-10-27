import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { getEmbeddingProvider, getMemoryStore, resetEmbeddingProvider } from "../be/memory";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import {
  pendingRecoveryBackfill,
  resetEmbeddingRecoveryForTests,
} from "../be/memory/embedding-recovery";

// A fake OpenAI-compatible endpoint that is down (503), rejects inputs (400)
// or works, like a local TEI that restarts.
let mode: "down" | "reject" | "up" = "up";
let server: ReturnType<typeof Bun.serve>;
const agentId = randomUUID();
const saved = {
  baseUrl: process.env.EMBEDDING_API_BASE_URL,
  key: process.env.EMBEDDING_API_KEY,
};

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (mode === "down") return new Response("model loading", { status: 503 });
      if (mode === "reject") {
        return Response.json({ error: { message: "bad input" } }, { status: 400 });
      }
      return Response.json({
        object: "list",
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
        })),
        model: "nomic-ai/nomic-embed-text-v1.5",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    },
  });
  process.env.EMBEDDING_API_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.EMBEDDING_API_KEY = "local-tei";
  resetEmbeddingProvider();
  initDb(":memory:");
  await createAgent({ id: agentId, name: "recovery", isLead: false, status: "idle" });
});

afterAll(() => {
  server.stop(true);
  closeDb();
  for (const [env, value] of [
    ["EMBEDDING_API_BASE_URL", saved.baseUrl],
    ["EMBEDDING_API_KEY", saved.key],
  ] as const) {
    if (value === undefined) delete process.env[env];
    else process.env[env] = value;
  }
  resetEmbeddingProvider();
});

beforeEach(() => {
  resetEmbeddingRecoveryForTests();
  mode = "up";
});

async function memoryWithoutVector(): Promise<string> {
  const memory = await getMemoryStore().store({
    agentId,
    scope: "agent",
    name: `written while down ${randomUUID()}`,
    content: "violet umbrella 37",
    source: "manual",
  });
  return memory.id;
}

/** A stored script with no vector, like one seeded while the endpoint was down. */
async function scriptWithoutVector(): Promise<string> {
  const id = randomUUID();
  await getDbClient().run(
    `INSERT INTO scripts (id, name, scope, source, description, intent, signatureJson, contentHash)
     VALUES (?, ?, 'global', 'export default async () => 1', 'umbrella counter', 'count', '{}', ?)`,
    [id, `recovery-${id}`, id],
  );
  return id;
}

async function scriptVectorBytes(id: string): Promise<number | null> {
  const row = await getDbClient().get<{ bytes: number | null }>(
    "SELECT length(embedding) AS bytes FROM script_embeddings WHERE scriptId = ?",
    [id],
  );
  return row?.bytes ?? null;
}

async function vectorBytes(id: string): Promise<number | null> {
  const row = await getDbClient().get<{ bytes: number | null }>(
    "SELECT length(embedding) AS bytes FROM agent_memory WHERE id = ?",
    [id],
  );
  return row?.bytes ?? null;
}

describe("backfill after the embeddings endpoint recovers", () => {
  test("a memory or script written while the endpoint was down gets its vector on the next working call", async () => {
    mode = "down";
    expect(await getEmbeddingProvider().embed("first try", { kind: "document" })).toBeNull();
    const id = await memoryWithoutVector();
    const scriptId = await scriptWithoutVector();
    expect(await vectorBytes(id)).toBeNull();
    expect(await scriptVectorBytes(scriptId)).toBeNull();

    mode = "up";
    expect(await getEmbeddingProvider().embed("a search", { kind: "query" })).not.toBeNull();
    const backfill = pendingRecoveryBackfill();
    expect(backfill).not.toBeNull();
    await backfill;
    expect(await vectorBytes(id)).toBe(EMBEDDING_DIMENSIONS * 4);
    expect(await scriptVectorBytes(scriptId)).toBe(EMBEDDING_DIMENSIONS * 4);
  }, 30_000);

  test("a rejected input does not start a backfill", async () => {
    mode = "reject";
    expect(await getEmbeddingProvider().embed("bad input")).toBeNull();
    mode = "up";
    expect(await getEmbeddingProvider().embed("a search", { kind: "query" })).not.toBeNull();
    expect(pendingRecoveryBackfill()).toBeNull();
  });

  test("working calls without an earlier failure start no backfill", async () => {
    expect(await getEmbeddingProvider().embed("a search", { kind: "query" })).not.toBeNull();
    expect(pendingRecoveryBackfill()).toBeNull();
  });
});

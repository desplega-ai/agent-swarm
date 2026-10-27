import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { deserializeEmbedding, serializeEmbedding } from "../be/embedding";
import { getEmbeddingProvider, getMemoryStore, resetEmbeddingProvider } from "../be/memory";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import { resetEmbeddingRecoveryForTests } from "../be/memory/embedding-recovery";
import {
  EMBEDDING_SPACE_KEY,
  EMBEDDING_SPACE_TARGET_KEY,
  embeddingSpaceCursorKey,
  embeddingSpaceFingerprint,
  reconcileEmbeddingSpace,
  runEmbeddingMaintenance,
  setDeploymentEnvReader,
} from "../be/memory/embedding-space";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";

// A fake OpenAI-compatible endpoint. Each model answers with its own constant
// vector, so a test can tell which space a stored row is in.
const MODEL_VALUE: Record<string, number> = { "model-a": 0.1, "model-b": 0.2 };
const OLD_VALUE = 0.9;
let down = false;
// Count of document requests to model-b that answer HTTP 400 (rejected input).
let rejectDocuments = 0;
let requests: string[][] = [];
let server: ReturnType<typeof Bun.serve>;
const agentId = randomUUID();
const ENV_KEYS = [
  "EMBEDDING_API_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DOCUMENT_PREFIX",
  "EMBEDDING_QUERY_PREFIX",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  process.env.EMBEDDING_API_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.EMBEDDING_API_KEY = "key-1";
  process.env.EMBEDDING_MODEL = "model-a";
  delete process.env.EMBEDDING_DOCUMENT_PREFIX;
  delete process.env.EMBEDDING_QUERY_PREFIX;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  resetEmbeddingProvider();
}

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[]; model: string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (down) return new Response("model loading", { status: 503 });
      requests.push(inputs);
      if (body.model === "model-b" && inputs.some((s) => s !== "test") && rejectDocuments > 0) {
        rejectDocuments--;
        return Response.json(
          { error: { message: "rejected input", type: "invalid_request_error" } },
          { status: 400 },
        );
      }
      return Response.json({
        object: "list",
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding: new Array(EMBEDDING_DIMENSIONS).fill(MODEL_VALUE[body.model] ?? 0.5),
        })),
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    },
  });
  setScriptEmbeddingProviderForTests(null);
  initDb(":memory:");
  await createAgent({ id: agentId, name: "space", isLead: false, status: "idle" });
});

afterAll(() => {
  server.stop(true);
  closeDb();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEmbeddingProvider();
});

beforeEach(async () => {
  down = false;
  rejectDocuments = 0;
  requests = [];
  resetEmbeddingRecoveryForTests();
  setEnv({});
  const db = getDbClient();
  await db.run("DELETE FROM agent_memory");
  await db.run("DELETE FROM script_embeddings");
  await db.run("DELETE FROM scripts");
  await db.run("DELETE FROM seed_state WHERE kind = 'maintenance' AND key LIKE 'embedding-space%'");
});

/** A memory whose vector is from some earlier space. */
async function oldMemory(): Promise<string> {
  const memory = await getMemoryStore().store({
    agentId,
    scope: "agent",
    name: `old ${randomUUID()}`,
    content: `violet umbrella ${randomUUID()}`,
    source: "manual",
  });
  await getMemoryStore().updateEmbedding(
    memory.id,
    new Float32Array(EMBEDDING_DIMENSIONS).fill(OLD_VALUE),
    "old/model",
  );
  return memory.id;
}

async function oldScript(): Promise<string> {
  const id = randomUUID();
  await getDbClient().run(
    `INSERT INTO scripts (id, name, scope, source, description, intent, signatureJson, contentHash)
     VALUES (?, ?, 'global', 'export default async () => 1', 'umbrella counter', 'count', '{}', ?)`,
    [id, `space-${id}`, id],
  );
  await getDbClient().run(
    `INSERT INTO script_embeddings (scriptId, embedding, embeddingModel, embeddedText, embeddedAt)
     VALUES (?, ?, 'old/model', 'x', datetime('now'))`,
    [id, serializeEmbedding(new Float32Array(EMBEDDING_DIMENSIONS).fill(OLD_VALUE))],
  );
  return id;
}

async function memoryValue(id: string): Promise<number | null> {
  const row = await getDbClient().get<{ embedding: Buffer | null }>(
    "SELECT embedding FROM agent_memory WHERE id = ?",
    [id],
  );
  return row?.embedding ? Number(deserializeEmbedding(row.embedding)[0]!.toFixed(3)) : null;
}

async function scriptValue(id: string): Promise<number | null> {
  const row = await getDbClient().get<{ embedding: Buffer }>(
    "SELECT embedding FROM script_embeddings WHERE scriptId = ?",
    [id],
  );
  return row ? Number(deserializeEmbedding(row.embedding)[0]!.toFixed(3)) : null;
}

async function state(key: string): Promise<string | null> {
  const row = await getDbClient().get<{ seededHash: string }>(
    "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
    [key],
  );
  return row?.seededHash ?? null;
}

const fingerprint = () => embeddingSpaceFingerprint(getEmbeddingProvider());
const embeddedInputs = () => requests.flat().filter((input) => input !== "test");

describe("embedding space fingerprint", () => {
  test("the first boot without a fingerprint adopts the current space and re-embeds nothing", async () => {
    const memoryId = await oldMemory();
    const scriptId = await oldScript();

    expect(await reconcileEmbeddingSpace()).toBe("adopted");
    expect(requests).toHaveLength(0);
    expect(await memoryValue(memoryId)).toBe(OLD_VALUE);
    expect(await scriptValue(scriptId)).toBe(OLD_VALUE);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(fingerprint());

    expect(await reconcileEmbeddingSpace()).toBe("unchanged");
    expect(requests).toHaveLength(0);
  });

  test("a key rotation or a query prefix change re-embeds nothing", async () => {
    const memoryId = await oldMemory();
    await reconcileEmbeddingSpace();
    const before = await state(EMBEDDING_SPACE_KEY);

    setEnv({ EMBEDDING_API_KEY: "key-2" });
    expect(await reconcileEmbeddingSpace()).toBe("unchanged");
    setEnv({ EMBEDDING_QUERY_PREFIX: "search_query: " });
    expect(await reconcileEmbeddingSpace()).toBe("unchanged");

    expect(requests).toHaveLength(0);
    expect(await memoryValue(memoryId)).toBe(OLD_VALUE);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(before);
  });

  test("an unconfigured provider leaves the record alone", async () => {
    process.env.EMBEDDING_API_KEY = "";
    delete process.env.OPENAI_API_KEY;
    resetEmbeddingProvider();
    expect(await reconcileEmbeddingSpace()).toBe("not-configured");
    expect(await state(EMBEDDING_SPACE_KEY)).toBeNull();
  });

  test("a model change re-embeds every memory and script, then records the new space", async () => {
    const memoryIds = [await oldMemory(), await oldMemory(), await oldMemory()];
    const scriptId = await oldScript();
    await reconcileEmbeddingSpace();
    const oldSpace = await state(EMBEDDING_SPACE_KEY);

    setEnv({ EMBEDDING_MODEL: "model-b" });
    expect(await reconcileEmbeddingSpace()).toBe("reembedded");

    for (const id of memoryIds) expect(await memoryValue(id)).toBe(0.2);
    expect(await scriptValue(scriptId)).toBe(0.2);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(fingerprint());
    expect(await state(EMBEDDING_SPACE_KEY)).not.toBe(oldSpace);
    expect(await state(EMBEDDING_SPACE_TARGET_KEY)).toBeNull();
    expect(await state(embeddingSpaceCursorKey("memory"))).toBeNull();
    expect(await state(embeddingSpaceCursorKey("scripts"))).toBeNull();

    requests = [];
    expect(await reconcileEmbeddingSpace()).toBe("unchanged");
    expect(requests).toHaveLength(0);
  });

  test("a document prefix change re-embeds with the new prefix", async () => {
    await oldMemory();
    await reconcileEmbeddingSpace();

    setEnv({ EMBEDDING_DOCUMENT_PREFIX: "search_document: " });
    expect(await reconcileEmbeddingSpace()).toBe("reembedded");
    const inputs = embeddedInputs();
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.startsWith("search_document: ")).toBe(true);
  });

  test("an interrupted re-embed resumes after the last committed batch", async () => {
    const memoryIds = [];
    for (let i = 0; i < 5; i++) memoryIds.push(await oldMemory());
    memoryIds.sort();
    const scriptId = await oldScript();
    await reconcileEmbeddingSpace();
    const oldSpace = await state(EMBEDDING_SPACE_KEY);

    setEnv({ EMBEDDING_MODEL: "model-b" });
    const crash = new Error("restart");
    await expect(
      reconcileEmbeddingSpace({
        batchSize: 2,
        afterBatch: () => {
          throw crash;
        },
      }),
    ).rejects.toBe(crash);

    // First batch is in the new space, the rest still in the old one, and the
    // old space stays recorded until the run finishes.
    expect(await memoryValue(memoryIds[0]!)).toBe(0.2);
    expect(await memoryValue(memoryIds[1]!)).toBe(0.2);
    expect(await memoryValue(memoryIds[2]!)).toBe(OLD_VALUE);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(oldSpace);
    expect(await state(EMBEDDING_SPACE_TARGET_KEY)).toBe(fingerprint());
    expect(await state(embeddingSpaceCursorKey("memory"))).toBe(memoryIds[1]!);

    requests = [];
    expect(await reconcileEmbeddingSpace({ batchSize: 2 })).toBe("reembedded");
    // Only the three remaining memories and the script embed again.
    expect(embeddedInputs()).toHaveLength(4);
    for (const id of memoryIds) expect(await memoryValue(id)).toBe(0.2);
    expect(await scriptValue(scriptId)).toBe(0.2);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(fingerprint());
  });

  test("a down endpoint pauses the re-embed and keeps the old vectors searchable", async () => {
    const memoryId = await oldMemory();
    await reconcileEmbeddingSpace();
    const oldSpace = await state(EMBEDDING_SPACE_KEY);

    setEnv({ EMBEDDING_MODEL: "model-b" });
    down = true;
    expect(await reconcileEmbeddingSpace()).toBe("interrupted");
    expect(await memoryValue(memoryId)).toBe(OLD_VALUE);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(oldSpace);

    down = false;
    // This test drives the retry itself, not the recovery hook.
    resetEmbeddingRecoveryForTests();
    expect(await reconcileEmbeddingSpace()).toBe("reembedded");
    expect(await memoryValue(memoryId)).toBe(0.2);
  }, 30_000);

  test("switching back mid re-embed re-embeds everything into the original space", async () => {
    const memoryIds = [await oldMemory(), await oldMemory(), await oldMemory()];
    memoryIds.sort();
    // Record model-a as the stored space.
    await reconcileEmbeddingSpace();
    const spaceA = await state(EMBEDDING_SPACE_KEY);

    setEnv({ EMBEDDING_MODEL: "model-b" });
    await expect(
      reconcileEmbeddingSpace({
        batchSize: 1,
        afterBatch: () => {
          throw new Error("restart");
        },
      }),
    ).rejects.toThrow("restart");
    expect(await memoryValue(memoryIds[0]!)).toBe(0.2);

    setEnv({ EMBEDDING_MODEL: "model-a" });
    expect(await reconcileEmbeddingSpace()).toBe("reembedded");
    for (const id of memoryIds) expect(await memoryValue(id)).toBe(0.1);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(spaceA);
    expect(await state(EMBEDDING_SPACE_TARGET_KEY)).toBeNull();
  });

  for (const urlKey of ["EMBEDDING_API_BASE_URL", "OPENAI_BASE_URL"] as const) {
    test(`a stored private ${urlKey} blocks the re-embed and sends no document`, async () => {
      const memoryId = await oldMemory();
      await reconcileEmbeddingSpace();
      const savedNodeEnv = process.env.NODE_ENV;
      const savedAllow = process.env.ALLOW_PRIVATE_NETWORK_URLS;
      process.env.NODE_ENV = "production";
      delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
      try {
        setEnv({ EMBEDDING_MODEL: "model-b" });
        if (urlKey === "OPENAI_BASE_URL") {
          process.env.OPENAI_BASE_URL = process.env.EMBEDDING_API_BASE_URL;
          delete process.env.EMBEDDING_API_BASE_URL;
          resetEmbeddingProvider();
        }
        requests = [];
        expect(await reconcileEmbeddingSpace()).toBe("blocked");
        expect(requests).toHaveLength(0);
        expect(await memoryValue(memoryId)).toBe(OLD_VALUE);
        expect(await state(EMBEDDING_SPACE_TARGET_KEY)).toBeNull();

        // The deployment environment's own URL may be private (bundled TEI).
        setDeploymentEnvReader((key) => process.env[key]);
        expect(await reconcileEmbeddingSpace()).toBe("reembedded");
        expect(await memoryValue(memoryId)).toBe(0.2);
      } finally {
        setDeploymentEnvReader(() => undefined);
        delete process.env.OPENAI_BASE_URL;
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedAllow !== undefined) process.env.ALLOW_PRIVATE_NETWORK_URLS = savedAllow;
      }
    });
  }

  test("a blocked endpoint URL stops every maintenance request, backfills included", async () => {
    const memoryId = await oldMemory();
    await reconcileEmbeddingSpace();
    await getMemoryStore().clearEmbedding(memoryId);
    const savedNodeEnv = process.env.NODE_ENV;
    const savedAllow = process.env.ALLOW_PRIVATE_NETWORK_URLS;
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
    try {
      setEnv({ EMBEDDING_MODEL: "model-b" });
      requests = [];
      await runEmbeddingMaintenance({ backfill: true });
      expect(requests).toHaveLength(0);
      expect(await memoryValue(memoryId)).toBeNull();
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedAllow !== undefined) process.env.ALLOW_PRIVATE_NETWORK_URLS = savedAllow;
    }
  });

  test("a reload re-embed retries a rejected row with the NULL backfill", async () => {
    const memoryId = await oldMemory();
    await reconcileEmbeddingSpace();
    setEnv({ EMBEDDING_MODEL: "model-b" });
    // Reject the batch and its single-input fallback; the retry is accepted.
    rejectDocuments = 2;
    await runEmbeddingMaintenance({ backfill: false });
    expect(rejectDocuments).toBe(0);
    expect(await memoryValue(memoryId)).toBe(0.2);
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(fingerprint());
  });

  test("a reload re-embed retries a rejected script with the missing-embedding backfill", async () => {
    const scriptId = await oldScript();
    await reconcileEmbeddingSpace();
    setEnv({ EMBEDDING_MODEL: "model-b" });
    rejectDocuments = 1;
    await runEmbeddingMaintenance({ backfill: false });
    expect(rejectDocuments).toBe(0);
    expect(await scriptValue(scriptId)).toBe(0.2);
  });

  test("a failed script cursor write rolls back the batch's vectors", async () => {
    const scriptId = await oldScript();
    await reconcileEmbeddingSpace();
    setEnv({ EMBEDDING_MODEL: "model-b" });
    await getDbClient().run(`CREATE TEMP TRIGGER fail_script_cursor BEFORE INSERT ON seed_state
      WHEN NEW.key = 'embedding-space:scripts:cursor'
      BEGIN SELECT RAISE(ABORT, 'cursor crash'); END`);
    try {
      await expect(reconcileEmbeddingSpace()).rejects.toThrow("cursor crash");
      expect(await scriptValue(scriptId)).toBe(OLD_VALUE);
      expect(await state(embeddingSpaceCursorKey("scripts"))).toBeNull();
    } finally {
      await getDbClient().run("DROP TRIGGER fail_script_cursor");
    }
    expect(await reconcileEmbeddingSpace()).toBe("reembedded");
    expect(await scriptValue(scriptId)).toBe(0.2);
  });

  test("maintenance calls made while one waits join it", async () => {
    const first = runEmbeddingMaintenance({ backfill: false });
    const second = runEmbeddingMaintenance({ backfill: false });
    expect(second).toBe(first);
    await first;
    expect(await state(EMBEDDING_SPACE_KEY)).toBe(fingerprint());
  });
});

import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { EMBEDDING_DIMENSIONS, LEARNING_TTL_DAYS, TTL_DEFAULTS } from "../be/memory/constants";
import { registerStoreProgressTool } from "../tools/store-progress";

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const agentId = "dddd0000-0000-4000-8000-000000000b01";

const server = new McpServer({ name: "store-progress-learning", version: "1.0.0" });
registerStoreProgressTool(server);
const tool = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        inputSchema: ZodType;
        handler: (args: unknown, meta: unknown) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools["store-progress"]!;

async function call(args: Record<string, unknown>) {
  return tool.handler(tool.inputSchema.parse(args), {
    sessionId: "store-progress-learning-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  });
}

async function task(vcsRepo?: string) {
  const row = await createTaskExtended("learning capture", {
    agentId,
    source: "system",
    followUpConfig: { disabled: true },
    ...(vcsRepo ? { vcsRepo } : {}),
  });
  await startTask(row.id);
  return row;
}

interface MemoryRow {
  id: string;
  agentId: string | null;
  key: string;
  name: string;
  scope: string;
  source: string;
  sourceTaskId: string;
  tags: string;
  content: string;
}

function learningRows(taskId: string): MemoryRow[] {
  return getDb()
    .query<MemoryRow, [string]>(
      "SELECT id, agentId, key, name, scope, source, sourceTaskId, tags, content FROM agent_memory WHERE sourceTaskId = ? AND key LIKE '/learnings/%' ORDER BY createdAt",
    )
    .all(taskId);
}

function learningData(result: ToolResult) {
  return result.structuredContent?.learning as
    | { status: string; key?: string; memoryId?: string; similarity?: number; error?: string }
    | undefined;
}

function message(result: ToolResult) {
  return String(result.structuredContent?.message);
}

const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
beforeAll(async () => {
  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  initDb(":memory:");
  await createAgent({ id: agentId, name: "Learner", isLead: false, status: "idle" });
});
afterAll(() => {
  closeDb();
  if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("store-progress learning", () => {
  test("stores a swarm manual memory under the explicit workstream", async () => {
    const t = await task("desplega-ai/agent-swarm");
    const result = await call({
      taskId: t.id,
      progress: "found the cause",
      learning: {
        text: "SQLite BUSY needs BEGIN IMMEDIATE\nA deferred BEGIN that reads first fails with BUSY_SNAPSHOT.",
        workstream: "DB Runtime",
        tags: ["SQLite", "gotcha", "learning"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(learningData(result)?.status).toBe("stored");
    expect(message(result)).toContain(
      "Learning stored at /learnings/db-runtime/sqlite-busy-needs-begin-immediate.",
    );
    const [row, ...rest] = learningRows(t.id);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      agentId,
      key: "/learnings/db-runtime/sqlite-busy-needs-begin-immediate",
      name: "SQLite BUSY needs BEGIN IMMEDIATE",
      scope: "swarm",
      source: "manual",
      sourceTaskId: t.id,
    });
    expect(JSON.parse(row!.tags)).toEqual(["learning", "sqlite", "gotcha"]);
    expect((await getTaskById(t.id))?.progress).toBe("found the cause");
  });

  test("string form falls back to the repo name, then to general", async () => {
    const withRepo = await task("desplega-ai/agent-swarm");
    await call({ taskId: withRepo.id, learning: "Run lint before tsc" });
    expect(learningRows(withRepo.id)[0]?.key).toBe("/learnings/agent-swarm/run-lint-before-tsc");

    const withoutRepo = await task();
    const result = await call({ taskId: withoutRepo.id, learning: { text: "Prefer scripts" } });
    expect(learningData(result)).toMatchObject({ status: "stored", workstream: "general" });
    expect(learningRows(withoutRepo.id)[0]?.key).toBe("/learnings/general/prefer-scripts");
  });

  test("a taken key gets a short suffix instead of failing", async () => {
    const first = await task();
    const second = await task();
    await call({ taskId: first.id, learning: "Same title\nfirst body" });
    const result = await call({ taskId: second.id, learning: "Same title\nsecond body" });

    expect(learningData(result)?.status).toBe("stored");
    expect(learningRows(first.id)[0]?.key).toBe("/learnings/general/same-title");
    expect(learningRows(second.id)[0]?.key).toMatch(
      /^\/learnings\/general\/same-title-[0-9a-f]{6}$/,
    );
  });

  test("an exact replay on the same task is skipped", async () => {
    const t = await task();
    await call({ taskId: t.id, learning: "Replay me" });
    const replay = await call({ taskId: t.id, progress: "again", learning: "Replay me" });

    expect(learningData(replay)).toMatchObject({
      status: "replayed",
      key: "/learnings/general/replay-me",
    });
    expect(learningRows(t.id)).toHaveLength(1);
  });

  test("overlapping calls with the same learning store it once", async () => {
    const t = await task();
    const learning = "Concurrent replay\nKeep exactly one copy of this lesson.";
    const results = await Promise.all([
      call({ taskId: t.id, learning }),
      call({ taskId: t.id, learning }),
    ]);

    expect(learningRows(t.id)).toHaveLength(1);
    expect(results.map((result) => learningData(result)?.status).sort()).toEqual([
      "replayed",
      "stored",
    ]);
  });

  // Synthetic token, built at runtime so no literal credential sits in the repo.
  const token = `ghp_${"abcd1234".repeat(5)}`;
  const kebabToken = token.replace("_", "-");

  test("a secret in the title, workstream or tags never reaches the key or tags", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      learning: {
        text: `${token}\nKeep credentials out of memory.`,
        workstream: token,
        tags: [token],
      },
    });

    expect(learningData(result)?.status).toBe("stored");
    const [row] = learningRows(t.id);
    for (const field of [row!.key, row!.name, row!.tags, row!.content, learningData(result)?.key]) {
      expect(field).not.toContain(token);
      expect(field).not.toContain(kebabToken);
    }
    expect(row!.content).toContain("[REDACTED:");
  });

  test("a replay of a secret-bearing learning is still detected", async () => {
    const t = await task();
    const learning = `Redact diagnostic tokens\nExample token: ${token}`;
    await call({ taskId: t.id, learning });
    const replay = await call({ taskId: t.id, learning });

    expect(learningData(replay)?.status).toBe("replayed");
    expect(learningRows(t.id)).toHaveLength(1);
  });

  test("a failed learning write leaves the progress write intact", async () => {
    const t = await task();
    getDb().run(
      "CREATE TEMP TRIGGER fail_learning BEFORE INSERT ON agent_memory WHEN NEW.key LIKE '/learnings/%' BEGIN SELECT RAISE(ABORT, 'learning insert refused'); END",
    );
    try {
      const result = await call({
        taskId: t.id,
        progress: "progress survives",
        status: "completed",
        output: "done",
        learning: "This write fails",
      });
      expect(result.isError).toBeFalsy();
      expect(learningData(result)).toMatchObject({ status: "failed" });
      expect(learningData(result)?.error).toContain("learning insert refused");
      expect(message(result)).toContain("Learning not stored:");
    } finally {
      getDb().run("DROP TRIGGER fail_learning");
    }
    const stored = await getTaskById(t.id);
    expect(stored?.progress).toBe("progress survives");
    expect(stored?.status).toBe("completed");
    expect(learningRows(t.id)).toHaveLength(0);
  });

  test("invalid learnings are reported without blocking progress", async () => {
    const t = await task();
    const tooManyTags = await call({
      taskId: t.id,
      progress: "still stored",
      learning: { text: "Tagged", tags: ["a", "b", "c", "d", "e", "f"] },
    });
    expect(learningData(tooManyTags)).toMatchObject({
      status: "failed",
      error: "learning takes at most 5 tags",
    });
    const tooLong = await call({ taskId: t.id, learning: "x".repeat(2001) });
    expect(learningData(tooLong)?.status).toBe("failed");
    expect((await getTaskById(t.id))?.progress).toBe("still stored");
    expect(learningRows(t.id)).toHaveLength(0);
  });

  test("a learning on the completing call is stored", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      status: "completed",
      output: "done",
      learning: "Ship on the completing call",
    });
    expect(learningData(result)?.status).toBe("stored");
    expect((await getTaskById(t.id))?.status).toBe("completed");
  });

  test("a call on a finished task stores nothing", async () => {
    const t = await task();
    await call({ taskId: t.id, status: "completed", output: "done" });
    const late = await call({
      taskId: t.id,
      status: "completed",
      output: "done",
      learning: "Too late",
    });
    expect(late.structuredContent).toMatchObject({ wasNoOp: true });
    expect(learningData(late)?.status).toBe("failed");

    const progressOnly = await call({ taskId: t.id, learning: "Still too late" });
    expect(learningData(progressOnly)?.status).toBe("failed");
    expect(learningRows(t.id)).toHaveLength(0);
  });
});

describe("store-progress learning near-duplicate guard", () => {
  const vectors = new Map<string, Float32Array>();
  let embedSpy: Mock<(text: string) => Promise<Float32Array | null>>;

  /** Unit vector on `axis`, tilted toward `axis + 1` so its cosine to the bare axis is `cos`. */
  function vector(axis: number, cos = 1): Float32Array {
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[axis] = cos;
    v[axis + 1] = Math.sqrt(1 - cos ** 2);
    return v;
  }

  /** Store a learning and give it its embedding now, not in the background. */
  async function seed(text: string, embedding: Float32Array, workstream = "seeded") {
    vectors.set(text, embedding);
    const t = await task();
    const result = await call({ taskId: t.id, learning: { text, workstream } });
    const memoryId = learningData(result)!.memoryId!;
    await getMemoryStore().updateEmbedding(memoryId, embedding, "test-embedding");
    return { task: t, memoryId, key: learningData(result)!.key! };
  }

  beforeAll(() => {
    embedSpy = spyOn(getEmbeddingProvider(), "embed").mockImplementation(
      async (text: string) => vectors.get(text) ?? null,
    );
  });
  afterAll(() => embedSpy.mockRestore());

  test("a near duplicate in another workstream is not stored and rates the existing row", async () => {
    const existing = await seed("Upsert scripts from file bytes\nPOST the raw file.", vector(10));
    const text = "Byte-exact script upsert from a local file\nPOST it to the API.";
    vectors.set(text, vector(10, 0.9));
    const t = await task();
    const result = await call({ taskId: t.id, learning: { text, workstream: "other" } });

    expect(learningData(result)).toMatchObject({
      status: "duplicate",
      memoryId: existing.memoryId,
      key: existing.key,
    });
    expect(learningData(result)?.similarity).toBeCloseTo(0.9, 2);
    expect(message(result)).toContain(`Learning not stored: it matches ${existing.key}`);
    expect(String(result.structuredContent?.nudge)).toContain(`memory-edit that memory instead`);
    expect(String(result.structuredContent?.nudge)).toContain(existing.memoryId);
    expect(learningRows(t.id)).toHaveLength(0);
    const ratings = getDb()
      .query<{ source: string; signal: number; taskId: string }, [string]>(
        "SELECT source, signal, taskId FROM memory_rating WHERE memoryId = ?",
      )
      .all(existing.memoryId);
    expect(ratings).toEqual([{ source: "learning-duplicate", signal: 1, taskId: t.id }]);
  });

  /** A curated swarm memory under `key`, with its embedding written now. */
  async function seedLongterm(key: string, embedding: Float32Array) {
    const memory = await getMemoryStore().store({
      agentId,
      scope: "swarm",
      source: "manual",
      name: key,
      content: `Curated knowledge at ${key}`,
      key,
    });
    await getMemoryStore().updateEmbedding(memory.id, embedding, "test-embedding");
    return memory;
  }

  for (const [label, key, axis] of [
    ["facts", "/longterm/facts/github/enqueue-unstable-pr-merge-queue", 50],
    ["entities", "/longterm/entities/people/someone", 60],
    ["workstreams", "/longterm/workstreams/active/some-workstream", 70],
  ] as const) {
    test(`a near duplicate of a /longterm/${label} memory is not stored`, async () => {
      const existing = await seedLongterm(key, vector(axis));
      const text = `Merge queue rule ${label}\nWhen a PR is unstable, enqueue it anyway.`;
      vectors.set(text, vector(axis, 0.86));
      const t = await task();
      const result = await call({ taskId: t.id, learning: text });

      expect(learningData(result)).toMatchObject({
        status: "duplicate",
        memoryId: existing.id,
        key,
      });
      expect(learningData(result)?.similarity).toBeCloseTo(0.86, 2);
      expect(learningRows(t.id)).toHaveLength(0);
      const ratings = getDb()
        .query<{ source: string }, [string]>("SELECT source FROM memory_rating WHERE memoryId = ?")
        .all(existing.id);
      expect(ratings).toEqual([{ source: "learning-duplicate" }]);
    });
  }

  test("a /longterm duplicate is found behind more than 4096 closer rows outside the prefixes", async () => {
    const existing = await seedLongterm("/longterm/facts/dedup/behind-the-cap", vector(200));
    const text = "Behind the KNN cap\nWhen 4096 rows are closer, still match.";
    const query = vector(200, 0.86);
    vectors.set(text, query);

    // Each noise row is query + a private axis: cosine 0.98 to the query, so
    // all of them outrank the 0.86 /longterm row in the vector index.
    const store = getMemoryStore();
    for (let i = 0; i < 4100; i++) {
      const noise = new Float32Array(EMBEDDING_DIMENSIONS);
      for (let d = 0; d < noise.length; d++) noise[d] = 0.98 * query[d]!;
      noise[300 + (i % 200)] = Math.sqrt(1 - 0.98 ** 2);
      const memory = await store.store({
        agentId,
        scope: "swarm",
        source: "manual",
        name: `noise ${i}`,
        content: `unrelated ${i}`,
        key: `/notes/noise/n-${i}`,
      });
      await store.updateEmbedding(memory.id, noise, "test-embedding");
    }

    const t = await task();
    const result = await call({ taskId: t.id, learning: text });
    expect(learningData(result)).toMatchObject({ status: "duplicate", memoryId: existing.id });
    expect(learningData(result)?.similarity).toBeCloseTo(0.86, 2);
    expect(learningRows(t.id)).toHaveLength(0);
  }, 120_000);

  /** Run `fn` with MEMORY_MIN_SIMILARITY set to `value`, then restore it. */
  async function withMinSimilarity<T>(value: string, fn: () => Promise<T>): Promise<T> {
    const original = process.env.MEMORY_MIN_SIMILARITY;
    process.env.MEMORY_MIN_SIMILARITY = value;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete process.env.MEMORY_MIN_SIMILARITY;
      else process.env.MEMORY_MIN_SIMILARITY = original;
    }
  }

  test("a /longterm duplicate is found when MEMORY_MIN_SIMILARITY is above the dedup threshold", async () => {
    const existing = await seedLongterm("/longterm/facts/dedup/above-the-floor", vector(80));
    const text = "Above the retrieval floor\nThe dedup threshold holds on its own.";
    vectors.set(text, vector(80, 0.86));
    const t = await task();
    const result = await withMinSimilarity("0.9", () => call({ taskId: t.id, learning: text }));

    expect(learningData(result)).toMatchObject({ status: "duplicate", memoryId: existing.id });
    expect(learningData(result)?.similarity).toBeCloseTo(0.86, 2);
    expect(learningRows(t.id)).toHaveLength(0);
  });

  for (const mode of ["vec", "fallback"] as const) {
    test(`a ${mode} memory search still drops a 0.86 row when MEMORY_MIN_SIMILARITY is 0.9`, async () => {
      const keyPrefix = `/longterm/facts/floor-${mode}/`;
      const existing = await seedLongterm(`${keyPrefix}row`, vector(mode === "vec" ? 90 : 94));
      const query = vector(mode === "vec" ? 90 : 94, 0.86);
      const store = getMemoryStore();
      const health = store.getHealth();
      expect(health.retrievalMode).toBe("vec");
      const healthSpy = spyOn(store, "getHealth").mockReturnValue({
        ...health,
        retrievalMode: mode,
      });
      const search = () => store.search(query, agentId, { scope: "swarm", keyPrefix, limit: 5 });
      try {
        // Control: under the default floor the same search returns the row.
        const unfiltered = await search();
        expect(unfiltered.map((c) => c.id)).toEqual([existing.id]);
        expect(unfiltered[0]?.retrievalSource).toBe(mode);
        expect(await withMinSimilarity("0.9", search)).toEqual([]);
      } finally {
        healthSpy.mockRestore();
      }
    });
  }

  test("a related learning below the threshold is stored", async () => {
    await seed("Retry flaky pushes once\nThe pre-push hook is slow.", vector(20));
    const text = "Pre-push hooks take five minutes\nLet them finish.";
    vectors.set(text, vector(20, 0.7));
    const t = await task();
    const result = await call({ taskId: t.id, learning: text });

    expect(learningData(result)?.status).toBe("stored");
    expect(learningRows(t.id)).toHaveLength(1);
  });

  test("a failed search falls through to the normal insert", async () => {
    await seed("Kebab keys only\nSlugs are lowercase.", vector(30));
    const text = "Keys are kebab case\nSlugs stay lowercase.";
    vectors.set(text, vector(30, 0.95));
    const searchSpy = spyOn(getMemoryStore(), "search").mockRejectedValue(new Error("vec down"));
    try {
      const t = await task();
      const result = await call({ taskId: t.id, progress: "kept", learning: text });
      expect(learningData(result)?.status).toBe("stored");
      expect(learningRows(t.id)).toHaveLength(1);
      expect((await getTaskById(t.id))?.progress).toBe("kept");
    } finally {
      searchSpy.mockRestore();
    }
  });

  test("an exact replay on the same task is replayed, not a duplicate", async () => {
    const text = "Replay before similarity\nThe same task retrying is not a duplicate.";
    const seeded = await seed(text, vector(40));
    const replay = await call({ taskId: seeded.task.id, learning: { text, workstream: "seeded" } });

    expect(learningData(replay)).toMatchObject({ status: "replayed", memoryId: seeded.memoryId });
    expect(learningRows(seeded.task.id)).toHaveLength(1);
  });
});

describe("store-progress learning expiry", () => {
  const DAY_MS = 86_400_000;

  function expiryRow(id: string) {
    return getDb()
      .query<{ createdAt: string; expiresAt: string | null }, [string]>(
        "SELECT createdAt, expiresAt FROM agent_memory WHERE id = ?",
      )
      .get(id);
  }

  test(`a new learning expires ${LEARNING_TTL_DAYS} days after it is created`, async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      learning: "Learnings age out\nWhen stored, expire.",
    });
    const row = expiryRow(learningData(result)!.memoryId!)!;

    expect(row.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const days = (Date.parse(row.expiresAt!) - Date.parse(row.createdAt)) / DAY_MS;
    expect(days).toBeGreaterThan(LEARNING_TTL_DAYS - 0.001);
    expect(days).toBeLessThan(LEARNING_TTL_DAYS + 0.001);
  });

  test("a /longterm memory and a non-learning manual memory never expire", async () => {
    const store = getMemoryStore();
    const base = { agentId, scope: "swarm" as const, source: "manual" as const, content: "x" };
    const longterm = await store.store({
      ...base,
      name: "curated",
      key: "/longterm/facts/expiry/curated",
    });
    const manual = await store.store({ ...base, name: "plain manual" });
    const nearMiss = await store.store({ ...base, name: "near miss", key: "/learnings-x/y" });

    for (const memory of [longterm, manual, nearMiss]) {
      expect(memory.expiresAt).toBeNull();
      expect(expiryRow(memory.id)?.expiresAt).toBeNull();
    }
  });

  test("an in-place edit keeps a learning's expiry; a move into /longterm clears it", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      learning: "Edit keeps expiry\nWhen edited, keep it.",
    });
    const id = learningData(result)!.memoryId!;
    const before = expiryRow(id)!.expiresAt;
    expect(before).not.toBeNull();

    const store = getMemoryStore();
    await store.edit({
      id,
      mode: "exact",
      oldString: "keep it",
      newString: "still keep it",
      intent: "test edit",
    });
    expect(expiryRow(id)?.expiresAt).toBe(before);

    await store.edit({
      id,
      mode: "exact",
      newKey: "/longterm/facts/expiry/promoted",
      intent: "promote",
    });
    expect(expiryRow(id)?.expiresAt).toBeNull();
  });

  function expectLearningTtl(expiresAt: string | null | undefined, from: number) {
    expect(expiresAt).not.toBeNull();
    const days = (Date.parse(expiresAt!) - from) / DAY_MS;
    expect(days).toBeGreaterThan(LEARNING_TTL_DAYS - 0.01);
    expect(days).toBeLessThan(LEARNING_TTL_DAYS + 0.01);
  }

  test("a move into /learnings starts the learning TTL on every chunk; a move out ends it", async () => {
    const store = getMemoryStore();
    const base = { agentId, scope: "swarm" as const, source: "manual" as const, name: "doc" };
    const chunks = [
      await store.store({
        ...base,
        content: "c0",
        key: "/notes/expiry/doc",
        chunkIndex: 0,
        totalChunks: 2,
      }),
      await store.store({
        ...base,
        content: "c1",
        key: "/notes/expiry/doc",
        chunkIndex: 1,
        totalChunks: 2,
      }),
    ];
    for (const chunk of chunks) expect(expiryRow(chunk.id)?.expiresAt).toBeNull();

    const movedAt = Date.now();
    const moved = await store.edit({
      id: chunks[1]!.id,
      mode: "exact",
      newKey: "/learnings/expiry/doc",
      intent: "demote to a learning",
    });
    expectLearningTtl(moved.memory.expiresAt, movedAt);
    for (const chunk of chunks) expect(expiryRow(chunk.id)?.expiresAt).toBe(moved.memory.expiresAt);

    const back = await store.edit({
      id: chunks[0]!.id,
      mode: "exact",
      newKey: "/notes/expiry/doc-kept",
      intent: "keep it after all",
    });
    expect(back.memory.expiresAt).toBeNull();
    for (const chunk of chunks) expect(expiryRow(chunk.id)?.expiresAt).toBeNull();
  });

  test("a learning moved out of /learnings past its deadline survives the purge", async () => {
    const t = await task();
    const result = await call({ taskId: t.id, learning: "Moved out\nWhen kept, survive GC." });
    const id = learningData(result)!.memoryId!;
    getDb().run("UPDATE agent_memory SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?", [
      id,
    ]);

    const store = getMemoryStore();
    await store.edit({ id, mode: "exact", newKey: "/notes/expiry/kept", intent: "keep" });
    await store.purgeExpired();
    expect(expiryRow(id)).toMatchObject({ expiresAt: null });
  });

  test("a move out of /learnings takes the source's own TTL; a move within keeps the deadline", async () => {
    const store = getMemoryStore();
    const completion = await store.store({
      agentId,
      scope: "swarm",
      source: "task_completion",
      name: "tc",
      content: "tc",
      key: "/learnings/expiry/tc",
    });
    const deadline = expiryRow(completion.id)!.expiresAt;

    const renamed = await store.edit({
      id: completion.id,
      mode: "exact",
      newKey: "/learnings/expiry/tc-renamed",
      intent: "rename",
    });
    expect(renamed.memory.expiresAt).toBe(deadline);
    expect(expiryRow(completion.id)?.expiresAt).toBe(deadline);

    const movedAt = Date.now();
    await store.edit({
      id: completion.id,
      mode: "exact",
      newKey: "/notes/expiry/tc",
      intent: "out",
    });
    const days = (Date.parse(expiryRow(completion.id)!.expiresAt!) - movedAt) / DAY_MS;
    expect(days).toBeGreaterThan(TTL_DEFAULTS.task_completion! - 0.01);
    expect(days).toBeLessThan(TTL_DEFAULTS.task_completion! + 0.01);
  });

  test("an expired learning is left out of search and removed by the purge", async () => {
    const t = await task();
    const result = await call({ taskId: t.id, learning: "Expired learning\nWhen past, drop it." });
    const id = learningData(result)!.memoryId!;
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS);
    embedding[90] = 1;
    const store = getMemoryStore();
    await store.updateEmbedding(id, embedding, "test-embedding");
    const search = () =>
      store.search(embedding, agentId, { scope: "swarm", keyPrefix: "/learnings/", limit: 50 });
    expect((await search()).map((hit) => hit.id)).toContain(id);

    getDb().run("UPDATE agent_memory SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?", [
      id,
    ]);
    expect((await search()).map((hit) => hit.id)).not.toContain(id);
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(expiryRow(id)).toBeNull();
  });
});

describe("279_backfill_learning_expiry", () => {
  test("sets createdAt + 30 days on learnings without an expiry and touches nothing else", async () => {
    const store = getMemoryStore();
    const base = { agentId, scope: "swarm" as const, source: "manual" as const, content: "y" };
    const legacy = await store.store({
      ...base,
      name: "legacy",
      key: "/learnings/backfill/legacy",
    });
    const preset = await store.store({
      ...base,
      name: "preset",
      key: "/learnings/backfill/preset",
    });
    const longterm = await store.store({ ...base, name: "lt", key: "/longterm/facts/backfill/lt" });
    const manual = await store.store({ ...base, name: "manual" });
    const nearMiss = await store.store({ ...base, name: "near", key: "/learnings-x/backfill" });
    const completion = await store.store({ ...base, name: "tc", source: "task_completion" });

    const db = getDb();
    const createdAt = "2026-10-26T09:15:00.123Z";
    db.run("UPDATE agent_memory SET expiresAt = NULL, createdAt = ? WHERE id = ?", [
      createdAt,
      legacy.id,
    ]);
    db.run("UPDATE agent_memory SET expiresAt = '2099-01-01T00:00:00.000Z' WHERE id = ?", [
      preset.id,
    ]);
    const before = new Map(
      [longterm, manual, nearMiss, completion].map((m) => [
        m.id,
        db
          .query<{ expiresAt: string | null }, [string]>(
            "SELECT expiresAt FROM agent_memory WHERE id = ?",
          )
          .get(m.id)?.expiresAt,
      ]),
    );

    const sql = await Bun.file(
      new URL("../be/migrations/279_backfill_learning_expiry.sql", import.meta.url),
    ).text();
    db.run(sql);

    const expiry = (id: string) =>
      db
        .query<{ expiresAt: string | null }, [string]>(
          "SELECT expiresAt FROM agent_memory WHERE id = ?",
        )
        .get(id)?.expiresAt;
    expect(expiry(legacy.id)).toBe("2026-11-25T09:15:00.123Z");
    expect(expiry(preset.id)).toBe("2099-01-01T00:00:00.000Z");
    for (const [id, value] of before) expect(expiry(id)).toBe(value);
  });
});

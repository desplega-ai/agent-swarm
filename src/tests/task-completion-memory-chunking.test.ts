import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb, startTask } from "../be/db";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import { taskCompletionMemoryKey } from "../be/memory/index-content";
import { rerank } from "../be/memory/reranker";
import type { MemoryCandidate } from "../be/memory/types";
import { runTaskTerminalEffects } from "../tasks/task-terminal-effects";
import type { Agent } from "../types";

const TEST_DB_PATH = "./test-task-completion-memory-chunking.sqlite";

let worker: Agent;
const embedded: string[] = [];

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  // Never hit the network: every input gets a valid vector.
  spyOn(getEmbeddingProvider(), "embed").mockImplementation(async (text: string) => {
    embedded.push(text);
    return new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1);
  });
  spyOn(getEmbeddingProvider(), "embedBatch").mockImplementation(async (texts: string[]) => {
    embedded.push(...texts);
    return texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1));
  });
  await createAgent({ name: "chunk-lead", isLead: true, status: "idle", capabilities: [] });
  worker = await createAgent({
    name: "chunk-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

type Row = {
  id: string;
  scope: string;
  key: string | null;
  content: string;
  chunkIndex: number;
  totalChunks: number;
  embedded: number;
};

async function rowsFor(taskId: string): Promise<Row[]> {
  return getDbClient().query<Row>(
    `SELECT id, scope, key, content, chunkIndex, totalChunks, embedding IS NOT NULL AS embedded
       FROM agent_memory WHERE sourceTaskId = ? AND source = 'task_completion'
      ORDER BY scope, chunkIndex`,
    [taskId],
  );
}

async function waitForEmbedded(taskId: string, ms = 3000): Promise<Row[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows = await rowsFor(taskId);
    if (rows.length > 0 && rows.every((r) => r.embedded)) return rows;
    await Bun.sleep(20);
  }
  return rowsFor(taskId);
}

/** ~60k chars in paragraphs, the shape of a long dreaming-run output. */
function longOutput(): string {
  return Array.from(
    { length: 300 },
    (_, i) => `Paragraph ${i}: ${crypto.randomUUID()} ${"lane finding ".repeat(12)}`,
  ).join("\n\n");
}

describe("task_completion memory goes through chunking", () => {
  test("a long output is stored as chunks of one document, each with an embedding", async () => {
    const task = await createTaskExtended("dreaming-v2 run: publish the nightly report", {
      agentId: worker.id,
      taskType: "research",
    });
    await startTask(task.id);
    const output = longOutput();

    await runTaskTerminalEffects({
      task,
      status: "completed",
      output,
      agentId: worker.id,
      persistMemory: true,
    });

    const rows = await waitForEmbedded(task.id);
    const agentRows = rows.filter((r) => r.scope === "agent");
    const swarmRows = rows.filter((r) => r.scope === "swarm");

    expect(agentRows.length).toBeGreaterThan(1);
    expect(swarmRows.length).toBeGreaterThan(1);
    for (const scoped of [agentRows, swarmRows]) {
      expect(scoped.map((r) => r.chunkIndex)).toEqual(scoped.map((_, i) => i));
      expect(new Set(scoped.map((r) => r.totalChunks))).toEqual(new Set([scoped.length]));
    }
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set([taskCompletionMemoryKey(task.id)]));
    expect(rows.every((r) => r.embedded)).toBe(true);
    for (const row of rows) expect(row.content.length).toBeLessThanOrEqual(2_200);
    expect(agentRows[0]!.content).toContain("Task: dreaming-v2 run");
    expect(Math.max(...embedded.map((t) => t.length))).toBeLessThanOrEqual(2_200);
  });

  test("a short output stays one row, keyed to its task", async () => {
    const task = await createTaskExtended("short task", { agentId: worker.id });
    await startTask(task.id);

    await runTaskTerminalEffects({
      task,
      status: "completed",
      output: "done, nothing else to report",
      agentId: worker.id,
      persistMemory: true,
    });

    const rows = await waitForEmbedded(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "agent",
      key: taskCompletionMemoryKey(task.id),
      chunkIndex: 0,
      totalChunks: 1,
      embedded: 1,
    });
  });
});

describe("rerank collapses chunks of one task", () => {
  function candidate(overrides: Partial<MemoryCandidate>): MemoryCandidate {
    return {
      id: crypto.randomUUID(),
      agentId: worker.id,
      scope: "agent",
      name: "Task: x",
      content: "x",
      summary: null,
      source: "task_completion",
      sourceTaskId: null,
      sourcePath: null,
      key: null,
      chunkIndex: 0,
      totalChunks: 1,
      tags: [],
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      accessCount: 0,
      expiresAt: null,
      embeddingModel: null,
      alpha: 1,
      beta: 1,
      similarity: 0.5,
      ...overrides,
    };
  }

  test("keeps the best chunk per task document and fills the limit with other memories", () => {
    const keyA = taskCompletionMemoryKey("aaaa");
    const keyB = taskCompletionMemoryKey("bbbb");
    const chunksA = [0.9, 0.85, 0.8, 0.75].map((similarity, chunkIndex) =>
      candidate({ key: keyA, chunkIndex, totalChunks: 4, similarity }),
    );
    const chunkB = candidate({ key: keyB, chunkIndex: 2, totalChunks: 3, similarity: 0.7 });
    const swarmCopyA = candidate({ key: keyA, scope: "swarm", totalChunks: 4, similarity: 0.65 });
    const manual = candidate({ source: "manual", key: "/longterm/facts/x", similarity: 0.3 });

    const ranked = rerank([...chunksA, chunkB, swarmCopyA, manual], { limit: 4 });

    expect(new Set(ranked.map((r) => r.id))).toEqual(
      new Set([chunksA[0]!.id, chunkB.id, swarmCopyA.id, manual.id]),
    );
  });

  test("manual chunks and single-chunk task rows are left alone", () => {
    const manualChunks = [0.9, 0.8].map((similarity, chunkIndex) =>
      candidate({
        source: "manual",
        key: "/longterm/facts/y",
        chunkIndex,
        totalChunks: 2,
        similarity,
      }),
    );
    const legacy = [0.7, 0.6].map((similarity) => candidate({ key: null, similarity }));

    const ranked = rerank([...manualChunks, ...legacy], { limit: 10 });

    expect(ranked).toHaveLength(4);
  });
});

async function waitForRows(
  taskId: string,
  done: (rows: Row[]) => boolean,
  ms = 3000,
): Promise<Row[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows = await rowsFor(taskId);
    if (done(rows)) return rows;
    await Bun.sleep(20);
  }
  return rowsFor(taskId);
}

async function hasTable(name: string): Promise<boolean> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?",
    [name],
  );
  return (row?.n ?? 0) > 0;
}

/** Rows left behind for memory ids that no longer exist. */
async function orphanCounts(): Promise<Record<string, number>> {
  const db = getDbClient();
  const count = async (sql: string) => (await db.get<{ n: number }>(sql))?.n ?? 0;
  const counts: Record<string, number> = {
    versions: await count(
      "SELECT COUNT(*) AS n FROM agent_memory_version WHERE memory_id NOT IN (SELECT id FROM agent_memory)",
    ),
  };
  if (await hasTable("memory_fts")) {
    counts.fts = await count(
      "SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id NOT IN (SELECT id FROM agent_memory)",
    );
  }
  if (await hasTable("memory_vec")) {
    counts.vec = await count(
      "SELECT COUNT(*) AS n FROM memory_vec WHERE memory_id NOT IN (SELECT id FROM agent_memory)",
    );
  }
  return counts;
}

describe("re-persisting a task replaces its document", () => {
  test("long -> short -> long replaces each scope's chunks, no duplicates or orphans", async () => {
    const task = await createTaskExtended("research: rewrite the memory report", {
      agentId: worker.id,
      taskType: "research",
    });
    await startTask(task.id);
    const key = taskCompletionMemoryKey(task.id);
    const persist = (output: string) =>
      runTaskTerminalEffects({
        task,
        status: "completed",
        output,
        agentId: worker.id,
        persistMemory: true,
      });
    const scoped = (rows: Row[], scope: string) => rows.filter((r) => r.scope === scope);

    await persist(longOutput());
    const first = await waitForRows(
      task.id,
      (rows) =>
        scoped(rows, "agent").length > 1 &&
        scoped(rows, "swarm").length > 1 &&
        rows.every((r) => r.embedded),
    );
    expect(scoped(first, "agent").length).toBeGreaterThan(1);
    expect(scoped(first, "swarm").length).toBeGreaterThan(1);

    // Another owner's document under the same key must survive the replace.
    const foreign = await getMemoryStore().store({
      agentId: crypto.randomUUID(),
      scope: "agent",
      name: "Task: someone else's run",
      content: "another owner's completion of the same task",
      source: "task_completion",
      sourceTaskId: task.id,
      key,
    });

    await persist("short re-run answer");
    const second = await waitForRows(
      task.id,
      (rows) => rows.length === 3 && rows.every((r) => r.embedded || r.id === foreign.id),
    );
    const mine = second.filter((r) => r.id !== foreign.id);
    expect(mine.map((r) => [r.scope, r.chunkIndex, r.totalChunks])).toEqual([
      ["agent", 0, 1],
      ["swarm", 0, 1],
    ]);
    for (const row of mine) expect(row.content).toContain("short re-run answer");
    expect(second.some((r) => r.id === foreign.id)).toBe(true);
    const oldIds = new Set(first.map((r) => r.id));
    expect(second.filter((r) => oldIds.has(r.id))).toEqual([]);

    await persist(longOutput());
    const third = await waitForRows(
      task.id,
      (rows) =>
        scoped(rows, "agent").length > 2 && rows.every((r) => r.embedded || r.id === foreign.id),
    );
    for (const scope of ["agent", "swarm"]) {
      const rows = scoped(third, scope).filter((r) => r.id !== foreign.id);
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));
      expect(new Set(rows.map((r) => r.totalChunks))).toEqual(new Set([rows.length]));
    }

    const duplicates = await getDbClient().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM agent_memory WHERE key = ?
          GROUP BY scope, COALESCE(agentId, ''), chunkIndex HAVING COUNT(*) > 1)`,
      [key],
    );
    expect(duplicates?.n).toBe(0);
    const orphans = await orphanCounts();
    for (const n of Object.values(orphans)) expect(n).toBe(0);
  });

  test("an embedding that lands after its row was replaced writes no vec row", async () => {
    const store = getMemoryStore();
    const memory = await store.store({
      agentId: worker.id,
      scope: "agent",
      name: "replaced before embed",
      content: "a chunk whose background embed finishes after a re-persist",
      source: "task_completion",
    });
    await store.delete(memory.id);

    await store.updateEmbedding(memory.id, new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1), "t");

    expect(await hasTable("memory_vec")).toBe(true);
    const vec = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memory_vec WHERE memory_id = ?",
      [memory.id],
    );
    expect(vec?.n).toBe(0);
  });

  test("an embedding racing a replace leaves no orphan vec row", async () => {
    const store = getMemoryStore();
    const task = await createTaskExtended("embed races replace", { agentId: worker.id });
    const input = {
      agentId: worker.id,
      scope: "agent" as const,
      name: "race",
      content: "original completion",
      source: "task_completion" as const,
      key: taskCompletionMemoryKey(task.id),
    };
    const memory = await store.store(input);
    const vector = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1);
    await store.updateEmbedding(memory.id, vector, "t");

    // The background embed of the old row is in flight when the re-persist
    // lands: the replace must not slip between its row UPDATE and vec insert.
    const [, replaced] = await Promise.all([
      store.updateEmbedding(memory.id, vector, "t"),
      store.replaceDocument(input, [{ ...input, content: "new completion" }]),
    ]);

    expect(await store.peek(memory.id)).toBeNull();
    expect(replaced.map((r) => r.content)).toEqual(["new completion"]);
    expect(await hasTable("memory_vec")).toBe(true);
    const orphans = await orphanCounts();
    for (const n of Object.values(orphans)) expect(n).toBe(0);
  });

  test("a document under the key from another source is not deleted", async () => {
    const task = await createTaskExtended("keyed manual collision", { agentId: worker.id });
    await startTask(task.id);
    const manual = await getMemoryStore().store({
      agentId: worker.id,
      scope: "agent",
      name: "manual note",
      content: "a manual memory that happens to use the task key",
      source: "manual",
      key: taskCompletionMemoryKey(task.id),
    });

    await runTaskTerminalEffects({
      task,
      status: "completed",
      output: "the task output that collides with the manual key",
      agentId: worker.id,
      persistMemory: true,
    });
    await Bun.sleep(200);

    expect((await getMemoryStore().peek(manual.id))?.content).toBe(manual.content);
  });
});

describe("structured completion output keeps every section", () => {
  test("100 markdown sections with short findings are all stored", async () => {
    const task = await createTaskExtended(
      "structured findings report: summarize every lane with one line each",
      { agentId: worker.id },
    );
    await startTask(task.id);
    const output = Array.from({ length: 100 }, (_, i) => `## Lane ${i}\n\nfinding-${i} holds`).join(
      "\n\n",
    );

    await runTaskTerminalEffects({
      task,
      status: "completed",
      output,
      agentId: worker.id,
      persistMemory: true,
    });

    const rows = await waitForRows(task.id, (r) => r.length > 0 && r.every((x) => x.embedded));
    const stored = rows.map((r) => r.content).join("\n");
    const missing = Array.from({ length: 100 }, (_, i) => `finding-${i} holds`).filter(
      (finding) => !stored.includes(finding),
    );
    expect(missing).toEqual([]);
    expect(stored).toContain("## Lane 99");
    for (const row of rows) expect(row.content.length).toBeLessThanOrEqual(2_200);
    // Packed into a few chunks, not one row per three-word section.
    expect(rows.length).toBeLessThan(10);
  });
});

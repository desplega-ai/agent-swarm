import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { applyRating, ExplicitSelfDuplicateError } from "../be/memory/raters/store";
import type { RatingEvent } from "../be/memory/raters/types";

const TEST_DB_PATH = "./test-memory-rater-store.sqlite";

describe("applyRating", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000001";
  const taskId = "00000000-0000-4000-8000-000000001234";
  const taskIdAlt = "00000000-0000-4000-8000-000000abcdef";
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    await initDb(TEST_DB_PATH);
    await createAgent({ id: agentA, name: "Test Agent A", isLead: false, status: "idle" });
    // Real agent_tasks rows so the memory_rating.taskId FK passes.
    const insertTask = (await getDb()).prepare(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    );
    const nowIso = new Date().toISOString();
    insertTask.run(taskId, agentA, "test task", nowIso, nowIso);
    insertTask.run(taskIdAlt, agentA, "test task alt", nowIso, nowIso);
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  beforeEach(async () => {
    // Reset memory_rating between tests so the partial unique index for
    // explicit-self doesn't leak between cases.
    (await getDb()).run("DELETE FROM memory_rating");
    // Reset Beta posteriors to (1,1) so each test starts from the prior.
    (await getDb()).run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
  });

  async function makeMemory(name: string): Promise<{ id: string }> {
    const memory = await store.store({
      agentId: agentA,
      scope: "agent",
      name,
      content: `${name} content`,
      source: "manual",
    });
    return { id: memory.id };
  }

  async function readPosterior(id: string): Promise<{ alpha: number; beta: number }> {
    const row = (await getDb())
      .prepare<{ alpha: number; beta: number }, [string]>(
        "SELECT alpha, beta FROM agent_memory WHERE id = ?",
      )
      .get(id);
    if (!row) throw new Error(`memory ${id} not found`);
    return { alpha: row.alpha, beta: row.beta };
  }

  async function countRatings(memoryId: string): Promise<number> {
    const row = (await getDb())
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM memory_rating WHERE memoryId = ?",
      )
      .get(memoryId);
    return row?.n ?? 0;
  }

  test("signal=+1, weight=1 → alpha += 1, beta += 0; audit row written", async () => {
    const m = await makeMemory("positive");
    const events: RatingEvent[] = [{ memoryId: m.id, signal: 1, weight: 1, source: "test" }];
    const result = await applyRating(events);
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(await readPosterior(m.id)).toEqual({ alpha: 2, beta: 1 });
    expect(await countRatings(m.id)).toBe(1);
  });

  test("signal=-1, weight=0.5 → alpha += 0, beta += 0.5", async () => {
    const m = await makeMemory("negative");
    const result = await applyRating([{ memoryId: m.id, signal: -1, weight: 0.5, source: "test" }]);
    expect(result.applied).toBe(1);
    expect(await readPosterior(m.id)).toEqual({ alpha: 1, beta: 1.5 });
  });

  test("signal=0 → no posterior movement, audit row still written", async () => {
    const m = await makeMemory("neutral");
    const result = await applyRating([{ memoryId: m.id, signal: 0, weight: 1, source: "test" }]);
    expect(result.applied).toBe(1);
    expect(await readPosterior(m.id)).toEqual({ alpha: 1, beta: 1 });
    expect(await countRatings(m.id)).toBe(1);
  });

  test("batch of mixed signals applies in one transaction", async () => {
    const a = await makeMemory("a");
    const b = await makeMemory("b");
    const result = await applyRating([
      { memoryId: a.id, signal: 1, weight: 1, source: "rater-x" },
      { memoryId: b.id, signal: -0.5, weight: 1, source: "rater-x" },
    ]);
    expect(result.applied).toBe(2);
    expect(await readPosterior(a.id)).toEqual({ alpha: 2, beta: 1 });
    expect(await readPosterior(b.id)).toEqual({ alpha: 1, beta: 1.5 });
  });

  test("commutativity: parallel applies sum to deterministic posterior", async () => {
    const m = await makeMemory("hot");
    const events: RatingEvent[] = Array.from({ length: 20 }, () => ({
      memoryId: m.id,
      signal: 1,
      weight: 0.1,
      source: "rater-x",
    }));
    await Promise.all(events.map(async (e) => Promise.resolve(await applyRating([e]))));
    const post = await readPosterior(m.id);
    expect(post.alpha).toBeCloseTo(1 + 20 * 0.1, 5);
    expect(post.beta).toBe(1);
    expect(await countRatings(m.id)).toBe(20);
  });

  test("out-of-range signal=2 → returned in rejected[], no DB write", async () => {
    const m = await makeMemory("oor-signal");
    const result = await applyRating([{ memoryId: m.id, signal: 2, weight: 1, source: "test" }]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/signal/);
    expect(await readPosterior(m.id)).toEqual({ alpha: 1, beta: 1 });
    expect(await countRatings(m.id)).toBe(0);
  });

  test("out-of-range weight=-1 → returned in rejected[], no DB write", async () => {
    const m = await makeMemory("oor-weight");
    const result = await applyRating([{ memoryId: m.id, signal: 1, weight: -1, source: "test" }]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/weight/);
    expect(await countRatings(m.id)).toBe(0);
  });

  test("missing memoryId → returned in rejected[], no DB write", async () => {
    const result = await applyRating([
      {
        memoryId: "00000000-0000-4000-8000-deadbeefdead",
        signal: 1,
        weight: 1,
        source: "test",
      },
    ]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/not found/i);
  });

  test("missing source → returned in rejected[]", async () => {
    const m = await makeMemory("no-source");
    const result = await applyRating([{ memoryId: m.id, signal: 1, weight: 1, source: "" }]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/source/);
  });

  test("partial batch: invalid events rejected, valid ones applied", async () => {
    const a = await makeMemory("a-part");
    const b = await makeMemory("b-part");
    const result = await applyRating([
      { memoryId: a.id, signal: 1, weight: 1, source: "test" },
      { memoryId: b.id, signal: 5, weight: 1, source: "test" }, // out of range
      { memoryId: a.id, signal: -0.5, weight: 0.5, source: "test" },
    ]);
    expect(result.applied).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(await readPosterior(a.id)).toEqual({ alpha: 2, beta: 1.25 });
    expect(await readPosterior(b.id)).toEqual({ alpha: 1, beta: 1 });
  });

  test("explicit-self duplicate raises ExplicitSelfDuplicateError", async () => {
    const m = await makeMemory("explicit");
    const event: RatingEvent = {
      memoryId: m.id,
      signal: 1,
      weight: 1,
      source: "explicit-self",
    };

    // First write succeeds.
    expect((await applyRating([event], { taskId })).applied).toBe(1);

    // Second write hits the partial unique index.
    expect(async () => await applyRating([event], { taskId })).toThrow(ExplicitSelfDuplicateError);

    // Posterior moved exactly once.
    expect(await readPosterior(m.id)).toEqual({ alpha: 2, beta: 1 });
  });

  test("empty batch → applied=0, no DB calls, no error", async () => {
    const result = await applyRating([]);
    expect(result).toEqual({ applied: 0, rejected: [] });
  });

  test("audit row carries source, signal, weight, reasoning, taskId", async () => {
    const m = await makeMemory("audit");
    await applyRating(
      [
        {
          memoryId: m.id,
          signal: 0.7,
          weight: 0.4,
          source: "test-rater",
          reasoning: "because reasons",
        },
      ],
      { taskId: taskIdAlt },
    );
    const row = (await getDb())
      .prepare<
        {
          memoryId: string;
          taskId: string | null;
          source: string;
          signal: number;
          weight: number;
          reasoning: string | null;
        },
        [string]
      >(
        "SELECT memoryId, taskId, source, signal, weight, reasoning FROM memory_rating WHERE memoryId = ?",
      )
      .get(m.id);
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe(taskIdAlt);
    expect(row!.source).toBe("test-rater");
    expect(row!.signal).toBe(0.7);
    expect(row!.weight).toBe(0.4);
    expect(row!.reasoning).toBe("because reasons");
  });
});

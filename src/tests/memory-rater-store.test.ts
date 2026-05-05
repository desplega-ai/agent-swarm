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
    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "Test Agent A", isLead: false, status: "idle" });
    // Real agent_tasks rows so the memory_rating.taskId FK passes.
    const insertTask = getDb().prepare(
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

  beforeEach(() => {
    // Reset memory_rating between tests so the partial unique index for
    // explicit-self doesn't leak between cases.
    getDb().run("DELETE FROM memory_rating");
    // Reset Beta posteriors to (1,1) so each test starts from the prior.
    getDb().run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
  });

  function makeMemory(name: string): { id: string } {
    const memory = store.store({
      agentId: agentA,
      scope: "agent",
      name,
      content: `${name} content`,
      source: "manual",
    });
    return { id: memory.id };
  }

  function readPosterior(id: string): { alpha: number; beta: number } {
    const row = getDb()
      .prepare<{ alpha: number; beta: number }, [string]>(
        "SELECT alpha, beta FROM agent_memory WHERE id = ?",
      )
      .get(id);
    if (!row) throw new Error(`memory ${id} not found`);
    return { alpha: row.alpha, beta: row.beta };
  }

  function countRatings(memoryId: string): number {
    const row = getDb()
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM memory_rating WHERE memoryId = ?",
      )
      .get(memoryId);
    return row?.n ?? 0;
  }

  test("signal=+1, weight=1 → alpha += 1, beta += 0; audit row written", () => {
    const m = makeMemory("positive");
    const events: RatingEvent[] = [{ memoryId: m.id, signal: 1, weight: 1, source: "test" }];
    const result = applyRating(events);
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(readPosterior(m.id)).toEqual({ alpha: 2, beta: 1 });
    expect(countRatings(m.id)).toBe(1);
  });

  test("signal=-1, weight=0.5 → alpha += 0, beta += 0.5", () => {
    const m = makeMemory("negative");
    const result = applyRating([{ memoryId: m.id, signal: -1, weight: 0.5, source: "test" }]);
    expect(result.applied).toBe(1);
    expect(readPosterior(m.id)).toEqual({ alpha: 1, beta: 1.5 });
  });

  test("signal=0 → no posterior movement, audit row still written", () => {
    const m = makeMemory("neutral");
    const result = applyRating([{ memoryId: m.id, signal: 0, weight: 1, source: "test" }]);
    expect(result.applied).toBe(1);
    expect(readPosterior(m.id)).toEqual({ alpha: 1, beta: 1 });
    expect(countRatings(m.id)).toBe(1);
  });

  test("batch of mixed signals applies in one transaction", () => {
    const a = makeMemory("a");
    const b = makeMemory("b");
    const result = applyRating([
      { memoryId: a.id, signal: 1, weight: 1, source: "rater-x" },
      { memoryId: b.id, signal: -0.5, weight: 1, source: "rater-x" },
    ]);
    expect(result.applied).toBe(2);
    expect(readPosterior(a.id)).toEqual({ alpha: 2, beta: 1 });
    expect(readPosterior(b.id)).toEqual({ alpha: 1, beta: 1.5 });
  });

  test("commutativity: parallel applies sum to deterministic posterior", async () => {
    const m = makeMemory("hot");
    const events: RatingEvent[] = Array.from({ length: 20 }, () => ({
      memoryId: m.id,
      signal: 1,
      weight: 0.1,
      source: "rater-x",
    }));
    await Promise.all(events.map((e) => Promise.resolve(applyRating([e]))));
    const post = readPosterior(m.id);
    expect(post.alpha).toBeCloseTo(1 + 20 * 0.1, 5);
    expect(post.beta).toBe(1);
    expect(countRatings(m.id)).toBe(20);
  });

  test("out-of-range signal=2 → returned in rejected[], no DB write", () => {
    const m = makeMemory("oor-signal");
    const result = applyRating([{ memoryId: m.id, signal: 2, weight: 1, source: "test" }]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/signal/);
    expect(readPosterior(m.id)).toEqual({ alpha: 1, beta: 1 });
    expect(countRatings(m.id)).toBe(0);
  });

  test("out-of-range weight=-1 → returned in rejected[], no DB write", () => {
    const m = makeMemory("oor-weight");
    const result = applyRating([{ memoryId: m.id, signal: 1, weight: -1, source: "test" }]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/weight/);
    expect(countRatings(m.id)).toBe(0);
  });

  test("missing memoryId → returned in rejected[], no DB write", () => {
    const result = applyRating([
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

  test("missing source → returned in rejected[]", () => {
    const m = makeMemory("no-source");
    const result = applyRating([{ memoryId: m.id, signal: 1, weight: 1, source: "" }]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/source/);
  });

  test("partial batch: invalid events rejected, valid ones applied", () => {
    const a = makeMemory("a-part");
    const b = makeMemory("b-part");
    const result = applyRating([
      { memoryId: a.id, signal: 1, weight: 1, source: "test" },
      { memoryId: b.id, signal: 5, weight: 1, source: "test" }, // out of range
      { memoryId: a.id, signal: -0.5, weight: 0.5, source: "test" },
    ]);
    expect(result.applied).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(readPosterior(a.id)).toEqual({ alpha: 2, beta: 1.25 });
    expect(readPosterior(b.id)).toEqual({ alpha: 1, beta: 1 });
  });

  test("explicit-self duplicate raises ExplicitSelfDuplicateError", () => {
    const m = makeMemory("explicit");
    const event: RatingEvent = {
      memoryId: m.id,
      signal: 1,
      weight: 1,
      source: "explicit-self",
    };

    // First write succeeds.
    expect(applyRating([event], { taskId }).applied).toBe(1);

    // Second write hits the partial unique index.
    expect(() => applyRating([event], { taskId })).toThrow(ExplicitSelfDuplicateError);

    // Posterior moved exactly once.
    expect(readPosterior(m.id)).toEqual({ alpha: 2, beta: 1 });
  });

  test("empty batch → applied=0, no DB calls, no error", () => {
    const result = applyRating([]);
    expect(result).toEqual({ applied: 0, rejected: [] });
  });

  test("audit row carries source, signal, weight, reasoning, taskId", () => {
    const m = makeMemory("audit");
    applyRating(
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
    const row = getDb()
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

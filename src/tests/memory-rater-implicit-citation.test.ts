import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createSessionLogs, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { ImplicitCitationRater } from "../be/memory/raters/implicit-citation";
import {
  getRaterWeightMultiplier,
  getRegisteredRaters,
  SERVER_RATERS,
} from "../be/memory/raters/registry";
import { getRetrievalsForTask, recordRetrievals } from "../be/memory/raters/retrieval";
import { applyRating } from "../be/memory/raters/store";
import type { RatingEvent } from "../be/memory/raters/types";

const TEST_DB_PATH = "./test-memory-rater-implicit-citation.sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// Pure-function unit tests — no DB required for these. Plan §7.
// ─────────────────────────────────────────────────────────────────────────────

describe("ImplicitCitationRater (pure)", () => {
  const rater = new ImplicitCitationRater();

  test("name is 'implicit-citation'", () => {
    expect(rater.name).toBe("implicit-citation");
  });

  test("hit + miss: emits +1 weight=0.5 for cited memory, -1 weight=0.25 for uncited", async () => {
    const events = await rater.rate({
      agentId: "agent-x",
      taskId: "task-y",
      retrievedMemoryIds: ["mem-A", "mem-B"],
      evidence: "I used mem-A here when solving the task.",
    });
    expect(events).toHaveLength(2);
    const a = events.find((e) => e.memoryId === "mem-A")!;
    const b = events.find((e) => e.memoryId === "mem-B")!;
    expect(a).toEqual({ memoryId: "mem-A", signal: 1, weight: 0.5, source: "" });
    expect(b).toEqual({ memoryId: "mem-B", signal: -1, weight: 0.25, source: "" });
  });

  test("rater leaves source empty — framework stamps it (anti-spoof)", async () => {
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-X"],
      evidence: "mem-X cited",
    });
    expect(events[0]!.source).toBe("");
  });

  test("empty evidence → all misses (negative)", async () => {
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-A", "mem-B", "mem-C"],
      evidence: "",
    });
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.signal).toBe(-1);
      expect(e.weight).toBe(0.25);
    }
  });

  test("null evidence → all misses (negative)", async () => {
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-A"],
      evidence: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.signal).toBe(-1);
  });

  test("empty retrievedMemoryIds → no events", async () => {
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: [],
      evidence: "anything",
    });
    expect(events).toEqual([]);
  });

  test("substring-prefix collision: citing 'mem-AB' counts as a hit for 'mem-A'", async () => {
    // Documented behaviour: literal substring match. UUID call sites never
    // collide; this test locks the rule for synthetic IDs so a future change
    // (e.g. word-boundary regex) is intentional.
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-A", "mem-AB"],
      evidence: "mem-AB only",
    });
    const a = events.find((e) => e.memoryId === "mem-A")!;
    const ab = events.find((e) => e.memoryId === "mem-AB")!;
    expect(a.signal).toBe(1);
    expect(ab.signal).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — DB-backed end-to-end through the same path as
// store-progress.ts §5 fires.
// ─────────────────────────────────────────────────────────────────────────────

describe("retrieval → ImplicitCitationRater → posterior shift", () => {
  const agentId = "aaaa0000-0000-4000-8000-000000000ic1";
  const taskId = "00000000-0000-4000-8000-0000000ic001";
  const taskIdMiss = "00000000-0000-4000-8000-0000000ic002";
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentId, name: "Citation Test Agent", isLead: false, status: "idle" });
    const insertTask = getDb().prepare(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    );
    const nowIso = new Date().toISOString();
    insertTask.run(taskId, agentId, "test task with citation", nowIso, nowIso);
    insertTask.run(taskIdMiss, agentId, "test task without citation", nowIso, nowIso);
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
    getDb().run("DELETE FROM memory_rating");
    getDb().run("DELETE FROM memory_retrieval");
    getDb().run("DELETE FROM session_logs");
    getDb().run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
  });

  function makeMemory(name: string): { id: string } {
    const memory = store.store({
      agentId,
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

  function getRatings(taskId: string) {
    return getDb()
      .prepare<
        {
          memoryId: string;
          source: string;
          signal: number;
          weight: number;
        },
        [string]
      >("SELECT memoryId, source, signal, weight FROM memory_rating WHERE taskId = ?")
      .all(taskId);
  }

  test("recordRetrievals writes one row per result for the task", () => {
    const m1 = makeMemory("retrieval-target-1");
    const m2 = makeMemory("retrieval-target-2");
    recordRetrievals(taskId, agentId, [
      { memoryId: m1.id, similarity: 0.9 },
      { memoryId: m2.id, similarity: 0.7 },
    ]);
    const rows = getRetrievalsForTask(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.memoryId).sort()).toEqual([m1.id, m2.id].sort());
  });

  test("recordRetrievals groups rows from one call and stamps result rank", () => {
    const first = makeMemory("retrieval-group-first");
    const second = makeMemory("retrieval-group-second");
    const third = makeMemory("retrieval-group-third");

    recordRetrievals(taskId, agentId, [
      { memoryId: first.id, similarity: 0.9 },
      { memoryId: second.id, similarity: 0.8 },
    ]);
    recordRetrievals(taskId, agentId, [{ memoryId: third.id, similarity: 0.7 }]);

    const rows = getDb()
      .prepare<{ memoryId: string; retrievalId: string | null; rank: number | null }, [string]>(
        "SELECT memoryId, retrievalId, rank FROM memory_retrieval WHERE taskId = ?",
      )
      .all(taskId);

    expect(rows).toHaveLength(3);
    const byMemoryId = new Map(rows.map((row) => [row.memoryId, row]));
    const firstRow = byMemoryId.get(first.id)!;
    const secondRow = byMemoryId.get(second.id)!;
    const thirdRow = byMemoryId.get(third.id)!;
    expect(firstRow.retrievalId).toBeTruthy();
    expect(secondRow.retrievalId).toBe(firstRow.retrievalId);
    expect(firstRow.rank).toBe(0);
    expect(secondRow.rank).toBe(1);
    expect(thirdRow.retrievalId).toBeTruthy();
    expect(thirdRow.retrievalId).not.toBe(firstRow.retrievalId);
    expect(thirdRow.rank).toBe(0);
  });

  test("recordRetrievals is a no-op when taskId is undefined", () => {
    const m = makeMemory("no-task");
    recordRetrievals(undefined, agentId, [{ memoryId: m.id, similarity: 0.9 }]);
    const rows = getDb().prepare("SELECT COUNT(*) as n FROM memory_retrieval").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  test("recordRetrievals is a no-op when results is empty", () => {
    recordRetrievals(taskId, agentId, []);
    const rows = getDb().prepare("SELECT COUNT(*) as n FROM memory_retrieval").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  test("end-to-end: cited memory shifts alpha by 0.5; uncited memory shifts beta by 0.25", async () => {
    const cited = makeMemory("cited");
    const uncited = makeMemory("uncited");

    // 1. Search-time: log the retrievals.
    recordRetrievals(taskId, agentId, [
      { memoryId: cited.id, similarity: 0.9 },
      { memoryId: uncited.id, similarity: 0.85 },
    ]);

    // 2. During the task: session_logs accumulate text mentioning ONE of them.
    createSessionLogs({
      taskId,
      sessionId: "session-1",
      iteration: 1,
      cli: "claude",
      lines: [`Looking up memory ${cited.id} for context.`, "Doing the work."],
    });

    // 3. Task completion: simulate the store-progress server-rater fire.
    const retrievals = getRetrievalsForTask(taskId);
    const retrievedMemoryIds = retrievals.map((r) => r.memoryId);
    const evidence = getDb()
      .prepare<{ content: string }, [string]>(
        "SELECT content FROM session_logs WHERE taskId = ? ORDER BY iteration, lineNumber",
      )
      .all(taskId)
      .map((row) => row.content)
      .join("\n");

    const rater = new ImplicitCitationRater();
    const events = await rater.rate({
      taskId,
      agentId,
      retrievedMemoryIds,
      evidence,
    });
    const stamped: RatingEvent[] = events.map((e) => ({ ...e, source: rater.name }));
    const result = applyRating(stamped, { taskId });
    expect(result.applied).toBe(2);

    // 4. Posteriors moved as documented.
    expect(readPosterior(cited.id)).toEqual({ alpha: 1.5, beta: 1.0 });
    expect(readPosterior(uncited.id)).toEqual({ alpha: 1.0, beta: 1.25 });

    // 5. Audit rows written with `source = 'implicit-citation'`.
    const ratings = getRatings(taskId);
    expect(ratings).toHaveLength(2);
    for (const r of ratings) {
      expect(r.source).toBe("implicit-citation");
    }
    const citedRow = ratings.find((r) => r.memoryId === cited.id)!;
    const uncitedRow = ratings.find((r) => r.memoryId === uncited.id)!;
    expect(citedRow).toMatchObject({ signal: 1, weight: 0.5 });
    expect(uncitedRow).toMatchObject({ signal: -1, weight: 0.25 });
  });

  test("negative path: no citation in session_logs → only beta moves", async () => {
    const m = makeMemory("never-cited");
    recordRetrievals(taskIdMiss, agentId, [{ memoryId: m.id, similarity: 0.9 }]);
    createSessionLogs({
      taskId: taskIdMiss,
      sessionId: "session-2",
      iteration: 1,
      cli: "claude",
      lines: ["completely unrelated content"],
    });

    const rater = new ImplicitCitationRater();
    const events = await rater.rate({
      taskId: taskIdMiss,
      agentId,
      retrievedMemoryIds: [m.id],
      evidence: "completely unrelated content",
    });
    const stamped: RatingEvent[] = events.map((e) => ({ ...e, source: rater.name }));
    applyRating(stamped, { taskId: taskIdMiss });

    expect(readPosterior(m.id)).toEqual({ alpha: 1.0, beta: 1.25 });
  });

  test("registry: implicit-citation is in SERVER_RATERS and instantiable via MEMORY_RATERS", () => {
    expect(SERVER_RATERS.has("implicit-citation")).toBe(true);

    const previous = process.env.MEMORY_RATERS;
    process.env.MEMORY_RATERS = "implicit-citation";
    try {
      const raters = getRegisteredRaters();
      expect(raters.map((r) => r.name)).toContain("implicit-citation");
      // Multiplier defaults to 1.0 when MEMORY_RATER_WEIGHTS is unset.
      expect(getRaterWeightMultiplier("implicit-citation")).toBe(1.0);
    } finally {
      if (previous === undefined) delete process.env.MEMORY_RATERS;
      else process.env.MEMORY_RATERS = previous;
    }
  });
});

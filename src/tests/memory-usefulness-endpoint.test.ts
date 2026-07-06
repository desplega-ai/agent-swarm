import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { recordRetrievals } from "../be/memory/raters/retrieval";
import { handleMemory } from "../http/memory";
import { getPathSegments } from "../http/utils";

const TEST_DB_PATH = "./test-memory-usefulness-endpoint.sqlite";

const AGENT_ID = "aaaa0000-0000-4000-8000-0000000use01";
const TASK_A = "00000000-0000-4000-8000-000000use001";
const TASK_B = "00000000-0000-4000-8000-000000use002";

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeReqRes(path: string) {
  const req = {
    method: "GET",
    url: path,
    headers: {},
  } as unknown as IncomingMessage;

  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = chunk;
      return this;
    },
  } as unknown as ServerResponse;

  return { req, res, captured };
}

async function callUsefulness(path: string) {
  const { req, res, captured } = fakeReqRes(path);
  const handled = await handleMemory(req, res, getPathSegments(req.url || ""), undefined);
  expect(handled).toBe(true);
  return captured;
}

function insertRating(row: {
  memoryId: string;
  taskId: string | null;
  source: string;
  signal: number;
  weight?: number;
  createdAt: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO memory_rating (id, memoryId, taskId, source, signal, weight, reasoning, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      crypto.randomUUID(),
      row.memoryId,
      row.taskId,
      row.source,
      row.signal,
      row.weight ?? 0.5,
      row.createdAt,
    );
}

describe("GET /api/memory/usefulness", () => {
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: AGENT_ID, name: "Usefulness Test Agent", isLead: false, status: "idle" });
    const insertTask = getDb().prepare(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    );
    const nowIso = new Date().toISOString();
    insertTask.run(TASK_A, AGENT_ID, "usefulness task A", nowIso, nowIso);
    insertTask.run(TASK_B, AGENT_ID, "usefulness task B", nowIso, nowIso);
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

  describe("empty DB", () => {
    test("returns zeros, not errors", async () => {
      const captured = await callUsefulness("/api/memory/usefulness");
      expect(captured.status).toBe(200);

      const body = JSON.parse(captured.body);
      expect(body).toMatchObject({
        windowDays: 30,
        threshold: 0.6,
        cutoff: expect.any(String),
        volume: {
          retrievals: 0,
          distinctMemories: 0,
          retrievalGroups: 0,
          byEventType: { search: 0, get: 0 },
        },
        byArm: [],
        citationBySource: [],
        posterior: {
          totalMemories: 0,
          movedFromPrior: 0,
          avgPosteriorMean: null,
          avgPosteriorMeanMoved: null,
          aboveThreshold: 0,
        },
        sanity: {
          totalRetrievalRows: 0,
          totalRatingRows: 0,
          ratingsBySource: [],
        },
      });
    });
  });

  describe("seeded stats", () => {
    let m1: string; // manual, cited twice, posterior 3/1
    let m2: string; // task_completion, uncited, posterior 1/2
    let m3: string; // manual, only legacy (out-of-window) activity, prior 1/1

    beforeAll(() => {
      m1 = store.store({
        agentId: AGENT_ID,
        scope: "agent",
        name: "usefulness-m1",
        content: "usefulness memory one",
        source: "manual",
      }).id;
      m2 = store.store({
        agentId: AGENT_ID,
        scope: "agent",
        name: "usefulness-m2",
        content: "usefulness memory two",
        source: "task_completion",
      }).id;
      m3 = store.store({
        agentId: AGENT_ID,
        scope: "agent",
        name: "usefulness-m3",
        content: "usefulness memory three",
        source: "manual",
      }).id;

      // In-window retrievals: one grouped call with two arms, one single-arm call.
      recordRetrievals(TASK_A, AGENT_ID, [
        { memoryId: m1, similarity: 0.9, retrievalSource: "vec" },
        { memoryId: m2, similarity: 0.7, retrievalSource: "hybrid" },
      ]);
      recordRetrievals(TASK_B, AGENT_ID, [
        { memoryId: m1, similarity: 0.8, retrievalSource: "hybrid" },
      ]);

      // Legacy out-of-window row: NULL retrievalSource/retrievalId, 10 days old.
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
      getDb()
        .prepare(
          `INSERT INTO memory_retrieval
             (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt, eventType)
           VALUES (?, ?, ?, NULL, ?, 0.5, ?, 'search')`,
        )
        .run(crypto.randomUUID(), TASK_A, AGENT_ID, m3, tenDaysAgo);

      // In-window implicit citations: m1 cited on both tasks, m2 uncited.
      const nowIso = new Date().toISOString();
      insertRating({
        memoryId: m1,
        taskId: TASK_A,
        source: "implicit-citation",
        signal: 1,
        createdAt: nowIso,
      });
      insertRating({
        memoryId: m2,
        taskId: TASK_A,
        source: "implicit-citation",
        signal: -1,
        weight: 0.25,
        createdAt: nowIso,
      });
      insertRating({
        memoryId: m1,
        taskId: TASK_B,
        source: "implicit-citation",
        signal: 1,
        createdAt: nowIso,
      });
      // Out-of-window implicit citation for the legacy row.
      insertRating({
        memoryId: m3,
        taskId: TASK_A,
        source: "implicit-citation",
        signal: 1,
        createdAt: tenDaysAgo,
      });
      // Non-citation rating source — must not leak into citation stats.
      insertRating({
        memoryId: m1,
        taskId: TASK_A,
        source: "explicit-self",
        signal: 1,
        weight: 1,
        createdAt: nowIso,
      });

      // Posterior movement: m1 → 0.75, m2 → 1/3, m3 stays at the 1/1 prior.
      getDb().prepare("UPDATE agent_memory SET alpha = 3.0, beta = 1.0 WHERE id = ?").run(m1);
      getDb().prepare("UPDATE agent_memory SET alpha = 1.0, beta = 2.0 WHERE id = ?").run(m2);
    });

    test("window filtering: 7-day volume excludes the old row", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=7");
      expect(captured.status).toBe(200);

      const body = JSON.parse(captured.body);
      expect(body.windowDays).toBe(7);
      expect(body.volume).toEqual({
        retrievals: 3,
        distinctMemories: 2,
        retrievalGroups: 2,
        byEventType: { search: 3, get: 0 },
      });
    });

    test("per-arm breakdown with citation join", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=7");
      const body = JSON.parse(captured.body);

      const arms = Object.fromEntries(
        body.byArm.map((a: { retrievalSource: string | null }) => [a.retrievalSource ?? "null", a]),
      );
      expect(body.byArm).toHaveLength(2);
      expect(arms.vec).toEqual({
        retrievalSource: "vec",
        retrievals: 1,
        distinctMemories: 1,
        citedRetrievals: 1,
        citationRate: 1,
      });
      expect(arms.hybrid).toEqual({
        retrievalSource: "hybrid",
        retrievals: 2,
        distinctMemories: 2,
        citedRetrievals: 1,
        citationRate: 0.5,
      });
    });

    test("get events are excluded from per-arm stats (would pollute the NULL arm)", async () => {
      const getRowId = crypto.randomUUID();
      getDb()
        .prepare(
          `INSERT INTO memory_retrieval
             (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt, eventType)
           VALUES (?, ?, ?, NULL, ?, 1.0, ?, 'get')`,
        )
        .run(getRowId, TASK_A, AGENT_ID, m3, new Date().toISOString());

      const captured = await callUsefulness("/api/memory/usefulness?days=7");
      const body = JSON.parse(captured.body);

      // Counted in volume's eventType split…
      expect(body.volume.byEventType.get).toBe(1);
      // …but absent from the per-arm breakdown (no NULL "legacy" arm appears).
      expect(
        body.byArm.find((a: { retrievalSource: string | null }) => a.retrievalSource === null),
      ).toBeUndefined();

      getDb().prepare("DELETE FROM memory_retrieval WHERE id = ?").run(getRowId);
    });

    test("wider window includes the legacy NULL arm", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=30");
      const body = JSON.parse(captured.body);

      expect(body.volume.retrievals).toBe(4);
      expect(body.volume.distinctMemories).toBe(3);
      const legacyArm = body.byArm.find(
        (a: { retrievalSource: string | null }) => a.retrievalSource === null,
      );
      expect(legacyArm).toEqual({
        retrievalSource: null,
        retrievals: 1,
        distinctMemories: 1,
        citedRetrievals: 1,
        citationRate: 1,
      });
    });

    test("citation rate per memory-source (implicit-citation only, windowed)", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=7");
      const body = JSON.parse(captured.body);

      const bySource = Object.fromEntries(
        body.citationBySource.map((s: { source: string }) => [s.source, s]),
      );
      expect(body.citationBySource).toHaveLength(2);
      expect(bySource.manual).toEqual({
        source: "manual",
        ratings: 2,
        positive: 2,
        citationRate: 1,
        avgSignal: 1,
      });
      expect(bySource.task_completion).toEqual({
        source: "task_completion",
        ratings: 1,
        positive: 0,
        citationRate: 0,
        avgSignal: -1,
      });
    });

    test("posterior movement stats", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=7");
      const body = JSON.parse(captured.body);

      expect(body.posterior.totalMemories).toBe(3);
      expect(body.posterior.movedFromPrior).toBe(2);
      expect(body.posterior.aboveThreshold).toBe(1); // only m1 at 0.75 > 0.6
      expect(body.posterior.avgPosteriorMean).toBeCloseTo((0.75 + 1 / 3 + 0.5) / 3, 5);
      expect(body.posterior.avgPosteriorMeanMoved).toBeCloseTo((0.75 + 1 / 3) / 2, 5);
    });

    test("threshold param moves the aboveThreshold count", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=7&threshold=0.3");
      const body = JSON.parse(captured.body);

      expect(body.threshold).toBe(0.3);
      // m1 (0.75), m2 (0.333…), m3 (0.5) all exceed 0.3.
      expect(body.posterior.aboveThreshold).toBe(3);
    });

    test("sanity block reports all-time totals by rating source", async () => {
      const captured = await callUsefulness("/api/memory/usefulness?days=7");
      const body = JSON.parse(captured.body);

      expect(body.sanity.totalRetrievalRows).toBe(4);
      expect(body.sanity.totalRatingRows).toBe(5);
      const bySource = Object.fromEntries(
        body.sanity.ratingsBySource.map((r: { source: string; count: number }) => [
          r.source,
          r.count,
        ]),
      );
      expect(bySource).toEqual({ "implicit-citation": 4, "explicit-self": 1 });
    });
  });

  describe("param validation", () => {
    test.each(["days=abc", "days=0", "days=366", "days=1.5"])("400 on bad %s", async (param) => {
      const captured = await callUsefulness(`/api/memory/usefulness?${param}`);
      expect(captured.status).toBe(400);
      expect(JSON.parse(captured.body).error).toContain("Validation error");
    });

    test.each([
      "threshold=2",
      "threshold=-0.1",
      "threshold=nope",
    ])("400 on bad %s", async (param) => {
      const captured = await callUsefulness(`/api/memory/usefulness?${param}`);
      expect(captured.status).toBe(400);
    });

    test("defaults apply when params omitted", async () => {
      const captured = await callUsefulness("/api/memory/usefulness");
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body);
      expect(body.windowDays).toBe(30);
      expect(body.threshold).toBe(0.6);
    });
  });
});

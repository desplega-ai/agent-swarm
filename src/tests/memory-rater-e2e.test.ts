/**
 * Cross-cutting end-to-end test for memory-rater v1.5.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-7.md §6
 *
 * Exercises the full flow that ships in v1.5:
 *   A. retrieval bridge writes `memory_retrieval` rows
 *   B. explicit rating with `referencesSource` updates the memory's posterior
 *      AND creates an `agent_memory_edge` row
 *   C. implicit-citation server rater fires on task completion, hits the
 *      cited memory and misses the uncited one
 *   D. LlmRater piggyback adds llm-source ratings + a second edge
 *   E. read endpoints surface the retrievals and the edges
 *   F. reranker — usefulness(α, β) > 1 after positive ratings, so the cited
 *      memory ranks above its baseline score
 *   G. backward compat — with no ratings on a fresh DB, reranker scores are
 *      byte-identical to a pre-v1.5 baseline
 *
 * Implementation notes:
 *   - Spawns the API server on an isolated SQLite file so the HTTP read
 *     endpoints can be exercised against the same DB the test mutates.
 *   - The retrieval bridge and the implicit-citation rater fire are invoked
 *     in-process via `recordRetrievals` and `runServerRaters` rather than
 *     through their HTTP entry points, because both call sites depend on
 *     external services (OpenAI embeddings for `/api/memory/search`,
 *     `claude -p` for the hook). Their HTTP wrappers are exercised by the
 *     dedicated step-2/step-3/step-4 suites; this test focuses on the
 *     cross-cutting state transitions the dedicated suites don't cover
 *     end-to-end.
 *   - The LlmRater path uses `buildRatingsFromLlm` with a hand-built
 *     `SummaryWithRatings`-shaped payload — this matches what the hook
 *     would have constructed from a successful `claude -p` summary call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { closeDb, createAgent, createSessionLogs, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { ImplicitCitationRater } from "../be/memory/raters/implicit-citation";
import { buildRatingsFromLlm } from "../be/memory/raters/llm";
import { recordRetrievals } from "../be/memory/raters/retrieval";
import { runServerRaters } from "../be/memory/raters/run-server-raters";
import { applyRating } from "../be/memory/raters/store";
import { rerank } from "../be/memory/reranker";
import type { MemoryCandidate } from "../be/memory/types";

const TEST_PORT = 19131;
const TEST_DB_PATH = `/tmp/test-memory-rater-e2e-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-key";

let serverProc: Subprocess;
let store: SqliteMemoryStore;
const agentId = randomUUID();
const taskId = randomUUID();

const testTemplateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedE2eTemplate?: Uint8Array;
};

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; agentId?: string; sourceTaskId?: string } = {},
  // biome-ignore lint/suspicious/noExplicitAny: test helper
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (opts.agentId) headers["x-agent-id"] = opts.agentId;
  if (opts.sourceTaskId) headers["x-source-task-id"] = opts.sourceTaskId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: body may be JSON or text
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not ready
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
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

function getRatings(taskIdArg: string) {
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
    .all(taskIdArg);
}

function countEdges(memoryId: string): number {
  const row = getDb()
    .prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM agent_memory_edge WHERE from_id = ? AND type = 'references-source'",
    )
    .get(memoryId);
  return row?.n ?? 0;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }

  serverProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY,
      // The cross-cutting flow gates on this allow-list — without it the
      // implicit-citation server rater is a no-op (the byte-identical
      // off-mode litmus from PR #429).
      MEMORY_RATERS: "implicit-citation,llm,explicit-self",
      CAPABILITIES: "core",
      SLACK_BOT_TOKEN: "",
      LINEAR_DISABLE: "true",
      JIRA_DISABLE: "true",
      GITHUB_DISABLE: "true",
      SLACK_DISABLE: "true",
      HEARTBEAT_DISABLE: "true",
      OAUTH_KEEPALIVE_DISABLE: "true",
      ANONYMIZED_TELEMETRY: "false",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitForServer(`${BASE}/health`);

  // Hide preload.ts's in-memory template so initDb opens the real file.
  testTemplateGlobals.__savedE2eTemplate = testTemplateGlobals.__testMigrationTemplate;
  testTemplateGlobals.__testMigrationTemplate = undefined;
  closeDb();
  initDb(TEST_DB_PATH);

  createAgent({ id: agentId, name: "E2E Agent", isLead: false, status: "idle" });
  const insertTask = getDb().prepare(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
  );
  const now = new Date().toISOString();
  insertTask.run(taskId, agentId, "e2e task", now, now);

  store = new SqliteMemoryStore();
}, 20000);

afterAll(async () => {
  closeDb();
  testTemplateGlobals.__testMigrationTemplate = testTemplateGlobals.__savedE2eTemplate;
  testTemplateGlobals.__savedE2eTemplate = undefined;
  if (serverProc) {
    serverProc.kill();
    try {
      await serverProc.exited;
    } catch {}
  }
  await Bun.sleep(50);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

beforeEach(() => {
  // Each test starts fresh — wipe all rater-touched state but keep the
  // agent / task rows, and reset all memory posteriors to Beta(1,1).
  getDb().run("DELETE FROM memory_rating");
  getDb().run("DELETE FROM memory_retrieval");
  getDb().run("DELETE FROM session_logs");
  getDb().run("DELETE FROM agent_memory_edge");
  getDb().run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
});

function makeMemory(name: string, scope: "agent" | "swarm"): { id: string } {
  return store.store({
    agentId,
    scope,
    name,
    content: `${name} content`,
    source: "manual",
  });
}

describe("memory-rater v1.5 — cross-cutting e2e", () => {
  test("Step A: retrieval bridge writes memory_retrieval rows", () => {
    const memA = makeMemory("mem-A-step-a", "agent");
    const memB = makeMemory("mem-B-step-a", "swarm");

    recordRetrievals(taskId, agentId, [
      { memoryId: memA.id, similarity: 0.9 },
      { memoryId: memB.id, similarity: 0.7 },
    ]);

    const rows = getDb()
      .prepare<{ memoryId: string }, [string]>(
        "SELECT memoryId FROM memory_retrieval WHERE taskId = ? ORDER BY memoryId",
      )
      .all(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.memoryId).sort()).toEqual([memA.id, memB.id].sort());
  });

  test("Step B: explicit-self rating with edge updates posterior + creates edge", async () => {
    const memA = makeMemory("mem-A-step-b", "agent");
    insertRetrieval(taskId, agentId, memA.id);

    const r = await api("POST", "/api/memory/rate", {
      agentId,
      body: {
        events: [
          {
            memoryId: memA.id,
            signal: 1,
            weight: 1,
            source: "explicit-self",
            taskId,
            referencesSource: "github:desplega-ai/agent-swarm#999",
          },
        ],
      },
    });

    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(1);

    expect(readPosterior(memA.id).alpha).toBeCloseTo(2.0, 5);

    const edges = getDb()
      .prepare<{ from_id: string; to_id: string; alpha: number; beta: number }, [string]>(
        "SELECT from_id, to_id, alpha, beta FROM agent_memory_edge WHERE from_id = ?",
      )
      .all(memA.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to_id).toBe("github:desplega-ai/agent-swarm#999");
    expect(edges[0]!.alpha).toBeCloseTo(2.0, 5);
    expect(edges[0]!.beta).toBeCloseTo(1.0, 5);
  });

  test("Step C: implicit-citation rater hits cited memory, misses the other", async () => {
    const memA = makeMemory("mem-A-step-c", "agent");
    const memB = makeMemory("mem-B-step-c", "swarm");

    // Pre-condition: explicit-self has already moved alpha for mem-A to 2.0
    // (mirrors the actual flow in step B).
    insertRetrieval(taskId, agentId, memA.id);
    insertRetrieval(taskId, agentId, memB.id);
    applyRating(
      [
        {
          memoryId: memA.id,
          signal: 1,
          weight: 1,
          source: "explicit-self",
        },
      ],
      { taskId },
    );
    expect(readPosterior(memA.id).alpha).toBeCloseTo(2.0, 5);

    // session_logs cite mem-A but NOT mem-B.
    createSessionLogs({
      taskId,
      sessionId: "session-c",
      iteration: 1,
      cli: "claude",
      lines: [`I used ${memA.id} to solve this`, "more progress"],
    });

    // Fire the server-rater orchestration the way `store-progress` does.
    // Inject the rater explicitly — the test process inherits its own
    // MEMORY_RATERS env (typically unset to avoid disturbing other suites),
    // and we want to exercise this rater regardless. Step G covers the
    // unset-env "byte-identical" backward-compat case separately.
    const result = await runServerRaters(
      {
        taskId,
        agentId,
        retrievedMemoryIds: [memA.id, memB.id],
        evidence: getDb()
          .prepare<{ content: string }, [string]>(
            "SELECT content FROM session_logs WHERE taskId = ? ORDER BY iteration, lineNumber",
          )
          .all(taskId)
          .map((r) => r.content)
          .join("\n"),
      },
      {
        raters: [new ImplicitCitationRater()],
      },
    );
    expect(result.ratersFired).toBeGreaterThanOrEqual(1);

    // mem-A.alpha = 2.0 (explicit) + 0.5 (implicit hit) = 2.5
    // mem-B.beta  = 1.0 (prior)    + 0.25 (implicit miss) = 1.25
    expect(readPosterior(memA.id)).toEqual({ alpha: 2.5, beta: 1.0 });
    expect(readPosterior(memB.id)).toEqual({ alpha: 1.0, beta: 1.25 });

    const ratings = getRatings(taskId);
    const sources = ratings.map((r) => r.source).sort();
    expect(sources).toContain("implicit-citation");
    expect(sources).toContain("explicit-self");
  });

  test("Step D: LlmRater piggyback updates posteriors + emits a second edge", async () => {
    const memA = makeMemory("mem-A-step-d", "agent");
    const memB = makeMemory("mem-B-step-d", "swarm");

    insertRetrieval(taskId, agentId, memA.id);
    insertRetrieval(taskId, agentId, memB.id);

    // What the `claude -p` summary call returns when the hook piggybacks
    // — same structure as `SummaryWithRatingsSchema`. Keeping this hand-
    // assembled (rather than going through the schema's parse) makes the
    // mapping the test exercises explicit.
    const llmRatings = [
      {
        id: memA.id,
        score: 0.9,
        reasoning: "directly answered the question",
        referencesSource: "linear:DES-294",
      },
      {
        id: memB.id,
        score: 0.2,
        reasoning: "tangentially related, mostly noise",
      },
    ];

    const events = buildRatingsFromLlm(llmRatings, [{ id: memA.id }, { id: memB.id }]);
    expect(events).toHaveLength(2);
    // Sanity-check the mapping (signal = 2*score - 1, weight = 0.8).
    const eA = events.find((e) => e.memoryId === memA.id)!;
    const eB = events.find((e) => e.memoryId === memB.id)!;
    expect(eA.signal).toBeCloseTo(0.8, 5); // 2*0.9 - 1
    expect(eB.signal).toBeCloseTo(-0.6, 5); // 2*0.2 - 1
    expect(eA.weight).toBeCloseTo(0.8, 5);
    expect(eA.referencesSource).toBe("linear:DES-294");
    expect(eB.referencesSource).toBeUndefined();

    const r = await api("POST", "/api/memory/rate", {
      agentId,
      body: {
        events: events.map((e) => ({ ...e, taskId })),
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(2);

    // Posterior shifts: alphaDelta = max(0, signal) * weight,
    //                   betaDelta  = max(0, -signal) * weight.
    // mem-A: alpha = 1 + 0.8 * 0.8 = 1.64, beta = 1
    // mem-B: alpha = 1, beta = 1 + 0.6 * 0.8 = 1.48
    expect(readPosterior(memA.id).alpha).toBeCloseTo(1.64, 5);
    expect(readPosterior(memA.id).beta).toBeCloseTo(1.0, 5);
    expect(readPosterior(memB.id).alpha).toBeCloseTo(1.0, 5);
    expect(readPosterior(memB.id).beta).toBeCloseTo(1.48, 5);

    expect(countEdges(memA.id)).toBe(1);
    expect(countEdges(memB.id)).toBe(0);

    const edges = getDb()
      .prepare<{ to_id: string }, [string]>("SELECT to_id FROM agent_memory_edge WHERE from_id = ?")
      .all(memA.id);
    expect(edges[0]!.to_id).toBe("linear:DES-294");
  });

  test("Step E: GET /api/memory/retrievals + GET /api/memory/edges return what was written", async () => {
    const memA = makeMemory("mem-A-step-e", "agent");
    const memB = makeMemory("mem-B-step-e", "swarm");

    insertRetrieval(taskId, agentId, memA.id);
    insertRetrieval(taskId, agentId, memB.id);

    // Two edges on mem-A, one from explicit-self (github), one from llm (linear).
    applyRating(
      [
        {
          memoryId: memA.id,
          signal: 1,
          weight: 1,
          source: "explicit-self",
          referencesSource: "github:desplega-ai/agent-swarm#999",
        },
      ],
      { taskId },
    );
    applyRating(
      [
        {
          memoryId: memA.id,
          signal: 0.8,
          weight: 0.8,
          source: "llm",
          referencesSource: "linear:DES-294",
        },
      ],
      { taskId },
    );

    const r1 = await api("GET", `/api/memory/retrievals?taskId=${taskId}`, {
      agentId,
    });
    expect(r1.status).toBe(200);
    expect(Array.isArray(r1.body.results)).toBe(true);
    expect(r1.body.results).toHaveLength(2);
    const rids = (r1.body.results as { id: string }[]).map((x) => x.id).sort();
    expect(rids).toEqual([memA.id, memB.id].sort());

    const r2 = await api("GET", `/api/memory/edges?memoryId=${memA.id}`, {
      agentId,
    });
    expect(r2.status).toBe(200);
    expect(Array.isArray(r2.body.edges)).toBe(true);
    expect(r2.body.edges).toHaveLength(2);
    const tos = (r2.body.edges as { to: string }[]).map((e) => e.to).sort();
    expect(tos).toEqual(["github:desplega-ai/agent-swarm#999", "linear:DES-294"]);
    for (const edge of r2.body.edges as {
      alpha: number;
      beta: number;
      usefulness: number;
    }[]) {
      expect(edge.alpha).toBeGreaterThan(1);
      expect(edge.usefulness).toBeGreaterThanOrEqual(1.0);
      expect(edge.usefulness).toBeLessThanOrEqual(2.0);
    }
  });

  test("Step F: reranker — usefulness > 1 after positive ratings, mem-A ranks higher than baseline", () => {
    const memA = makeMemory("mem-A-step-f", "agent");
    const memB = makeMemory("mem-B-step-f", "swarm");

    // Build a reproducible candidate set — same fields as the reranker reads.
    const buildCandidate = (
      id: string,
      similarity: number,
      alpha: number,
      beta: number,
    ): MemoryCandidate => ({
      id,
      agentId,
      scope: "agent",
      name: id,
      content: id,
      source: "manual",
      similarity,
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      accessCount: 0,
      alpha,
      beta,
      tags: null,
      sourceTaskId: null,
      sourcePath: null,
      chunkIndex: null,
      totalChunks: null,
      expiresAt: null,
      embeddingModel: null,
    });

    // Baseline (Beta(1,1)) — mem-A and mem-B both have usefulness = 1.
    const baselineA = buildCandidate(memA.id, 0.5, 1, 1);
    const baselineB = buildCandidate(memB.id, 0.5, 1, 1);
    const baselineRanked = rerank([baselineA, baselineB], { limit: 2 });
    const baselineScoreA = baselineRanked.find((r) => r.id === memA.id)!.similarity;

    // After positive ratings push mem-A's posterior to (2.5, 1.0) — same
    // numbers we asserted in step C — usefulness(2.5, 1.0) = clamp(
    // 2 * 2.5 / 3.5, 1.0, 2.0) ≈ 1.428. So the rescaled score is strictly
    // greater than baseline.
    const ratedA = buildCandidate(memA.id, 0.5, 2.5, 1.0);
    const ratedRanked = rerank([ratedA, baselineB], { limit: 2 });
    const ratedScoreA = ratedRanked.find((r) => r.id === memA.id)!.similarity;

    expect(ratedScoreA).toBeGreaterThan(baselineScoreA);
    // mem-A now ranks first (was tied with mem-B before).
    expect(ratedRanked[0]!.id).toBe(memA.id);
  });

  test("Step G: backward compat — Beta(1,1) yields a usefulness factor of exactly 1.0 (byte-identical)", () => {
    const id = randomUUID();
    const buildCandidate = (similarity: number): MemoryCandidate => ({
      id,
      agentId,
      scope: "agent",
      name: id,
      content: id,
      source: "manual",
      similarity,
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      accessCount: 0,
      alpha: 1,
      beta: 1,
      tags: null,
      sourceTaskId: null,
      sourcePath: null,
      chunkIndex: null,
      totalChunks: null,
      expiresAt: null,
      embeddingModel: null,
    });

    // The pre-rater reranker computed: similarity * recency_decay * access_boost.
    // With access_boost = 1 (accessCount = 0) and a fresh timestamp
    // (recency_decay ≈ 1 for ages well below the half-life), the score is
    // approximately equal to the input similarity — and crucially, the
    // usefulness factor MUST contribute 1.0 exactly so the v1.5 reranker
    // is byte-identical to pre-v1.5 for unrated memories.
    const candidates = [buildCandidate(0.5), buildCandidate(0.7), buildCandidate(0.3)];
    const ranked = rerank(candidates, { limit: 3 });

    // Order is preserved by similarity (since all other multipliers are equal).
    expect(ranked.map((r) => r.similarity).sort((a, b) => b - a)).toEqual(
      ranked.map((r) => r.similarity),
    );

    // The usefulness factor at Beta(1,1) is exactly 1.0; a memory with no
    // ratings should score = similarity * recency * access * sourceQuality * usefulness.
    // For source=manual: sourceQuality=1.5, recency=1.0 (no decay for manual),
    // access=1.0, usefulness=1.0. So score = 0.5 * 1.5 = 0.75.
    const fresh = buildCandidate(0.5);
    const score = rerank([fresh], { limit: 1 })[0]!.similarity;
    expect(score).toBeCloseTo(0.75, 10);
  });
});

function insertRetrieval(taskIdArg: string, agentIdArg: string, memoryId: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_retrieval (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt)
       VALUES (?, ?, ?, NULL, ?, 0.85, ?)`,
    )
    .run(randomUUID(), taskIdArg, agentIdArg, memoryId, new Date().toISOString());
}

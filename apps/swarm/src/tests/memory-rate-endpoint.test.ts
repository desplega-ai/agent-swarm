/**
 * HTTP integration tests for the memory-rater v1.5 worker-facing endpoints:
 *   POST /api/memory/rate
 *   GET  /api/memory/retrievals
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-3.md
 *
 * Spawns the API server against an isolated SQLite file, then opens the same
 * file from the test process for state setup/verification (WAL mode allows
 * concurrent readers + writers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

const TEST_PORT = 19111;
const TEST_DB_PATH = `/tmp/test-memory-rate-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-key";

let serverProc: Subprocess;
const agentA = randomUUID();
const agentB = randomUUID();
const taskA = randomUUID();
const taskB = randomUUID();
let store: SqliteMemoryStore;

// preload.ts builds an in-memory migrated DB template that initDb's fast path
// restores from — fine for single-process tests, but here we need the test
// process to share a real file-backed DB with the spawned API server. Hide the
// template across the suite and restore it in afterAll for downstream suites.
const testTemplateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedRateTemplate?: Uint8Array;
};

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; agentId?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (opts.agentId) headers["x-agent-id"] = opts.agentId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
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

function makeMemory(name: string, agentId = agentA): { id: string } {
  return store.store({
    agentId,
    scope: "agent",
    name,
    content: `${name} content`,
    source: "manual",
  });
}

function insertRetrieval(taskId: string, agentId: string, memoryId: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_retrieval (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt)
       VALUES (?, ?, ?, NULL, ?, 0.85, ?)`,
    )
    .run(randomUUID(), taskId, agentId, memoryId, new Date().toISOString());
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

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }

  serverProc = Bun.spawn(["bun", "apps/swarm/src/http.ts"], {
    cwd: `${import.meta.dir}/../../../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY,
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

  // Hide preload.ts's in-memory template so initDb opens the real file (the
  // server already migrated it), giving us cross-process WAL visibility.
  testTemplateGlobals.__savedRateTemplate = testTemplateGlobals.__testMigrationTemplate;
  testTemplateGlobals.__testMigrationTemplate = undefined;
  // Close any leftover in-memory DB from a prior test in the same Bun worker.
  // initDb is a no-op when `db` is already set, so without this the test
  // process can keep writing to the previous template-restored DB while the
  // spawned server reads from TEST_DB_PATH — defensive even if today's CI
  // ordering happens to leave `db` null here.
  closeDb();
  initDb(TEST_DB_PATH);
  createAgent({ id: agentA, name: "Agent A", isLead: false, status: "idle" });
  createAgent({ id: agentB, name: "Agent B", isLead: false, status: "idle" });

  const insertTask = getDb().prepare(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
  );
  const now = new Date().toISOString();
  insertTask.run(taskA, agentA, "task A", now, now);
  insertTask.run(taskB, agentA, "task B", now, now);

  store = new SqliteMemoryStore();
}, 20000);

afterAll(async () => {
  closeDb();
  // Restore preload.ts's template for any subsequent suites.
  testTemplateGlobals.__testMigrationTemplate = testTemplateGlobals.__savedRateTemplate;
  testTemplateGlobals.__savedRateTemplate = undefined;
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
  // Reset per-test mutable state. agent_memory rows persist across tests;
  // alpha/beta are reset so each test starts from the Beta(1,1) prior.
  getDb().run("DELETE FROM memory_rating");
  getDb().run("DELETE FROM memory_retrieval");
  getDb().run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
});

describe("POST /api/memory/rate", () => {
  test("happy path: source=llm with valid memoryId → 200, applied=1, alpha bumped", async () => {
    const m = makeMemory("rate-llm-1");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [{ memoryId: m.id, signal: 1, weight: 1, source: "llm", taskId: taskA }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(1);
    expect(r.body.rejected).toEqual([]);
    expect(readPosterior(m.id).alpha).toBeCloseTo(2, 5);
  });

  test("source=explicit-self with no retrieval row → 400 (R6 spam guard)", async () => {
    const m = makeMemory("explicit-no-retr");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [{ memoryId: m.id, signal: 1, weight: 1, source: "explicit-self", taskId: taskA }],
      },
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/not present in memory_retrieval/);
  });

  test("source=explicit-self without taskId → 400", async () => {
    const m = makeMemory("explicit-no-task");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [{ memoryId: m.id, signal: 1, weight: 1, source: "explicit-self" }],
      },
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/requires taskId/);
  });

  test("source=explicit-self with retrieval row → 200, applied=1", async () => {
    const m = makeMemory("explicit-ok");
    insertRetrieval(taskA, agentA, m.id);
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [{ memoryId: m.id, signal: 1, weight: 1, source: "explicit-self", taskId: taskA }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(1);
  });

  test("duplicate explicit-self for same (taskId, memoryId) → 409", async () => {
    const m = makeMemory("explicit-dup");
    insertRetrieval(taskA, agentA, m.id);
    const evt = {
      memoryId: m.id,
      signal: 1,
      weight: 1,
      source: "explicit-self",
      taskId: taskA,
    };
    const first = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: { events: [evt] },
    });
    expect(first.status).toBe(200);
    const second = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: { events: [evt] },
    });
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/Duplicate explicit-self/);
  });

  test("51 events → 400 (cap enforced)", async () => {
    const m = makeMemory("cap");
    const events = Array.from({ length: 51 }, () => ({
      memoryId: m.id,
      signal: 1,
      weight: 0.01,
      source: "llm",
    }));
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: { events },
    });
    expect(r.status).toBe(400);
  });

  test("source=implicit-citation rejected at HTTP boundary → 400", async () => {
    const m = makeMemory("impl-cit-spoof");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [{ memoryId: m.id, signal: 1, weight: 1, source: "implicit-citation" }],
      },
    });
    expect(r.status).toBe(400);
  });

  test("missing X-Agent-ID → 400", async () => {
    const m = makeMemory("no-agent");
    const r = await api("POST", "/api/memory/rate", {
      body: { events: [{ memoryId: m.id, signal: 1, weight: 1, source: "llm" }] },
    });
    expect(r.status).toBe(400);
  });
});

describe("GET /api/memory/retrievals", () => {
  test("requires taskId or sessionId → 400", async () => {
    const r = await api("GET", "/api/memory/retrievals", { agentId: agentA });
    expect(r.status).toBe(400);
  });

  test("returns rows for the requesting agent only (defence-in-depth)", async () => {
    const m1 = makeMemory("retr-1");
    const m2 = makeMemory("retr-2");
    const mOther = makeMemory("retr-other");
    insertRetrieval(taskA, agentA, m1.id);
    insertRetrieval(taskA, agentA, m2.id);
    insertRetrieval(taskA, agentB, mOther.id); // wrong agent — must NOT leak

    const r = await api("GET", `/api/memory/retrievals?taskId=${taskA}`, {
      agentId: agentA,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
    expect(r.body.results).toHaveLength(2);
    const ids = (r.body.results as { id: string }[]).map((x) => x.id).sort();
    expect(ids).toEqual([m1.id, m2.id].sort());
    // Content snippet capped at 500 chars
    for (const row of r.body.results as { content: string; name: string }[]) {
      expect(row.content.length).toBeLessThanOrEqual(500);
      expect(row.name).toMatch(/^retr-/);
    }
  });
});

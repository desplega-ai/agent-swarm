/**
 * Exhaustive HTTP API Integration Tests
 *
 * Spawns the actual HTTP server with a temporary SQLite database
 * and tests every API endpoint for correct behavior.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";

const TEST_PORT = 19876;
const TEST_DB_PATH = `/tmp/test-http-integration-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;

let serverProc: Subprocess;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; agentId?: string; headers?: Record<string, string> } = {},
  // biome-ignore lint/suspicious/noExplicitAny: test helper needs flexible body type
): Promise<{ status: number; body: any; ok: boolean }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.agentId) headers["x-agent-id"] = opts.agentId;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: body can be parsed JSON or raw text
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, ok: res.ok };
}

const get = (p: string, o?: Parameters<typeof api>[2]) => api("GET", p, o);
const post = (p: string, o?: Parameters<typeof api>[2]) => api("POST", p, o);
const put = (p: string, o?: Parameters<typeof api>[2]) => api("PUT", p, o);
const del = (p: string, o?: Parameters<typeof api>[2]) => api("DELETE", p, o);

async function waitForServer(url: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Shared state — IDs created during tests for cross-test references
// ---------------------------------------------------------------------------
const ids = {
  leadAgent: randomUUID(),
  workerAgent: randomUUID(),
  workerAgent2: randomUUID(),
  task: "",
  task2: "",
  epic: "",
  channel: "",
  message: "",
  config: "",
  repo: "",
  session: "",
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any leftover test DB
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  try {
    await unlink(`${TEST_DB_PATH}-wal`);
  } catch {}
  try {
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {}

  serverProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY: "", // no auth required
      CAPABILITIES: "core,task-pool,messaging,profiles,services,scheduling,epics,memory",
      // Disable optional integrations
      SLACK_BOT_TOKEN: "",
      GITHUB_WEBHOOK_SECRET: "",
      AGENTMAIL_API_KEY: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitForServer(`${BASE}/health`);
}, 20000);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    // Wait for process to exit
    try {
      await serverProc.exited;
    } catch {}
  }
  await Bun.sleep(300);
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  try {
    await unlink(`${TEST_DB_PATH}-wal`);
  } catch {}
  try {
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {}
});

// ===========================================================================
// 1. Health & Core
// ===========================================================================

describe("Health & Core", () => {
  test("GET /health returns ok", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  });

  test("OPTIONS returns 204 (CORS preflight)", async () => {
    const res = await fetch(`${BASE}/api/agents`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("GET /me without agent ID returns 400", async () => {
    const { status, body } = await get("/me");
    expect(status).toBe(400);
    expect(body.error).toContain("Missing X-Agent-ID");
  });

  test("GET /me with non-existent agent returns 404", async () => {
    const { status } = await get("/me", { agentId: randomUUID() });
    expect(status).toBe(404);
  });

  test("POST /ping without agent ID returns 400", async () => {
    const { status } = await post("/ping");
    expect(status).toBe(400);
  });

  test("POST /close without agent ID returns 400", async () => {
    const { status } = await post("/close");
    expect(status).toBe(400);
  });

  test("unknown route returns 404", async () => {
    const { status } = await get("/api/nonexistent");
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 2. Agents
// ===========================================================================

describe("Agents", () => {
  test("POST /api/agents — missing name returns 400", async () => {
    const { status, body } = await post("/api/agents", { body: {} });
    expect(status).toBe(400);
    expect(body.error).toContain("name");
  });

  test("POST /api/agents — create lead agent", async () => {
    const { status, body } = await post("/api/agents", {
      agentId: ids.leadAgent,
      body: {
        name: "TestLead",
        isLead: true,
        description: "Lead agent for tests",
        role: "lead",
        capabilities: ["core", "messaging"],
        maxTasks: 3,
      },
    });
    expect(status).toBe(201);
    expect(body.id).toBe(ids.leadAgent);
    expect(body.name).toBe("TestLead");
    expect(body.isLead).toBeTruthy();
  });

  test("POST /api/agents — create worker agent", async () => {
    const { status, body } = await post("/api/agents", {
      agentId: ids.workerAgent,
      body: { name: "TestWorker", role: "worker", maxTasks: 2 },
    });
    expect(status).toBe(201);
    expect(body.id).toBe(ids.workerAgent);
    expect(body.name).toBe("TestWorker");
  });

  test("POST /api/agents — create second worker", async () => {
    const { status, body } = await post("/api/agents", {
      agentId: ids.workerAgent2,
      body: { name: "TestWorker2" },
    });
    expect(status).toBe(201);
    expect(body.id).toBe(ids.workerAgent2);
  });

  test("POST /api/agents — re-register existing agent returns 200", async () => {
    const { status, body } = await post("/api/agents", {
      agentId: ids.workerAgent,
      body: { name: "TestWorker" },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(ids.workerAgent);
  });

  test("GET /api/agents — list all agents", async () => {
    const { status, body } = await get("/api/agents");
    expect(status).toBe(200);
    expect(body.agents).toBeDefined();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(3);
  });

  test("GET /api/agents/:id — get specific agent", async () => {
    const { status, body } = await get(`/api/agents/${ids.workerAgent}`);
    expect(status).toBe(200);
    expect(body.id).toBe(ids.workerAgent);
    expect(body.name).toBe("TestWorker");
    // Should include capacity info
    expect(body.capacity).toBeDefined();
  });

  test("GET /api/agents/:id — non-existent returns 404", async () => {
    const { status } = await get(`/api/agents/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("PUT /api/agents/:id/name — rename agent", async () => {
    const { status, body } = await put(`/api/agents/${ids.workerAgent}/name`, {
      body: { name: "RenamedWorker" },
    });
    expect(status).toBe(200);
    expect(body.name).toBe("RenamedWorker");
  });

  test("PUT /api/agents/:id/name — missing name returns 400", async () => {
    const { status } = await put(`/api/agents/${ids.workerAgent}/name`, { body: {} });
    expect(status).toBe(400);
  });

  test("PUT /api/agents/:id/profile — update profile", async () => {
    const { status, body } = await put(`/api/agents/${ids.workerAgent}/profile`, {
      body: {
        description: "Updated description",
        role: "senior-worker",
        capabilities: ["typescript", "testing"],
      },
    });
    expect(status).toBe(200);
    expect(body.description).toBe("Updated description");
    expect(body.role).toBe("senior-worker");
  });

  test("PUT /api/agents/:id/profile — non-existent returns 404", async () => {
    const { status } = await put(`/api/agents/${randomUUID()}/profile`, {
      body: { role: "ghost" },
    });
    expect(status).toBe(404);
  });

  test("PUT /api/agents/:id/activity — update activity timestamp", async () => {
    const { status } = await put(`/api/agents/${ids.workerAgent}/activity`);
    expect(status).toBe(204);
  });

  test("PUT /api/agents/:id/activity — non-existent still returns 204 (fire-and-forget)", async () => {
    // Activity endpoint doesn't validate agent existence; it just runs an UPDATE
    const { status } = await put(`/api/agents/${randomUUID()}/activity`);
    expect(status).toBe(204);
  });

  test("GET /api/agents/:id/setup-script — returns setup script", async () => {
    const { status, body } = await get(`/api/agents/${ids.workerAgent}/setup-script`);
    expect(status).toBe(200);
    expect(body).toBeDefined();
  });

  test("GET /api/agents/:id/setup-script — non-existent returns 404", async () => {
    const { status } = await get(`/api/agents/${randomUUID()}/setup-script`);
    expect(status).toBe(404);
  });

  test("GET /me — returns agent info", async () => {
    const { status, body } = await get("/me", { agentId: ids.workerAgent });
    expect(status).toBe(200);
    expect(body.id).toBe(ids.workerAgent);
  });

  test("POST /ping — heartbeat updates agent", async () => {
    const { status } = await post("/ping", { agentId: ids.workerAgent });
    expect(status).toBe(204);
  });

  test("POST /ping — non-existent agent returns 404", async () => {
    const { status } = await post("/ping", { agentId: randomUUID() });
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 3. Tasks
// ===========================================================================

describe("Tasks", () => {
  test("POST /api/tasks — missing task field returns 400", async () => {
    const { status, body } = await post("/api/tasks", { body: {} });
    expect(status).toBe(400);
    expect(body.error).toContain("task");
  });

  test("POST /api/tasks — create unassigned task", async () => {
    const { status, body } = await post("/api/tasks", {
      agentId: ids.leadAgent,
      body: {
        task: "Integration test task 1",
        taskType: "test",
        tags: ["automated"],
        priority: 75,
      },
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.task).toBe("Integration test task 1");
    ids.task = body.id;
  });

  test("POST /api/tasks — create assigned task", async () => {
    const { status, body } = await post("/api/tasks", {
      agentId: ids.leadAgent,
      body: {
        task: "Integration test task 2",
        agentId: ids.workerAgent,
      },
    });
    expect(status).toBe(201);
    expect(body.agentId).toBe(ids.workerAgent);
    ids.task2 = body.id;
  });

  test("GET /api/tasks — list all tasks", async () => {
    const { status, body } = await get("/api/tasks");
    expect(status).toBe(200);
    expect(body.tasks).toBeDefined();
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/tasks?status=pending — filter by status", async () => {
    const { status, body } = await get("/api/tasks?status=pending");
    expect(status).toBe(200);
    for (const t of body.tasks) {
      expect(t.status).toBe("pending");
    }
  });

  test("GET /api/tasks?agentId=... — filter by agent", async () => {
    const { status, body } = await get(`/api/tasks?agentId=${ids.workerAgent}`);
    expect(status).toBe(200);
    for (const t of body.tasks) {
      expect(t.agentId).toBe(ids.workerAgent);
    }
  });

  test("GET /api/tasks?search=... — search tasks", async () => {
    const { status, body } = await get("/api/tasks?search=Integration+test");
    expect(status).toBe(200);
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/tasks?limit=1 — pagination", async () => {
    const { status, body } = await get("/api/tasks?limit=1");
    expect(status).toBe(200);
    expect(body.tasks.length).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test("GET /api/tasks/:id — get specific task", async () => {
    const { status, body } = await get(`/api/tasks/${ids.task}`);
    expect(status).toBe(200);
    expect(body.id).toBe(ids.task);
    expect(body.task).toBe("Integration test task 1");
  });

  test("GET /api/tasks/:id — non-existent returns 404", async () => {
    const { status } = await get(`/api/tasks/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("PUT /api/tasks/:id/claude-session — update session ID", async () => {
    const sessionId = randomUUID();
    const { status, body } = await put(`/api/tasks/${ids.task2}/claude-session`, {
      agentId: ids.workerAgent,
      body: { claudeSessionId: sessionId },
    });
    expect(status).toBe(200);
    expect(body.claudeSessionId).toBe(sessionId);
  });

  test("PUT /api/tasks/:id/claude-session — missing fields returns 400", async () => {
    const { status } = await put(`/api/tasks/${ids.task2}/claude-session`, {
      body: {},
    });
    expect(status).toBe(400);
  });

  test("POST /api/tasks/:id/finish — missing agent ID returns 400", async () => {
    const { status } = await post(`/api/tasks/${ids.task2}/finish`, {
      body: { status: "completed" },
    });
    expect(status).toBe(400);
  });

  test("POST /api/tasks/:id/finish — invalid status returns 400", async () => {
    const { status } = await post(`/api/tasks/${ids.task2}/finish`, {
      agentId: ids.workerAgent,
      body: { status: "invalid" },
    });
    expect(status).toBe(400);
  });

  test("POST /api/tasks/:id/finish — pending task returns alreadyFinished", async () => {
    // Task is in 'pending' status (not in_progress), so finish returns success with alreadyFinished flag
    const { status, body } = await post(`/api/tasks/${ids.task2}/finish`, {
      agentId: ids.workerAgent,
      body: { status: "completed", output: "Test output" },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.alreadyFinished).toBe(true);
  });

  test("POST /api/tasks/:id/finish — wrong agent returns 403", async () => {
    // Create a task for worker, try to finish as worker2
    const createRes = await post("/api/tasks", {
      agentId: ids.leadAgent,
      body: { task: "Forbidden finish test", agentId: ids.workerAgent },
    });
    const taskId = createRes.body.id;
    const { status } = await post(`/api/tasks/${taskId}/finish`, {
      agentId: ids.workerAgent2,
      body: { status: "completed" },
    });
    expect(status).toBe(403);
  });

  test("POST /api/tasks/:id/finish — non-existent task returns 404", async () => {
    const { status } = await post(`/api/tasks/${randomUUID()}/finish`, {
      agentId: ids.workerAgent,
      body: { status: "failed", failureReason: "Not found" },
    });
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 4. Task Pause / Resume
// ===========================================================================

describe("Task Pause & Resume", () => {
  let pauseTaskId: string;

  test("create a task to pause", async () => {
    const { body } = await post("/api/tasks", {
      agentId: ids.leadAgent,
      body: { task: "Pause test task", agentId: ids.workerAgent2 },
    });
    pauseTaskId = body.id;
  });

  test("POST /api/tasks/:id/pause — missing agent ID returns 400", async () => {
    const { status } = await post(`/api/tasks/${pauseTaskId}/pause`);
    expect(status).toBe(400);
  });

  test("POST /api/tasks/:id/pause — pause the task", async () => {
    const { status } = await post(`/api/tasks/${pauseTaskId}/pause`, {
      agentId: ids.workerAgent2,
    });
    // Pausing a pending task may succeed or fail depending on implementation
    expect([200, 400, 403]).toContain(status);
  });

  test("GET /api/paused-tasks — requires agent ID", async () => {
    const { status } = await get("/api/paused-tasks");
    expect(status).toBe(400);
  });

  test("GET /api/paused-tasks — returns paused tasks for agent", async () => {
    const { status } = await get("/api/paused-tasks", { agentId: ids.workerAgent2 });
    expect(status).toBe(200);
  });

  test("POST /api/tasks/:id/resume — non-existent returns 404", async () => {
    const { status } = await post(`/api/tasks/${randomUUID()}/resume`, {
      agentId: ids.workerAgent,
    });
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 4b. Task Cancel
// ===========================================================================

describe("Task Cancel", () => {
  let cancelTaskId: string;

  test("POST /api/tasks/:id/cancel — cancel pending task with reason", async () => {
    const { body: t } = await post("/api/tasks", {
      agentId: ids.leadAgent,
      body: { task: "Cancel test - pending task" },
    });
    cancelTaskId = t.id;

    const { status, body } = await post(`/api/tasks/${cancelTaskId}/cancel`, {
      body: { reason: "test cancellation" },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.task).toBeDefined();
    expect(body.task.status).toBe("cancelled");
    expect(body.task.failureReason).toContain("test cancellation");
  });

  test("POST /api/tasks/:id/cancel — already-cancelled task returns 400", async () => {
    // cancelTaskId was cancelled in the previous test
    const { status } = await post(`/api/tasks/${cancelTaskId}/cancel`);
    expect(status).toBe(400);
  });

  test("POST /api/tasks/:id/cancel — non-existent task returns 404", async () => {
    const { status } = await post(`/api/tasks/${randomUUID()}/cancel`);
    expect(status).toBe(404);
  });

  test("POST /api/tasks/:id/cancel — cancel without reason", async () => {
    const { body: t } = await post("/api/tasks", {
      agentId: ids.leadAgent,
      body: { task: "Cancel test - no reason" },
    });
    const { status, body } = await post(`/api/tasks/${t.id}/cancel`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.task.status).toBe("cancelled");
  });
});

// ===========================================================================
// 5. Cancelled Tasks
// ===========================================================================

describe("Cancelled Tasks", () => {
  test("GET /cancelled-tasks — missing agent ID returns 400", async () => {
    const { status } = await get("/cancelled-tasks");
    expect(status).toBe(400);
  });

  test("GET /cancelled-tasks — returns cancelled list for agent", async () => {
    const { status, body } = await get("/cancelled-tasks", { agentId: ids.workerAgent });
    expect(status).toBe(200);
    expect(body.cancelled).toBeDefined();
    expect(Array.isArray(body.cancelled)).toBe(true);
  });

  test("GET /cancelled-tasks?taskId=... — check specific task", async () => {
    const { status, body } = await get(`/cancelled-tasks?taskId=${ids.task}`, {
      agentId: ids.workerAgent,
    });
    expect(status).toBe(200);
    expect(body.cancelled).toBeDefined();
  });
});

// ===========================================================================
// 6. Session Logs
// ===========================================================================

describe("Session Logs", () => {
  const sessionId = randomUUID();

  test("POST /api/session-logs — missing sessionId returns 400", async () => {
    const { status, body } = await post("/api/session-logs", {
      body: { iteration: 1, lines: ["test"] },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("sessionId");
  });

  test("POST /api/session-logs — missing iteration returns 400", async () => {
    const { status } = await post("/api/session-logs", {
      body: { sessionId, lines: ["test"] },
    });
    expect(status).toBe(400);
  });

  test("POST /api/session-logs — missing lines returns 400", async () => {
    const { status } = await post("/api/session-logs", {
      body: { sessionId, iteration: 1 },
    });
    expect(status).toBe(400);
  });

  test("POST /api/session-logs — store logs successfully", async () => {
    const { status, body } = await post("/api/session-logs", {
      body: {
        sessionId,
        taskId: ids.task,
        iteration: 1,
        lines: ["line 1", "line 2"],
      },
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
  });

  test("GET /api/tasks/:id/session-logs — get logs for task", async () => {
    const { status, body } = await get(`/api/tasks/${ids.task}/session-logs`);
    expect(status).toBe(200);
    expect(body.logs).toBeDefined();
  });

  test("GET /api/tasks/:id/session-logs — non-existent task returns 404", async () => {
    const { status } = await get(`/api/tasks/${randomUUID()}/session-logs`);
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 7. Session Costs
// ===========================================================================

describe("Session Costs", () => {
  const sessionId = randomUUID();

  test("POST /api/session-costs — missing sessionId returns 400", async () => {
    const { status } = await post("/api/session-costs", {
      body: { agentId: ids.workerAgent, totalCostUsd: 0.5 },
    });
    expect(status).toBe(400);
  });

  test("POST /api/session-costs — missing agentId returns 400", async () => {
    const { status } = await post("/api/session-costs", {
      body: { sessionId, totalCostUsd: 0.5 },
    });
    expect(status).toBe(400);
  });

  test("POST /api/session-costs — missing totalCostUsd returns 400", async () => {
    const { status } = await post("/api/session-costs", {
      body: { sessionId, agentId: ids.workerAgent },
    });
    expect(status).toBe(400);
  });

  test("POST /api/session-costs — store cost successfully", async () => {
    const { status, body } = await post("/api/session-costs", {
      body: {
        sessionId,
        agentId: ids.workerAgent,
        taskId: ids.task,
        totalCostUsd: 1.23,
        inputTokens: 5000,
        outputTokens: 2000,
        model: "opus",
        numTurns: 5,
        durationMs: 30000,
      },
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.cost).toBeDefined();
  });

  test("GET /api/session-costs — list costs", async () => {
    const { status, body } = await get("/api/session-costs");
    expect(status).toBe(200);
    expect(body.costs).toBeDefined();
    expect(Array.isArray(body.costs)).toBe(true);
  });

  test("GET /api/session-costs/summary — get cost summary", async () => {
    const { status } = await get("/api/session-costs/summary");
    expect(status).toBe(200);
  });

  test("GET /api/session-costs/dashboard — get dashboard data", async () => {
    const { status } = await get("/api/session-costs/dashboard");
    expect(status).toBe(200);
  });
});

// ===========================================================================
// 8. Active Sessions
// ===========================================================================

describe("Active Sessions", () => {
  test("POST /api/active-sessions — missing fields returns 400", async () => {
    const { status } = await post("/api/active-sessions", {
      body: { agentId: ids.workerAgent },
    });
    expect(status).toBe(400);
  });

  test("POST /api/active-sessions — create session", async () => {
    const { status, body } = await post("/api/active-sessions", {
      body: {
        agentId: ids.workerAgent,
        taskId: ids.task,
        triggerType: "task",
        taskDescription: "Test session",
      },
    });
    expect(status).toBe(201);
    expect(body.session).toBeDefined();
    ids.session = body.session.id;
  });

  test("GET /api/active-sessions — list sessions", async () => {
    const { status, body } = await get("/api/active-sessions");
    expect(status).toBe(200);
    expect(body.sessions).toBeDefined();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test("GET /api/active-sessions?agentId=... — filter by agent", async () => {
    const { status, body } = await get(`/api/active-sessions?agentId=${ids.workerAgent}`);
    expect(status).toBe(200);
    expect(body.sessions).toBeDefined();
  });

  test("PUT /api/active-sessions/heartbeat/:taskId — update heartbeat", async () => {
    const { status } = await put(`/api/active-sessions/heartbeat/${ids.task}`);
    expect(status).toBe(200);
  });

  test("DELETE /api/active-sessions/:id — delete by session ID", async () => {
    const { status } = await del(`/api/active-sessions/${ids.session}`);
    expect(status).toBe(200);
  });

  test("DELETE /api/active-sessions/by-task/:taskId — delete by task", async () => {
    // Create a session then delete by task
    await post("/api/active-sessions", {
      body: { agentId: ids.workerAgent2, taskId: ids.task, triggerType: "task" },
    });
    const { status } = await del(`/api/active-sessions/by-task/${ids.task}`);
    expect(status).toBe(200);
  });

  test("POST /api/active-sessions/cleanup — cleanup stale sessions", async () => {
    const { status, body } = await post("/api/active-sessions/cleanup", {
      body: { maxAgeMinutes: 1 },
    });
    expect(status).toBe(200);
    expect(typeof body.cleaned).toBe("number");
  });

  test("POST /api/active-sessions/cleanup — cleanup by agent", async () => {
    const { status, body } = await post("/api/active-sessions/cleanup", {
      body: { agentId: ids.workerAgent },
    });
    expect(status).toBe(200);
    expect(typeof body.cleaned).toBe("number");
  });
});

// ===========================================================================
// 9. Stats, Logs, Services, Scheduled Tasks
// ===========================================================================

describe("Stats & Metadata", () => {
  test("GET /api/stats — returns stats", async () => {
    const { status, body } = await get("/api/stats");
    expect(status).toBe(200);
    expect(body.agents).toBeDefined();
    expect(body.tasks).toBeDefined();
    expect(body.agents.total).toBeGreaterThanOrEqual(3);
  });

  test("GET /api/logs — returns logs", async () => {
    const { status, body } = await get("/api/logs");
    expect(status).toBe(200);
    expect(body.logs).toBeDefined();
    expect(Array.isArray(body.logs)).toBe(true);
  });

  test("GET /api/services — returns services list", async () => {
    const { status, body } = await get("/api/services");
    expect(status).toBe(200);
    expect(body.services).toBeDefined();
    expect(Array.isArray(body.services)).toBe(true);
  });

  test("GET /api/scheduled-tasks — returns scheduled tasks", async () => {
    const { status, body } = await get("/api/scheduled-tasks");
    expect(status).toBe(200);
    expect(body.scheduledTasks).toBeDefined();
    expect(Array.isArray(body.scheduledTasks)).toBe(true);
  });

  test("GET /api/concurrent-context — returns concurrency info", async () => {
    const { status } = await get("/api/concurrent-context");
    expect(status).toBe(200);
  });
});

// ===========================================================================
// 10. Polling
// ===========================================================================

describe("Polling", () => {
  test("GET /api/poll — requires agent ID", async () => {
    const { status } = await get("/api/poll");
    expect(status).toBe(400);
  });

  test("GET /api/poll — returns poll response for agent", async () => {
    const { status, body } = await get("/api/poll", { agentId: ids.workerAgent });
    expect(status).toBe(200);
    expect(body).toBeDefined();
  });
});

// ===========================================================================
// 11. Epics
// ===========================================================================

describe("Epics", () => {
  test("POST /api/epics — missing fields returns 400", async () => {
    const { status, body } = await post("/api/epics", {
      body: { name: "No Goal" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("name, goal");
  });

  test("POST /api/epics — create epic", async () => {
    const { status, body } = await post("/api/epics", {
      agentId: ids.leadAgent,
      body: {
        name: "Test Epic",
        goal: "Test all API endpoints",
        description: "Comprehensive testing",
        priority: 80,
        tags: ["testing"],
      },
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Test Epic");
    ids.epic = body.id;
  });

  test("GET /api/epics — list epics", async () => {
    const { status, body } = await get("/api/epics");
    expect(status).toBe(200);
    expect(body.epics).toBeDefined();
    expect(Array.isArray(body.epics)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/epics/:id — get specific epic", async () => {
    const { status, body } = await get(`/api/epics/${ids.epic}`);
    expect(status).toBe(200);
    expect(body.id).toBe(ids.epic);
    expect(body.name).toBe("Test Epic");
  });

  test("GET /api/epics/:id — non-existent returns 404", async () => {
    const { status } = await get(`/api/epics/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("PUT /api/epics/:id — update epic", async () => {
    const { status } = await put(`/api/epics/${ids.epic}`, {
      body: { goal: "Updated goal", status: "active" },
    });
    expect(status).toBe(200);
  });

  test("PUT /api/epics/:id — non-existent returns 404", async () => {
    const { status } = await put(`/api/epics/${randomUUID()}`, {
      body: { goal: "Ghost" },
    });
    expect(status).toBe(404);
  });

  test("POST /api/epics/:id/tasks — assign task to epic", async () => {
    const { status } = await post(`/api/epics/${ids.epic}/tasks`, {
      body: { taskId: ids.task },
    });
    expect(status).toBe(200);
  });

  test("POST /api/epics/:id/tasks — missing taskId returns 400", async () => {
    const { status } = await post(`/api/epics/${ids.epic}/tasks`, {
      body: {},
    });
    expect(status).toBe(400);
  });

  test("POST /api/epics/:id/tasks — non-existent epic returns 404", async () => {
    const { status } = await post(`/api/epics/${randomUUID()}/tasks`, {
      body: { taskId: ids.task },
    });
    expect(status).toBe(404);
  });

  test("DELETE /api/epics/:id — delete the test epic", async () => {
    const { status } = await del(`/api/epics/${ids.epic}`);
    expect(status).toBe(200);
  });

  test("DELETE /api/epics/:id — non-existent returns 404", async () => {
    const { status } = await del(`/api/epics/${randomUUID()}`);
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 11b. Schedule CRUD
// ===========================================================================

describe("Schedule CRUD", () => {
  let scheduleId: string;

  test("POST /api/schedules — create schedule with cron expression", async () => {
    const { status, body } = await post("/api/schedules", {
      body: {
        name: "test-schedule",
        taskTemplate: "Run integration test suite",
        cronExpression: "0 * * * *",
      },
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-schedule");
    expect(body.nextRunAt).toBeDefined();
    expect(body.enabled).toBe(true);
    scheduleId = body.id;
  });

  test("POST /api/schedules — missing name returns 400", async () => {
    const { status } = await post("/api/schedules", {
      body: { taskTemplate: "do something" },
    });
    expect(status).toBe(400);
  });

  test("POST /api/schedules — missing taskTemplate returns 400", async () => {
    const { status } = await post("/api/schedules", {
      body: { name: "no-template" },
    });
    expect(status).toBe(400);
  });

  test("POST /api/schedules — invalid cron expression returns 400", async () => {
    const { status } = await post("/api/schedules", {
      body: {
        name: "bad-cron",
        taskTemplate: "do something",
        cronExpression: "not-a-cron",
      },
    });
    expect(status).toBe(400);
  });

  test("POST /api/schedules — duplicate name returns 409", async () => {
    const { status } = await post("/api/schedules", {
      body: {
        name: "test-schedule",
        taskTemplate: "duplicate",
        cronExpression: "0 * * * *",
      },
    });
    expect([400, 409]).toContain(status);
  });

  test("GET /api/schedules/:id — fetch single schedule", async () => {
    const { status, body } = await get(`/api/schedules/${scheduleId}`);
    expect(status).toBe(200);
    expect(body.id).toBe(scheduleId);
    expect(body.name).toBe("test-schedule");
    expect(body.taskTemplate).toBe("Run integration test suite");
  });

  test("GET /api/schedules/:id — non-existent returns 404", async () => {
    const { status } = await get(`/api/schedules/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("PUT /api/schedules/:id — update name", async () => {
    const { status, body } = await put(`/api/schedules/${scheduleId}`, {
      body: { name: "updated-schedule" },
    });
    expect(status).toBe(200);
    expect(body.name).toBe("updated-schedule");
  });

  test("PUT /api/schedules/:id — disable schedule clears nextRunAt", async () => {
    const { status, body } = await put(`/api/schedules/${scheduleId}`, {
      body: { enabled: false },
    });
    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.nextRunAt).toBeFalsy();
  });

  test("PUT /api/schedules/:id — re-enable schedule recalculates nextRunAt", async () => {
    const { status, body } = await put(`/api/schedules/${scheduleId}`, {
      body: { enabled: true },
    });
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.nextRunAt).toBeDefined();
    expect(body.nextRunAt).not.toBeNull();
  });

  test("PUT /api/schedules/:id — non-existent returns 404", async () => {
    const { status } = await put(`/api/schedules/${randomUUID()}`, {
      body: { name: "ghost" },
    });
    expect(status).toBe(404);
  });

  test("POST /api/schedules/:id/run — run now creates a task", async () => {
    const { status, body } = await post(`/api/schedules/${scheduleId}/run`);
    expect(status).toBe(200);
    expect(body.schedule).toBeDefined();
    expect(body.task).toBeDefined();
    expect(body.task.id).toBeDefined();
  });

  test("POST /api/schedules/:id/run — disabled schedule returns 400", async () => {
    // Disable the schedule first
    await put(`/api/schedules/${scheduleId}`, {
      body: { enabled: false },
    });
    const { status } = await post(`/api/schedules/${scheduleId}/run`);
    expect(status).toBe(400);
    // Re-enable for subsequent tests
    await put(`/api/schedules/${scheduleId}`, {
      body: { enabled: true },
    });
  });

  test("POST /api/schedules/:id/run — non-existent returns 404", async () => {
    const { status } = await post(`/api/schedules/${randomUUID()}/run`);
    expect(status).toBe(404);
  });

  test("DELETE /api/schedules/:id — delete schedule", async () => {
    const { status, body } = await del(`/api/schedules/${scheduleId}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test("DELETE /api/schedules/:id — non-existent returns 404", async () => {
    const { status } = await del(`/api/schedules/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("GET /api/schedules/:id — deleted schedule returns 404", async () => {
    const { status } = await get(`/api/schedules/${scheduleId}`);
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 12. Channels & Messages
// ===========================================================================

describe("Channels & Messages", () => {
  test("GET /api/channels — list channels (includes default 'general')", async () => {
    const { status, body } = await get("/api/channels");
    expect(status).toBe(200);
    expect(body.channels).toBeDefined();
    expect(Array.isArray(body.channels)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: channel shape varies
    const general = body.channels.find((c: any) => c.name === "general");
    expect(general).toBeDefined();
    ids.channel = general.id;
  });

  test("POST /api/channels/:id/messages — post a message", async () => {
    const { status, body } = await post(`/api/channels/${ids.channel}/messages`, {
      body: { content: "Hello from integration test!", agentId: ids.workerAgent },
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    ids.message = body.id;
  });

  test("POST /api/channels/:id/messages — missing content returns 400", async () => {
    const { status } = await post(`/api/channels/${ids.channel}/messages`, {
      body: {},
    });
    expect(status).toBe(400);
  });

  test("POST /api/channels/:id/messages — non-existent channel returns 404", async () => {
    const { status } = await post(`/api/channels/${randomUUID()}/messages`, {
      body: { content: "Ghost channel" },
    });
    expect(status).toBe(404);
  });

  test("GET /api/channels/:id/messages — get messages", async () => {
    const { status, body } = await get(`/api/channels/${ids.channel}/messages`);
    expect(status).toBe(200);
    const messages = body.messages || body;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/channels/:id/messages — non-existent channel returns 404", async () => {
    const { status } = await get(`/api/channels/${randomUUID()}/messages`);
    expect(status).toBe(404);
  });

  test("GET /api/channels/:id/messages/:messageId/thread — get thread", async () => {
    const { status } = await get(`/api/channels/${ids.channel}/messages/${ids.message}/thread`);
    expect(status).toBe(200);
  });

  // --- Channel Create / Delete ---

  let createdChannelId: string;

  test("POST /api/channels — create channel", async () => {
    const { status, body } = await post("/api/channels", {
      body: { name: "test-channel-crud" },
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-channel-crud");
    expect(body.type).toBe("public");
    createdChannelId = body.id;
  });

  test("POST /api/channels — create with description and type", async () => {
    const { status, body } = await post("/api/channels", {
      body: { name: "test-dm-channel", description: "A DM channel", type: "dm" },
    });
    expect(status).toBe(201);
    expect(body.type).toBe("dm");
    expect(body.description).toBe("A DM channel");
    // Clean up - delete this channel
    await del(`/api/channels/${body.id}`);
  });

  test("POST /api/channels — duplicate name returns 409", async () => {
    const { status } = await post("/api/channels", {
      body: { name: "test-channel-crud" },
    });
    expect([400, 409]).toContain(status);
  });

  test("POST /api/channels — missing name returns 400", async () => {
    const { status } = await post("/api/channels", {
      body: {},
    });
    expect(status).toBe(400);
  });

  test("DELETE /api/channels/:id — delete created channel", async () => {
    const { status, body } = await del(`/api/channels/${createdChannelId}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test("DELETE /api/channels/:id — cannot delete general channel", async () => {
    // The general channel has the well-known ID
    const generalId = "00000000-0000-4000-8000-000000000001";
    const { status } = await del(`/api/channels/${generalId}`);
    expect([400, 403]).toContain(status);
  });

  test("DELETE /api/channels/:id — non-existent returns 404", async () => {
    const { status } = await del(`/api/channels/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("GET /api/channels — deleted channel not in list", async () => {
    const { status, body } = await get("/api/channels");
    expect(status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: channel shape varies
    const found = body.channels.find((c: any) => c.id === createdChannelId);
    expect(found).toBeUndefined();
  });
});

// ===========================================================================
// 13. Config
// ===========================================================================

describe("Config", () => {
  test("PUT /api/config — missing required fields returns 400", async () => {
    const { status } = await put("/api/config", {
      body: { scope: "global" },
    });
    expect(status).toBe(400);
  });

  test("PUT /api/config — create global config", async () => {
    const { status, body } = await put("/api/config", {
      body: {
        scope: "global",
        key: "TEST_CONFIG_KEY",
        value: "test_value",
        description: "Test config",
      },
    });
    expect(status).toBe(200);
    expect(body.key).toBe("TEST_CONFIG_KEY");
    ids.config = body.id;
  });

  test("PUT /api/config — agent scope requires scopeId", async () => {
    const { status, body } = await put("/api/config", {
      body: { scope: "agent", key: "AGENT_KEY", value: "v" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("scopeId");
  });

  test("PUT /api/config — create agent-scoped config", async () => {
    const { status, body } = await put("/api/config", {
      body: {
        scope: "agent",
        scopeId: ids.workerAgent,
        key: "AGENT_SPECIFIC",
        value: "agent_val",
      },
    });
    expect(status).toBe(200);
    expect(body.scope).toBe("agent");
  });

  test("GET /api/config — list all config entries", async () => {
    const { status, body } = await get("/api/config");
    expect(status).toBe(200);
    expect(body.configs).toBeDefined();
    expect(Array.isArray(body.configs)).toBe(true);
  });

  test("GET /api/config/:id — get specific config", async () => {
    const { status, body } = await get(`/api/config/${ids.config}`);
    expect(status).toBe(200);
    expect(body.key).toBe("TEST_CONFIG_KEY");
  });

  test("GET /api/config/:id — non-existent returns 404", async () => {
    const { status } = await get(`/api/config/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("GET /api/config/resolved — get merged config", async () => {
    const { status } = await get("/api/config/resolved");
    expect(status).toBe(200);
  });

  test("GET /api/config/resolved?agentId=... — with agent scope", async () => {
    const { status } = await get(`/api/config/resolved?agentId=${ids.workerAgent}`);
    expect(status).toBe(200);
  });

  test("DELETE /api/config/:id — delete config", async () => {
    // Create a config to delete
    const createRes = await put("/api/config", {
      body: { scope: "global", key: "DELETE_ME", value: "bye" },
    });
    const configId = createRes.body.id;
    const { status } = await del(`/api/config/${configId}`);
    expect(status).toBe(200);
  });

  test("DELETE /api/config/:id — non-existent returns 404", async () => {
    const { status } = await del(`/api/config/${randomUUID()}`);
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 14. Repos
// ===========================================================================

describe("Repos", () => {
  test("POST /api/repos — missing fields returns 400", async () => {
    const { status } = await post("/api/repos", {
      body: { name: "test-repo" },
    });
    expect(status).toBe(400);
  });

  test("POST /api/repos — create repo", async () => {
    const { status, body } = await post("/api/repos", {
      body: {
        name: "test-repo",
        url: "https://github.com/test-org/test-repo",
        defaultBranch: "main",
        description: "Test repository",
      },
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-repo");
    ids.repo = body.id;
  });

  test("POST /api/repos — duplicate URL returns 409", async () => {
    const { status } = await post("/api/repos", {
      body: {
        name: "test-repo-dup",
        url: "https://github.com/test-org/test-repo",
      },
    });
    expect(status).toBe(409);
  });

  test("GET /api/repos — list repos", async () => {
    const { status, body } = await get("/api/repos");
    expect(status).toBe(200);
    expect(body.repos).toBeDefined();
    expect(Array.isArray(body.repos)).toBe(true);
  });

  test("GET /api/repos/:id — get specific repo", async () => {
    const { status, body } = await get(`/api/repos/${ids.repo}`);
    expect(status).toBe(200);
    expect(body.name).toBe("test-repo");
  });

  test("GET /api/repos/:id — non-existent returns 404", async () => {
    const { status } = await get(`/api/repos/${randomUUID()}`);
    expect(status).toBe(404);
  });

  test("PUT /api/repos/:id — update repo", async () => {
    const { status, body } = await put(`/api/repos/${ids.repo}`, {
      body: { defaultBranch: "develop" },
    });
    expect(status).toBe(200);
    expect(body.defaultBranch).toBe("develop");
  });

  test("PUT /api/repos/:id — non-existent returns 404", async () => {
    const { status } = await put(`/api/repos/${randomUUID()}`, {
      body: { description: "Ghost" },
    });
    expect(status).toBe(404);
  });

  test("DELETE /api/repos/:id — delete repo", async () => {
    // Create a repo to delete
    const createRes = await post("/api/repos", {
      body: { name: "delete-me", url: "https://github.com/test-org/delete-me" },
    });
    const repoId = createRes.body.id;
    const { status } = await del(`/api/repos/${repoId}`);
    expect(status).toBe(200);
  });

  test("DELETE /api/repos/:id — non-existent returns 404", async () => {
    const { status } = await del(`/api/repos/${randomUUID()}`);
    expect(status).toBe(404);
  });
});

// ===========================================================================
// 15. Memory
// ===========================================================================

describe("Memory", () => {
  test("POST /api/memory/index — missing required fields returns 400", async () => {
    const { status } = await post("/api/memory/index", {
      body: {},
    });
    expect(status).toBe(400);
  });

  test("POST /api/memory/index — index content (returns 202)", async () => {
    const { status, body } = await post("/api/memory/index", {
      agentId: ids.workerAgent,
      body: {
        content: "This is a test memory about API integration testing patterns.",
        name: "test-memory",
        scope: "agent",
        source: "manual",
      },
    });
    expect(status).toBe(202);
    expect(body.queued).toBe(true);
    expect(body.memoryIds).toBeDefined();
  });

  test("POST /api/memory/search — missing query returns 400", async () => {
    const { status } = await post("/api/memory/search", {
      body: {},
    });
    expect(status).toBe(400);
  });

  test("POST /api/memory/search — search with valid query", async () => {
    const { status } = await post("/api/memory/search", {
      agentId: ids.workerAgent,
      body: { query: "integration testing", limit: 5 },
    });
    // May return 200 (success) or 500 (no OPENAI_API_KEY for embeddings)
    expect([200, 500]).toContain(status);
  });
});

// ===========================================================================
// 16. Ecosystem
// ===========================================================================

describe("Ecosystem", () => {
  test("GET /ecosystem — missing agent ID header returns 400", async () => {
    const { status } = await get("/ecosystem");
    expect(status).toBe(400);
  });

  test("GET /ecosystem — returns ecosystem config for agent", async () => {
    const { status, body } = await get("/ecosystem", { agentId: ids.workerAgent });
    expect(status).toBe(200);
    expect(body.apps).toBeDefined();
    expect(Array.isArray(body.apps)).toBe(true);
  });
});

// ===========================================================================
// 17. Close Agent (run near end as it changes agent state)
// ===========================================================================

describe("Close Agent", () => {
  test("POST /close — close agent session", async () => {
    // Create a disposable agent to close
    const closeAgentId = randomUUID();
    await post("/api/agents", {
      agentId: closeAgentId,
      body: { name: "DisposableAgent" },
    });

    const { status } = await post("/close", { agentId: closeAgentId });
    expect(status).toBe(204);

    // Verify agent is now offline
    const { body } = await get(`/api/agents/${closeAgentId}`);
    expect(body.status).toBe("offline");
  });

  test("POST /close — non-existent agent returns 404", async () => {
    const { status } = await post("/close", { agentId: randomUUID() });
    expect(status).toBe(404);
  });
});

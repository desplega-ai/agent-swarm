import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";

const TEST_PORT = 13033;
const TEST_DB_PATH = `/tmp/test-events-http-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;

let serverProc: Subprocess;

async function api(
  method: string,
  path: string,
  opts: { body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const get = (p: string) => api("GET", p);
const post = (p: string, body?: unknown) => api("POST", p, { body });

async function waitForServer(url: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}

  serverProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY: "",
      CAPABILITIES: "core",
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
    try {
      await serverProc.exited;
    } catch {}
  }
  await Bun.sleep(50);
  try {
    await unlink(TEST_DB_PATH);
    await unlink(`${TEST_DB_PATH}-wal`);
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {}
});

describe("POST /api/events — single event", () => {
  test("creates event with required fields", async () => {
    const { status, body } = await post("/api/events", {
      category: "tool",
      event: "tool.start",
      source: "worker",
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.event.id).toBeDefined();
    expect(body.event.category).toBe("tool");
    expect(body.event.event).toBe("tool.start");
    expect(body.event.status).toBe("ok");
    expect(body.event.source).toBe("worker");
  });

  test("creates event with all optional fields", async () => {
    const { status, body } = await post("/api/events", {
      category: "skill",
      event: "skill.invoke",
      source: "worker",
      status: "error",
      agentId: "agent-1",
      taskId: "task-1",
      sessionId: "session-1",
      parentEventId: "parent-1",
      numericValue: 3.14,
      durationMs: 500,
      data: { skillName: "commit" },
    });
    expect(status).toBe(201);
    expect(body.event.status).toBe("error");
    expect(body.event.agentId).toBe("agent-1");
    expect(body.event.data.skillName).toBe("commit");
    expect(body.event.numericValue).toBe(3.14);
    expect(body.event.durationMs).toBe(500);
  });

  test("rejects invalid category", async () => {
    const { status } = await post("/api/events", {
      category: "invalid",
      event: "tool.start",
      source: "worker",
    });
    expect(status).toBe(400);
  });

  test("rejects invalid event name", async () => {
    const { status } = await post("/api/events", {
      category: "tool",
      event: "invalid.event",
      source: "worker",
    });
    expect(status).toBe(400);
  });

  test("rejects missing required fields", async () => {
    const { status } = await post("/api/events", { category: "tool" });
    expect(status).toBe(400);
  });
});

describe("POST /api/events/batch", () => {
  test("creates multiple events", async () => {
    const { status, body } = await post("/api/events/batch", {
      events: [
        { category: "tool", event: "tool.start", source: "worker", data: { toolName: "Read" } },
        { category: "tool", event: "tool.start", source: "worker", data: { toolName: "Bash" } },
        {
          category: "skill",
          event: "skill.invoke",
          source: "worker",
          data: { skillName: "commit" },
        },
      ],
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.count).toBe(3);
  });

  test("rejects empty events array", async () => {
    const { status } = await post("/api/events/batch", { events: [] });
    expect(status).toBe(400);
  });

  test("rejects batch with invalid event", async () => {
    const { status } = await post("/api/events/batch", {
      events: [
        { category: "tool", event: "tool.start", source: "worker" },
        { category: "bad", event: "tool.start", source: "worker" },
      ],
    });
    expect(status).toBe(400);
  });
});

describe("GET /api/events", () => {
  test("returns events list", async () => {
    const { status, body } = await get("/api/events");
    expect(status).toBe(200);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by category", async () => {
    const { status, body } = await get("/api/events?category=skill");
    expect(status).toBe(200);
    for (const evt of body.events) {
      expect(evt.category).toBe("skill");
    }
  });

  test("filters by event name", async () => {
    const { status, body } = await get("/api/events?event=tool.start");
    expect(status).toBe(200);
    for (const evt of body.events) {
      expect(evt.event).toBe("tool.start");
    }
  });

  test("filters by source", async () => {
    const { status, body } = await get("/api/events?source=worker");
    expect(status).toBe(200);
    for (const evt of body.events) {
      expect(evt.source).toBe("worker");
    }
  });

  test("respects limit parameter", async () => {
    const { status, body } = await get("/api/events?limit=2");
    expect(status).toBe(200);
    expect(body.events.length).toBeLessThanOrEqual(2);
  });

  test("filters by agentId", async () => {
    const { body } = await get("/api/events?agentId=agent-1");
    for (const evt of body.events) {
      expect(evt.agentId).toBe("agent-1");
    }
  });

  test("returns empty array for non-matching filters", async () => {
    const { status, body } = await get("/api/events?agentId=nonexistent");
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
  });
});

describe("GET /api/events/counts", () => {
  test("returns counts grouped by event name", async () => {
    const { status, body } = await get("/api/events/counts");
    expect(status).toBe(200);
    expect(Array.isArray(body.counts)).toBe(true);
    expect(body.counts.length).toBeGreaterThanOrEqual(1);
    const first = body.counts[0];
    expect(first.event).toBeDefined();
    expect(first.count).toBeGreaterThanOrEqual(1);
  });

  test("counts are in descending order", async () => {
    const { body } = await get("/api/events/counts");
    for (let i = 1; i < body.counts.length; i++) {
      expect(body.counts[i - 1].count).toBeGreaterThanOrEqual(body.counts[i].count);
    }
  });

  test("filters counts by category", async () => {
    const { body } = await get("/api/events/counts?category=tool");
    for (const c of body.counts) {
      expect(c.event.startsWith("tool.")).toBe(true);
    }
  });

  test("filters counts by agentId", async () => {
    const { body: all } = await get("/api/events/counts");
    const { body: filtered } = await get("/api/events/counts?agentId=agent-1");
    // Filtered should be a subset
    const filteredTotal = (filtered as { counts: { count: number }[] }).counts.reduce(
      (s: number, c: { count: number }) => s + c.count,
      0,
    );
    const allTotal = (all as { counts: { count: number }[] }).counts.reduce(
      (s: number, c: { count: number }) => s + c.count,
      0,
    );
    expect(filteredTotal).toBeLessThanOrEqual(allTotal);
  });
});

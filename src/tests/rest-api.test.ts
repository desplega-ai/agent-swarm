import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDb,
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
  runDbTransaction,
  updateAgentStatus,
} from "../be/db";

const TEST_DB_PATH = "./test-rest-api.sqlite";
const TEST_PORT = 13015;

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

function _parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

// Minimal HTTP handler for REST API endpoints
async function handleRequest(
  req: { method: string; url: string; headers: { get: (key: string) => string | null } },
  _body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const myAgentId = req.headers.get("x-agent-id");

  // GET /me - Get current agent info
  if (req.method === "GET" && (req.url === "/me" || req.url?.startsWith("/me?"))) {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const agent = await getAgentById(myAgentId);

    if (!agent) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    return { status: 200, body: agent };
  }

  // POST /ping - Update agent heartbeat
  if (req.method === "POST" && req.url === "/ping") {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const result = await runDbTransaction(async () => {
      const agent = await getAgentById(myAgentId);

      if (!agent) {
        return { error: true };
      }

      let status: "idle" | "busy" = "idle";
      if (agent.status === "busy") {
        status = "busy";
      }

      await updateAgentStatus(agent.id, status);
      return { error: false };
    });

    if (result.error) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    return { status: 204, body: "" };
  }

  // POST /close - Mark agent as offline
  if (req.method === "POST" && req.url === "/close") {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const result = await runDbTransaction(async () => {
      const agent = await getAgentById(myAgentId);

      if (!agent) {
        return { error: true };
      }

      await updateAgentStatus(agent.id, "offline");
      return { error: false };
    });

    if (result.error) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    return { status: 204, body: "" };
  }

  // GET /api/agents/:id - Get single agent
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2]
  ) {
    const agentId = pathSegments[2];
    const agent = await getAgentById(agentId);

    if (!agent) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    return { status: 200, body: agent };
  }

  // GET /api/tasks/:id - Get single task
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const taskId = pathSegments[2];
    const task = (await getDb())
      .query("SELECT * FROM agent_tasks WHERE id = ?")
      .get(taskId) as unknown;

    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }

    // Mirror the real `GET /api/tasks/:id` handler in `src/http/tasks.ts`
    // by decorating the row with `attachments`. The mock omits `logs` since
    // those tests live elsewhere; attachments are cheap enough to inline.
    const attachments = await getTaskAttachments(taskId);
    return { status: 200, body: { ...(task as object), attachments } };
  }

  // GET /api/stats - Dashboard summary stats
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "stats") {
    const agents = (await getDb()).query("SELECT * FROM agents").all() as Array<{ status: string }>;
    const tasks = (await getDb()).query("SELECT * FROM agent_tasks").all() as Array<{
      status: string;
    }>;

    const stats = {
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        busy: agents.filter((a) => a.status === "busy").length,
        offline: agents.filter((a) => a.status === "offline").length,
      },
      tasks: {
        total: tasks.length,
        unassigned: tasks.filter((t) => t.status === "unassigned").length,
        offered: tasks.filter((t) => t.status === "offered").length,
        reviewing: tasks.filter((t) => t.status === "reviewing").length,
        pending: tasks.filter((t) => t.status === "pending").length,
        in_progress: tasks.filter((t) => t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
      },
    };

    return { status: 200, body: stats };
  }

  return { status: 404, body: { error: "Not found" } };
}

// Create test HTTP server
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();

    const headers = {
      get: (key: string) => req.headers[key.toLowerCase()] as string | null,
    };

    const result = await handleRequest(
      { method: req.method || "GET", url: req.url || "/", headers },
      body,
    );

    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

describe("REST API Endpoints", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    await initDb(TEST_DB_PATH);

    // Start test server
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        console.log(`Test server listening on port ${TEST_PORT}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Close server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Close database
    closeDb();

    // Clean up test database file
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("GET /me", () => {
    test("should return 400 if X-Agent-ID header is missing", async () => {
      const response = await fetch(`${baseUrl}/me`);

      expect(response.status).toBe(400);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/me`, {
        headers: {
          "X-Agent-ID": "non-existent-agent",
        },
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.error).toContain("not found");
    });

    test("should return agent info for existing agent", async () => {
      const agentId = "test-agent-me";
      await createAgent({
        id: agentId,
        name: "Test Agent Me",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/me`, {
        headers: {
          "X-Agent-ID": agentId,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.id).toBe(agentId);
      expect(data.name).toBe("Test Agent Me");
      expect(data.status).toBe("idle");
    });
  });

  describe("POST /ping", () => {
    test("should return 400 if X-Agent-ID header is missing", async () => {
      const response = await fetch(`${baseUrl}/ping`, {
        method: "POST",
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/ping`, {
        method: "POST",
        headers: {
          "X-Agent-ID": "non-existent-agent",
        },
      });

      expect(response.status).toBe(404);
    });

    test("should update agent heartbeat for existing agent", async () => {
      const agentId = "test-agent-ping";
      await createAgent({
        id: agentId,
        name: "Test Agent Ping",
        isLead: false,
        status: "offline",
      });

      const response = await fetch(`${baseUrl}/ping`, {
        method: "POST",
        headers: {
          "X-Agent-ID": agentId,
        },
      });

      expect(response.status).toBe(204);

      // Verify agent status was updated to idle
      const agent = await getAgentById(agentId);
      expect(agent?.status).toBe("idle");
    });

    test("should preserve busy status when pinging", async () => {
      const agentId = "test-agent-ping-busy";
      await createAgent({
        id: agentId,
        name: "Test Agent Ping Busy",
        isLead: false,
        status: "busy",
      });

      const response = await fetch(`${baseUrl}/ping`, {
        method: "POST",
        headers: {
          "X-Agent-ID": agentId,
        },
      });

      expect(response.status).toBe(204);

      // Verify agent status remains busy
      const agent = await getAgentById(agentId);
      expect(agent?.status).toBe("busy");
    });
  });

  describe("POST /close", () => {
    test("should return 400 if X-Agent-ID header is missing", async () => {
      const response = await fetch(`${baseUrl}/close`, {
        method: "POST",
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/close`, {
        method: "POST",
        headers: {
          "X-Agent-ID": "non-existent-agent",
        },
      });

      expect(response.status).toBe(404);
    });

    test("should mark agent as offline", async () => {
      const agentId = "test-agent-close";
      await createAgent({
        id: agentId,
        name: "Test Agent Close",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/close`, {
        method: "POST",
        headers: {
          "X-Agent-ID": agentId,
        },
      });

      expect(response.status).toBe(204);

      // Verify agent status was updated to offline
      const agent = await getAgentById(agentId);
      expect(agent?.status).toBe("offline");
    });
  });

  describe("GET /api/agents/:id", () => {
    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/api/agents/non-existent-agent`);

      expect(response.status).toBe(404);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.error).toContain("not found");
    });

    test("should return agent details for existing agent", async () => {
      const agentId = "test-agent-get";
      await createAgent({
        id: agentId,
        name: "Test Agent Get",
        isLead: true,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.id).toBe(agentId);
      expect(data.name).toBe("Test Agent Get");
      expect(data.isLead).toBe(true);
      expect(data.status).toBe("idle");
    });

    test("should return agent with profile fields", async () => {
      const agentId = "test-agent-with-profile";

      // First create agent, then update its profile
      await createAgent({
        id: agentId,
        name: "Agent with Profile",
        isLead: false,
        status: "idle",
      });

      // Update profile fields via SQL since createAgent doesn't accept them
      (await getDb()).run(
        "UPDATE agents SET description = ?, role = ?, capabilities = ? WHERE id = ?",
        ["Test description", "Test role", JSON.stringify(["test-cap-1", "test-cap-2"]), agentId],
      );

      const response = await fetch(`${baseUrl}/api/agents/${agentId}`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.id).toBe(agentId);
      expect(data.description).toBe("Test description");
      expect(data.role).toBe("Test role");
      expect(data.capabilities).toEqual(["test-cap-1", "test-cap-2"]);
    });
  });

  describe("GET /api/tasks/:id", () => {
    test("should return 404 if task does not exist", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-task`);

      expect(response.status).toBe(404);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.error).toContain("not found");
    });

    test("should return task details for existing task", async () => {
      const task = await createTaskExtended("Test task for GET endpoint", {
        creatorAgentId: "test-agent-get",
      });

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };
      expect(data.id).toBe(task.id);
      expect(data.task).toBe("Test task for GET endpoint");
      expect(data.status).toBe("unassigned");
    });

    test("should include attachments[] in the response", async () => {
      const task = await createTaskExtended("Task with attachments", {
        creatorAgentId: "test-agent-attach",
      });
      await insertTaskAttachment({
        taskId: task.id,
        kind: "url",
        name: "report",
        url: "https://example.com/r.pdf",
        intent: "primary deliverable",
        isPrimary: true,
      });
      await insertTaskAttachment({
        taskId: task.id,
        kind: "agent-fs",
        name: "doc",
        path: "/thoughts/a.md",
      });

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}`);
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        id: string;
        attachments: Array<{ kind: string; name: string; url?: string; path?: string }>;
      };
      expect(data.attachments).toBeDefined();
      expect(data.attachments.length).toBe(2);
      expect(data.attachments[0]?.kind).toBe("url");
      expect(data.attachments[0]?.name).toBe("report");
      expect(data.attachments[1]?.kind).toBe("agent-fs");
      expect(data.attachments[1]?.path).toBe("/thoughts/a.md");
    });

    test("should return an empty attachments[] when none are attached", async () => {
      const task = await createTaskExtended("Task without attachments", {
        creatorAgentId: "test-agent-noattach",
      });
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}`);
      expect(response.status).toBe(200);
      const data = (await response.json()) as { attachments: unknown[] };
      expect(Array.isArray(data.attachments)).toBe(true);
      expect(data.attachments.length).toBe(0);
    });
  });

  describe("GET /api/stats", () => {
    test("should return dashboard statistics", async () => {
      // Create some test data
      await createAgent({
        id: "stats-agent-1",
        name: "Stats Agent 1",
        isLead: false,
        status: "idle",
      });

      await createAgent({
        id: "stats-agent-2",
        name: "Stats Agent 2",
        isLead: false,
        status: "busy",
      });

      await createAgent({
        id: "stats-agent-3",
        name: "Stats Agent 3",
        isLead: false,
        status: "offline",
      });

      await createTaskExtended("Stats task 1", {
        creatorAgentId: "stats-agent-1",
        agentId: "stats-agent-1",
      });

      await createTaskExtended("Stats task 2", {
        creatorAgentId: "stats-agent-1",
      });

      const response = await fetch(`${baseUrl}/api/stats`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };

      expect(data.agents).toBeDefined();
      expect(data.agents.total).toBeGreaterThanOrEqual(3);
      expect(data.agents.idle).toBeGreaterThanOrEqual(1);
      expect(data.agents.busy).toBeGreaterThanOrEqual(1);
      expect(data.agents.offline).toBeGreaterThanOrEqual(1);

      expect(data.tasks).toBeDefined();
      expect(data.tasks.total).toBeGreaterThanOrEqual(2);
      expect(data.tasks.pending).toBeGreaterThanOrEqual(1);
      expect(data.tasks.unassigned).toBeGreaterThanOrEqual(1); // One task was created without agentId
    });

    test("should return empty stats for empty database", async () => {
      // Clean up the database for this test
      closeDb();
      await unlink(TEST_DB_PATH).catch(() => {});
      await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
      await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
      await initDb(TEST_DB_PATH);

      const response = await fetch(`${baseUrl}/api/stats`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        error?: string;
        id?: string;
        name?: string;
        status?: string;
        trigger?: unknown;
      };

      expect(data.agents.total).toBe(0);
      expect(data.agents.idle).toBe(0);
      expect(data.agents.busy).toBe(0);
      expect(data.agents.offline).toBe(0);

      expect(data.tasks.total).toBe(0);
      expect(data.tasks.unassigned).toBe(0);
      expect(data.tasks.offered).toBe(0);
      expect(data.tasks.reviewing).toBe(0);
      expect(data.tasks.pending).toBe(0);
      expect(data.tasks.in_progress).toBe(0);
      expect(data.tasks.completed).toBe(0);
      expect(data.tasks.failed).toBe(0);
    });
  });
});

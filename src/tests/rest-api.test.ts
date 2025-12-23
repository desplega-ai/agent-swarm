import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createChannel,
  createService,
  createTaskExtended,
  getAgentById,
  getDb,
  initDb,
  postMessage,
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

function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

// Minimal HTTP handler for REST API endpoints
async function handleRequest(
  req: { method: string; url: string; headers: { get: (key: string) => string | null } },
  body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  const myAgentId = req.headers.get("x-agent-id");

  // GET /me - Get current agent info
  if (req.method === "GET" && (req.url === "/me" || req.url?.startsWith("/me?"))) {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const agent = getAgentById(myAgentId);

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

    const tx = getDb().transaction(() => {
      const agent = getAgentById(myAgentId);

      if (!agent) {
        return { error: true };
      }

      let status: "idle" | "busy" = "idle";
      if (agent.status === "busy") {
        status = "busy";
      }

      updateAgentStatus(agent.id, status);
      return { error: false };
    });

    const result = tx();
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

    const tx = getDb().transaction(() => {
      const agent = getAgentById(myAgentId);

      if (!agent) {
        return { error: true };
      }

      updateAgentStatus(agent.id, "offline");
      return { error: false };
    });

    const result = tx();
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
    const agent = getAgentById(agentId);

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
    const task = getDb()
      .query("SELECT * FROM agent_tasks WHERE id = ?")
      .get(taskId) as unknown;

    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }

    return { status: 200, body: task };
  }

  // GET /api/stats - Dashboard summary stats
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "stats") {
    const agents = getDb().query("SELECT * FROM agents").all() as Array<{ status: string }>;
    const tasks = getDb().query("SELECT * FROM agent_tasks").all() as Array<{ status: string }>;

    const stats = {
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        busy: agents.filter((a) => a.status === "busy").length,
        offline: agents.filter((a) => a.status === "offline").length,
      },
      tasks: {
        total: tasks.length,
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
    initDb(TEST_DB_PATH);

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
      const data = await response.json();
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/me`, {
        headers: {
          "X-Agent-ID": "non-existent-agent",
        },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("not found");
    });

    test("should return agent info for existing agent", async () => {
      const agentId = "test-agent-me";
      createAgent({
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
      const data = await response.json();
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
      const data = await response.json();
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
      createAgent({
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
      const agent = getAgentById(agentId);
      expect(agent?.status).toBe("idle");
    });

    test("should preserve busy status when pinging", async () => {
      const agentId = "test-agent-ping-busy";
      createAgent({
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
      const agent = getAgentById(agentId);
      expect(agent?.status).toBe("busy");
    });
  });

  describe("POST /close", () => {
    test("should return 400 if X-Agent-ID header is missing", async () => {
      const response = await fetch(`${baseUrl}/close`, {
        method: "POST",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
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
      createAgent({
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
      const agent = getAgentById(agentId);
      expect(agent?.status).toBe("offline");
    });
  });

  describe("GET /api/agents/:id", () => {
    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/api/agents/non-existent-agent`);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("not found");
    });

    test("should return agent details for existing agent", async () => {
      const agentId = "test-agent-get";
      createAgent({
        id: agentId,
        name: "Test Agent Get",
        isLead: true,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe(agentId);
      expect(data.name).toBe("Test Agent Get");
      expect(data.isLead).toBe(true);
      expect(data.status).toBe("idle");
    });

    test("should return agent with profile fields", async () => {
      const agentId = "test-agent-with-profile";

      // First create agent, then update its profile
      createAgent({
        id: agentId,
        name: "Agent with Profile",
        isLead: false,
        status: "idle",
      });

      // Update profile fields via SQL since createAgent doesn't accept them
      getDb().run(
        "UPDATE agents SET description = ?, role = ?, capabilities = ? WHERE id = ?",
        ["Test description", "Test role", JSON.stringify(["test-cap-1", "test-cap-2"]), agentId],
      );

      const response = await fetch(`${baseUrl}/api/agents/${agentId}`);

      expect(response.status).toBe(200);
      const data = await response.json();
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
      const data = await response.json();
      expect(data.error).toContain("not found");
    });

    test("should return task details for existing task", async () => {
      const task = createTaskExtended("Test task for GET endpoint", {
        creatorAgentId: "test-agent-get",
      });

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe(task.id);
      expect(data.task).toBe("Test task for GET endpoint");
      expect(data.status).toBe("unassigned");
    });
  });

  describe("GET /api/stats", () => {
    test("should return dashboard statistics", async () => {
      // Create some test data
      createAgent({
        id: "stats-agent-1",
        name: "Stats Agent 1",
        isLead: false,
        status: "idle",
      });

      createAgent({
        id: "stats-agent-2",
        name: "Stats Agent 2",
        isLead: false,
        status: "busy",
      });

      createAgent({
        id: "stats-agent-3",
        name: "Stats Agent 3",
        isLead: false,
        status: "offline",
      });

      createTaskExtended("Stats task 1", {
        creatorAgentId: "stats-agent-1",
        agentId: "stats-agent-1",
      });

      createTaskExtended("Stats task 2", {
        creatorAgentId: "stats-agent-1",
      });

      const response = await fetch(`${baseUrl}/api/stats`);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.agents).toBeDefined();
      expect(data.agents.total).toBeGreaterThanOrEqual(3);
      expect(data.agents.idle).toBeGreaterThanOrEqual(1);
      expect(data.agents.busy).toBeGreaterThanOrEqual(1);
      expect(data.agents.offline).toBeGreaterThanOrEqual(1);

      expect(data.tasks).toBeDefined();
      expect(data.tasks.total).toBeGreaterThanOrEqual(2);
      expect(data.tasks.pending).toBeGreaterThanOrEqual(1);
      expect(data.tasks.unassigned).toBeUndefined(); // Check that invalid status isn't counted
    });

    test("should return empty stats for empty database", async () => {
      // Clean up the database for this test
      closeDb();
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
      await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
      initDb(TEST_DB_PATH);

      const response = await fetch(`${baseUrl}/api/stats`);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.agents.total).toBe(0);
      expect(data.agents.idle).toBe(0);
      expect(data.agents.busy).toBe(0);
      expect(data.agents.offline).toBe(0);

      expect(data.tasks.total).toBe(0);
      expect(data.tasks.pending).toBe(0);
      expect(data.tasks.in_progress).toBe(0);
      expect(data.tasks.completed).toBe(0);
      expect(data.tasks.failed).toBe(0);
    });
  });
});

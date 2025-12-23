import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDb,
  getInboxSummary,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getUnassignedTasksCount,
  initDb,
  updateAgentStatus,
} from "../be/db";

const TEST_DB_PATH = "./test-runner-polling.sqlite";
const TEST_PORT = 13013;

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

// Minimal HTTP handler for the endpoints we're testing
async function handleRequest(
  req: { method: string; url: string; headers: { get: (key: string) => string | null } },
  body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const myAgentId = req.headers.get("x-agent-id");

  // POST /api/agents - Register a new agent
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    !pathSegments[2]
  ) {
    const parsedBody = JSON.parse(body);

    if (!parsedBody.name || typeof parsedBody.name !== "string") {
      return { status: 400, body: { error: "Missing or invalid 'name' field" } };
    }

    const agentId = myAgentId || crypto.randomUUID();

    const result = getDb().transaction(() => {
      const existingAgent = getAgentById(agentId);
      if (existingAgent) {
        if (existingAgent.status === "offline") {
          updateAgentStatus(existingAgent.id, "idle");
        }
        return { agent: getAgentById(agentId), created: false };
      }

      const agent = createAgent({
        id: agentId,
        name: parsedBody.name,
        isLead: parsedBody.isLead ?? false,
        status: "idle",
        description: parsedBody.description,
        role: parsedBody.role,
        capabilities: parsedBody.capabilities,
      });

      return { agent, created: true };
    })();

    return { status: result.created ? 201 : 200, body: result.agent };
  }

  // GET /api/poll - Poll for triggers
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const result = getDb().transaction(() => {
      const agent = getAgentById(myAgentId);
      if (!agent) {
        return { error: "Agent not found", status: 404 };
      }

      const offeredTasks = getOfferedTasksForAgent(myAgentId);
      const firstOfferedTask = offeredTasks[0];
      if (firstOfferedTask) {
        return {
          trigger: {
            type: "task_offered",
            taskId: firstOfferedTask.id,
            task: firstOfferedTask,
          },
        };
      }

      const pendingTask = getPendingTaskForAgent(myAgentId);
      if (pendingTask) {
        return {
          trigger: {
            type: "task_assigned",
            taskId: pendingTask.id,
            task: pendingTask,
          },
        };
      }

      if (agent.isLead) {
        const inbox = getInboxSummary(myAgentId);
        if (inbox.mentionsCount > 0) {
          return {
            trigger: {
              type: "unread_mentions",
              mentionsCount: inbox.mentionsCount,
            },
          };
        }

        const unassignedCount = getUnassignedTasksCount();
        if (unassignedCount > 0) {
          return {
            trigger: {
              type: "pool_tasks_available",
              count: unassignedCount,
            },
          };
        }
      }

      return { trigger: null };
    })();

    if ("error" in result) {
      return { status: result.status ?? 500, body: { error: result.error } };
    }

    return { status: 200, body: result };
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

describe("Runner-Level Polling API", () => {
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

  describe("POST /api/agents", () => {
    test("should create a new agent with provided ID", async () => {
      const agentId = "test-agent-001";
      const response = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({ name: "Test Agent 1" }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as any;
      expect(data.id).toBe(agentId);
      expect(data.name).toBe("Test Agent 1");
      expect(data.status).toBe("idle");
    });

    test("should return existing agent if already registered", async () => {
      const agentId = "test-agent-001";
      const response = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({ name: "Test Agent 1 Updated" }),
      });

      expect(response.status).toBe(200); // Not 201 since it exists
      const data = (await response.json()) as any;
      expect(data.id).toBe(agentId);
      expect(data.name).toBe("Test Agent 1"); // Original name preserved
    });

    test("should generate UUID if no X-Agent-ID header", async () => {
      const response = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Auto-ID Agent" }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as any;
      expect(data.id).toBeDefined();
      expect(data.id.length).toBe(36); // UUID format
      expect(data.name).toBe("Auto-ID Agent");
    });

    test("should return 400 if name is missing", async () => {
      const response = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": "test-agent-bad",
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error).toContain("name");
    });

    test("should create lead agent with isLead flag", async () => {
      const agentId = "test-lead-001";
      const response = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({ name: "Lead Agent", isLead: true }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as any;
      expect(data.id).toBe(agentId);
      expect(data.isLead).toBe(true);
    });
  });

  describe("GET /api/poll", () => {
    test("should return 400 if X-Agent-ID header is missing", async () => {
      const response = await fetch(`${baseUrl}/api/poll`);

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/api/poll`, {
        headers: {
          "X-Agent-ID": "non-existent-agent",
        },
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as any;
      expect(data.error).toContain("not found");
    });

    test("should return null trigger when no work available", async () => {
      const response = await fetch(`${baseUrl}/api/poll`, {
        headers: {
          "X-Agent-ID": "test-agent-001",
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.trigger).toBeNull();
    });

    test("should return task_assigned trigger when pending task exists", async () => {
      const agentId = "test-worker-with-task";

      // Create agent first
      await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({ name: "Worker With Task" }),
      });

      // Create a pending task assigned to this agent
      const task = createTaskExtended("Test task for worker", {
        agentId,
        creatorAgentId: "test-lead-001",
      });

      const response = await fetch(`${baseUrl}/api/poll`, {
        headers: {
          "X-Agent-ID": agentId,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.trigger).not.toBeNull();
      expect(data.trigger.type).toBe("task_assigned");
      expect(data.trigger.taskId).toBe(task.id);
    });

    test("should return task_offered trigger when offered task exists", async () => {
      const agentId = "test-worker-with-offer";

      // Create agent first
      await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({ name: "Worker With Offer" }),
      });

      // Create an offered task for this agent (using offeredTo sets status to "offered")
      const task = createTaskExtended("Offered task for worker", {
        offeredTo: agentId,
        creatorAgentId: "test-lead-001",
      });

      const response = await fetch(`${baseUrl}/api/poll`, {
        headers: {
          "X-Agent-ID": agentId,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.trigger).not.toBeNull();
      expect(data.trigger.type).toBe("task_offered");
      expect(data.trigger.taskId).toBe(task.id);
    });

    test("should return pool_tasks_available for lead when unassigned tasks exist", async () => {
      const leadId = "test-lead-poll";

      // Create lead agent
      await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": leadId,
        },
        body: JSON.stringify({ name: "Lead For Poll Test", isLead: true }),
      });

      // Create an unassigned task (no agentId means status = "unassigned")
      createTaskExtended("Unassigned task in pool", {
        creatorAgentId: leadId,
        // No agentId = unassigned
      });

      const response = await fetch(`${baseUrl}/api/poll`, {
        headers: {
          "X-Agent-ID": leadId,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      expect(data.trigger).not.toBeNull();
      expect(data.trigger.type).toBe("pool_tasks_available");
      expect(data.trigger.count).toBeGreaterThan(0);
    });

    test("worker should NOT see pool_tasks_available trigger", async () => {
      const workerId = "test-worker-no-pool";

      // Create worker agent (not lead)
      await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": workerId,
        },
        body: JSON.stringify({ name: "Worker No Pool Access", isLead: false }),
      });

      // There's already an unassigned task from previous test

      const response = await fetch(`${baseUrl}/api/poll`, {
        headers: {
          "X-Agent-ID": workerId,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as any;
      // Worker should NOT see pool tasks
      expect(data.trigger).toBeNull();
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskById,
  initDb,
  updateTaskClaudeSessionId,
} from "../be/db";

const TEST_DB_PATH = "./test-session-attach.sqlite";
const TEST_PORT = 13022;

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

// Minimal HTTP handler for session attachment endpoints
async function handleRequest(req: {
  method: string;
  url: string;
  body?: string;
}): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");

  // PUT /api/tasks/:id/claude-session - Update Claude session ID
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "claude-session"
  ) {
    const taskId = pathSegments[2];
    const reqBody = req.body ? JSON.parse(req.body) : {};

    if (!reqBody.claudeSessionId || typeof reqBody.claudeSessionId !== "string") {
      return { status: 400, body: { error: "Missing or invalid 'claudeSessionId' field" } };
    }

    const task = updateTaskClaudeSessionId(taskId, reqBody.claudeSessionId);
    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }

    return { status: 200, body: task };
  }

  // GET /api/tasks/:id - Get single task
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2]
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);
    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }
    return { status: 200, body: task };
  }

  // POST /api/tasks - Create a task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    !pathSegments[2]
  ) {
    const reqBody = req.body ? JSON.parse(req.body) : {};
    if (!reqBody.task) {
      return { status: 400, body: { error: "Missing 'task' field" } };
    }
    const task = createTaskExtended(reqBody.task, {
      agentId: reqBody.agentId || undefined,
      parentTaskId: reqBody.parentTaskId || undefined,
      source: "api",
    });
    return { status: 201, body: task };
  }

  return { status: 404, body: { error: "Not found" } };
}

// Create test HTTP server
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    // Read body for PUT/POST
    let body = "";
    if (req.method === "PUT" || req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString();
    }

    const result = await handleRequest({
      method: req.method || "GET",
      url: req.url || "/",
      body,
    });

    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

describe("Session Attachment", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }

    initDb(TEST_DB_PATH);

    // Create shared agents for tests
    createAgent({
      id: "lead-session-test",
      name: "Lead Agent",
      isLead: true,
      status: "idle",
    });
    createAgent({
      id: "worker-a-session",
      name: "Worker A",
      isLead: false,
      status: "idle",
    });
    createAgent({
      id: "worker-b-session",
      name: "Worker B",
      isLead: false,
      status: "idle",
    });

    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("DB Layer — Migration", () => {
    test("parentTaskId and claudeSessionId columns exist after initDb", () => {
      const task = createTaskExtended("Test migration columns", {
        creatorAgentId: "lead-session-test",
      });
      const fetched = getTaskById(task.id);
      expect(fetched).not.toBeNull();
      // Fields exist (undefined since not set)
      expect(fetched?.parentTaskId).toBeUndefined();
      expect(fetched?.claudeSessionId).toBeUndefined();
    });
  });

  describe("DB Layer — createTaskExtended with parentTaskId", () => {
    test("should persist parentTaskId when provided", () => {
      const parentTask = createTaskExtended("Parent task", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      const childTask = createTaskExtended("Child task", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
        parentTaskId: parentTask.id,
      });

      const fetched = getTaskById(childTask.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.parentTaskId).toBe(parentTask.id);
    });

    test("claudeSessionId should NOT be set at creation time", () => {
      const task = createTaskExtended("Task without session", {
        creatorAgentId: "lead-session-test",
      });

      const fetched = getTaskById(task.id);
      expect(fetched?.claudeSessionId).toBeUndefined();
    });
  });

  describe("DB Layer — updateTaskClaudeSessionId", () => {
    test("should set claudeSessionId on existing task", () => {
      const task = createTaskExtended("Task for session ID", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      const sessionId = "test-session-id-12345";
      const updated = updateTaskClaudeSessionId(task.id, sessionId);

      expect(updated).not.toBeNull();
      expect(updated?.claudeSessionId).toBe(sessionId);

      // Verify via getTaskById
      const fetched = getTaskById(task.id);
      expect(fetched?.claudeSessionId).toBe(sessionId);
    });

    test("should return null for non-existent task", () => {
      const result = updateTaskClaudeSessionId("non-existent-id", "some-session");
      expect(result).toBeNull();
    });
  });

  describe("API Layer — PUT /api/tasks/:id/claude-session", () => {
    test("should update claudeSessionId and return 200", async () => {
      const task = createTaskExtended("Task for API session update", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      const sessionId = "api-session-id-67890";
      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/claude-session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSessionId: sessionId }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { claudeSessionId?: string };
      expect(data.claudeSessionId).toBe(sessionId);
    });

    test("should return 404 for invalid task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-task/claude-session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSessionId: "some-session" }),
      });

      expect(response.status).toBe(404);
    });

    test("should return 400 for missing claudeSessionId", async () => {
      const task = createTaskExtended("Task for bad request", {
        creatorAgentId: "lead-session-test",
      });

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/claude-session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("API Layer — POST /api/tasks with parentTaskId", () => {
    test("should create task with parentTaskId via API", async () => {
      const parentTask = createTaskExtended("API parent task", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "API child task",
          parentTaskId: parentTask.id,
          agentId: "worker-a-session",
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as { id: string; parentTaskId?: string };
      expect(data.parentTaskId).toBe(parentTask.id);
    });
  });

  describe("API Layer — GET /api/tasks/:id returns new fields", () => {
    test("should return parentTaskId and claudeSessionId", async () => {
      const parentTask = createTaskExtended("Parent for GET test", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      const childTask = createTaskExtended("Child for GET test", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
        parentTaskId: parentTask.id,
      });

      // Set session ID on parent
      updateTaskClaudeSessionId(parentTask.id, "parent-session-123");

      // GET child task
      const childResponse = await fetch(`${baseUrl}/api/tasks/${childTask.id}`);
      expect(childResponse.status).toBe(200);
      const childData = (await childResponse.json()) as {
        parentTaskId?: string;
        claudeSessionId?: string;
      };
      expect(childData.parentTaskId).toBe(parentTask.id);

      // GET parent task — should have claudeSessionId
      const parentResponse = await fetch(`${baseUrl}/api/tasks/${parentTask.id}`);
      expect(parentResponse.status).toBe(200);
      const parentData = (await parentResponse.json()) as { claudeSessionId?: string };
      expect(parentData.claudeSessionId).toBe("parent-session-123");
    });
  });

  describe("Auto-Routing — send-task logic simulation", () => {
    test("should auto-route to parent's worker when no agentId", () => {
      // Simulate send-task auto-routing: parent assigned to worker A
      const parentTask = createTaskExtended("Parent for routing", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      // Auto-routing logic (mirrors send-task.ts)
      let effectiveAgentId: string | undefined;
      const parentTaskId = parentTask.id;
      const agentId = undefined; // No explicit agentId

      if (parentTaskId && !agentId) {
        const parent = getTaskById(parentTaskId);
        if (parent?.agentId) {
          effectiveAgentId = parent.agentId;
        }
      }

      expect(effectiveAgentId).toBe("worker-a-session");

      // Create child with auto-routed agentId
      const childTask = createTaskExtended("Child routed task", {
        creatorAgentId: "lead-session-test",
        agentId: effectiveAgentId,
        parentTaskId: parentTask.id,
      });

      const fetched = getTaskById(childTask.id);
      expect(fetched?.agentId).toBe("worker-a-session");
      expect(fetched?.parentTaskId).toBe(parentTask.id);
    });

    test("should use explicit agentId over auto-routing", () => {
      const parentTask = createTaskExtended("Parent for override", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      // Explicit agentId provided — should NOT auto-route
      let effectiveAgentId: string | undefined = "worker-b-session";
      const parentTaskId = parentTask.id;
      const agentId: string | undefined = "worker-b-session";

      if (parentTaskId && !agentId) {
        const parent = getTaskById(parentTaskId);
        if (parent?.agentId) {
          effectiveAgentId = parent.agentId;
        }
      }

      expect(effectiveAgentId).toBe("worker-b-session");

      const childTask = createTaskExtended("Child override task", {
        creatorAgentId: "lead-session-test",
        agentId: effectiveAgentId,
        parentTaskId: parentTask.id,
      });

      const fetched = getTaskById(childTask.id);
      expect(fetched?.agentId).toBe("worker-b-session");
    });

    test("should not auto-route when parent has no agentId", () => {
      // Parent is unassigned (pool task)
      const parentTask = createTaskExtended("Unassigned parent", {
        creatorAgentId: "lead-session-test",
      });

      let effectiveAgentId: string | undefined;
      const parentTaskId = parentTask.id;
      const agentId = undefined;

      if (parentTaskId && !agentId) {
        const parent = getTaskById(parentTaskId);
        if (parent?.agentId) {
          effectiveAgentId = parent.agentId;
        }
      }

      // Parent has no agentId, so effectiveAgentId remains undefined
      expect(effectiveAgentId).toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    test("parent with no claudeSessionId returns null gracefully", () => {
      const parentTask = createTaskExtended("Parent without session", {
        creatorAgentId: "lead-session-test",
        agentId: "worker-a-session",
      });

      const fetched = getTaskById(parentTask.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.claudeSessionId).toBeUndefined();
    });

    test("parentTaskId referencing non-existent task still creates task", () => {
      const bogusParentId = "00000000-0000-0000-0000-000000000000";
      const childTask = createTaskExtended("Child with bogus parent", {
        creatorAgentId: "lead-session-test",
        parentTaskId: bogusParentId,
      });

      expect(childTask).not.toBeNull();
      expect(childTask.parentTaskId).toBe(bogusParentId);

      // Verify the parent doesn't exist
      const parent = getTaskById(bogusParentId);
      expect(parent).toBeNull();
    });
  });
});

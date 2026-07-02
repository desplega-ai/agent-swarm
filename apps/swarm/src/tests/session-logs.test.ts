import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createSessionLogs,
  createTaskExtended,
  getSessionLogsBySession,
  getSessionLogsByTaskId,
  getTaskById,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-session-logs.sqlite";
const TEST_PORT = 13014;

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

// Minimal HTTP handler for session logs endpoints
async function handleRequest(
  req: { method: string; url: string },
  body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");

  // POST /api/session-logs - Store session logs (batch)
  if (req.method === "POST" && pathSegments[0] === "api" && pathSegments[1] === "session-logs") {
    const parsedBody = JSON.parse(body);

    // Validate required fields
    if (!parsedBody.sessionId || typeof parsedBody.sessionId !== "string") {
      return { status: 400, body: { error: "Missing or invalid 'sessionId' field" } };
    }

    if (typeof parsedBody.iteration !== "number" || parsedBody.iteration < 1) {
      return { status: 400, body: { error: "Missing or invalid 'iteration' field" } };
    }

    if (!Array.isArray(parsedBody.lines) || parsedBody.lines.length === 0) {
      return { status: 400, body: { error: "Missing or invalid 'lines' array" } };
    }

    try {
      createSessionLogs({
        taskId: parsedBody.taskId || undefined,
        sessionId: parsedBody.sessionId,
        iteration: parsedBody.iteration,
        cli: parsedBody.cli || "claude",
        lines: parsedBody.lines,
      });

      return { status: 201, body: { success: true, count: parsedBody.lines.length } };
    } catch (error) {
      console.error("[TEST] Failed to create session logs:", error);
      return { status: 500, body: { error: "Failed to store session logs" } };
    }
  }

  // GET /api/tasks/:id/session-logs - Get session logs for a task
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "session-logs"
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }

    const logs = getSessionLogsByTaskId(taskId);
    return { status: 200, body: { logs } };
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

    const result = await handleRequest({ method: req.method || "GET", url: req.url || "/" }, body);

    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

describe("Session Logs API", () => {
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

  describe("Database Functions", () => {
    test("should create and retrieve session logs by taskId", () => {
      // Create a task first
      const task = createTaskExtended("Test task for session logs");

      // Create session logs for the task
      createSessionLogs({
        taskId: task.id,
        sessionId: "test-session-1",
        iteration: 1,
        cli: "claude",
        lines: ['{"type":"system"}', '{"type":"assistant","message":"Hello"}'],
      });

      // Retrieve logs
      const logs = getSessionLogsByTaskId(task.id);

      expect(logs.length).toBe(2);
      expect(logs[0]?.content).toBe('{"type":"system"}');
      expect(logs[1]?.content).toBe('{"type":"assistant","message":"Hello"}');
      expect(logs[0]?.taskId).toBe(task.id);
      expect(logs[0]?.sessionId).toBe("test-session-1");
      expect(logs[0]?.iteration).toBe(1);
      expect(logs[0]?.cli).toBe("claude");
      expect(logs[0]?.lineNumber).toBe(0);
      expect(logs[1]?.lineNumber).toBe(1);
    });

    test("should create session logs without taskId", () => {
      createSessionLogs({
        sessionId: "ai-loop-session",
        iteration: 1,
        cli: "claude",
        lines: ['{"type":"system","subtype":"init"}'],
      });

      // Retrieve by session
      const logs = getSessionLogsBySession("ai-loop-session", 1);

      expect(logs.length).toBe(1);
      expect(logs[0]?.taskId).toBeUndefined();
      expect(logs[0]?.sessionId).toBe("ai-loop-session");
    });

    test("should order logs by iteration and lineNumber", () => {
      const task = createTaskExtended("Task for ordering test");

      // Create logs for multiple iterations
      createSessionLogs({
        taskId: task.id,
        sessionId: "order-session",
        iteration: 1,
        cli: "claude",
        lines: ["line1-iter1", "line2-iter1"],
      });

      createSessionLogs({
        taskId: task.id,
        sessionId: "order-session",
        iteration: 2,
        cli: "claude",
        lines: ["line1-iter2", "line2-iter2"],
      });

      const logs = getSessionLogsByTaskId(task.id);

      expect(logs.length).toBe(4);
      // First iteration, first line
      expect(logs[0]?.content).toBe("line1-iter1");
      expect(logs[0]?.iteration).toBe(1);
      expect(logs[0]?.lineNumber).toBe(0);
      // First iteration, second line
      expect(logs[1]?.content).toBe("line2-iter1");
      expect(logs[1]?.iteration).toBe(1);
      expect(logs[1]?.lineNumber).toBe(1);
      // Second iteration, first line
      expect(logs[2]?.content).toBe("line1-iter2");
      expect(logs[2]?.iteration).toBe(2);
      expect(logs[2]?.lineNumber).toBe(0);
      // Second iteration, second line
      expect(logs[3]?.content).toBe("line2-iter2");
      expect(logs[3]?.iteration).toBe(2);
      expect(logs[3]?.lineNumber).toBe(1);
    });
  });

  describe("POST /api/session-logs", () => {
    test("should return 400 if sessionId is missing", async () => {
      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iteration: 1, lines: ["test"] }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("sessionId");
    });

    test("should return 400 if iteration is missing", async () => {
      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test", lines: ["test"] }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("iteration");
    });

    test("should return 400 if iteration is less than 1", async () => {
      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test", iteration: 0, lines: ["test"] }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("iteration");
    });

    test("should return 400 if lines is missing", async () => {
      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test", iteration: 1 }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("lines");
    });

    test("should return 400 if lines is empty array", async () => {
      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test", iteration: 1, lines: [] }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("lines");
    });

    test("should return 201 on successful POST", async () => {
      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "api-test-session",
          iteration: 1,
          cli: "claude",
          lines: ['{"type":"system"}', '{"type":"result"}'],
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as { success: boolean; count: number };
      expect(data.success).toBe(true);
      expect(data.count).toBe(2);
    });

    test("should store logs with taskId", async () => {
      const task = createTaskExtended("API test task");

      const response = await fetch(`${baseUrl}/api/session-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "api-task-session",
          iteration: 1,
          taskId: task.id,
          cli: "claude",
          lines: ['{"type":"test"}'],
        }),
      });

      expect(response.status).toBe(201);

      // Verify it was stored correctly
      const logs = getSessionLogsByTaskId(task.id);
      expect(logs.length).toBe(1);
      expect(logs[0]?.taskId).toBe(task.id);
    });
  });

  describe("GET /api/tasks/:id/session-logs", () => {
    test("should return 404 if task does not exist", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-task/session-logs`);

      expect(response.status).toBe(404);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("Task not found");
    });

    test("should return empty logs array for task with no logs", async () => {
      const task = createTaskExtended("Task without logs");

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/session-logs`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { logs: unknown[] };
      expect(data.logs).toEqual([]);
    });

    test("should return session logs for a task", async () => {
      const task = createTaskExtended("Task with logs for GET test");

      // Create some logs
      createSessionLogs({
        taskId: task.id,
        sessionId: "get-test-session",
        iteration: 1,
        cli: "claude",
        lines: ['{"type":"system"}', '{"type":"assistant"}'],
      });

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/session-logs`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        logs: Array<{
          id: string;
          taskId: string;
          sessionId: string;
          iteration: number;
          cli: string;
          content: string;
          lineNumber: number;
          createdAt: string;
        }>;
      };
      expect(data.logs.length).toBe(2);
      expect(data.logs[0]?.content).toBe('{"type":"system"}');
      expect(data.logs[1]?.content).toBe('{"type":"assistant"}');
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  cancelTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDb,
  getRecentlyCancelledTasksForAgent,
  getTaskById,
  initDb,
  startTask,
  updateAgentStatusFromCapacity,
} from "../be/db";

const TEST_DB_PATH = "./test-task-cancellation.sqlite";
const TEST_PORT = 13016;

// Helper to parse query params
function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

// Minimal HTTP handler for cancellation endpoints
async function handleRequest(req: {
  method: string;
  url: string;
  headers: { get: (key: string) => string | null };
}): Promise<{ status: number; body: unknown }> {
  const myAgentId = req.headers.get("x-agent-id");

  // GET /cancelled-tasks - with optional ?taskId= query param
  if (
    req.method === "GET" &&
    (req.url === "/cancelled-tasks" || req.url?.startsWith("/cancelled-tasks?"))
  ) {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const agent = getAgentById(myAgentId);
    if (!agent) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    const queryParams = parseQueryParams(req.url || "");
    const taskId = queryParams.get("taskId");

    if (taskId) {
      // Check specific task
      const task = getTaskById(taskId);
      if (task && task.status === "cancelled") {
        return {
          status: 200,
          body: {
            cancelled: [
              {
                id: task.id,
                task: task.task,
                failureReason: task.failureReason,
              },
            ],
          },
        };
      }
      return { status: 200, body: { cancelled: [] } };
    }

    // Return all recently cancelled tasks for agent
    const cancelledTasks = getRecentlyCancelledTasksForAgent(myAgentId);
    return { status: 200, body: { cancelled: cancelledTasks } };
  }

  return { status: 404, body: { error: "Not found" } };
}

// Create test HTTP server
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    const headers = {
      get: (key: string) => req.headers[key.toLowerCase()] as string | null,
    };

    const result = await handleRequest({
      method: req.method || "GET",
      url: req.url || "/",
      headers,
    });

    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

describe("Task Cancellation", () => {
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

  describe("cancelTask database function", () => {
    test("should cancel a pending task", () => {
      const leadAgent = createAgent({
        id: "lead-agent-cancel",
        name: "Lead Agent",
        isLead: true,
        status: "idle",
      });

      const workerAgent = createAgent({
        id: "worker-agent-cancel",
        name: "Worker Agent",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task to cancel", {
        creatorAgentId: leadAgent.id,
        agentId: workerAgent.id,
      });

      expect(task.status).toBe("pending");

      const cancelled = cancelTask(task.id, "Test cancellation reason");

      expect(cancelled).not.toBeNull();
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.failureReason).toBe("Test cancellation reason");
      expect(cancelled?.finishedAt).toBeTruthy();
    });

    test("should cancel an in_progress task", () => {
      const workerAgent = createAgent({
        id: "worker-in-progress",
        name: "Worker In Progress",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task in progress to cancel", {
        creatorAgentId: "lead-agent-cancel",
        agentId: workerAgent.id,
      });

      // Start the task
      startTask(task.id, workerAgent.id);
      const startedTask = getTaskById(task.id);
      expect(startedTask?.status).toBe("in_progress");

      const cancelled = cancelTask(task.id, "Cancelled while in progress");

      expect(cancelled).not.toBeNull();
      expect(cancelled?.status).toBe("cancelled");
    });

    test("should not cancel a completed task", () => {
      const task = createTaskExtended("Completed task", {
        creatorAgentId: "lead-agent-cancel",
      });

      // Manually mark as completed via SQL
      getDb().run("UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?", [
        new Date().toISOString(),
        task.id,
      ]);

      const completedTask = getTaskById(task.id);
      expect(completedTask?.status).toBe("completed");

      const result = cancelTask(task.id, "Try to cancel completed");
      expect(result).toBeNull();
    });

    test("should not cancel a failed task", () => {
      const task = createTaskExtended("Failed task", {
        creatorAgentId: "lead-agent-cancel",
      });

      // Manually mark as failed via SQL
      getDb().run("UPDATE agent_tasks SET status = 'failed', finishedAt = ? WHERE id = ?", [
        new Date().toISOString(),
        task.id,
      ]);

      const failedTask = getTaskById(task.id);
      expect(failedTask?.status).toBe("failed");

      const result = cancelTask(task.id, "Try to cancel failed");
      expect(result).toBeNull();
    });

    test("should return null for non-existent task", () => {
      const result = cancelTask("non-existent-task-id", "Reason");
      expect(result).toBeNull();
    });

    test("should not cancel an unassigned task", () => {
      // Tasks without an agentId have status "unassigned" which is not cancellable
      const task = createTaskExtended("Unassigned task", {
        creatorAgentId: "lead-agent-cancel",
        // No agentId - so it's unassigned
      });

      expect(task.status).toBe("unassigned");

      const result = cancelTask(task.id, "Try to cancel unassigned");
      expect(result).toBeNull();
    });

    test("should use default cancellation reason if none provided", () => {
      const agentId = "worker-default-reason";
      createAgent({
        id: agentId,
        name: "Worker Default Reason",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task without reason", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId, // Assign to agent so status is "pending" (cancellable)
      });

      expect(task.status).toBe("pending");

      const cancelled = cancelTask(task.id);

      expect(cancelled).not.toBeNull();
      expect(cancelled?.failureReason).toBe("Cancelled by user");
    });
  });

  describe("getRecentlyCancelledTasksForAgent", () => {
    test("should return cancelled tasks for an agent", () => {
      const agentId = "worker-recent-cancelled";
      createAgent({
        id: agentId,
        name: "Worker Recent Cancelled",
        isLead: false,
        status: "idle",
      });

      const task1 = createTaskExtended("Recent cancelled task 1", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId,
      });
      const task2 = createTaskExtended("Recent cancelled task 2", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId,
      });

      cancelTask(task1.id, "Reason 1");
      cancelTask(task2.id, "Reason 2");

      const cancelledTasks = getRecentlyCancelledTasksForAgent(agentId);

      expect(cancelledTasks.length).toBeGreaterThanOrEqual(2);
      const taskIds = cancelledTasks.map((t) => t.id);
      expect(taskIds).toContain(task1.id);
      expect(taskIds).toContain(task2.id);
    });

    test("should not return cancelled tasks from other agents", () => {
      const agentA = "agent-a-isolated";
      const agentB = "agent-b-isolated";

      createAgent({
        id: agentA,
        name: "Agent A",
        isLead: false,
        status: "idle",
      });
      createAgent({
        id: agentB,
        name: "Agent B",
        isLead: false,
        status: "idle",
      });

      const taskA = createTaskExtended("Task for Agent A", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentA,
      });
      const taskB = createTaskExtended("Task for Agent B", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentB,
      });

      cancelTask(taskA.id, "Cancelled A");
      cancelTask(taskB.id, "Cancelled B");

      const cancelledForA = getRecentlyCancelledTasksForAgent(agentA);
      const taskIdsA = cancelledForA.map((t) => t.id);
      expect(taskIdsA).toContain(taskA.id);
      expect(taskIdsA).not.toContain(taskB.id);
    });
  });

  describe("updateAgentStatusFromCapacity after cancellation", () => {
    test("should update agent status to idle after task cancellation", () => {
      const agentId = "worker-capacity-update";
      createAgent({
        id: agentId,
        name: "Worker Capacity",
        isLead: false,
        status: "busy",
        maxTasks: 1,
      });

      const task = createTaskExtended("Task for capacity test", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId,
      });

      // Start the task - agent should be busy
      startTask(task.id, agentId);
      let agent = getAgentById(agentId);
      expect(agent?.status).toBe("busy");

      // Cancel the task
      const cancelled = cancelTask(task.id, "Test cancellation");
      expect(cancelled).not.toBeNull();

      // Update agent status based on capacity
      updateAgentStatusFromCapacity(agentId);

      agent = getAgentById(agentId);
      expect(agent?.status).toBe("idle");
    });
  });

  describe("GET /cancelled-tasks endpoint", () => {
    test("should return 400 without X-Agent-ID header", async () => {
      const response = await fetch(`${baseUrl}/cancelled-tasks`);
      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 for non-existent agent", async () => {
      const response = await fetch(`${baseUrl}/cancelled-tasks`, {
        headers: { "X-Agent-ID": "non-existent-agent-id" },
      });
      expect(response.status).toBe(404);
    });

    test("should return empty array when no cancelled tasks", async () => {
      const agentId = "worker-no-cancelled";
      createAgent({
        id: agentId,
        name: "Worker No Cancelled",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/cancelled-tasks`, {
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { cancelled: unknown[] };
      expect(Array.isArray(data.cancelled)).toBe(true);
    });

    test("should return cancelled tasks for agent", async () => {
      const agentId = "worker-with-cancelled";
      createAgent({
        id: agentId,
        name: "Worker With Cancelled",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task to be cancelled for endpoint test", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId,
      });

      cancelTask(task.id, "Endpoint test reason");

      const response = await fetch(`${baseUrl}/cancelled-tasks`, {
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        cancelled: Array<{ id: string; failureReason?: string }>;
      };
      expect(data.cancelled.length).toBeGreaterThanOrEqual(1);

      const cancelledTask = data.cancelled.find((t) => t.id === task.id);
      expect(cancelledTask).toBeTruthy();
      expect(cancelledTask?.failureReason).toBe("Endpoint test reason");
    });

    test("should check specific task with ?taskId= query param", async () => {
      const agentId = "worker-specific-task";
      createAgent({
        id: agentId,
        name: "Worker Specific Task",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Specific task to check", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId,
      });

      cancelTask(task.id, "Specific task cancelled");

      // Check the specific cancelled task
      const response = await fetch(`${baseUrl}/cancelled-tasks?taskId=${task.id}`, {
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        cancelled: Array<{ id: string; failureReason?: string }>;
      };
      expect(data.cancelled.length).toBe(1);
      expect(data.cancelled[0].id).toBe(task.id);
      expect(data.cancelled[0].failureReason).toBe("Specific task cancelled");
    });

    test("should return empty when ?taskId= points to non-cancelled task", async () => {
      const agentId = "worker-not-cancelled-task";
      createAgent({
        id: agentId,
        name: "Worker Not Cancelled Task",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task not cancelled", {
        creatorAgentId: "lead-agent-cancel",
        agentId: agentId,
      });
      // Don't cancel this task

      const response = await fetch(`${baseUrl}/cancelled-tasks?taskId=${task.id}`, {
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { cancelled: unknown[] };
      expect(data.cancelled.length).toBe(0);
    });

    test("should return empty when ?taskId= points to non-existent task", async () => {
      const agentId = "worker-nonexistent-task";
      createAgent({
        id: agentId,
        name: "Worker Non-existent Task",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/cancelled-tasks?taskId=non-existent-task-id`, {
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { cancelled: unknown[] };
      expect(data.cancelled.length).toBe(0);
    });
  });
});

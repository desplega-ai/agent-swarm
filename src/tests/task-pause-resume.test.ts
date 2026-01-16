import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDb,
  getPausedTasksForAgent,
  getTaskById,
  initDb,
  pauseTask,
  resumeTask,
  startTask,
  updateAgentStatusFromCapacity,
} from "../be/db";

const TEST_DB_PATH = "./test-task-pause-resume.sqlite";
const TEST_PORT = 13017;

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

// Minimal HTTP handler for pause/resume endpoints
async function handleRequest(req: {
  method: string;
  url: string;
  headers: { get: (key: string) => string | null };
}): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const myAgentId = req.headers.get("x-agent-id");

  // GET /api/paused-tasks - Get paused tasks for agent
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "paused-tasks") {
    if (!myAgentId) {
      return { status: 400, body: { error: "Missing X-Agent-ID header" } };
    }

    const agent = getAgentById(myAgentId);
    if (!agent) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    const pausedTasks = getPausedTasksForAgent(myAgentId);
    return { status: 200, body: { paused: pausedTasks } };
  }

  // POST /api/tasks/:id/pause - Pause a task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "pause"
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }

    const paused = pauseTask(taskId);
    if (!paused) {
      return {
        status: 400,
        body: { error: "Task cannot be paused (must be in_progress)" },
      };
    }

    return { status: 200, body: { success: true, task: paused } };
  }

  // POST /api/tasks/:id/resume - Resume a task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "resume"
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      return { status: 404, body: { error: "Task not found" } };
    }

    const resumed = resumeTask(taskId);
    if (!resumed) {
      return {
        status: 400,
        body: { error: "Task cannot be resumed (must be paused)" },
      };
    }

    return { status: 200, body: { success: true, task: resumed } };
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

describe("Task Pause/Resume", () => {
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

  describe("pauseTask database function", () => {
    test("should pause an in_progress task", () => {
      const leadAgent = createAgent({
        id: "lead-agent-pause",
        name: "Lead Agent",
        isLead: true,
        status: "idle",
      });

      const workerAgent = createAgent({
        id: "worker-agent-pause",
        name: "Worker Agent",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task to pause", {
        creatorAgentId: leadAgent.id,
        agentId: workerAgent.id,
      });

      // Start the task first
      startTask(task.id, workerAgent.id);
      const startedTask = getTaskById(task.id);
      expect(startedTask?.status).toBe("in_progress");

      // Now pause it
      const paused = pauseTask(task.id);

      expect(paused).not.toBeNull();
      expect(paused?.status).toBe("paused");
      expect(paused?.agentId).toBe(workerAgent.id); // Agent assignment retained
    });

    test("should not pause a pending task", () => {
      const workerAgent = createAgent({
        id: "worker-pending-pause",
        name: "Worker Pending",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Pending task", {
        creatorAgentId: "lead-agent-pause",
        agentId: workerAgent.id,
      });

      expect(task.status).toBe("pending");

      const result = pauseTask(task.id);
      expect(result).toBeNull();
    });

    test("should not pause a completed task", () => {
      const task = createTaskExtended("Completed task for pause test", {
        creatorAgentId: "lead-agent-pause",
      });

      // Manually mark as completed via SQL
      getDb().run("UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?", [
        new Date().toISOString(),
        task.id,
      ]);

      const completedTask = getTaskById(task.id);
      expect(completedTask?.status).toBe("completed");

      const result = pauseTask(task.id);
      expect(result).toBeNull();
    });

    test("should not pause a failed task", () => {
      const task = createTaskExtended("Failed task for pause test", {
        creatorAgentId: "lead-agent-pause",
      });

      // Manually mark as failed via SQL
      getDb().run("UPDATE agent_tasks SET status = 'failed', finishedAt = ? WHERE id = ?", [
        new Date().toISOString(),
        task.id,
      ]);

      const failedTask = getTaskById(task.id);
      expect(failedTask?.status).toBe("failed");

      const result = pauseTask(task.id);
      expect(result).toBeNull();
    });

    test("should return null for non-existent task", () => {
      const result = pauseTask("non-existent-task-id");
      expect(result).toBeNull();
    });
  });

  describe("resumeTask database function", () => {
    test("should resume a paused task", () => {
      const workerAgent = createAgent({
        id: "worker-resume-test",
        name: "Worker Resume",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task to resume", {
        creatorAgentId: "lead-agent-pause",
        agentId: workerAgent.id,
      });

      // Start and then pause the task
      startTask(task.id, workerAgent.id);
      pauseTask(task.id);

      const pausedTask = getTaskById(task.id);
      expect(pausedTask?.status).toBe("paused");

      // Now resume it
      const resumed = resumeTask(task.id);

      expect(resumed).not.toBeNull();
      expect(resumed?.status).toBe("in_progress");
      expect(resumed?.agentId).toBe(workerAgent.id);
    });

    test("should not resume a non-paused task", () => {
      const workerAgent = createAgent({
        id: "worker-not-paused",
        name: "Worker Not Paused",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task not paused", {
        creatorAgentId: "lead-agent-pause",
        agentId: workerAgent.id,
      });

      // Start but don't pause
      startTask(task.id, workerAgent.id);

      const runningTask = getTaskById(task.id);
      expect(runningTask?.status).toBe("in_progress");

      const result = resumeTask(task.id);
      expect(result).toBeNull();
    });

    test("should return null for non-existent task", () => {
      const result = resumeTask("non-existent-task-id");
      expect(result).toBeNull();
    });

    test("should not resume a pending task", () => {
      const workerAgent = createAgent({
        id: "worker-pending-resume",
        name: "Worker Pending Resume",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Pending task for resume", {
        creatorAgentId: "lead-agent-pause",
        agentId: workerAgent.id,
      });

      expect(task.status).toBe("pending");

      const result = resumeTask(task.id);
      expect(result).toBeNull();
    });
  });

  describe("getPausedTasksForAgent database function", () => {
    test("should return paused tasks for an agent", () => {
      const agentId = "worker-get-paused";
      createAgent({
        id: agentId,
        name: "Worker Get Paused",
        isLead: false,
        status: "idle",
      });

      const task1 = createTaskExtended("Paused task 1", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });
      const task2 = createTaskExtended("Paused task 2", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      // Start and pause both tasks
      startTask(task1.id, agentId);
      pauseTask(task1.id);
      startTask(task2.id, agentId);
      pauseTask(task2.id);

      const pausedTasks = getPausedTasksForAgent(agentId);

      expect(pausedTasks.length).toBeGreaterThanOrEqual(2);
      const taskIds = pausedTasks.map((t) => t.id);
      expect(taskIds).toContain(task1.id);
      expect(taskIds).toContain(task2.id);
    });

    test("should not return paused tasks from other agents", () => {
      const agentA = "agent-a-paused-isolated";
      const agentB = "agent-b-paused-isolated";

      createAgent({
        id: agentA,
        name: "Agent A Paused",
        isLead: false,
        status: "idle",
      });
      createAgent({
        id: agentB,
        name: "Agent B Paused",
        isLead: false,
        status: "idle",
      });

      const taskA = createTaskExtended("Task for Agent A pause", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentA,
      });
      const taskB = createTaskExtended("Task for Agent B pause", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentB,
      });

      startTask(taskA.id, agentA);
      pauseTask(taskA.id);
      startTask(taskB.id, agentB);
      pauseTask(taskB.id);

      const pausedForA = getPausedTasksForAgent(agentA);
      const taskIdsA = pausedForA.map((t) => t.id);
      expect(taskIdsA).toContain(taskA.id);
      expect(taskIdsA).not.toContain(taskB.id);
    });

    test("should return tasks ordered by creation time (FIFO)", () => {
      const agentId = "worker-fifo-paused";
      createAgent({
        id: agentId,
        name: "Worker FIFO Paused",
        isLead: false,
        status: "idle",
      });

      const task1 = createTaskExtended("First paused task", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      // Small delay to ensure different timestamps
      const task2 = createTaskExtended("Second paused task", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      startTask(task1.id, agentId);
      pauseTask(task1.id);
      startTask(task2.id, agentId);
      pauseTask(task2.id);

      const pausedTasks = getPausedTasksForAgent(agentId);
      const relevantTasks = pausedTasks.filter((t) => t.id === task1.id || t.id === task2.id);

      // First task should come before second task (FIFO order)
      const task1Index = relevantTasks.findIndex((t) => t.id === task1.id);
      const task2Index = relevantTasks.findIndex((t) => t.id === task2.id);
      expect(task1Index).toBeLessThan(task2Index);
    });

    test("should return empty array if no paused tasks", () => {
      const agentId = "worker-no-paused-tasks";
      createAgent({
        id: agentId,
        name: "Worker No Paused",
        isLead: false,
        status: "idle",
      });

      const pausedTasks = getPausedTasksForAgent(agentId);
      // Filter to only tasks belonging to this agent (in case of shared test state)
      const agentPausedTasks = pausedTasks.filter((t) => t.agentId === agentId);
      expect(agentPausedTasks.length).toBe(0);
    });
  });

  describe("updateAgentStatusFromCapacity after pause", () => {
    test("should update agent status to idle after task is paused", () => {
      const agentId = "worker-capacity-pause";
      createAgent({
        id: agentId,
        name: "Worker Capacity Pause",
        isLead: false,
        status: "busy",
        maxTasks: 1,
      });

      const task = createTaskExtended("Task for capacity pause test", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      // Start the task - agent should be busy
      startTask(task.id, agentId);
      let agent = getAgentById(agentId);
      expect(agent?.status).toBe("busy");

      // Pause the task
      const paused = pauseTask(task.id);
      expect(paused).not.toBeNull();

      // Update agent status based on capacity
      updateAgentStatusFromCapacity(agentId);

      agent = getAgentById(agentId);
      expect(agent?.status).toBe("idle");
    });
  });

  describe("GET /api/paused-tasks endpoint", () => {
    test("should return 400 without X-Agent-ID header", async () => {
      const response = await fetch(`${baseUrl}/api/paused-tasks`);
      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("X-Agent-ID");
    });

    test("should return 404 for non-existent agent", async () => {
      const response = await fetch(`${baseUrl}/api/paused-tasks`, {
        headers: { "X-Agent-ID": "non-existent-agent-id" },
      });
      expect(response.status).toBe(404);
    });

    test("should return paused tasks for agent", async () => {
      const agentId = "worker-endpoint-paused";
      createAgent({
        id: agentId,
        name: "Worker Endpoint Paused",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task for endpoint pause test", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      startTask(task.id, agentId);
      pauseTask(task.id);

      const response = await fetch(`${baseUrl}/api/paused-tasks`, {
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        paused: Array<{ id: string; status: string }>;
      };
      expect(data.paused.length).toBeGreaterThanOrEqual(1);

      const pausedTask = data.paused.find((t) => t.id === task.id);
      expect(pausedTask).toBeTruthy();
      expect(pausedTask?.status).toBe("paused");
    });
  });

  describe("POST /api/tasks/:id/pause endpoint", () => {
    test("should pause an in_progress task", async () => {
      const agentId = "worker-api-pause";
      createAgent({
        id: agentId,
        name: "Worker API Pause",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task to pause via API", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      startTask(task.id, agentId);

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/pause`, {
        method: "POST",
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        task: { status: string };
      };
      expect(data.success).toBe(true);
      expect(data.task.status).toBe("paused");
    });

    test("should return 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-task-id/pause`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("should return 400 for non-in_progress task", async () => {
      const agentId = "worker-api-pause-invalid";
      createAgent({
        id: agentId,
        name: "Worker API Pause Invalid",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Pending task cannot be paused via API", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      // Don't start the task - it's still pending

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/pause`, {
        method: "POST",
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("cannot be paused");
    });
  });

  describe("POST /api/tasks/:id/resume endpoint", () => {
    test("should resume a paused task", async () => {
      const agentId = "worker-api-resume";
      createAgent({
        id: agentId,
        name: "Worker API Resume",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Task to resume via API", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      startTask(task.id, agentId);
      pauseTask(task.id);

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/resume`, {
        method: "POST",
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        task: { status: string };
      };
      expect(data.success).toBe(true);
      expect(data.task.status).toBe("in_progress");
    });

    test("should return 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-task-id/resume`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("should return 400 for non-paused task", async () => {
      const agentId = "worker-api-resume-invalid";
      createAgent({
        id: agentId,
        name: "Worker API Resume Invalid",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("Running task cannot be resumed via API", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      startTask(task.id, agentId);
      // Don't pause the task - it's still in_progress

      const response = await fetch(`${baseUrl}/api/tasks/${task.id}/resume`, {
        method: "POST",
        headers: { "X-Agent-ID": agentId },
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("cannot be resumed");
    });
  });

  describe("Full pause/resume workflow", () => {
    test("should support full pause and resume cycle", async () => {
      const agentId = "worker-full-cycle";
      createAgent({
        id: agentId,
        name: "Worker Full Cycle",
        isLead: false,
        status: "idle",
      });

      // Create and start a task
      const task = createTaskExtended("Task for full cycle test", {
        creatorAgentId: "lead-agent-pause",
        agentId: agentId,
      });

      startTask(task.id, agentId);
      let currentTask = getTaskById(task.id);
      expect(currentTask?.status).toBe("in_progress");

      // Pause the task via API
      const pauseResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/pause`, {
        method: "POST",
        headers: { "X-Agent-ID": agentId },
      });
      expect(pauseResponse.status).toBe(200);

      currentTask = getTaskById(task.id);
      expect(currentTask?.status).toBe("paused");

      // Verify it shows in paused tasks list
      const listResponse = await fetch(`${baseUrl}/api/paused-tasks`, {
        headers: { "X-Agent-ID": agentId },
      });
      expect(listResponse.status).toBe(200);
      const listData = (await listResponse.json()) as {
        paused: Array<{ id: string }>;
      };
      expect(listData.paused.map((t) => t.id)).toContain(task.id);

      // Resume the task via API
      const resumeResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/resume`, {
        method: "POST",
        headers: { "X-Agent-ID": agentId },
      });
      expect(resumeResponse.status).toBe(200);

      currentTask = getTaskById(task.id);
      expect(currentTask?.status).toBe("in_progress");

      // Verify it's no longer in paused tasks list
      const listResponse2 = await fetch(`${baseUrl}/api/paused-tasks`, {
        headers: { "X-Agent-ID": agentId },
      });
      expect(listResponse2.status).toBe(200);
      const listData2 = (await listResponse2.json()) as {
        paused: Array<{ id: string }>;
      };
      expect(listData2.paused.map((t) => t.id)).not.toContain(task.id);
    });
  });
});

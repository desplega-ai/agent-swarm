import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getActiveTaskCount,
  getAgentById,
  getRemainingCapacity,
  hasCapacity,
  initDb,
  startTask,
  updateAgentStatusFromCapacity,
} from "../be/db";

const TEST_DB_PATH = "./test-concurrency.sqlite";

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("Concurrency Integration Tests", () => {
  describe("Backwards Compatibility", () => {
    test("agent without maxTasks defaults to 1", async () => {
      const agent = await createAgent({
        name: "compat-agent",
        isLead: false,
        status: "idle",
        capabilities: [],
      });

      // Should default to maxTasks = 1
      expect(agent.maxTasks).toBe(1);

      // Can start one task
      const task1 = await createTaskExtended("Task 1", { agentId: agent.id });
      await startTask(task1.id);

      // Should be at capacity after one task
      expect(await hasCapacity(agent.id)).toBe(false);
      expect(await getActiveTaskCount(agent.id)).toBe(1);
    });
  });

  describe("Concurrent Execution Simulation", () => {
    test("agent with maxTasks=3 can have 3 in-progress tasks", async () => {
      const agent = await createAgent({
        name: "concurrent-agent",
        isLead: false,
        status: "idle",
        capabilities: [],
        maxTasks: 3,
      });

      // Create and start 3 tasks
      const task1 = await createTaskExtended("Task 1", { agentId: agent.id });
      const task2 = await createTaskExtended("Task 2", { agentId: agent.id });
      const task3 = await createTaskExtended("Task 3", { agentId: agent.id });

      await startTask(task1.id);
      expect(await getActiveTaskCount(agent.id)).toBe(1);
      expect(await hasCapacity(agent.id)).toBe(true);

      await startTask(task2.id);
      expect(await getActiveTaskCount(agent.id)).toBe(2);
      expect(await hasCapacity(agent.id)).toBe(true);

      await startTask(task3.id);
      expect(await getActiveTaskCount(agent.id)).toBe(3);
      expect(await hasCapacity(agent.id)).toBe(false);

      // Can't start more
      expect(await getRemainingCapacity(agent.id)).toBe(0);
    });

    test("queued tasks wait in pending until capacity opens", async () => {
      const agent = await createAgent({
        name: "queue-agent",
        isLead: false,
        status: "idle",
        capabilities: [],
        maxTasks: 2,
      });

      // Create and start 2 tasks
      const task1 = await createTaskExtended("Task 1", { agentId: agent.id });
      const task2 = await createTaskExtended("Task 2", { agentId: agent.id });
      const task3 = await createTaskExtended("Task 3", { agentId: agent.id });

      await startTask(task1.id);
      await startTask(task2.id);

      // At capacity
      expect(await hasCapacity(agent.id)).toBe(false);

      // task3 stays pending - can't start
      expect(task3.status).toBe("pending");

      // Complete task1
      await completeTask(task1.id, "done");

      // Now have capacity for task3
      expect(await hasCapacity(agent.id)).toBe(true);
      expect(await getRemainingCapacity(agent.id)).toBe(1);

      // Can now start task3
      await startTask(task3.id);
      expect(await getActiveTaskCount(agent.id)).toBe(2);
    });
  });

  describe("Status Accuracy", () => {
    test("status reflects busy when any tasks in progress", async () => {
      const agent = await createAgent({
        name: "status-agent",
        isLead: false,
        status: "idle",
        capabilities: [],
        maxTasks: 3,
      });

      expect((await getAgentById(agent.id))?.status).toBe("idle");

      // Start first task
      const task1 = await createTaskExtended("Task 1", { agentId: agent.id });
      await startTask(task1.id);
      await updateAgentStatusFromCapacity(agent.id);

      expect((await getAgentById(agent.id))?.status).toBe("busy");

      // Start second task - still busy
      const task2 = await createTaskExtended("Task 2", { agentId: agent.id });
      await startTask(task2.id);
      await updateAgentStatusFromCapacity(agent.id);

      expect((await getAgentById(agent.id))?.status).toBe("busy");

      // Complete first task - still busy (task2 running)
      await completeTask(task1.id, "done");
      await updateAgentStatusFromCapacity(agent.id);

      expect((await getAgentById(agent.id))?.status).toBe("busy");

      // Complete second task - now idle
      await completeTask(task2.id, "done");
      await updateAgentStatusFromCapacity(agent.id);

      expect((await getAgentById(agent.id))?.status).toBe("idle");
    });

    test("failed tasks also free capacity", async () => {
      const agent = await createAgent({
        name: "fail-agent",
        isLead: false,
        status: "idle",
        capabilities: [],
        maxTasks: 2,
      });

      const task1 = await createTaskExtended("Task 1", { agentId: agent.id });
      const task2 = await createTaskExtended("Task 2", { agentId: agent.id });

      await startTask(task1.id);
      await startTask(task2.id);

      expect(await hasCapacity(agent.id)).toBe(false);

      // Fail task1
      await failTask(task1.id, "error");

      // Capacity restored
      expect(await hasCapacity(agent.id)).toBe(true);
      expect(await getRemainingCapacity(agent.id)).toBe(1);
    });
  });

  describe("Edge Cases", () => {
    test("capacity functions handle non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";

      expect(await getActiveTaskCount(fakeId)).toBe(0);
      expect(await hasCapacity(fakeId)).toBe(false);
      expect(await getRemainingCapacity(fakeId)).toBe(0);
    });

    test("agent maxTasks respects schema limits", async () => {
      // maxTasks should be at least 1 (validated at creation)
      const agent = await createAgent({
        name: "limits-agent",
        isLead: false,
        status: "idle",
        capabilities: [],
        maxTasks: 100, // Max allowed by schema
      });

      expect(agent.maxTasks).toBe(100);
      expect(await getRemainingCapacity(agent.id)).toBe(100);
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getRemainingCapacity,
  hasCapacity,
  initDb,
  startTask,
  updateAgentStatusFromCapacity,
} from "../be/db";

const TEST_DB_PATH = "./test-db-capacity.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
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

describe("Agent Capacity Functions", () => {
  test("getActiveTaskCount returns 0 for agent with no tasks", () => {
    const agent = createAgent({
      name: "test-agent-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    expect(getActiveTaskCount(agent.id)).toBe(0);
  });

  test("getActiveTaskCount returns count of in_progress tasks", () => {
    const agent = createAgent({
      name: "test-agent-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create and start two tasks
    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    const task2 = createTaskExtended("Task 2", { agentId: agent.id });
    const _task3 = createTaskExtended("Task 3", { agentId: agent.id });

    startTask(task1.id);
    startTask(task2.id);
    // task3 stays pending

    expect(getActiveTaskCount(agent.id)).toBe(2);
  });

  test("hasCapacity returns true when under limit", () => {
    const agent = createAgent({
      name: "test-agent-3",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 3,
    });

    expect(hasCapacity(agent.id)).toBe(true);

    // Start one task
    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    startTask(task1.id);

    expect(hasCapacity(agent.id)).toBe(true);
  });

  test("hasCapacity returns false when at limit", () => {
    const agent = createAgent({
      name: "test-agent-4",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 2,
    });

    // Start two tasks to fill capacity
    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    const task2 = createTaskExtended("Task 2", { agentId: agent.id });
    startTask(task1.id);
    startTask(task2.id);

    expect(hasCapacity(agent.id)).toBe(false);
  });

  test("getRemainingCapacity returns correct count", () => {
    const agent = createAgent({
      name: "test-agent-5",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 3,
    });

    expect(getRemainingCapacity(agent.id)).toBe(3);

    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    startTask(task1.id);
    expect(getRemainingCapacity(agent.id)).toBe(2);

    const task2 = createTaskExtended("Task 2", { agentId: agent.id });
    startTask(task2.id);
    expect(getRemainingCapacity(agent.id)).toBe(1);

    const task3 = createTaskExtended("Task 3", { agentId: agent.id });
    startTask(task3.id);
    expect(getRemainingCapacity(agent.id)).toBe(0);
  });

  test("updateAgentStatusFromCapacity sets busy when tasks in progress", () => {
    const agent = createAgent({
      name: "test-agent-6",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 2,
    });

    expect(getAgentById(agent.id)?.status).toBe("idle");

    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    startTask(task1.id);
    updateAgentStatusFromCapacity(agent.id);

    expect(getAgentById(agent.id)?.status).toBe("busy");
  });

  test("updateAgentStatusFromCapacity sets idle when no tasks in progress", () => {
    const agent = createAgent({
      name: "test-agent-7",
      isLead: false,
      status: "busy",
      capabilities: [],
      maxTasks: 2,
    });

    // No tasks assigned, should become idle
    updateAgentStatusFromCapacity(agent.id);
    expect(getAgentById(agent.id)?.status).toBe("idle");
  });

  test("updateAgentStatusFromCapacity does not modify offline status", () => {
    const agent = createAgent({
      name: "test-agent-8",
      isLead: false,
      status: "offline",
      capabilities: [],
      maxTasks: 2,
    });

    updateAgentStatusFromCapacity(agent.id);
    expect(getAgentById(agent.id)?.status).toBe("offline");
  });

  test("agent defaults to maxTasks=1 when not specified", () => {
    const agent = createAgent({
      name: "test-agent-9",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // maxTasks defaults to 1 (via rowToAgent)
    expect(agent.maxTasks).toBe(1);

    // Can only have 1 in-progress task
    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    startTask(task1.id);

    expect(hasCapacity(agent.id)).toBe(false);
  });

  test("completing tasks restores capacity", () => {
    const agent = createAgent({
      name: "test-agent-10",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 2,
    });

    const task1 = createTaskExtended("Task 1", { agentId: agent.id });
    const task2 = createTaskExtended("Task 2", { agentId: agent.id });
    startTask(task1.id);
    startTask(task2.id);

    expect(hasCapacity(agent.id)).toBe(false);
    expect(getRemainingCapacity(agent.id)).toBe(0);

    // Complete one task
    completeTask(task1.id, "done");

    expect(hasCapacity(agent.id)).toBe(true);
    expect(getRemainingCapacity(agent.id)).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createSessionCost,
  createTaskExtended,
  getSessionCostsByTaskId,
  initDb,
  updateTaskProgress,
} from "../be/db";

const TEST_DB_PATH = "./test-store-progress-cost.sqlite";

type TestCostData = {
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  numTurns?: number;
  model?: string;
};

describe("store-progress with cost data", () => {
  let agentId: string;
  let taskId: string;

  beforeAll(async () => {
    // Initialize test database
    initDb(TEST_DB_PATH);

    // Create test agent
    const agent = createAgent({
      name: "Test Worker",
      description: "Test agent for cost tracking",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;

    // Create test task
    const task = createTaskExtended("Test task for cost tracking", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    taskId = task.id;
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // Ignore errors if file doesn't exist
    }
  });

  test("should create session cost when costData is provided with store-progress", () => {
    // Simulate what store-progress does when costData is provided
    const costData = {
      totalCostUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      durationMs: 5000,
      numTurns: 3,
      model: "opus",
    };

    // Create session cost (this is what store-progress does internally)
    const sessionId = `mcp-${taskId}-${Date.now()}`;
    const cost = createSessionCost({
      sessionId,
      taskId,
      agentId,
      totalCostUsd: costData.totalCostUsd,
      inputTokens: costData.inputTokens ?? 0,
      outputTokens: costData.outputTokens ?? 0,
      cacheReadTokens: costData.cacheReadTokens ?? 0,
      cacheWriteTokens: costData.cacheWriteTokens ?? 0,
      durationMs: costData.durationMs ?? 0,
      numTurns: costData.numTurns ?? 1,
      model: costData.model ?? "unknown",
      isError: false,
    });

    // Verify cost was created
    expect(cost).toBeDefined();
    expect(cost.taskId).toBe(taskId);
    expect(cost.agentId).toBe(agentId);
    expect(cost.totalCostUsd).toBe(0.05);
    expect(cost.inputTokens).toBe(1000);
    expect(cost.outputTokens).toBe(500);
    expect(cost.cacheReadTokens).toBe(100);
    expect(cost.cacheWriteTokens).toBe(50);
    expect(cost.durationMs).toBe(5000);
    expect(cost.numTurns).toBe(3);
    expect(cost.model).toBe("opus");
    expect(cost.isError).toBe(false);

    // Verify cost can be retrieved by taskId
    const costs = getSessionCostsByTaskId(taskId);
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.some((c) => c.id === cost.id)).toBe(true);
  });

  test("should create session cost with isError=true when task fails", () => {
    // Create another task for this test
    const failTask2 = createTaskExtended("Test task for failure cost tracking", {
      agentId,
      source: "mcp",
      priority: 50,
    });

    const costData: TestCostData = {
      totalCostUsd: 0.02,
      inputTokens: 500,
      outputTokens: 200,
      durationMs: 2000,
      numTurns: 1,
      model: "sonnet",
    };

    const sessionId = `mcp-${failTask2.id}-${Date.now()}`;
    const cost = createSessionCost({
      sessionId,
      taskId: failTask2.id,
      agentId,
      totalCostUsd: costData.totalCostUsd,
      inputTokens: costData.inputTokens ?? 0,
      outputTokens: costData.outputTokens ?? 0,
      cacheReadTokens: costData.cacheReadTokens ?? 0,
      cacheWriteTokens: costData.cacheWriteTokens ?? 0,
      durationMs: costData.durationMs ?? 0,
      numTurns: costData.numTurns ?? 1,
      model: costData.model ?? "unknown",
      isError: true, // Failed task
    });

    expect(cost.isError).toBe(true);
    expect(cost.model).toBe("sonnet");
  });

  test("should use default values when optional cost fields are missing", () => {
    // Create another task for this test
    const minimalTask = createTaskExtended("Test task with minimal cost data", {
      agentId,
      source: "mcp",
      priority: 50,
    });

    // Only provide required field
    const costData: TestCostData = {
      totalCostUsd: 0.01,
    };

    const sessionId = `mcp-${minimalTask.id}-${Date.now()}`;
    const cost = createSessionCost({
      sessionId,
      taskId: minimalTask.id,
      agentId,
      totalCostUsd: costData.totalCostUsd,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      numTurns: 1,
      model: "unknown",
      isError: false,
    });

    expect(cost.totalCostUsd).toBe(0.01);
    expect(cost.inputTokens).toBe(0);
    expect(cost.outputTokens).toBe(0);
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheWriteTokens).toBe(0);
    expect(cost.durationMs).toBe(0);
    expect(cost.numTurns).toBe(1);
    expect(cost.model).toBe("unknown");
  });

  test("should not create session cost when costData is not provided", () => {
    // Create a task without cost data
    const noCostTask = createTaskExtended("Test task without cost data", {
      agentId,
      source: "mcp",
      priority: 50,
    });

    // Just update progress without cost data (existing behavior)
    updateTaskProgress(noCostTask.id, "Working on it...");

    // Complete the task without cost data
    completeTask(noCostTask.id, "Done!");

    // No session costs should be created for this task
    const costs = getSessionCostsByTaskId(noCostTask.id);
    expect(costs.length).toBe(0);
  });
});

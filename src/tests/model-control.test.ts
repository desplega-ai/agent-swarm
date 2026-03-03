import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  getResolvedConfig,
  getScheduledTaskById,
  getTaskById,
  initDb,
  updateScheduledTask,
  upsertSwarmConfig,
} from "../be/db";
import { runScheduleNow } from "../scheduler";

const TEST_DB_PATH = "./test-model-control.sqlite";

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

describe("Model Control - Task Creation", () => {
  test("should store model when creating a task with model='sonnet'", () => {
    const task = createTaskExtended("Test task with sonnet", { model: "sonnet" });
    expect(task.model).toBe("sonnet");

    const retrieved = getTaskById(task.id);
    expect(retrieved?.model).toBe("sonnet");
  });

  test("should store model when creating a task with model='haiku'", () => {
    const task = createTaskExtended("Test task with haiku", { model: "haiku" });
    expect(task.model).toBe("haiku");
  });

  test("should store model when creating a task with model='opus'", () => {
    const task = createTaskExtended("Test task with opus", { model: "opus" });
    expect(task.model).toBe("opus");
  });

  test("should default model to undefined when not specified", () => {
    const task = createTaskExtended("Test task without model");
    expect(task.model).toBeUndefined();
  });

  test("should preserve model alongside other task options", () => {
    const agent = createAgent({ name: "model-test-agent", isLead: false, status: "idle" });

    const task = createTaskExtended("Task with model and options", {
      model: "haiku",
      agentId: agent.id,
      priority: 80,
      taskType: "test",
      tags: ["model-test"],
    });

    expect(task.model).toBe("haiku");
    expect(task.agentId).toBe(agent.id);
    expect(task.priority).toBe(80);
    expect(task.taskType).toBe("test");
    expect(task.tags).toContain("model-test");
  });

  test("should store model on offered tasks", () => {
    const agent = createAgent({ name: "offer-model-agent", isLead: false, status: "idle" });

    const task = createTaskExtended("Offered task with model", {
      model: "sonnet",
      offeredTo: agent.id,
    });

    expect(task.model).toBe("sonnet");
    expect(task.status).toBe("offered");
  });
});

describe("Model Control - Schedule Creation", () => {
  test("should store model on scheduled task creation", () => {
    const schedule = createScheduledTask({
      name: "model-schedule-sonnet",
      intervalMs: 60000,
      taskTemplate: "Scheduled with sonnet",
      model: "sonnet",
    });

    expect(schedule.model).toBe("sonnet");

    const retrieved = getScheduledTaskById(schedule.id);
    expect(retrieved?.model).toBe("sonnet");
  });

  test("should store all valid model values on schedules", () => {
    for (const model of ["haiku", "sonnet", "opus"] as const) {
      const schedule = createScheduledTask({
        name: `model-schedule-all-${model}-${Date.now()}`,
        intervalMs: 60000,
        taskTemplate: `Scheduled with ${model}`,
        model,
      });

      expect(schedule.model).toBe(model);
    }
  });

  test("should default model to undefined when not specified on schedule", () => {
    const schedule = createScheduledTask({
      name: "model-schedule-default",
      intervalMs: 60000,
      taskTemplate: "Scheduled without model",
    });

    expect(schedule.model).toBeUndefined();
  });
});

describe("Model Control - Schedule Update", () => {
  test("should update model on existing schedule", () => {
    const schedule = createScheduledTask({
      name: "model-update-test",
      intervalMs: 60000,
      taskTemplate: "Update model test",
      model: "opus",
    });

    expect(schedule.model).toBe("opus");

    const updated = updateScheduledTask(schedule.id, { model: "haiku" });
    expect(updated?.model).toBe("haiku");

    const retrieved = getScheduledTaskById(schedule.id);
    expect(retrieved?.model).toBe("haiku");
  });

  test("should clear model by setting to null", () => {
    const schedule = createScheduledTask({
      name: "model-clear-test",
      intervalMs: 60000,
      taskTemplate: "Clear model test",
      model: "sonnet",
    });

    expect(schedule.model).toBe("sonnet");

    const updated = updateScheduledTask(schedule.id, { model: null });
    expect(updated?.model).toBeUndefined();
  });

  test("should preserve model when updating other fields", () => {
    const schedule = createScheduledTask({
      name: "model-preserve-test",
      intervalMs: 60000,
      taskTemplate: "Preserve model test",
      model: "haiku",
    });

    const updated = updateScheduledTask(schedule.id, { priority: 90 });
    expect(updated?.model).toBe("haiku");
    expect(updated?.priority).toBe(90);
  });
});

describe("Model Control - Schedule to Task Propagation", () => {
  test("should propagate model from schedule to task on manual run", async () => {
    const schedule = createScheduledTask({
      name: "model-propagate-manual",
      intervalMs: 60000,
      taskTemplate: "Propagated model task (manual)",
      model: "haiku",
      enabled: true,
    });

    await runScheduleNow(schedule.id);

    // Find the created task by its template text
    const { getDb } = await import("../be/db");
    const row = getDb()
      .query("SELECT id FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
      .get("Propagated model task (manual)") as { id: string } | null;

    expect(row).not.toBeNull();
    const task = getTaskById(row!.id);
    expect(task?.model).toBe("haiku");
  });

  test("should create task without model when schedule has no model", async () => {
    const schedule = createScheduledTask({
      name: "model-propagate-none",
      intervalMs: 60000,
      taskTemplate: "Propagated no-model task",
      enabled: true,
    });

    await runScheduleNow(schedule.id);

    const { getDb } = await import("../be/db");
    const row = getDb()
      .query("SELECT id FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
      .get("Propagated no-model task") as { id: string } | null;

    expect(row).not.toBeNull();
    const task = getTaskById(row!.id);
    expect(task?.model).toBeUndefined();
  });
});

describe("Model Control - Config MODEL_OVERRIDE Resolution", () => {
  test("should resolve global MODEL_OVERRIDE config", () => {
    upsertSwarmConfig({
      scope: "global",
      key: "MODEL_OVERRIDE",
      value: "sonnet",
    });

    const configs = getResolvedConfig();
    const modelOverride = configs.find((c) => c.key === "MODEL_OVERRIDE");
    expect(modelOverride).toBeDefined();
    expect(modelOverride?.value).toBe("sonnet");
  });

  test("agent-scoped MODEL_OVERRIDE should override global", () => {
    const agent = createAgent({ name: "config-agent", isLead: false, status: "idle" });

    upsertSwarmConfig({
      scope: "global",
      key: "MODEL_OVERRIDE",
      value: "opus",
    });

    upsertSwarmConfig({
      scope: "agent",
      scopeId: agent.id,
      key: "MODEL_OVERRIDE",
      value: "haiku",
    });

    const configs = getResolvedConfig(agent.id);
    const modelOverride = configs.find((c) => c.key === "MODEL_OVERRIDE");
    expect(modelOverride?.value).toBe("haiku");
    expect(modelOverride?.scope).toBe("agent");
  });

  test("should fallback to global when no agent-scoped config exists", () => {
    const agent = createAgent({ name: "fallback-agent", isLead: false, status: "idle" });

    upsertSwarmConfig({
      scope: "global",
      key: "MODEL_OVERRIDE",
      value: "sonnet",
    });

    const configs = getResolvedConfig(agent.id);
    const modelOverride = configs.find((c) => c.key === "MODEL_OVERRIDE");
    expect(modelOverride?.value).toBe("sonnet");
    expect(modelOverride?.scope).toBe("global");
  });
});

describe("Model Control - Priority Resolution Logic", () => {
  // The runner resolves model as: task.model || freshEnv.MODEL_OVERRIDE || "opus"
  // We test the same logic pattern here to ensure correctness

  function resolveModel(taskModel?: string, configOverride?: string): string {
    return taskModel || configOverride || "opus";
  }

  test("task.model takes highest priority", () => {
    expect(resolveModel("haiku", "sonnet")).toBe("haiku");
  });

  test("config MODEL_OVERRIDE is used when task has no model", () => {
    expect(resolveModel(undefined, "sonnet")).toBe("sonnet");
  });

  test("defaults to 'opus' when no task model and no config override", () => {
    expect(resolveModel(undefined, undefined)).toBe("opus");
  });

  test("empty string task model falls through to config", () => {
    expect(resolveModel("", "sonnet")).toBe("sonnet");
  });

  test("empty string config override falls through to default", () => {
    expect(resolveModel(undefined, "")).toBe("opus");
  });

  test("all three levels specified — task wins", () => {
    expect(resolveModel("haiku", "sonnet")).toBe("haiku");
    // "opus" is the hardcoded default, tested implicitly
  });
});

describe("Model Control - Zod Validation Schema", () => {
  // The MCP tools use z.enum(["haiku", "sonnet", "opus"]) for validation.
  // We test the schema directly to ensure only valid values are accepted.

  test("should accept valid model values", async () => {
    const { z } = await import("zod");
    const modelSchema = z.enum(["haiku", "sonnet", "opus"]).optional();

    expect(modelSchema.parse("haiku")).toBe("haiku");
    expect(modelSchema.parse("sonnet")).toBe("sonnet");
    expect(modelSchema.parse("opus")).toBe("opus");
    expect(modelSchema.parse(undefined)).toBeUndefined();
  });

  test("should reject invalid model values", async () => {
    const { z } = await import("zod");
    const modelSchema = z.enum(["haiku", "sonnet", "opus"]).optional();

    expect(() => modelSchema.parse("gpt-4")).toThrow();
    expect(() => modelSchema.parse("claude")).toThrow();
    expect(() => modelSchema.parse("turbo")).toThrow();
    expect(() => modelSchema.parse("")).toThrow();
    expect(() => modelSchema.parse(123)).toThrow();
    expect(() => modelSchema.parse(null)).toThrow();
  });

  test("nullable model schema (update-schedule) should accept null", async () => {
    const { z } = await import("zod");
    const modelSchema = z.enum(["haiku", "sonnet", "opus"]).nullable().optional();

    expect(modelSchema.parse(null)).toBeNull();
    expect(modelSchema.parse("haiku")).toBe("haiku");
    expect(modelSchema.parse(undefined)).toBeUndefined();
  });
});

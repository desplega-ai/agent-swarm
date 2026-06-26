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
import { createScheduleInputSchema } from "../tools/schedules/create-schedule";
import { updateScheduleInputSchema } from "../tools/schedules/update-schedule";
import { sendTaskInputSchema } from "../tools/send-task";
import { taskActionInputSchema } from "../tools/task-action";
import {
  parseModelTier,
  resolveModelTier,
  resolveTaskModelSelection,
  splitLegacyModelAlias,
} from "../types";

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

  test("should store modelTier when creating a task with portable tier", () => {
    const task = createTaskExtended("Test task with tier", { modelTier: "smart" });
    expect(task.model).toBeUndefined();
    expect(task.modelTier).toBe("smart");

    const retrieved = getTaskById(task.id);
    expect(retrieved?.modelTier).toBe("smart");
  });

  test("should preserve freeform concrete model strings", () => {
    const task = createTaskExtended("Test task with freeform model", {
      model: "openrouter/anthropic/claude-sonnet-4.6",
    });

    expect(task.model).toBe("openrouter/anthropic/claude-sonnet-4.6");
    expect(task.modelTier).toBeUndefined();
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
    for (const model of ["haiku", "sonnet", "opus", "fable", "gpt-5.5"] as const) {
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

  test("should store modelTier on scheduled task creation", () => {
    const schedule = createScheduledTask({
      name: "model-schedule-tier",
      intervalMs: 60000,
      taskTemplate: "Scheduled with portable tier",
      modelTier: "regular",
    });

    expect(schedule.model).toBeUndefined();
    expect(schedule.modelTier).toBe("regular");

    const retrieved = getScheduledTaskById(schedule.id);
    expect(retrieved?.modelTier).toBe("regular");
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

  test("should update and clear modelTier on existing schedule", () => {
    const schedule = createScheduledTask({
      name: "model-tier-update-test",
      intervalMs: 60000,
      taskTemplate: "Update model tier test",
      modelTier: "regular",
    });

    expect(schedule.modelTier).toBe("regular");

    const updated = updateScheduledTask(schedule.id, { modelTier: "ultra" });
    expect(updated?.modelTier).toBe("ultra");

    const cleared = updateScheduledTask(schedule.id, { modelTier: null });
    expect(cleared?.modelTier).toBeUndefined();
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

  test("should propagate modelTier from schedule to task on manual run", async () => {
    const schedule = createScheduledTask({
      name: "model-tier-propagate-manual",
      intervalMs: 60000,
      taskTemplate: "Propagated model tier task (manual)",
      modelTier: "smart",
      enabled: true,
    });

    await runScheduleNow(schedule.id);

    const { getDb } = await import("../be/db");
    const row = getDb()
      .query("SELECT id FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
      .get("Propagated model tier task (manual)") as { id: string } | null;

    expect(row).not.toBeNull();
    const task = getTaskById(row!.id);
    expect(task?.model).toBeUndefined();
    expect(task?.modelTier).toBe("smart");
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
  test("task.model takes highest priority", () => {
    expect(
      resolveTaskModelSelection({
        model: "gpt-5.5",
        modelTier: "smol",
        harnessProvider: "codex",
      }).model,
    ).toBe("gpt-5.5");
  });

  test("task.modelTier resolves using the claiming worker harness", () => {
    expect(resolveModelTier({ tier: "smol", harnessProvider: "claude" })).toBe("haiku");
    expect(resolveModelTier({ tier: "smol", harnessProvider: "codex" })).toBe("gpt-5.4-mini");
    expect(resolveModelTier({ tier: "smart", harnessProvider: "opencode" })).toBe(
      "openrouter/deepseek/deepseek-v4-pro",
    );
    expect(resolveModelTier({ tier: "ultra", harnessProvider: "pi" })).toBe(
      "openrouter/anthropic/claude-opus-4.8",
    );
  });

  test("task.modelTier supports env map and direct tier overrides", () => {
    expect(
      resolveModelTier({
        tier: "regular",
        harnessProvider: "codex",
        env: { MODEL_TIER_MAP: JSON.stringify({ regular: "gpt-5.3-codex" }) },
      }),
    ).toBe("gpt-5.3-codex");
    expect(
      resolveModelTier({
        tier: "regular",
        harnessProvider: "codex",
        env: {
          MODEL_TIER_MAP: JSON.stringify({ regular: "gpt-5.3-codex" }),
          MODEL_TIER_REGULAR: "gpt-5.5",
        },
      }),
    ).toBe("gpt-5.5");
  });

  test("legacy model aliases parse as tiers", () => {
    expect(parseModelTier("haiku")).toBe("smol");
    expect(parseModelTier("sonnet")).toBe("regular");
    expect(parseModelTier("opus")).toBe("smart");
    expect(parseModelTier("fable")).toBe("ultra");
    expect(splitLegacyModelAlias({ model: "opus" })).toEqual({ modelTier: "smart" });
  });

  test("freeform concrete model strings stay concrete", () => {
    expect(splitLegacyModelAlias({ model: "gpt-5.5" })).toEqual({
      model: "gpt-5.5",
      modelTier: undefined,
    });
  });

  test("missing task model selection falls through to adapter/config", () => {
    expect(
      resolveTaskModelSelection({ model: "", modelTier: undefined, harnessProvider: "codex" }),
    ).toEqual({ source: "none" });
  });
});

describe("Model Control - Zod Validation Schema", () => {
  test("task tools accept freeform concrete models and model tiers", () => {
    expect(
      sendTaskInputSchema.parse({ agentId: crypto.randomUUID(), task: "x", model: "gpt-5.5" })
        .model,
    ).toBe("gpt-5.5");
    expect(
      taskActionInputSchema.parse({ action: "create", task: "x", modelTier: "ultra" }).modelTier,
    ).toBe("ultra");
  });

  test("task tools reject empty model strings and invalid tiers", () => {
    expect(() =>
      sendTaskInputSchema.parse({ agentId: crypto.randomUUID(), task: "x", model: "" }),
    ).toThrow();
    expect(() =>
      taskActionInputSchema.parse({ action: "create", task: "x", modelTier: "massive" }),
    ).toThrow();
  });

  test("nullable model schema (update-schedule) should accept null", async () => {
    expect(updateScheduleInputSchema.shape.model.parse(null)).toBeNull();
    expect(updateScheduleInputSchema.shape.model.parse("gpt-5.5")).toBe("gpt-5.5");
    expect(updateScheduleInputSchema.shape.modelTier.parse(null)).toBeNull();
    expect(updateScheduleInputSchema.shape.modelTier.parse("smol")).toBe("smol");
  });

  test("create schedule schema accepts freeform model and modelTier", () => {
    const parsed = createScheduleInputSchema.parse({
      name: "schema-model-tier",
      taskTemplate: "x",
      intervalMs: 60000,
      model: "openrouter/openai/gpt-5.5",
      modelTier: "smart",
    });
    expect(parsed.model).toBe("openrouter/openai/gpt-5.5");
    expect(parsed.modelTier).toBe("smart");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  deleteScheduledTask,
  getDb,
  getScheduledTaskById,
  getScheduledTaskByName,
  getScheduledTasks,
  initDb,
  updateScheduledTask,
} from "../be/db";
import { calculateNextRun, runScheduleNow } from "../scheduler";
import type { ScheduledTask } from "../types";

const TEST_DB_PATH = "./test-scheduled-tasks.sqlite";

describe("Scheduled Tasks Integration", () => {
  let testAgent: { id: string; name: string };

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    initDb(TEST_DB_PATH);

    // Create a test agent
    testAgent = createAgent({
      name: "Test Schedule Agent",
      isLead: false,
      status: "idle",
    });
  });

  afterAll(async () => {
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

  describe("Scheduled Task CRUD Operations", () => {
    test("should create a scheduled task with cron expression", () => {
      const schedule = createScheduledTask({
        name: "test-cron-schedule",
        description: "Test schedule with cron",
        cronExpression: "0 9 * * *", // Daily at 9 AM
        taskTemplate: "Run daily backup",
        taskType: "maintenance",
        tags: ["backup", "daily"],
        priority: 60,
        createdByAgentId: testAgent.id,
        timezone: "UTC",
      });

      expect(schedule.id).toBeDefined();
      expect(schedule.name).toBe("test-cron-schedule");
      expect(schedule.description).toBe("Test schedule with cron");
      expect(schedule.cronExpression).toBe("0 9 * * *");
      expect(schedule.taskTemplate).toBe("Run daily backup");
      expect(schedule.taskType).toBe("maintenance");
      expect(schedule.tags).toEqual(["backup", "daily"]);
      expect(schedule.priority).toBe(60);
      expect(schedule.enabled).toBe(true);
      expect(schedule.timezone).toBe("UTC");
    });

    test("should create a scheduled task with interval", () => {
      const schedule = createScheduledTask({
        name: "test-interval-schedule",
        intervalMs: 3600000, // 1 hour
        taskTemplate: "Run hourly health check",
        taskType: "monitoring",
        tags: ["health", "hourly"],
        priority: 50,
      });

      expect(schedule.id).toBeDefined();
      expect(schedule.name).toBe("test-interval-schedule");
      expect(schedule.intervalMs).toBe(3600000);
      expect(schedule.cronExpression).toBeUndefined();
    });

    test("should retrieve scheduled task by ID", () => {
      const created = createScheduledTask({
        name: "test-get-by-id",
        intervalMs: 60000,
        taskTemplate: "Test task",
      });

      const retrieved = getScheduledTaskById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe("test-get-by-id");
    });

    test("should retrieve scheduled task by name", () => {
      const created = createScheduledTask({
        name: "test-get-by-name-unique",
        intervalMs: 60000,
        taskTemplate: "Test task",
      });

      const retrieved = getScheduledTaskByName("test-get-by-name-unique");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe("test-get-by-name-unique");
    });

    test("should return null for non-existent schedule ID", () => {
      const result = getScheduledTaskById("non-existent-id");
      expect(result).toBeNull();
    });

    test("should return null for non-existent schedule name", () => {
      const result = getScheduledTaskByName("non-existent-name");
      expect(result).toBeNull();
    });

    test("should update scheduled task", () => {
      const schedule = createScheduledTask({
        name: "test-update-schedule",
        intervalMs: 60000,
        taskTemplate: "Original task",
        enabled: true,
      });

      const updated = updateScheduledTask(schedule.id, {
        taskTemplate: "Updated task",
        priority: 80,
        enabled: false,
      });

      expect(updated).not.toBeNull();
      expect(updated?.taskTemplate).toBe("Updated task");
      expect(updated?.priority).toBe(80);
      expect(updated?.enabled).toBe(false);
    });

    test("should delete scheduled task", () => {
      const schedule = createScheduledTask({
        name: "test-delete-schedule",
        intervalMs: 60000,
        taskTemplate: "Task to delete",
      });

      const deleted = deleteScheduledTask(schedule.id);
      expect(deleted).toBe(true);

      const retrieved = getScheduledTaskById(schedule.id);
      expect(retrieved).toBeNull();
    });

    test("should return false when deleting non-existent schedule", () => {
      const deleted = deleteScheduledTask("non-existent-id");
      expect(deleted).toBe(false);
    });

    test("should list scheduled tasks with filters", () => {
      // Create enabled and disabled schedules
      createScheduledTask({
        name: "test-filter-enabled",
        intervalMs: 60000,
        taskTemplate: "Enabled task",
        enabled: true,
      });

      createScheduledTask({
        name: "test-filter-disabled",
        intervalMs: 60000,
        taskTemplate: "Disabled task",
        enabled: false,
      });

      const enabledOnly = getScheduledTasks({ enabled: true });
      const disabledOnly = getScheduledTasks({ enabled: false });

      expect(enabledOnly.every((s) => s.enabled)).toBe(true);
      expect(disabledOnly.every((s) => !s.enabled)).toBe(true);
    });

    test("should filter scheduled tasks by name", () => {
      createScheduledTask({
        name: "unique-name-xyz-123",
        intervalMs: 60000,
        taskTemplate: "Unique task",
      });

      const filtered = getScheduledTasks({ name: "xyz-123" });

      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered.some((s) => s.name.includes("xyz-123"))).toBe(true);
    });
  });

  describe("runScheduleNow (Manual Trigger)", () => {
    test("should create a task when schedule is run manually", async () => {
      const schedule = createScheduledTask({
        name: "test-manual-run-1",
        cronExpression: "0 9 * * *",
        taskTemplate: "Manual trigger test task",
        taskType: "test",
        tags: ["test", "manual"],
        priority: 75,
        createdByAgentId: testAgent.id,
        enabled: true,
      });

      // Get task count before
      const tasksBefore = getDb().query("SELECT COUNT(*) as count FROM agent_tasks").get() as {
        count: number;
      };

      await runScheduleNow(schedule.id);

      // Get task count after
      const tasksAfter = getDb().query("SELECT COUNT(*) as count FROM agent_tasks").get() as {
        count: number;
      };

      expect(tasksAfter.count).toBe(tasksBefore.count + 1);

      // Verify the created task has correct properties
      const createdTask = getDb()
        .query("SELECT * FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
        .get(schedule.taskTemplate) as {
        id: string;
        taskType: string;
        tags: string;
        priority: number;
      };

      expect(createdTask).toBeDefined();
      expect(createdTask.taskType).toBe("test");
      expect(createdTask.priority).toBe(75);
      const tags = JSON.parse(createdTask.tags);
      expect(tags).toContain("scheduled");
      expect(tags).toContain("manual-run");
      expect(tags).toContain(`schedule:${schedule.name}`);
    });

    test("should update lastRunAt but NOT nextRunAt on manual run", async () => {
      const schedule = createScheduledTask({
        name: "test-manual-run-2",
        cronExpression: "0 12 * * *", // Noon daily
        taskTemplate: "Manual run preserve nextRunAt",
        enabled: true,
      });

      // Set a known nextRunAt
      const futureDate = new Date("2026-02-01T12:00:00.000Z").toISOString();
      updateScheduledTask(schedule.id, { nextRunAt: futureDate });

      const beforeRun = getScheduledTaskById(schedule.id);
      expect(beforeRun?.nextRunAt).toBe(futureDate);
      expect(beforeRun?.lastRunAt).toBeUndefined();

      await runScheduleNow(schedule.id);

      const afterRun = getScheduledTaskById(schedule.id);

      // nextRunAt should remain unchanged
      expect(afterRun?.nextRunAt).toBe(futureDate);
      // lastRunAt should be set
      expect(afterRun?.lastRunAt).toBeDefined();
    });

    test("should throw error for non-existent schedule", async () => {
      await expect(runScheduleNow("non-existent-schedule-id")).rejects.toThrow(
        "Schedule not found",
      );
    });

    test("should throw error for disabled schedule", async () => {
      const schedule = createScheduledTask({
        name: "test-manual-disabled",
        intervalMs: 60000,
        taskTemplate: "Disabled schedule task",
        enabled: false,
      });

      await expect(runScheduleNow(schedule.id)).rejects.toThrow("disabled");
    });

    test("should create task with target agent when specified", async () => {
      const targetAgent = createAgent({
        name: "Target Agent",
        isLead: false,
        status: "idle",
      });

      const schedule = createScheduledTask({
        name: "test-manual-with-target",
        intervalMs: 60000,
        taskTemplate: "Task for specific agent",
        targetAgentId: targetAgent.id,
        enabled: true,
      });

      await runScheduleNow(schedule.id);

      // Find the created task
      const createdTask = getDb()
        .query("SELECT * FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
        .get(schedule.taskTemplate) as { agentId: string; status: string };

      expect(createdTask).toBeDefined();
      expect(createdTask.agentId).toBe(targetAgent.id);
      expect(createdTask.status).toBe("pending"); // Should be pending when assigned to agent
    });

    test("should create unassigned task when no target agent specified", async () => {
      const schedule = createScheduledTask({
        name: "test-manual-no-target",
        intervalMs: 60000,
        taskTemplate: "Task for pool",
        enabled: true,
      });

      await runScheduleNow(schedule.id);

      // Find the created task
      const createdTask = getDb()
        .query("SELECT * FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
        .get(schedule.taskTemplate) as { agentId: string | null; status: string };

      expect(createdTask).toBeDefined();
      expect(createdTask.agentId).toBeNull();
      expect(createdTask.status).toBe("unassigned");
    });

    test("should be transactional - task and schedule update are atomic", async () => {
      const schedule = createScheduledTask({
        name: "test-transactional",
        intervalMs: 60000,
        taskTemplate: "Transactional test task",
        enabled: true,
      });

      const taskCountBefore = (
        getDb().query("SELECT COUNT(*) as count FROM agent_tasks").get() as { count: number }
      ).count;

      await runScheduleNow(schedule.id);

      const taskCountAfter = (
        getDb().query("SELECT COUNT(*) as count FROM agent_tasks").get() as { count: number }
      ).count;

      const updatedSchedule = getScheduledTaskById(schedule.id);

      // Both operations should have completed
      expect(taskCountAfter).toBe(taskCountBefore + 1);
      expect(updatedSchedule?.lastRunAt).toBeDefined();
    });
  });

  describe("calculateNextRun", () => {
    test("should calculate next run for cron expression", () => {
      const schedule = createScheduledTask({
        name: "test-calc-cron",
        cronExpression: "0 9 * * *", // Daily at 9 AM
        taskTemplate: "Test task",
        timezone: "UTC",
      });

      const fromDate = new Date("2026-01-15T08:00:00Z");
      const nextRun = calculateNextRun(schedule, fromDate);

      // Should be 9 AM on the same day
      expect(nextRun).toBe("2026-01-15T09:00:00.000Z");
    });

    test("should calculate next run for interval", () => {
      const schedule = createScheduledTask({
        name: "test-calc-interval",
        intervalMs: 3600000, // 1 hour
        taskTemplate: "Test task",
      });

      const fromDate = new Date("2026-01-15T08:00:00Z");
      const nextRun = calculateNextRun(schedule, fromDate);

      // Should be 1 hour later
      expect(nextRun).toBe("2026-01-15T09:00:00.000Z");
    });

    test("should throw error for schedule without cron or interval", () => {
      // Create a mock schedule object without cron or interval
      const mockSchedule = {
        id: "test-id",
        name: "test-no-schedule",
        taskTemplate: "Test task",
        tags: [],
        priority: 50,
        enabled: true,
        timezone: "UTC",
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      } as ScheduledTask;

      expect(() => calculateNextRun(mockSchedule)).toThrow(
        "Schedule must have cronExpression or intervalMs",
      );
    });
  });

  describe("Schedule with Target Agent", () => {
    test("should preserve all schedule properties when running", async () => {
      const schedule = createScheduledTask({
        name: "test-preserve-props",
        description: "Schedule with all properties",
        cronExpression: "0 6 * * 1", // Monday 6 AM
        taskTemplate: "Comprehensive test task",
        taskType: "comprehensive",
        tags: ["tag1", "tag2", "tag3"],
        priority: 90,
        targetAgentId: testAgent.id,
        enabled: true,
        timezone: "America/New_York",
        createdByAgentId: testAgent.id,
      });

      await runScheduleNow(schedule.id);

      // Find the created task
      const createdTask = getDb()
        .query("SELECT * FROM agent_tasks WHERE task = ? ORDER BY createdAt DESC LIMIT 1")
        .get(schedule.taskTemplate) as {
        task: string;
        taskType: string;
        tags: string;
        priority: number;
        agentId: string;
        creatorAgentId: string;
      };

      expect(createdTask.task).toBe("Comprehensive test task");
      expect(createdTask.taskType).toBe("comprehensive");
      expect(createdTask.priority).toBe(90);
      expect(createdTask.agentId).toBe(testAgent.id);
      expect(createdTask.creatorAgentId).toBe(testAgent.id);

      const tags = JSON.parse(createdTask.tags);
      expect(tags).toContain("tag1");
      expect(tags).toContain("tag2");
      expect(tags).toContain("tag3");
      expect(tags).toContain("scheduled");
      expect(tags).toContain("manual-run");
    });
  });

  describe("Multiple Manual Runs", () => {
    test("should allow multiple consecutive manual runs", async () => {
      const schedule = createScheduledTask({
        name: "test-multiple-runs",
        intervalMs: 60000,
        taskTemplate: "Multiple run test",
        enabled: true,
      });

      await runScheduleNow(schedule.id);
      const firstRunSchedule = getScheduledTaskById(schedule.id);
      const firstRunAt = firstRunSchedule?.lastRunAt;

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      await runScheduleNow(schedule.id);
      const secondRunSchedule = getScheduledTaskById(schedule.id);
      const secondRunAt = secondRunSchedule?.lastRunAt;

      expect(firstRunAt).toBeDefined();
      expect(secondRunAt).toBeDefined();
      expect(secondRunAt).not.toBe(firstRunAt);

      // Count tasks created
      const tasks = getDb()
        .query("SELECT COUNT(*) as count FROM agent_tasks WHERE task = ?")
        .get("Multiple run test") as { count: number };

      expect(tasks.count).toBe(2);
    });
  });
});

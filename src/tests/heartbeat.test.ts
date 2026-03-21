import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getIdleWorkersWithCapacity,
  getStalledInProgressTasks,
  getTaskById,
  getUnassignedPoolTasks,
  initDb,
  startTask,
  updateAgentStatus,
} from "../be/db";
import {
  codeLevelTriage,
  preflightGate,
  runHeartbeatSweep,
  startHeartbeat,
  stopHeartbeat,
} from "../heartbeat/heartbeat";

const TEST_DB_PATH = "./test-heartbeat.sqlite";

describe("Heartbeat Triage", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    closeDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // Clean up tasks between tests to avoid interference
  beforeEach(() => {
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
  });

  // ==========================================================================
  // Tier 1: Preflight Gate
  // ==========================================================================

  describe("Preflight Gate", () => {
    test("returns false when no tasks and no agents exist", () => {
      expect(preflightGate()).toBe(false);
    });

    test("returns false when only completed tasks exist and agents are idle", () => {
      const agent = createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createTaskExtended("Completed task", { agentId: agent.id });
      // Manually mark as completed
      getDb().run(
        "UPDATE agent_tasks SET status = 'completed', finishedAt = datetime('now') WHERE agentId = ?",
        [agent.id],
      );

      expect(preflightGate()).toBe(false);
    });

    test("returns true when unassigned pool tasks exist with idle workers", () => {
      createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createTaskExtended("Pool task");

      expect(preflightGate()).toBe(true);
    });

    test("returns true when in_progress tasks exist", () => {
      const agent = createAgent({ name: "busy-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Active task", { agentId: agent.id });
      startTask(task.id);

      expect(preflightGate()).toBe(true);
    });

    test("returns true when busy workers exist (need health check)", () => {
      createAgent({ name: "busy-worker", isLead: false, status: "busy" });

      expect(preflightGate()).toBe(true);
    });

    test("returns false when only offline agents exist", () => {
      createAgent({ name: "offline-worker", isLead: false, status: "offline" });

      expect(preflightGate()).toBe(false);
    });
  });

  // ==========================================================================
  // DB Query Functions
  // ==========================================================================

  describe("getStalledInProgressTasks", () => {
    test("returns tasks with stale lastUpdatedAt", () => {
      const agent = createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Manually set lastUpdatedAt to 45 minutes ago
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      const stalled = getStalledInProgressTasks(30);
      expect(stalled.length).toBe(1);
      expect(stalled[0]!.id).toBe(task.id);
    });

    test("does not return recently updated in_progress tasks", () => {
      const agent = createAgent({ name: "active-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Active task", { agentId: agent.id });
      startTask(task.id);

      const stalled = getStalledInProgressTasks(30);
      expect(stalled.length).toBe(0);
    });
  });

  describe("getIdleWorkersWithCapacity", () => {
    test("returns idle non-lead agents", () => {
      createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createAgent({ name: "idle-lead", isLead: true, status: "idle" });
      createAgent({ name: "busy-worker", isLead: false, status: "busy" });
      createAgent({ name: "offline-worker", isLead: false, status: "offline" });

      const workers = getIdleWorkersWithCapacity();
      expect(workers.length).toBe(1);
      expect(workers[0]!.name).toBe("idle-worker");
    });

    test("excludes workers at max capacity", () => {
      const agent = createAgent({ name: "full-worker", isLead: false, status: "idle" });
      // maxTasks defaults to 1, so create one in_progress task
      const task = createTaskExtended("Existing task", { agentId: agent.id });
      startTask(task.id);

      const workers = getIdleWorkersWithCapacity();
      expect(workers.length).toBe(0);
    });
  });

  describe("getUnassignedPoolTasks", () => {
    test("returns unassigned tasks ordered by priority then creation time", () => {
      createTaskExtended("Low priority", { priority: 30 });
      createTaskExtended("High priority", { priority: 80 });
      createTaskExtended("Medium priority", { priority: 50 });

      const tasks = getUnassignedPoolTasks(10);
      expect(tasks.length).toBe(3);
      expect(tasks[0]!.priority).toBe(80);
      expect(tasks[1]!.priority).toBe(50);
      expect(tasks[2]!.priority).toBe(30);
    });

    test("respects limit parameter", () => {
      createTaskExtended("Task 1");
      createTaskExtended("Task 2");
      createTaskExtended("Task 3");

      const tasks = getUnassignedPoolTasks(2);
      expect(tasks.length).toBe(2);
    });
  });

  // ==========================================================================
  // Tier 2: Code-Level Triage
  // ==========================================================================

  describe("Code-Level Triage", () => {
    test("detects stalled tasks", async () => {
      const agent = createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Make task stale
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      const findings = await codeLevelTriage();
      expect(findings.stalledTasks.length).toBe(1);
      expect(findings.escalationNeeded).toBe(true);
    });

    test("auto-assigns pool tasks to idle workers", async () => {
      const worker = createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createTaskExtended("Pool task 1");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(worker.id);

      // Verify task is now in_progress
      const task = getTaskById(findings.autoAssigned[0]!.taskId);
      expect(task?.status).toBe("in_progress");
      expect(task?.agentId).toBe(worker.id);
    });

    test("auto-assignment skips lead agents", async () => {
      createAgent({ name: "idle-lead", isLead: true, status: "idle" });
      createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("auto-assignment skips offline workers", async () => {
      createAgent({ name: "offline-worker", isLead: false, status: "offline" });
      createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("auto-assignment respects worker capacity", async () => {
      const worker = createAgent({ name: "full-worker", isLead: false, status: "idle" });
      // maxTasks defaults to 1 — fill capacity
      const existingTask = createTaskExtended("Existing task", { agentId: worker.id });
      startTask(existingTask.id);

      createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("fixes worker with busy status but no active tasks", async () => {
      createAgent({ name: "ghost-busy", isLead: false, status: "busy" });

      const findings = await codeLevelTriage();
      expect(findings.workerHealthFixes.length).toBe(1);
      expect(findings.workerHealthFixes[0]!.oldStatus).toBe("busy");
      expect(findings.workerHealthFixes[0]!.newStatus).toBe("idle");
    });

    test("fixes worker with idle status but active tasks", async () => {
      const worker = createAgent({ name: "ghost-idle", isLead: false, status: "idle" });
      const task = createTaskExtended("Active task", { agentId: worker.id });
      startTask(task.id);
      // Force status back to idle (simulate race)
      updateAgentStatus(worker.id, "idle");

      const findings = await codeLevelTriage();
      expect(
        findings.workerHealthFixes.some((f) => f.oldStatus === "idle" && f.newStatus === "busy"),
      ).toBe(true);
    });

    test("no escalation when no stalled tasks", async () => {
      createAgent({ name: "healthy-worker", isLead: false, status: "idle" });

      const findings = await codeLevelTriage();
      expect(findings.escalationNeeded).toBe(false);
    });
  });

  // ==========================================================================
  // Full Sweep
  // ==========================================================================

  describe("runHeartbeatSweep", () => {
    test("bails early when gate returns false (empty state)", async () => {
      // No tasks, no agents — gate should bail
      // Should not throw
      await runHeartbeatSweep();
    });

    test("runs full triage when gate detects issues", async () => {
      const worker = createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      createAgent({ name: "lead", isLead: true, status: "idle" });
      createTaskExtended("Pool task");

      await runHeartbeatSweep();

      // Verify task was auto-assigned
      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE status = 'in_progress' AND agentId = ?")
        .all(worker.id) as Array<{ id: string }>;
      expect(tasks.length).toBe(1);
    });

    test("creates triage task for lead when stalled tasks found", async () => {
      const lead = createAgent({ name: "triage-lead", isLead: true, status: "idle" });
      const worker = createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: worker.id });
      startTask(task.id);

      // Make task stale
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      await runHeartbeatSweep();

      // Verify triage task was created for lead
      const triageTasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat' AND agentId = ?")
        .all(lead.id) as Array<{ id: string; task: string }>;
      expect(triageTasks.length).toBe(1);
      expect(triageTasks[0]!.task).toContain("Stalled Tasks");
    });

    test("does not create duplicate triage tasks for same stalled set", async () => {
      const lead = createAgent({ name: "triage-lead", isLead: true, status: "idle" });
      const worker = createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: worker.id });
      startTask(task.id);

      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      await runHeartbeatSweep();
      await runHeartbeatSweep();

      const triageTasks = getDb()
        .query("SELECT id FROM agent_tasks WHERE taskType = 'heartbeat' AND agentId = ?")
        .all(lead.id) as Array<{ id: string }>;
      expect(triageTasks.length).toBe(1);
    });

    test("cleans stale sessions even when preflight gate bails", async () => {
      const worker = createAgent({ name: "worker", isLead: false, status: "offline" });
      const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      getDb().run(
        `INSERT INTO active_sessions (id, agentId, triggerType, startedAt, lastHeartbeatAt)
         VALUES (?, ?, 'manual', ?, ?)`,
        ["test-stale-session", worker.id, staleTime, staleTime],
      );

      await runHeartbeatSweep();

      const remaining = getDb()
        .query("SELECT COUNT(*) as count FROM active_sessions WHERE id = ?")
        .get("test-stale-session") as { count: number };
      expect(remaining.count).toBe(0);
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe("Start/Stop Lifecycle", () => {
    test("startHeartbeat and stopHeartbeat work without errors", () => {
      startHeartbeat(60000);
      // Should not throw when called again
      startHeartbeat(60000);
      stopHeartbeat();
      // Should not throw when called again
      stopHeartbeat();
    });
  });
});

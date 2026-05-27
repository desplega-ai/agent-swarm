import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getDb,
  getIdleWorkersWithCapacity,
  getStalledInProgressTasks,
  getTaskById,
  getUnassignedPoolTasks,
  initDb,
  insertActiveSession,
  startTask,
  updateAgentStatus,
} from "../be/db";
import {
  codeLevelTriage,
  getRebootAffectedTasks,
  preflightGate,
  runHeartbeatSweep,
  runRebootSweep,
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
    await initDb(TEST_DB_PATH);
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
  beforeEach(async () => {
    (await getDb()).run("DELETE FROM agent_tasks");
    (await getDb()).run("DELETE FROM agents");
    (await getDb()).run("DELETE FROM active_sessions");
  });

  // ==========================================================================
  // Tier 1: Preflight Gate
  // ==========================================================================

  describe("Preflight Gate", () => {
    test("returns false when no tasks and no agents exist", async () => {
      expect(await preflightGate()).toBe(false);
    });

    test("returns false when only completed tasks exist and agents are idle", async () => {
      const agent = await createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      await createTaskExtended("Completed task", { agentId: agent.id });
      // Manually mark as completed
      (await getDb()).run(
        "UPDATE agent_tasks SET status = 'completed', finishedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE agentId = ?",
        [agent.id],
      );

      expect(await preflightGate()).toBe(false);
    });

    test("returns true when unassigned pool tasks exist with idle workers", async () => {
      await createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      await createTaskExtended("Pool task");

      expect(await preflightGate()).toBe(true);
    });

    test("returns true when in_progress tasks exist", async () => {
      const agent = await createAgent({ name: "busy-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Active task", { agentId: agent.id });
      await startTask(task.id);

      expect(await preflightGate()).toBe(true);
    });

    test("returns true when busy workers exist (need health check)", async () => {
      await createAgent({ name: "busy-worker", isLead: false, status: "busy" });

      expect(await preflightGate()).toBe(true);
    });

    test("returns false when only offline agents exist", async () => {
      await createAgent({ name: "offline-worker", isLead: false, status: "offline" });

      expect(await preflightGate()).toBe(false);
    });
  });

  // ==========================================================================
  // DB Query Functions
  // ==========================================================================

  describe("getStalledInProgressTasks", () => {
    test("returns tasks with stale lastUpdatedAt", async () => {
      const agent = await createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      // Manually set lastUpdatedAt to 45 minutes ago
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      const stalled = await getStalledInProgressTasks(30);
      expect(stalled.length).toBe(1);
      expect(stalled[0]!.id).toBe(task.id);
    });

    test("does not return recently updated in_progress tasks", async () => {
      const agent = await createAgent({ name: "active-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Active task", { agentId: agent.id });
      await startTask(task.id);

      const stalled = await getStalledInProgressTasks(30);
      expect(stalled.length).toBe(0);
    });
  });

  describe("getActiveSessionForTask", () => {
    test("returns active session for task", async () => {
      const agent = await createAgent({ name: "worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Task", { agentId: agent.id });
      await startTask(task.id);

      await insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });

      const session = await getActiveSessionForTask(task.id);
      expect(session).not.toBeNull();
      expect(session!.taskId).toBe(task.id);
    });

    test("returns null when no session exists", async () => {
      const session = await getActiveSessionForTask("non-existent-task-id");
      expect(session).toBeNull();
    });
  });

  describe("getIdleWorkersWithCapacity", () => {
    test("returns idle non-lead agents", async () => {
      await createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      await createAgent({ name: "idle-lead", isLead: true, status: "idle" });
      await createAgent({ name: "busy-worker", isLead: false, status: "busy" });
      await createAgent({ name: "offline-worker", isLead: false, status: "offline" });

      const workers = await getIdleWorkersWithCapacity();
      expect(workers.length).toBe(1);
      expect(workers[0]!.name).toBe("idle-worker");
    });

    test("excludes workers at max capacity", async () => {
      const agent = await createAgent({ name: "full-worker", isLead: false, status: "idle" });
      // maxTasks defaults to 1, so create one in_progress task
      const task = await createTaskExtended("Existing task", { agentId: agent.id });
      await startTask(task.id);

      const workers = await getIdleWorkersWithCapacity();
      expect(workers.length).toBe(0);
    });
  });

  describe("getUnassignedPoolTasks", () => {
    test("returns unassigned tasks ordered by priority then creation time", async () => {
      await createTaskExtended("Low priority", { priority: 30 });
      await createTaskExtended("High priority", { priority: 80 });
      await createTaskExtended("Medium priority", { priority: 50 });

      const tasks = await getUnassignedPoolTasks(10);
      expect(tasks.length).toBe(3);
      expect(tasks[0]!.priority).toBe(80);
      expect(tasks[1]!.priority).toBe(50);
      expect(tasks[2]!.priority).toBe(30);
    });

    test("respects limit parameter", async () => {
      await createTaskExtended("Task 1");
      await createTaskExtended("Task 2");
      await createTaskExtended("Task 3");

      const tasks = await getUnassignedPoolTasks(2);
      expect(tasks.length).toBe(2);
    });
  });

  // ==========================================================================
  // Tier 2: Code-Level Triage
  // ==========================================================================

  describe("Code-Level Triage", () => {
    test("auto-fails stalled task with no active session", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      // Make task stale (10 min — past the 5 min no-session threshold)
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      const findings = await codeLevelTriage();

      expect(findings.autoFailedTasks.length).toBe(1);
      expect(findings.autoFailedTasks[0]!.taskId).toBe(task.id);
      expect(findings.stalledTasks.length).toBe(0);

      // Verify task is actually failed in DB
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.failureReason).toContain("no active session");
    });

    test("auto-fails stalled task with stale session heartbeat", async () => {
      const agent = await createAgent({ name: "crashed-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      // Create an active session with stale heartbeat
      await insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });
      // Make both task and session heartbeat stale (20 min — past the 15 min threshold)
      const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);
      (await getDb()).run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
        oldTime,
        task.id,
      ]);

      const findings = await codeLevelTriage();

      expect(findings.autoFailedTasks.length).toBe(1);
      expect(findings.autoFailedTasks[0]!.taskId).toBe(task.id);
      expect(findings.stalledTasks.length).toBe(0);

      // Verify task is failed and session is deleted
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.failureReason).toContain("stale");

      const session = await getActiveSessionForTask(task.id);
      expect(session).toBeNull();
    });

    test("escalates stalled task with fresh session heartbeat (ambiguous)", async () => {
      const agent = await createAgent({ name: "alive-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      // Create an active session with fresh heartbeat
      await insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });

      // Make task stale (45 min — past the 30 min threshold) but keep session fresh
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);
      // Session lastHeartbeatAt stays current (just created)

      const findings = await codeLevelTriage();

      expect(findings.autoFailedTasks.length).toBe(0);
      expect(findings.stalledTasks.length).toBe(1);
      expect(findings.stalledTasks[0]!.id).toBe(task.id);
      // Task should NOT be failed
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("in_progress");
    });

    test("auto-assigns pool tasks to idle workers", async () => {
      const worker = await createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      await createTaskExtended("Pool task 1");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(worker.id);

      // Verify task is now in_progress
      const task = await getTaskById(findings.autoAssigned[0]!.taskId);
      expect(task?.status).toBe("in_progress");
      expect(task?.agentId).toBe(worker.id);
    });

    test("auto-assignment skips lead agents", async () => {
      await createAgent({ name: "idle-lead", isLead: true, status: "idle" });
      await createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("auto-assignment skips offline workers", async () => {
      await createAgent({ name: "offline-worker", isLead: false, status: "offline" });
      await createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("auto-assignment respects worker capacity", async () => {
      const worker = await createAgent({ name: "full-worker", isLead: false, status: "idle" });
      // maxTasks defaults to 1 — fill capacity
      const existingTask = await createTaskExtended("Existing task", { agentId: worker.id });
      await startTask(existingTask.id);

      await createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(0);
    });

    test("fixes worker with busy status but no active tasks", async () => {
      await createAgent({ name: "ghost-busy", isLead: false, status: "busy" });

      const findings = await codeLevelTriage();
      expect(findings.workerHealthFixes.length).toBe(1);
      expect(findings.workerHealthFixes[0]!.oldStatus).toBe("busy");
      expect(findings.workerHealthFixes[0]!.newStatus).toBe("idle");
    });

    test("fixes worker with idle status but active tasks", async () => {
      const worker = await createAgent({ name: "ghost-idle", isLead: false, status: "idle" });
      const task = await createTaskExtended("Active task", { agentId: worker.id });
      await startTask(task.id);
      // Force status back to idle (simulate race)
      await updateAgentStatus(worker.id, "idle");

      const findings = await codeLevelTriage();
      expect(
        findings.workerHealthFixes.some((f) => f.oldStatus === "idle" && f.newStatus === "busy"),
      ).toBe(true);
    });

    test("no stalled tasks when workers are healthy", async () => {
      await createAgent({ name: "healthy-worker", isLead: false, status: "idle" });

      const findings = await codeLevelTriage();
      expect(findings.stalledTasks.length).toBe(0);
    });

    test("sets agent to idle after auto-failing its only task", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      await codeLevelTriage();

      // Agent should be set to idle since it has no more active tasks
      const agents = (await getDb())
        .query("SELECT status FROM agents WHERE id = ?")
        .get(agent.id) as {
        status: string;
      };
      expect(agents.status).toBe("idle");
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
      const worker = await createAgent({ name: "idle-worker", isLead: false, status: "idle" });
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      await createTaskExtended("Pool task");

      await runHeartbeatSweep();

      // Verify task was auto-assigned
      const tasks = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE status = 'in_progress' AND agentId = ?")
        .all(worker.id) as Array<{ id: string }>;
      expect(tasks.length).toBe(1);
    });

    test("auto-fails stalled task with no session during sweep", async () => {
      const worker = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled no-session", { agentId: worker.id });
      await startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      await runHeartbeatSweep();

      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");
    });

    test("cleans stale sessions even when preflight gate bails", async () => {
      const worker = await createAgent({ name: "worker", isLead: false, status: "offline" });
      const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      (await getDb()).run(
        `INSERT INTO active_sessions (id, agentId, triggerType, startedAt, lastHeartbeatAt)
         VALUES (?, ?, 'manual', ?, ?)`,
        ["test-stale-session", worker.id, staleTime, staleTime],
      );

      await runHeartbeatSweep();

      const remaining = (await getDb())
        .query("SELECT COUNT(*) as count FROM active_sessions WHERE id = ?")
        .get("test-stale-session") as { count: number };
      expect(remaining.count).toBe(0);
    });
  });

  // ==========================================================================
  // Reboot Sweep
  // ==========================================================================

  describe("Reboot Sweep", () => {
    test("no-op when no in_progress tasks exist", async () => {
      await runRebootSweep();

      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(0);
    });

    test("auto-fails in_progress task with no session and creates retry", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Interrupted task", { agentId: agent.id });
      await startTask(task.id);

      // Backdate so getStalledInProgressTasks(0) picks it up (avoids same-ms timing issue)
      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // Original task should be failed
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.failureReason).toContain("reboot sweep");

      // Retry task should exist
      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(1);
      expect(affected[0]!.original.id).toBe(task.id);
      expect(affected[0]!.retryTaskId).not.toBeNull();

      // Verify retry task in DB
      const retryTask = await getTaskById(affected[0]!.retryTaskId!);
      expect(retryTask).not.toBeNull();
      expect(retryTask!.parentTaskId).toBe(task.id);
      expect(retryTask!.task).toBe(task.task);
      // No agentId → goes to pool as "unassigned", auto-assign will route it
      expect(retryTask!.status).toBe("unassigned");

      // Verify retry has correct tags
      const retryRow = (await getDb())
        .query("SELECT tags FROM agent_tasks WHERE id = ?")
        .get(affected[0]!.retryTaskId!) as { tags: string };
      const tags = JSON.parse(retryRow.tags);
      expect(tags).toContain("reboot-retry");
      expect(tags).toContain("auto-generated");
    });

    test("skips in_progress task that has an active session", async () => {
      const agent = await createAgent({ name: "alive-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Active task", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      // Create an active session — worker is still alive
      await insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });

      await runRebootSweep();

      // Task should NOT be failed
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("in_progress");

      // No retry tasks should exist for this task
      const retries = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);
    });

    test("retry dedup: does not create second retry when one already exists", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Interrupted task", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      // Pre-create a retry task (simulating a previous reboot sweep)
      await createTaskExtended("Retry of interrupted task", { parentTaskId: task.id });

      await runRebootSweep();

      // Should only have the one pre-existing retry, not a second
      const retries = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(1);
    });

    test("does not retry system tasks (heartbeat-checklist)", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
      const task = await createTaskExtended("Heartbeat check", {
        agentId: lead.id,
        taskType: "heartbeat-checklist",
      });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // Task should be failed
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");

      // But no retry should be created
      const retries = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);

      // Affected list should show null retryTaskId
      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(1);
      expect(affected[0]!.retryTaskId).toBeNull();
    });

    test("does not retry system tasks (boot-triage)", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
      const task = await createTaskExtended("Boot triage", {
        agentId: lead.id,
        taskType: "boot-triage",
      });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");

      const retries = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);
    });

    test("does not retry system tasks (heartbeat)", async () => {
      const agent = await createAgent({ name: "worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Heartbeat task", {
        agentId: agent.id,
        taskType: "heartbeat",
      });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("failed");

      const retries = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(0);
    });

    test("sets agent to idle after auto-failing its only task", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Interrupted task", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const agentRow = (await getDb())
        .query("SELECT status FROM agents WHERE id = ?")
        .get(agent.id) as {
        status: string;
      };
      expect(agentRow.status).toBe("idle");
    });

    test("concurrent calls only process tasks once (dedup guard)", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Interrupted task", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      // Run two sweeps concurrently
      await Promise.all([runRebootSweep(), runRebootSweep()]);

      // Only one retry should be created
      const retries = (await getDb())
        .query("SELECT * FROM agent_tasks WHERE parentTaskId = ?")
        .all(task.id);
      expect(retries.length).toBe(1);
    });

    test("preserves task priority and source in retry", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("High priority task", {
        agentId: agent.id,
        priority: 90,
        source: "slack",
      });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      (await getDb()).run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const affected = getRebootAffectedTasks();
      expect(affected.length).toBe(1);

      const retryTask = await getTaskById(affected[0]!.retryTaskId!);
      expect(retryTask!.priority).toBe(90);
      expect(retryTask!.source).toBe("slack");
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

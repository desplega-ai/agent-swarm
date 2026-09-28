import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getDbClient,
  getIdleWorkersWithCapacity,
  getOrphanedInProgressTasksForAgent,
  getPendingTaskForAgent,
  getStalledInProgressTasks,
  getTaskById,
  getUnassignedPoolTasks,
  incrementEmptyPollCount,
  initDb,
  insertActiveSession,
  MAX_EMPTY_POLLS,
  resetOrphanedInProgressTasksForAgent,
  startTask,
  updateAgentProfile,
  updateAgentStatus,
  updateTaskClaudeSessionId,
} from "../be/db";
import {
  codeLevelTriage,
  preflightGate,
  runHeartbeatSweep,
  startHeartbeat,
  stopHeartbeat,
} from "../heartbeat/heartbeat";
import { createResumeFollowUp } from "../tasks/worker-follow-up";

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
  beforeEach(async () => {
    await getDbClient().run("DELETE FROM agent_tasks");
    await getDbClient().run("DELETE FROM agents");
    await getDbClient().run("DELETE FROM active_sessions");
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
      await getDbClient().run(
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
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
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

  describe("orphaned in_progress recovery", () => {
    test("resets stale in_progress task with no session and no claudeSessionId to pending", async () => {
      const agent = await createAgent({ name: "orphan-worker", isLead: false, status: "idle" });
      const task = await createTaskExtended("Orphaned task", { agentId: agent.id });
      await startTask(task.id);

      const oldTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      const orphaned = await getOrphanedInProgressTasksForAgent(agent.id, 60);
      expect(orphaned.map((t) => t.id)).toContain(task.id);

      const reset = await resetOrphanedInProgressTasksForAgent(agent.id, 60);
      expect(reset.map((t) => t.id)).toContain(task.id);

      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("pending");
      expect((await getPendingTaskForAgent(agent.id))?.id).toBe(task.id);
    });

    test("does not reset tasks with active session, provider session, or fresh update", async () => {
      const agent = await createAgent({ name: "live-worker", isLead: false, status: "idle" });
      const withActiveSession = await createTaskExtended("Live session task", {
        agentId: agent.id,
      });
      const withProviderSession = await createTaskExtended("Provider session task", {
        agentId: agent.id,
      });
      const fresh = await createTaskExtended("Fresh task", { agentId: agent.id });

      await startTask(withActiveSession.id);
      await startTask(withProviderSession.id);
      await startTask(fresh.id);

      const oldTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id IN (?, ?)", [
        oldTime,
        withActiveSession.id,
        withProviderSession.id,
      ]);
      await insertActiveSession({
        agentId: agent.id,
        taskId: withActiveSession.id,
        triggerType: "task_assigned",
      });
      await updateTaskClaudeSessionId(withProviderSession.id, "claude-live-session");

      const reset = await resetOrphanedInProgressTasksForAgent(agent.id, 60);
      expect(reset.length).toBe(0);

      expect((await getTaskById(withActiveSession.id))?.status).toBe("in_progress");
      expect((await getTaskById(withProviderSession.id))?.status).toBe("in_progress");
      expect((await getTaskById(fresh.id))?.status).toBe("in_progress");
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
    test("reports approval sweep counts in staleCleanup", async () => {
      const findings = await codeLevelTriage();

      expect(typeof findings.staleCleanup.approvalAutoCancelled).toBe("number");
      expect(typeof findings.staleCleanup.approvalTimedOut).toBe("number");
    });

    test("reclaims stalled task with no active session", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      // Make task stale (10 min — past the 5 min no-session threshold)
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      const findings = await codeLevelTriage();

      expect(findings.reclaimedTasks.length).toBe(1);
      expect(findings.reclaimedTasks[0]!.taskId).toBe(task.id);
      expect(findings.reclaimedTasks[0]!.reason).toContain("no active session");
      expect(findings.autoFailedTasks.length).toBe(0);
      expect(findings.stalledTasks.length).toBe(0);

      // Reclaim: the same row is pending again, not failed or superseded.
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("pending");
      expect(updated?.failureReason).toBeFalsy();
    });

    test("reclaims stalled task with stale session heartbeat", async () => {
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
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);
      await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
        oldTime,
        task.id,
      ]);

      const findings = await codeLevelTriage();

      expect(findings.reclaimedTasks.length).toBe(1);
      expect(findings.reclaimedTasks[0]!.taskId).toBe(task.id);
      expect(findings.reclaimedTasks[0]!.reason).toContain("stale");
      expect(findings.autoFailedTasks.length).toBe(0);
      expect(findings.stalledTasks.length).toBe(0);

      // Reclaim: the same row is pending again, not failed or superseded.
      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe("pending");
      expect(updated?.failureReason).toBeFalsy();

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
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
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

      // Verify task is pending so the worker's normal poll returns task_assigned.
      const task = await getTaskById(findings.autoAssigned[0]!.taskId);
      expect(task?.status).toBe("pending");
      expect(task?.agentId).toBe(worker.id);

      const dispatchable = await getPendingTaskForAgent(worker.id);
      expect(dispatchable?.id).toBe(task?.id);
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

    test("auto-assignment counts pending reservations when assigning pool tasks", async () => {
      const worker = await createAgent({
        name: "single-slot-worker",
        isLead: false,
        status: "idle",
      });
      await createTaskExtended("Pool task 1");
      await createTaskExtended("Pool task 2");

      const findings = await codeLevelTriage();
      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(worker.id);

      const assigned = (await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'pending'",
        [worker.id],
      )) as { count: number };
      const remaining = (await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
      )) as { count: number };

      expect(assigned.count).toBe(1);
      expect(remaining.count).toBe(1);
    });

    test("auto-assignment skips idle workers gated by emptyPollCount, still assigns healthy ones", async () => {
      const healthy = await createAgent({ name: "healthy-idle", isLead: false, status: "idle" });
      const gated = await createAgent({ name: "gated-idle", isLead: false, status: "idle" });
      // Push the gated worker to the poll-gate threshold.
      for (let i = 0; i < MAX_EMPTY_POLLS; i++) await incrementEmptyPollCount(gated.id);

      await createTaskExtended("Pool task");

      const findings = await codeLevelTriage();
      // Exactly one assignment, and it goes to the healthy worker — never the gated one.
      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(healthy.id);
      expect(findings.autoAssigned.some((a) => a.agentId === gated.id)).toBe(false);
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

    test("privileged crash recovery reroutes a legacy worker parent to the Lead", async () => {
      const worker = await createAgent({ name: "misrouted-worker", isLead: false, status: "idle" });
      const lead = await createAgent({ name: "recovery-lead", isLead: true, status: "idle" });
      const parent = await createTaskExtended("Merge this PR", { agentId: worker.id });
      // Simulate a legacy row created before the structured constraint existed.
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'superseded', routingAffinity = ? WHERE id = ?",
        [JSON.stringify({ sourceAgentId: worker.id, capabilities: [], leadOnly: true }), parent.id],
      );

      const result = await createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.task.agentId).toBe(lead.id);
      expect(result.task.routingAffinity?.leadOnly).toBe(true);
      const audit = await getDbClient().get<{ metadata: string }>(
        "SELECT metadata FROM agent_log WHERE taskId = ? AND eventType = 'task_recovery_authorization'",
        [result.task.id],
      );
      expect(audit?.metadata).toContain("rerouted_to_lead");
    });

    test("privileged crash recovery preserves parent capabilities on an unassigned child", async () => {
      const worker = await createAgent({
        name: "capability-source-worker",
        isLead: false,
        status: "idle",
      });
      const underprivilegedLead = await createAgent({
        name: "capability-underprivileged-lead",
        isLead: true,
        status: "idle",
      });
      await updateAgentProfile(worker.id, { capabilities: ["typescript"] });
      await updateAgentProfile(underprivilegedLead.id, { capabilities: ["typescript"] });
      const parent = await createTaskExtended("Merge this PR", { agentId: worker.id });
      // Simulate legacy privileged work whose source snapshot has capabilities
      // unrelated to its authorization requirement.
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'superseded', routingAffinity = ? WHERE id = ?",
        [
          JSON.stringify({ sourceAgentId: worker.id, capabilities: ["merge"], leadOnly: true }),
          parent.id,
        ],
      );

      const result = await createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.task.status).toBe("unassigned");
      expect(result.task.routingAffinity).toMatchObject({
        leadOnly: true,
        capabilities: ["merge"],
      });
      expect(await claimTask(result.task.id, underprivilegedLead.id)).toBeNull();
    });

    test("privileged recovery retains a safe Lead source pin", async () => {
      const lead = await createAgent({ name: "source-lead", isLead: true, status: "idle" });
      const parent = await createTaskExtended("Merge this PR", {
        agentId: lead.id,
        routingAffinity: { capabilities: [], leadOnly: true },
      });
      await getDbClient().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [
        parent.id,
      ]);

      const result = await createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.task.agentId).toBe(lead.id);
      expect(result.task.tags).toContain("crash-recovery-pin");
    });

    test("sets agent to idle after auto-superseding its only task", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      await codeLevelTriage();

      // Agent goes idle: the parent task is terminal (superseded) and the
      // crash_recovery resume is now PINNED back to this agent as `pending`
      // (DES-523 same-agent pin). `pending` does not count toward in_progress
      // capacity, so getActiveTaskCount drops to 0 and the agent flips to idle.
      const agents = (await getDbClient().get<{ status: string }>(
        "SELECT status FROM agents WHERE id = ?",
        [agent.id],
      )) as {
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
      const tasks = (await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE status = 'pending' AND agentId = ?",
        [worker.id],
      )) as Array<{ id: string }>;
      expect(tasks.length).toBe(1);
    });

    test("reclaims stalled task with no session during sweep", async () => {
      const worker = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled no-session", { agentId: worker.id });
      await startTask(task.id);

      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      await runHeartbeatSweep();

      const updated = await getTaskById(task.id);
      // Reclaim: same row goes back to pending, no supersede/resume child.
      expect(updated?.status).toBe("pending");
    });

    test("cleans stale sessions even when preflight gate bails", async () => {
      const worker = await createAgent({ name: "worker", isLead: false, status: "offline" });
      const staleTime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      await getDbClient().run(
        `INSERT INTO active_sessions (id, agentId, triggerType, startedAt, lastHeartbeatAt)
         VALUES (?, ?, 'manual', ?, ?)`,
        ["test-stale-session", worker.id, staleTime, staleTime],
      );

      await runHeartbeatSweep();

      const remaining = (await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) as count FROM active_sessions WHERE id = ?",
        ["test-stale-session"],
      )) as { count: number };
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

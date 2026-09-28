/**
 * Heartbeat Reclaim + Unpin (specs/tla/heartbeat/HeartbeatSimple.tla).
 *
 * A stalled task goes back to `pending` on the SAME row (Reclaim); a pin its
 * agent never starts goes back to the pool (Unpin). No resume or retry rows.
 * Own sqlite file, full DB reset between tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getChildTasks,
  getDbClient,
  getLeadAgent,
  getLogsByTaskId,
  getTaskById,
  initDb,
  insertActiveSession,
  reclaimTask,
  startTask,
  updateAgentStatus,
  updateTaskProgress,
} from "../be/db";
import {
  codeLevelTriage,
  maxResumeGenerations,
  RESUME_BUDGET_EXHAUSTED_REASON,
  setBeforeHeartbeatReclaimForTests,
} from "../heartbeat/heartbeat";

const TEST_DB_PATH = "./test-heartbeat-reclaim.sqlite";

const minutesAgo = (min: number) => new Date(Date.now() - min * 60 * 1000).toISOString();

async function setLastUpdated(taskId: string, iso: string): Promise<void> {
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [iso, taskId]);
}

async function setAttempt(taskId: string, attempt: number): Promise<void> {
  await getDbClient().run("UPDATE agent_tasks SET attempt = ? WHERE id = ?", [attempt, taskId]);
}

async function stalledTask(opts: { taskType?: string; minutes?: number } = {}) {
  const agent = await createAgent({ name: "worker", isLead: false, status: "busy" });
  const task = await createTaskExtended("Long-running work", {
    agentId: agent.id,
    taskType: opts.taskType,
  });
  await startTask(task.id);
  await setLastUpdated(task.id, minutesAgo(opts.minutes ?? 10));
  return { agent, task };
}

async function taskCount(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks");
  return row?.n ?? 0;
}

describe("Heartbeat Reclaim (HeartbeatSimple.tla)", () => {
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
    for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
      try {
        await unlink(path);
      } catch {
        // Files may not exist
      }
    }
  });

  beforeEach(async () => {
    setBeforeHeartbeatReclaimForTests(null);
    const db = getDbClient();
    await db.run("DELETE FROM agent_tasks");
    await db.run("DELETE FROM agents");
    await db.run("DELETE FROM active_sessions");
  });

  test("no session: the task goes back to pending on the same row, pinned, attempt 1", async () => {
    const { agent, task } = await stalledTask();

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toEqual([
      expect.objectContaining({ taskId: task.id, agentId: agent.id, attempt: 1 }),
    ]);
    expect(findings.autoFailedTasks).toHaveLength(0);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.agentId).toBe(agent.id);
    expect(after?.attempt).toBe(1);
    // One row per unit of work: no resume or retry child.
    expect(await getChildTasks(task.id)).toHaveLength(0);
    expect(await taskCount()).toBe(1);
    const log = (await getLogsByTaskId(task.id)).find(
      (l) => l.eventType === "task_status_change" && l.newValue === "pending",
    );
    expect(JSON.parse(log?.metadata ?? "{}")).toMatchObject({ reclaimed: true, attempt: 1 });
  });

  test("stale session: reclaimed and its session row deleted in the same write", async () => {
    const { agent, task } = await stalledTask({ minutes: 20 });
    await insertActiveSession({ agentId: agent.id, taskId: task.id, triggerType: "task_assigned" });
    await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
      minutesAgo(20),
      task.id,
    ]);

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks.map((r) => r.taskId)).toEqual([task.id]);
    expect((await getTaskById(task.id))?.status).toBe("pending");
    expect(await getActiveSessionForTask(task.id)).toBeNull();
  });

  test("fresh session: recorded only, not reclaimed", async () => {
    const { agent, task } = await stalledTask({ minutes: 40 });
    await insertActiveSession({ agentId: agent.id, taskId: task.id, triggerType: "task_assigned" });

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toHaveLength(0);
    expect(findings.stalledTasks.map((t) => t.id)).toEqual([task.id]);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("the pinned agent restarts the reclaimed row (same id, attempt kept)", async () => {
    const { task } = await stalledTask();
    await codeLevelTriage();

    const restarted = await startTask(task.id);

    expect(restarted?.status).toBe("in_progress");
    expect(restarted?.id).toBe(task.id);
    expect(restarted?.attempt).toBe(1);
  });

  test("a reclaimed pending row is not reclaimed again and creates nothing on re-sweep", async () => {
    const { task } = await stalledTask();
    await codeLevelTriage();
    await setLastUpdated(task.id, minutesAgo(3)); // inside the unpin grace

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toHaveLength(0);
    expect((await getTaskById(task.id))?.attempt).toBe(1);
    expect(await taskCount()).toBe(1);
  });

  test("budget: the reclaim after the last allowed one fails the task", async () => {
    const { task } = await stalledTask();
    await setAttempt(task.id, maxResumeGenerations());

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toHaveLength(0);
    expect(findings.autoFailedTasks.map((f) => f.reason)).toEqual([RESUME_BUDGET_EXHAUSTED_REASON]);
    expect((await getTaskById(task.id))?.status).toBe("failed");
  });

  test("budget: the last allowed reclaim still reclaims", async () => {
    const { task } = await stalledTask();
    await setAttempt(task.id, maxResumeGenerations() - 1);

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks.map((r) => r.attempt)).toEqual([maxResumeGenerations()]);
  });

  for (const taskType of ["heartbeat", "heartbeat-checklist", "boot-triage", "reroute-decision"]) {
    test(`control-plane task (${taskType}) is failed, not reclaimed`, async () => {
      const { task } = await stalledTask({ taskType });

      const findings = await codeLevelTriage();

      expect(findings.reclaimedTasks).toHaveLength(0);
      expect(findings.autoFailedTasks.map((f) => f.taskId)).toEqual([task.id]);
      expect((await getTaskById(task.id))?.status).toBe("failed");
    });
  }

  test("workflow step is failed with the workflow reason (engine retry owns it)", async () => {
    const { task } = await stalledTask();
    // FKs off: this exercises the heartbeat path, not the workflow engine.
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    try {
      await getDbClient().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [
        crypto.randomUUID(),
        task.id,
      ]);
    } finally {
      await getDbClient().run("PRAGMA foreign_keys = ON");
    }

    const findings = await codeLevelTriage();

    expect(findings.autoFailedTasks.map((f) => f.reason)).toEqual(["superseded_workflow_task"]);
    expect((await getTaskById(task.id))?.status).toBe("failed");
  });

  test("CAS: progress between the read and the write cancels the reclaim", async () => {
    const { task } = await stalledTask();
    setBeforeHeartbeatReclaimForTests(async (candidate) => {
      await updateTaskProgress(candidate.id, "still working");
    });

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toHaveLength(0);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("in_progress");
    expect(after?.attempt).toBe(0);
  });

  test("CAS: a session registered between the read and the write cancels the reclaim", async () => {
    const { agent, task } = await stalledTask();
    setBeforeHeartbeatReclaimForTests(async (candidate) => {
      await insertActiveSession({
        agentId: agent.id,
        taskId: candidate.id,
        triggerType: "task_assigned",
      });
    });

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toHaveLength(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("CAS: a tool-call heartbeat on the observed session cancels the reclaim", async () => {
    const { agent, task } = await stalledTask({ minutes: 20 });
    await insertActiveSession({ agentId: agent.id, taskId: task.id, triggerType: "task_assigned" });
    await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
      minutesAgo(20),
      task.id,
    ]);
    setBeforeHeartbeatReclaimForTests(async (candidate) => {
      await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
        new Date().toISOString(),
        candidate.id,
      ]);
    });

    const findings = await codeLevelTriage();

    expect(findings.reclaimedTasks).toHaveLength(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(await getActiveSessionForTask(task.id)).not.toBeNull();
  });

  test("reclaimTask is a no-op when the attempt moved on", async () => {
    const { task } = await stalledTask();
    const row = await getTaskById(task.id);

    const result = await reclaimTask(task.id, {
      expectedAttempt: 1,
      expectedLastUpdatedAt: row!.lastUpdatedAt,
      observedSessionHeartbeatAt: null,
      reason: "test",
    });

    expect(result).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("fence: a progress write from the old attempt does not revive a reclaimed row", async () => {
    const { task } = await stalledTask();
    await codeLevelTriage();

    const result = await updateTaskProgress(task.id, "zombie progress");

    expect(result).toBeNull();
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.progress).not.toBe("zombie progress");
  });

  test("sets the agent idle after reclaiming its only task", async () => {
    const { agent } = await stalledTask();

    await codeLevelTriage();

    const row = await getDbClient().get<{ status: string }>(
      "SELECT status FROM agents WHERE id = ?",
      [agent.id],
    );
    expect(row?.status).toBe("idle");
  });
});

describe("Heartbeat Unpin (HeartbeatSimple.tla)", () => {
  beforeAll(async () => {
    closeDb();
    initDb(TEST_DB_PATH);
  });

  beforeEach(async () => {
    const db = getDbClient();
    await db.run("DELETE FROM agent_tasks");
    await db.run("DELETE FROM agents");
    await db.run("DELETE FROM active_sessions");
  });

  async function reclaimedPin(minutesPending: number) {
    const { agent, task } = await stalledTask();
    await codeLevelTriage();
    await setLastUpdated(task.id, minutesAgo(minutesPending));
    return { agent, task };
  }

  test("a reclaimed pin its agent did not start within the grace goes to the pool", async () => {
    const { agent, task } = await reclaimedPin(15);

    const findings = await codeLevelTriage();

    expect(findings.unpinnedTasks).toEqual([{ taskId: task.id, previousAgentId: agent.id }]);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("unassigned");
    expect(after?.agentId ?? null).toBeNull();
    expect(after?.attempt).toBe(1);
    // Role-gated pool: affinity stamped from the agent that held it.
    expect(after?.routingAffinity?.sourceAgentId).toBe(agent.id);
    expect(await taskCount()).toBe(1);
  });

  test("a reclaimed pin inside the grace window keeps its pin", async () => {
    const { agent, task } = await reclaimedPin(3);

    const findings = await codeLevelTriage();

    expect(findings.unpinnedTasks).toHaveLength(0);
    expect((await getTaskById(task.id))?.agentId).toBe(agent.id);
  });

  test("a reclaimed pin the agent restarted is not unpinned", async () => {
    const { task } = await reclaimedPin(15);
    await startTask(task.id);

    const findings = await codeLevelTriage();

    expect(findings.unpinnedTasks).toHaveLength(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("a directly assigned task queued behind a busy agent is not a pin", async () => {
    const agent = await createAgent({ name: "busy", isLead: false, status: "busy" });
    const task = await createTaskExtended("Queued work", { agentId: agent.id });
    await setLastUpdated(task.id, minutesAgo(60));

    const findings = await codeLevelTriage();

    expect(findings.unpinnedTasks).toHaveLength(0);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.agentId).toBe(agent.id);
  });

  test("a legacy graceful-shutdown resume pin is unpinned too", async () => {
    const agent = await createAgent({ name: "gone", isLead: false, status: "idle" });
    const resume = await createTaskExtended("Resume work", {
      agentId: agent.id,
      taskType: "resume",
      tags: ["graceful-shutdown-pin"],
    });
    await setLastUpdated(resume.id, minutesAgo(15));

    const findings = await codeLevelTriage();

    expect(findings.unpinnedTasks.map((u) => u.taskId)).toEqual([resume.id]);
    expect((await getTaskById(resume.id))?.status).toBe("unassigned");
  });

  test("a Lead-held pin is left alone", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const task = await createTaskExtended("Lead work", { agentId: lead.id });
    await startTask(task.id);
    await setLastUpdated(task.id, minutesAgo(10));
    await codeLevelTriage();
    await setLastUpdated(task.id, minutesAgo(15));
    await updateAgentStatus(lead.id, "idle");

    const findings = await codeLevelTriage();

    expect(findings.unpinnedTasks).toHaveLength(0);
    expect((await getTaskById(task.id))?.agentId).toBe(lead.id);
  });

  test("getLeadAgent prefers a non-offline lead", async () => {
    const offline = await createAgent({ name: "old-lead", isLead: true, status: "offline" });
    expect((await getLeadAgent())?.id).toBe(offline.id);
    const online = await createAgent({ name: "new-lead", isLead: true, status: "idle" });
    expect((await getLeadAgent())?.id).toBe(online.id);
  });
});

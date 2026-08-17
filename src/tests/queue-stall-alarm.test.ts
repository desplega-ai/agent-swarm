import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTaskExtended, getDb, initDb, updateTaskVcs } from "../be/db";
import {
  _test,
  checkQueueStall,
  getQueueStallSnapshot,
  isQueueStalled,
  QUEUE_STALL_THRESHOLD_MS,
} from "../queue-stall-alarm";

const TEST_DB_PATH = "./test-queue-stall-alarm.sqlite";
const NOW = new Date("2026-08-17T17:00:00.000Z");

beforeAll(() => {
  closeDb();
  initDb(TEST_DB_PATH);
});

beforeEach(() => {
  _test.resetState();
  getDb().run("DELETE FROM agent_log");
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM agents");
});

afterAll(async () => {
  _test.resetState();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

function setCreatedAt(taskId: string, createdAt: string): void {
  getDb().run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
    createdAt,
    createdAt,
    taskId,
  ]);
  getDb().run(
    "UPDATE agent_log SET createdAt = ? WHERE taskId = ? AND eventType = 'task_created'",
    [createdAt, taskId],
  );
}

describe("queue stall alarm", () => {
  test("positive control: alerts when a claimable task is older than 30 minutes", async () => {
    const worker = createAgent({ name: "worker", isLead: false, status: "idle" });
    const task = createTaskExtended("Old claimable task", { agentId: worker.id });
    setCreatedAt(task.id, "2026-08-17T16:29:59.000Z");
    const notify = mock(async (_message: string) => {});

    const snapshot = await checkQueueStall(NOW, notify);

    expect(isQueueStalled(snapshot)).toBe(true);
    expect(snapshot.claimableCount).toBe(1);
    expect(snapshot.oldestTaskId).toBe(task.id);
    expect(snapshot.oldestAgeMs).toBeGreaterThan(QUEUE_STALL_THRESHOLD_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain("queue pickup stalled");
  });

  test("negative control: an empty queue never alerts", async () => {
    const notify = mock(async (_message: string) => {});

    const snapshot = await checkQueueStall(NOW, notify);

    expect(snapshot.claimableCount).toBe(0);
    expect(isQueueStalled(snapshot)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  test("does not alert for a non-empty but fresh queue", async () => {
    const task = createTaskExtended("Fresh pool task");
    setCreatedAt(task.id, "2026-08-17T16:45:00.000Z");
    const notify = mock(async (_message: string) => {});

    const snapshot = await checkQueueStall(NOW, notify);

    expect(snapshot.claimableCount).toBe(1);
    expect(isQueueStalled(snapshot)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  test("measures queue age from a backlog task becoming claimable", async () => {
    const task = createTaskExtended("Released backlog task");
    setCreatedAt(task.id, "2026-08-17T12:00:00.000Z");
    getDb().run("UPDATE agent_tasks SET status = 'backlog' WHERE id = ?", [task.id]);
    getDb().run("UPDATE agent_tasks SET status = 'unassigned', lastUpdatedAt = ? WHERE id = ?", [
      "2026-08-17T16:59:00.000Z",
      task.id,
    ]);
    getDb().run(
      `INSERT INTO agent_log (id, eventType, taskId, oldValue, newValue, createdAt)
       VALUES (?, 'task_status_change', ?, 'backlog', 'unassigned', ?)`,
      [crypto.randomUUID(), task.id, "2026-08-17T16:59:00.000Z"],
    );
    const notify = mock(async (_message: string) => {});

    const snapshot = await checkQueueStall(NOW, notify);

    expect(snapshot.oldestAgeMs).toBe(60_000);
    expect(isQueueStalled(snapshot)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  test("measures queue age from the final dependency completing", async () => {
    const worker = createAgent({ name: "worker", isLead: false, status: "idle" });
    const prerequisite = createTaskExtended("Prerequisite", { agentId: worker.id });
    const blocked = createTaskExtended("Newly unblocked", {
      agentId: worker.id,
      dependsOn: [prerequisite.id],
    });
    setCreatedAt(blocked.id, "2026-08-17T12:00:00.000Z");
    getDb().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ?, lastUpdatedAt = ? WHERE id = ?",
      ["2026-08-17T16:59:00.000Z", "2026-08-17T16:59:00.000Z", prerequisite.id],
    );
    const notify = mock(async (_message: string) => {});

    const snapshot = await checkQueueStall(NOW, notify);

    expect(snapshot.oldestTaskId).toBe(blocked.id);
    expect(snapshot.oldestAgeMs).toBe(60_000);
    expect(isQueueStalled(snapshot)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  test("does not reset queue age when VCS metadata updates a claimable task", () => {
    const task = createTaskExtended("Old task with new VCS metadata");
    setCreatedAt(task.id, "2026-08-17T16:00:00.000Z");

    updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1177,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/1177",
    });

    const snapshot = getQueueStallSnapshot(NOW);
    expect(snapshot.oldestAgeMs).toBe(60 * 60 * 1000);
    expect(isQueueStalled(snapshot)).toBe(true);
  });

  test("does not reset claimable age when VCS metadata updates a completed dependency", () => {
    const worker = createAgent({ name: "worker", isLead: false, status: "idle" });
    const prerequisite = createTaskExtended("Completed prerequisite", { agentId: worker.id });
    const blocked = createTaskExtended("Waiting after prerequisite", {
      agentId: worker.id,
      dependsOn: [prerequisite.id],
    });
    setCreatedAt(blocked.id, "2026-08-17T12:00:00.000Z");
    getDb().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ?, lastUpdatedAt = ? WHERE id = ?",
      ["2026-08-17T16:00:00.000Z", "2026-08-17T16:00:00.000Z", prerequisite.id],
    );

    updateTaskVcs(prerequisite.id, {
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1177,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/1177",
    });

    const snapshot = getQueueStallSnapshot(NOW);
    expect(snapshot.oldestTaskId).toBe(blocked.id);
    expect(snapshot.oldestAgeMs).toBe(60 * 60 * 1000);
    expect(isQueueStalled(snapshot)).toBe(true);
  });

  test("excludes pending tasks whose dependencies are not complete", () => {
    const worker = createAgent({ name: "worker", isLead: false, status: "idle" });
    const prerequisite = createTaskExtended("Prerequisite", { agentId: worker.id });
    const blocked = createTaskExtended("Blocked", {
      agentId: worker.id,
      dependsOn: [prerequisite.id],
    });
    setCreatedAt(blocked.id, "2026-08-17T12:00:00.000Z");

    const snapshot = getQueueStallSnapshot(NOW);

    expect(snapshot.claimableCount).toBe(1);
    expect(snapshot.oldestTaskId).toBe(prerequisite.id);
  });

  test("reports direct and pool pickup transitions as diagnostic context", () => {
    const worker = createAgent({ name: "worker", isLead: false, status: "idle" });
    const task = createTaskExtended("Queued", { agentId: worker.id });
    getDb().run(
      `INSERT INTO agent_log (id, eventType, taskId, agentId, oldValue, newValue, createdAt)
       VALUES (?, 'task_status_change', ?, ?, 'pending', 'in_progress', ?)`,
      [crypto.randomUUID(), task.id, worker.id, "2026-08-17T16:50:00.000Z"],
    );
    getDb().run(
      `INSERT INTO agent_log (id, eventType, taskId, agentId, oldValue, newValue, createdAt)
       VALUES (?, 'task_claimed', ?, ?, 'unassigned', 'in_progress', ?)`,
      [crypto.randomUUID(), task.id, worker.id, "2026-08-17T16:55:00.000Z"],
    );

    expect(getQueueStallSnapshot(NOW).recentPickupCount).toBe(2);
  });

  test("scrubs secrets from notification failures before logging", () => {
    const token = "ghp_1234567890abcdefABCDEF1234567890ABCD";

    const output = _test.formatCheckFailure(new Error(`Slack rejected token ${token}`));

    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED:github_token]");
  });

  test("deduplicates an active alarm and sends recovery", async () => {
    const task = createTaskExtended("Old pool task");
    setCreatedAt(task.id, "2026-08-17T16:00:00.000Z");
    const notify = mock(async (_message: string) => {});

    await checkQueueStall(NOW, notify);
    await checkQueueStall(NOW, notify);
    getDb().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [task.id]);
    await checkQueueStall(NOW, notify);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[0]).toContain("queue pickup recovered");
  });
});

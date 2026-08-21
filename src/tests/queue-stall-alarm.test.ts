import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  initDb,
  updateTaskVcs,
} from "../be/db";
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

beforeEach(async () => {
  _test.resetState();
  const client = getDbClient();
  await client.run("DELETE FROM agent_log");
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM agents");
});

afterAll(async () => {
  _test.resetState();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

async function setCreatedAt(taskId: string, createdAt: string): Promise<void> {
  const client = getDbClient();
  await client.run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
    createdAt,
    createdAt,
    taskId,
  ]);
  await client.run(
    "UPDATE agent_log SET createdAt = ? WHERE taskId = ? AND eventType = 'task_created'",
    [createdAt, taskId],
  );
}

describe("queue stall alarm", () => {
  test("positive control: alerts when a claimable task is older than 30 minutes", async () => {
    const worker = await createAgent({ name: "worker", isLead: false, status: "idle" });
    const task = await createTaskExtended("Old claimable task", { agentId: worker.id });
    await setCreatedAt(task.id, "2026-08-17T16:29:59.000Z");
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
    const task = await createTaskExtended("Fresh pool task");
    await setCreatedAt(task.id, "2026-08-17T16:45:00.000Z");
    const notify = mock(async (_message: string) => {});

    const snapshot = await checkQueueStall(NOW, notify);

    expect(snapshot.claimableCount).toBe(1);
    expect(isQueueStalled(snapshot)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  test("measures queue age from a backlog task becoming claimable", async () => {
    const task = await createTaskExtended("Released backlog task");
    await setCreatedAt(task.id, "2026-08-17T12:00:00.000Z");
    const client = getDbClient();
    await client.run("UPDATE agent_tasks SET status = 'backlog' WHERE id = ?", [task.id]);
    await client.run(
      "UPDATE agent_tasks SET status = 'unassigned', lastUpdatedAt = ? WHERE id = ?",
      ["2026-08-17T16:59:00.000Z", task.id],
    );
    await client.run(
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
    const worker = await createAgent({ name: "worker", isLead: false, status: "idle" });
    const prerequisite = await createTaskExtended("Prerequisite", { agentId: worker.id });
    const blocked = await createTaskExtended("Newly unblocked", {
      agentId: worker.id,
      dependsOn: [prerequisite.id],
    });
    await setCreatedAt(blocked.id, "2026-08-17T12:00:00.000Z");
    await getDbClient().run(
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

  test("does not reset queue age when VCS metadata updates a claimable task", async () => {
    const task = await createTaskExtended("Old task with new VCS metadata");
    await setCreatedAt(task.id, "2026-08-17T16:00:00.000Z");

    await updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1177,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/1177",
    });

    const snapshot = await getQueueStallSnapshot(NOW);
    expect(snapshot.oldestAgeMs).toBe(60 * 60 * 1000);
    expect(isQueueStalled(snapshot)).toBe(true);
  });

  test("does not reset claimable age when VCS metadata updates a completed dependency", async () => {
    const worker = await createAgent({ name: "worker", isLead: false, status: "idle" });
    const prerequisite = await createTaskExtended("Completed prerequisite", { agentId: worker.id });
    const blocked = await createTaskExtended("Waiting after prerequisite", {
      agentId: worker.id,
      dependsOn: [prerequisite.id],
    });
    await setCreatedAt(blocked.id, "2026-08-17T12:00:00.000Z");
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ?, lastUpdatedAt = ? WHERE id = ?",
      ["2026-08-17T16:00:00.000Z", "2026-08-17T16:00:00.000Z", prerequisite.id],
    );

    await updateTaskVcs(prerequisite.id, {
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1177,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/1177",
    });

    const snapshot = await getQueueStallSnapshot(NOW);
    expect(snapshot.oldestTaskId).toBe(blocked.id);
    expect(snapshot.oldestAgeMs).toBe(60 * 60 * 1000);
    expect(isQueueStalled(snapshot)).toBe(true);
  });

  test("excludes pending tasks whose dependencies are not complete", async () => {
    const worker = await createAgent({ name: "worker", isLead: false, status: "idle" });
    const prerequisite = await createTaskExtended("Prerequisite", { agentId: worker.id });
    const blocked = await createTaskExtended("Blocked", {
      agentId: worker.id,
      dependsOn: [prerequisite.id],
    });
    await setCreatedAt(blocked.id, "2026-08-17T12:00:00.000Z");

    const snapshot = await getQueueStallSnapshot(NOW);

    expect(snapshot.claimableCount).toBe(1);
    expect(snapshot.oldestTaskId).toBe(prerequisite.id);
  });

  test("reports direct and pool pickup transitions as diagnostic context", async () => {
    const worker = await createAgent({ name: "worker", isLead: false, status: "idle" });
    const task = await createTaskExtended("Queued", { agentId: worker.id });
    const client = getDbClient();
    await client.run(
      `INSERT INTO agent_log (id, eventType, taskId, agentId, oldValue, newValue, createdAt)
       VALUES (?, 'task_status_change', ?, ?, 'pending', 'in_progress', ?)`,
      [crypto.randomUUID(), task.id, worker.id, "2026-08-17T16:50:00.000Z"],
    );
    await client.run(
      `INSERT INTO agent_log (id, eventType, taskId, agentId, oldValue, newValue, createdAt)
       VALUES (?, 'task_claimed', ?, ?, 'unassigned', 'in_progress', ?)`,
      [crypto.randomUUID(), task.id, worker.id, "2026-08-17T16:55:00.000Z"],
    );

    expect((await getQueueStallSnapshot(NOW)).recentPickupCount).toBe(2);
  });

  test("scrubs secrets from notification failures before logging", () => {
    const token = "ghp_1234567890abcdefABCDEF1234567890ABCD";

    const output = _test.formatCheckFailure(new Error(`Slack rejected token ${token}`));

    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED:github_token]");
  });

  test("deduplicates an active alarm and sends recovery", async () => {
    const task = await createTaskExtended("Old pool task");
    await setCreatedAt(task.id, "2026-08-17T16:00:00.000Z");
    const notify = mock(async (_message: string) => {});

    await checkQueueStall(NOW, notify);
    await checkQueueStall(NOW, notify);
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [task.id]);
    await checkQueueStall(NOW, notify);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[0]).toContain("queue pickup recovered");
  });
});

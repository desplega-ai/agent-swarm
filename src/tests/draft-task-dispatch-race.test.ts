/**
 * #1240 — a UI task with attachments is pool-claimable before its
 * attachments exist. Covers the `draft` status that closes the race:
 * created dispatch-ineligible, promoted once the upload batch settles (or
 * times out via the heartbeat sweep for an abandoned draft).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getPendingTaskForAgent,
  getTaskById,
  initDb,
  promoteAbandonedDraftTasks,
  promoteDraftTask,
} from "../be/db";

const TEST_DB_PATH = "./test-draft-task-dispatch-race.sqlite";

describe("Draft task dispatch race (#1240)", () => {
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

  beforeEach(async () => {
    await getDbClient().run("DELETE FROM agent_tasks");
    await getDbClient().run("DELETE FROM agents");
    await getDbClient().run("DELETE FROM agent_log");
  });

  test("status:'draft' wins over agentId — task lands in draft, not pending", async () => {
    const agent = await createAgent({ name: "lead-1", isLead: true, status: "idle" });
    const task = await createTaskExtended("Draft task with owner", {
      agentId: agent.id,
      status: "draft",
    });
    expect(task.status).toBe("draft");
    expect(task.agentId).toBe(agent.id);
  });

  test("status:'draft' wins over offeredTo — task lands in draft, not offered", async () => {
    const agent = await createAgent({ name: "offeree-1", isLead: false, status: "idle" });
    const task = await createTaskExtended("Draft task offered", {
      offeredTo: agent.id,
      status: "draft",
    });
    expect(task.status).toBe("draft");
  });

  test("a draft task assigned to an agent is NOT returned by getPendingTaskForAgent", async () => {
    const agent = await createAgent({ name: "lead-2", isLead: true, status: "idle" });
    await createTaskExtended("Draft task, uploads in flight", {
      agentId: agent.id,
      status: "draft",
    });

    const pending = await getPendingTaskForAgent(agent.id);
    expect(pending).toBeNull();
  });

  test("a draft task with no owner is NOT returned by pool claim", async () => {
    const agent = await createAgent({ name: "worker-1", isLead: false, status: "idle" });
    const task = await createTaskExtended("Draft task, no owner yet", {
      status: "draft",
    });

    const claimed = await claimTask(task.id, agent.id);
    expect(claimed).toBeNull();

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("draft");
    expect(stored?.agentId).toBeNull();
  });

  test("promoteDraftTask moves an owned draft to pending, then it dispatches normally", async () => {
    const agent = await createAgent({ name: "lead-3", isLead: true, status: "idle" });
    const task = await createTaskExtended("Draft task to promote", {
      agentId: agent.id,
      status: "draft",
    });

    // Not dispatch-eligible yet.
    expect(await getPendingTaskForAgent(agent.id)).toBeNull();

    const promoted = await promoteDraftTask(task.id);
    expect(promoted?.status).toBe("pending");
    expect(promoted?.agentId).toBe(agent.id);

    // Now dispatch-eligible.
    const pending = await getPendingTaskForAgent(agent.id);
    expect(pending?.id).toBe(task.id);
  });

  test("promoteDraftTask moves an unowned draft to unassigned, then pool claim succeeds", async () => {
    const worker = await createAgent({ name: "worker-2", isLead: false, status: "idle" });
    const task = await createTaskExtended("Draft task, no owner", { status: "draft" });

    expect(await claimTask(task.id, worker.id)).toBeNull();

    const promoted = await promoteDraftTask(task.id);
    expect(promoted?.status).toBe("unassigned");

    const claimed = await claimTask(task.id, worker.id);
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.agentId).toBe(worker.id);
  });

  test("promoteDraftTask moves an offered draft to offered", async () => {
    const agent = await createAgent({ name: "offeree-2", isLead: false, status: "idle" });
    const task = await createTaskExtended("Draft task, offered", {
      offeredTo: agent.id,
      status: "draft",
    });

    const promoted = await promoteDraftTask(task.id);
    expect(promoted?.status).toBe("offered");
    expect(promoted?.offeredTo).toBe(agent.id);
  });

  test("promoteDraftTask is a no-op on a task that already left draft", async () => {
    const task = await createTaskExtended("Already pending", {});
    expect(task.status).toBe("unassigned");

    const result = await promoteDraftTask(task.id);
    expect(result).toBeNull();

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("unassigned");
  });

  test("promoteAbandonedDraftTasks leaves a fresh draft untouched", async () => {
    const agent = await createAgent({ name: "lead-4", isLead: true, status: "idle" });
    const task = await createTaskExtended("Fresh draft", {
      agentId: agent.id,
      status: "draft",
    });

    const promotedCount = await promoteAbandonedDraftTasks(5);
    expect(promotedCount).toBe(0);

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("draft");
  });

  test("promoteAbandonedDraftTasks promotes a draft past the timeout", async () => {
    const agent = await createAgent({ name: "lead-5", isLead: true, status: "idle" });
    const task = await createTaskExtended("Abandoned draft (tab closed)", {
      agentId: agent.id,
      status: "draft",
    });

    // Simulate an abandoned draft — back-date lastUpdatedAt past the timeout.
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      staleTime,
      task.id,
    ]);

    const promotedCount = await promoteAbandonedDraftTasks(5);
    expect(promotedCount).toBe(1);

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("pending");

    const pending = await getPendingTaskForAgent(agent.id);
    expect(pending?.id).toBe(task.id);
  });
});

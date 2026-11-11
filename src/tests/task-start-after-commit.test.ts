import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { onTaskStarted } from "../be/task-lifecycle-events";
import type { AgentTask } from "../types";

const TEST_DB_PATH = "./test-task-start-after-commit.sqlite";
const workerId = crypto.randomUUID();
let received: AgentTask[] = [];
onTaskStarted((task) => {
  if (task.agentId === workerId) received.push(task);
});

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

describe("startTask lifecycle notifications", () => {
  beforeEach(async () => {
    closeDb();
    await removeTestDb();
    initDb(TEST_DB_PATH);
    await createAgent({ id: workerId, name: "Start Worker", isLead: false, status: "idle" });
    received = [];
  });

  afterEach(async () => {
    closeDb();
    await removeTestDb();
  });

  test("does not notify subscribers when the enclosing transaction rolls back", async () => {
    const task = await createTaskExtended("rolled back start", { agentId: workerId });

    await expect(
      getDbClient().transaction(async () => {
        await startTask(task.id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await getTaskById(task.id))?.status).toBe("pending");
    expect(received).toEqual([]);
  });

  test("notifies once after the enclosing transaction commits", async () => {
    const task = await createTaskExtended("committed start", { agentId: workerId });

    await getDbClient().transaction(async () => {
      await startTask(task.id);
      await Promise.resolve();
      expect(received).toEqual([]);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: task.id, status: "in_progress" });
  });

  test("notifies outside a transaction without repeating an existing start", async () => {
    const task = await createTaskExtended("standalone start", { agentId: workerId });

    await startTask(task.id);
    await startTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(task.id);
  });
});

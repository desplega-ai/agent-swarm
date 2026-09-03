import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  initDb,
  updateTaskClaudeSessionId,
} from "../be/db";
import { telemetry } from "../telemetry";

const TEST_DB_PATH = "./test-task-lifecycle-telemetry.sqlite";
const WORKER_ID = "bbbb0000-0000-4000-8000-000000000002";

async function flushMicrotasks(): Promise<void> {
  // The post-commit telemetry hook runs through DbClient.afterCommit and then
  // chains an async verify read, so one microtask turn no longer covers it.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

describe("task lifecycle telemetry", () => {
  let taskEventSpy: ReturnType<typeof spyOn>;
  let calls: Array<{ event: string; props: Parameters<typeof telemetry.taskEvent>[1] }>;

  beforeEach(async () => {
    closeDb();
    await removeTestDb();
    initDb(TEST_DB_PATH);
    await createAgent({ id: WORKER_ID, name: "Telemetry Worker", isLead: false, status: "idle" });

    calls = [];
    taskEventSpy = spyOn(telemetry, "taskEvent").mockImplementation((event, props) => {
      calls.push({ event, props });
    });
  });

  afterEach(async () => {
    taskEventSpy.mockRestore();
    closeDb();
    await removeTestDb();
  });

  test("emits task.created from createTaskExtended after the task is committed", async () => {
    const task = await createTaskExtended("create telemetry", {
      agentId: WORKER_ID,
      source: "mcp",
      tags: ["telemetry"],
      priority: 60,
    });

    expect(calls).toHaveLength(0);

    await flushMicrotasks();

    expect(calls).toEqual([
      {
        event: "created",
        props: {
          taskId: task.id,
          source: "mcp",
          hasParent: false,
          has_repo: false,
          priority: 60,
        },
      },
    ]);
  });

  test("does not emit task.created when an enclosing transaction rolls back", async () => {
    await expect(
      getDbClient().transaction(async () => {
        await createTaskExtended("rolled back telemetry", {
          agentId: WORKER_ID,
          source: "mcp",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    await flushMicrotasks();

    expect(calls).toHaveLength(0);
  });

  test("emits terminal lifecycle events from universal status helpers", async () => {
    const completedTask = await createTaskExtended("complete telemetry", {
      agentId: WORKER_ID,
      source: "mcp",
    });
    await flushMicrotasks();
    calls = [];

    await completeTask(completedTask.id, "done");
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: "completed",
      props: { taskId: completedTask.id, agentId: WORKER_ID },
    });
    expect(typeof calls[0]?.props.durationMs).toBe("number");

    const failedTask = await createTaskExtended("fail telemetry", {
      agentId: WORKER_ID,
      source: "mcp",
    });
    await flushMicrotasks();
    calls = [];

    await failTask(failedTask.id, "nope");
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: "failed",
      props: { taskId: failedTask.id, agentId: WORKER_ID },
    });
    expect(typeof calls[0]?.props.durationMs).toBe("number");

    const cancelledTask = await createTaskExtended("cancel telemetry", {
      agentId: WORKER_ID,
      source: "api",
    });
    await flushMicrotasks();
    calls = [];

    await cancelTask(cancelledTask.id, "not needed");
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: "cancelled",
      props: {
        taskId: cancelledTask.id,
        source: "api",
        agentId: WORKER_ID,
        previousStatus: "pending",
      },
    });
    expect(typeof calls[0]?.props.durationMs).toBe("number");
  });

  test("emits structured task provider and harness context instead of tags", async () => {
    const task = await createTaskExtended("complete telemetry with harness context", {
      agentId: WORKER_ID,
      source: "mcp",
      tags: ["telemetry"],
    });
    await updateTaskClaudeSessionId(
      task.id,
      "provider-session-1",
      "codex",
      undefined,
      "gpt-5.5",
      "stock",
      { version: "0.40.1" },
    );
    await flushMicrotasks();
    calls = [];

    await completeTask(task.id, "done");
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: "completed",
      props: {
        taskId: task.id,
        source: "mcp",
        agentId: WORKER_ID,
        provider: "codex",
        harnessVariant: "stock",
        harnessVersion: "0.40.1",
      },
    });
    expect(calls[0]?.props.tags).toBeUndefined();
  });
});

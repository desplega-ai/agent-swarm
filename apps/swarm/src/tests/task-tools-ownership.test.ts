import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";
import { cancelTaskHandler } from "../tools/cancel-task";
import { getTaskDetailsHandler } from "../tools/get-task-details";
import { taskActionHandler } from "../tools/task-action";
import { ownerCtx, userCtx } from "../tools/task-tool-ctx";

const TEST_DB_PATH = "./test-task-tools-ownership.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch {}
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM agents").run();
  db.prepare("DELETE FROM users").run();
});

function expectForbidden(result: Awaited<ReturnType<typeof getTaskDetailsHandler>>): void {
  expect(result.isError).toBe(true);
  expect(result.content[0]?.type).toBe("text");
  expect(result.content[0]?.text).toContain("this task is not yours");
  expect((result.structuredContent as { code?: string })?.code).toBe("forbidden");
}

describe("ownership-gated task tools", () => {
  test("getTaskDetailsHandler gates user ctx and leaves owner ctx visible", async () => {
    const owner = createUser({ name: "Task Owner" });
    const foreignUser = createUser({ name: "Foreign User" });
    const task = createTaskExtended("owned details", { requestedByUserId: owner.id });

    expectForbidden(await getTaskDetailsHandler(userCtx(foreignUser), { taskId: task.id }));

    const userResult = await getTaskDetailsHandler(userCtx(owner), { taskId: task.id });
    expect(
      (userResult.structuredContent as { success: boolean; task?: { id: string } }).success,
    ).toBe(true);
    expect((userResult.structuredContent as { task?: { id: string } }).task?.id).toBe(task.id);

    const ownerResult = await getTaskDetailsHandler(
      ownerCtx({
        agentId: "00000000-0000-4000-8000-000000000001",
      }),
      { taskId: task.id },
    );
    expect((ownerResult.structuredContent as { success: boolean }).success).toBe(true);
  });

  test("cancelTaskHandler gates user ctx and preserves owner lead permission", async () => {
    const owner = createUser({ name: "Cancel Owner" });
    const foreignUser = createUser({ name: "Cancel Foreign" });
    const task = createTaskExtended("owned cancellation", { requestedByUserId: owner.id });

    expectForbidden(
      await cancelTaskHandler(userCtx(foreignUser), {
        taskId: task.id,
        reason: "foreign attempt",
      }),
    );
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    const userResult = await cancelTaskHandler(userCtx(owner), {
      taskId: task.id,
      reason: "owned cancel",
    });
    expect(
      (userResult.structuredContent as { success: boolean; task?: { status: string } }).success,
    ).toBe(true);
    expect((userResult.structuredContent as { task?: { status: string } }).task?.status).toBe(
      "cancelled",
    );

    const lead = createAgent({ name: "lead", isLead: true, status: "idle", maxTasks: 1 });
    const leadTask = createTaskExtended("lead cancellation");
    const ownerResult = await cancelTaskHandler(ownerCtx({ agentId: lead.id }), {
      taskId: leadTask.id,
      reason: "lead cancel",
    });
    expect((ownerResult.structuredContent as { success: boolean }).success).toBe(true);
  });

  test("taskActionHandler gates user backlog moves and rejects agent-only actions", async () => {
    const owner = createUser({ name: "Backlog Owner" });
    const foreignUser = createUser({ name: "Backlog Foreign" });
    const task = createTaskExtended("owned backlog move", { requestedByUserId: owner.id });

    expectForbidden(
      await taskActionHandler(userCtx(foreignUser), {
        action: "to_backlog",
        taskId: task.id,
      }),
    );
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    const toBacklog = await taskActionHandler(userCtx(owner), {
      action: "to_backlog",
      taskId: task.id,
    });
    expect(
      (toBacklog.structuredContent as { success: boolean; task?: { status: string } }).success,
    ).toBe(true);
    expect((toBacklog.structuredContent as { task?: { status: string } }).task?.status).toBe(
      "backlog",
    );

    const fromBacklog = await taskActionHandler(userCtx(owner), {
      action: "from_backlog",
      taskId: task.id,
    });
    expect(
      (fromBacklog.structuredContent as { success: boolean; task?: { status: string } }).success,
    ).toBe(true);
    expect((fromBacklog.structuredContent as { task?: { status: string } }).task?.status).toBe(
      "unassigned",
    );

    const rejected = await taskActionHandler(userCtx(owner), {
      action: "create",
      task: "duplicate create path",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.type).toBe("text");
    expect(rejected.content[0]?.text).toContain("only available to worker agents");
  });

  test("taskActionHandler owner ctx preserves worker release behavior", async () => {
    const worker = createAgent({ name: "worker", isLead: false, status: "idle", maxTasks: 1 });
    const task = createTaskExtended("assigned task", { agentId: worker.id });

    const result = await taskActionHandler(ownerCtx({ agentId: worker.id }), {
      action: "release",
      taskId: task.id,
    });

    expect(
      (result.structuredContent as { success: boolean; task?: { status: string } }).success,
    ).toBe(true);
    expect((result.structuredContent as { task?: { status: string } }).task?.status).toBe(
      "unassigned",
    );
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { ownerCtx, type ToolCtx, userCtx } from "../tools/task-tool-ctx";
import { finalizeSwarmToolResult } from "../tools/utils";

// Handlers now return the raw SwarmToolResult contract (src/tools/utils.ts);
// the registrar composes the wire CallToolResult via finalizeSwarmToolResult.
// These tests exercise handlers directly, so they run the same finalize step
// the registrar would, to assert against the real wire shape (isError,
// content[0].text, structuredContent) the model/harness actually sees.
async function callGetTaskDetails(
  ctx: ToolCtx,
  args: Parameters<typeof getTaskDetailsHandler>[1],
): Promise<CallToolResult> {
  return finalizeSwarmToolResult("get-task-details", await getTaskDetailsHandler(ctx, args));
}

async function callCancelTask(
  ctx: ToolCtx,
  args: Parameters<typeof cancelTaskHandler>[1],
): Promise<CallToolResult> {
  return finalizeSwarmToolResult("cancel-task", await cancelTaskHandler(ctx, args));
}

async function callTaskAction(
  ctx: ToolCtx,
  args: Parameters<typeof taskActionHandler>[1],
): Promise<CallToolResult> {
  return finalizeSwarmToolResult("task-action", await taskActionHandler(ctx, args));
}

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

function expectForbidden(result: CallToolResult): void {
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

    expectForbidden(await callGetTaskDetails(userCtx(foreignUser), { taskId: task.id }));

    const userResult = await callGetTaskDetails(userCtx(owner), { taskId: task.id });
    expect(
      (userResult.structuredContent as { success: boolean; task?: { id: string } }).success,
    ).toBe(true);
    expect((userResult.structuredContent as { task?: { id: string } }).task?.id).toBe(task.id);

    const ownerResult = await callGetTaskDetails(
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
      await callCancelTask(userCtx(foreignUser), {
        taskId: task.id,
        reason: "foreign attempt",
      }),
    );
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    const userResult = await callCancelTask(userCtx(owner), {
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
    const ownerResult = await callCancelTask(ownerCtx({ agentId: lead.id }), {
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
      await callTaskAction(userCtx(foreignUser), {
        action: "to_backlog",
        taskId: task.id,
      }),
    );
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    const toBacklog = await callTaskAction(userCtx(owner), {
      action: "to_backlog",
      taskId: task.id,
    });
    expect(
      (toBacklog.structuredContent as { success: boolean; task?: { status: string } }).success,
    ).toBe(true);
    expect((toBacklog.structuredContent as { task?: { status: string } }).task?.status).toBe(
      "backlog",
    );

    const fromBacklog = await callTaskAction(userCtx(owner), {
      action: "from_backlog",
      taskId: task.id,
    });
    expect(
      (fromBacklog.structuredContent as { success: boolean; task?: { status: string } }).success,
    ).toBe(true);
    expect((fromBacklog.structuredContent as { task?: { status: string } }).task?.status).toBe(
      "unassigned",
    );

    const rejected = await callTaskAction(userCtx(owner), {
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

    const result = await callTaskAction(ownerCtx({ agentId: worker.id }), {
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

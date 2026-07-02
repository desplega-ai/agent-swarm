import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createTaskExtended, createUser, getTaskById, initDb } from "../be/db";
import { getTasksHandler } from "../tools/get-tasks";
import { sendTaskHandler } from "../tools/send-task";
import { assertOwnsTask, ownerCtx, userCtx } from "../tools/task-tool-ctx";

const TEST_DB_PATH = "./test-task-tools-ctx.sqlite";

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("task tool ctx", () => {
  test("sendTaskHandler with user ctx writes requestedByUserId", async () => {
    const user = createUser({ name: "MCP User" });

    const result = await sendTaskHandler(userCtx(user), {
      task: "user requested task",
      offerMode: false,
      allowDuplicate: false,
    });

    const structured = result.structuredContent as {
      success: boolean;
      task: { id: string; requestedByUserId?: string };
    };
    expect(structured.success).toBe(true);
    expect(structured.task.requestedByUserId).toBe(user.id);

    const stored = getTaskById(structured.task.id);
    expect(stored?.creatorAgentId).toBeUndefined();
    expect(stored?.requestedByUserId).toBe(user.id);
  });

  test("getTasksHandler with user ctx only returns that user's tasks", async () => {
    const userA = createUser({ name: "List User A" });
    const userB = createUser({ name: "List User B" });

    const a1 = createTaskExtended("owned task one", { requestedByUserId: userA.id });
    const a2 = createTaskExtended("owned task two", { requestedByUserId: userA.id });
    const b1 = createTaskExtended("foreign task", { requestedByUserId: userB.id });
    createTaskExtended("owner-only task");

    const result = await getTasksHandler(userCtx(userA), {
      includeFull: true,
      includeHeartbeat: true,
      limit: 50,
      mineOnly: true,
      offeredToMe: true,
    });

    const structured = result.structuredContent as {
      tasks: Array<{ id: string; task?: string }>;
    };
    const ids = structured.tasks.map((task) => task.id);
    expect(ids).toContain(a1.id);
    expect(ids).toContain(a2.id);
    expect(ids).not.toContain(b1.id);
    expect(structured.tasks.every((task) => task.task?.startsWith("owned task"))).toBe(true);
  });

  test("assertOwnsTask gates user tasks and allows owned or owner ctx", () => {
    const owner = createUser({ name: "Task Owner" });
    const foreignUser = createUser({ name: "Foreign User" });
    const ownedTask = createTaskExtended("owned", { requestedByUserId: owner.id });

    expect(assertOwnsTask(userCtx(owner), ownedTask)).toBeNull();
    expect(
      assertOwnsTask(
        ownerCtx({
          agentId: "00000000-0000-4000-8000-000000000001",
          sourceTaskId: undefined,
          sessionId: "session-1",
        }),
        ownedTask,
      ),
    ).toBeNull();

    const forbidden = assertOwnsTask(userCtx(foreignUser), ownedTask);
    expect(forbidden?.isError).toBe(true);
    expect(forbidden?.content[0]?.type).toBe("text");
    expect(forbidden?.content[0]?.text).toContain("this task is not yours");
    expect((forbidden?.structuredContent as { code?: string })?.code).toBe("forbidden");
  });
});

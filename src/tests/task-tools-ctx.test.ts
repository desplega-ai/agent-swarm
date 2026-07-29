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

    // NEW CONTRACT: handlers return a SwarmToolResult ({ ok, message, data }),
    // not a wire-level CallToolResult with structuredContent — the registrar
    // composes structuredContent (data spread + success/message) only at the
    // registerTool boundary, not inside the handler itself.
    expect(result.ok).toBe(true);
    const data = result.data as { task: { id: string; requestedByUserId?: string } };
    expect(data.task.requestedByUserId).toBe(user.id);

    const stored = getTaskById(data.task.id);
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

    expect(result.ok).toBe(true);
    const data = result.data as { tasks: Array<{ id: string; task?: string }> };
    const ids = data.tasks.map((task) => task.id);
    expect(ids).toContain(a1.id);
    expect(ids).toContain(a2.id);
    expect(ids).not.toContain(b1.id);
    expect(data.tasks.every((task) => task.task?.startsWith("owned task"))).toBe(true);
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

    // NEW CONTRACT: assertOwnsTask returns a SwarmToolResult | null, not a wire
    // CallToolResult — isError/content/structuredContent are only synthesized
    // by finalizeSwarmToolResult at the registrar boundary. Assert ok:false +
    // the real error text in `message` + the payload under `data`.
    const forbidden = assertOwnsTask(userCtx(foreignUser), ownedTask);
    expect(forbidden?.ok).toBe(false);
    expect(forbidden?.message).toContain("this task is not yours");
    expect((forbidden?.data as { code?: string })?.code).toBe("forbidden");
  });
});

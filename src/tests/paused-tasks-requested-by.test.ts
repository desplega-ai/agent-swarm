import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  initDb,
  pauseTask,
  startTask,
} from "../be/db";
import { handleTasks } from "../http/tasks";

const TEST_DB_PATH = "./test-paused-tasks-requested-by.sqlite";
const AGENT_ID = "50000000-0000-4000-8000-000000000001";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function getPausedTasks(): Promise<{
  status: number;
  body: { tasks: Array<{ id: string; requestedBy?: Record<string, unknown> }> };
}> {
  let status = 200;
  let bodyStr = "";
  const req = {
    method: "GET",
    url: "/api/paused-tasks",
    headers: { "x-agent-id": AGENT_ID },
  } as unknown as Parameters<typeof handleTasks>[0];
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(body?: string) {
      bodyStr = body ?? "";
    },
  } as unknown as Parameters<typeof handleTasks>[1];
  const handled = await handleTasks(
    req,
    res,
    ["api", "paused-tasks"],
    new URLSearchParams(),
    AGENT_ID,
  );
  if (!handled) throw new Error("handleTasks did not handle the request");
  return { status, body: JSON.parse(bodyStr) };
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await createAgent({ id: AGENT_ID, name: "Paused Worker", isLead: false, status: "idle" });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("GET /api/paused-tasks requester projection", () => {
  test("carries the same requestedBy a task_assigned trigger carries", async () => {
    const user = await createUser({
      name: "Paused Requester",
      email: "paused@example.com",
      role: "CTO",
      notes: "Paused requester notes",
    });
    const withUser = await createTaskExtended("Paused task with requester", {
      agentId: AGENT_ID,
      requestedByUserId: user.id,
    });
    const withoutUser = await createTaskExtended("Paused task without requester", {
      agentId: AGENT_ID,
    });
    for (const task of [withUser, withoutUser]) {
      await startTask(task.id);
      expect(await pauseTask(task.id)).not.toBeNull();
    }

    const { status, body } = await getPausedTasks();
    expect(status).toBe(200);
    const byId = new Map(body.tasks.map((task) => [task.id, task]));
    expect(byId.get(withUser.id)?.requestedBy).toMatchObject({
      id: user.id,
      name: "Paused Requester",
      email: "paused@example.com",
      role: "CTO",
      notes: "Paused requester notes",
    });
    expect(byId.get(withoutUser.id)).toBeDefined();
    expect(byId.get(withoutUser.id)?.requestedBy).toBeUndefined();
  });
});

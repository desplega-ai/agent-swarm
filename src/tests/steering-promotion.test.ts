import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer } from "node:http";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  failTask,
  getChildTasks,
  getDbClient,
  getSteeringMessagesForTask,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { buildResumeContextPreamble } from "../commands/context-preamble";
import { codeLevelTriage } from "../heartbeat/heartbeat";

const TEST_DB_PATH = `./test-steering-promotion-${process.pid}.sqlite`;

describe("steering promotion on terminal tasks", () => {
  let agentId: string;

  const originalSteeringEnabled = process.env.STEERING_ENABLED;

  beforeAll(async () => {
    process.env.STEERING_ENABLED = "true";
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    closeDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    if (originalSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
    else process.env.STEERING_ENABLED = originalSteeringEnabled;
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  beforeEach(async () => {
    const client = getDbClient();
    await client.run("DELETE FROM task_steering_messages");
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM agents");
    await client.run("DELETE FROM active_sessions");
    agentId = (await createAgent({ name: "steering worker", isLead: false, status: "busy" })).id;
  });

  async function taskWithPendingSteer(
    body: string,
    options?: { followUpConfig?: { disabled: boolean } },
  ) {
    const task = await createTaskExtended("terminal steering parent", {
      agentId,
      followUpConfig: options?.followUpConfig,
    });
    expect((await startTask(task.id))?.status).toBe("in_progress");
    const message = await createSteeringMessage({
      taskId: task.id,
      body,
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });
    return { task, message };
  }

  test.each([
    ["cancelled", async (id: string) => await cancelTask(id)],
    ["completed", async (id: string) => await completeTask(id, "done")],
    ["failed", async (id: string) => await failTask(id, "broken")],
  ])("promotes pending steering when a task is %s", async (_status, transition) => {
    const { task, message } = await taskWithPendingSteer("preserve this instruction");

    expect((await transition(task.id))?.status).toBe(_status);
    const [promoted] = await getSteeringMessagesForTask(task.id);
    expect(promoted).toMatchObject({ id: message.id, status: "promoted" });
    expect(promoted?.promotedTaskId).toBeDefined();
    expect(await getTaskById(promoted!.promotedTaskId!)).toMatchObject({
      parentTaskId: task.id,
      task: "preserve this instruction",
      taskType: "follow-up",
    });
  });

  test("promotion bypasses disabled follow-up configuration", async () => {
    const { task } = await taskWithPendingSteer("must still be followed", {
      followUpConfig: { disabled: true },
    });

    expect((await completeTask(task.id, "done"))?.status).toBe("completed");
    expect(await getChildTasks(task.id)).toContainEqual(
      expect.objectContaining({ task: "must still be followed", taskType: "follow-up" }),
    );
  });

  test("failTask promotion is re-entrancy-safe and does not create a follow-up loop", async () => {
    const { task } = await taskWithPendingSteer("do not lose this steer");

    expect((await failTask(task.id, "worker failed"))?.status).toBe("failed");
    const [promoted] = await getSteeringMessagesForTask(task.id);
    const followUp = await getTaskById(promoted!.promotedTaskId!);
    expect(followUp).toMatchObject({ taskType: "follow-up" });

    expect((await failTask(followUp!.id, "follow-up failed"))?.status).toBe("failed");
    expect(await getChildTasks(followUp!.id)).toEqual([]);
    expect(await getSteeringMessagesForTask(task.id)).toEqual([
      expect.objectContaining({ status: "promoted", promotedTaskId: followUp!.id }),
    ]);
  });

  test("fresh steering defers a stalled task only until the grace window expires", async () => {
    const { task, message } = await taskWithPendingSteer("wait for this steering");
    const staleTaskTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      staleTaskTime,
      task.id,
    ]);

    const duringGrace = await codeLevelTriage();
    expect(duringGrace.autoResumedTasks).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");

    const expiredSteeringTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE task_steering_messages SET created_at = ? WHERE id = ?", [
      expiredSteeringTime,
      message.id,
    ]);
    const afterGrace = await codeLevelTriage();

    expect(afterGrace.autoResumedTasks).toHaveLength(1);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
    expect(await getSteeringMessagesForTask(task.id)).toEqual([
      expect.objectContaining({
        id: message.id,
        status: "promoted",
        promotedTaskId: expect.any(String),
      }),
    ]);
  });

  test("resume preambles include pending and promoted steering fetched over HTTP", async () => {
    const parentId = crypto.randomUUID();
    let steeringRequestUrl = "";
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      if (url === `/api/tasks/${parentId}`) {
        res.end(JSON.stringify({ id: parentId, task: "original task", attachments: [] }));
        return;
      }
      if (url.startsWith(`/api/tasks/${parentId}/session-logs`)) {
        res.end(JSON.stringify({ logs: [] }));
        return;
      }
      if (url.startsWith(`/api/tasks/${parentId}/steering-messages`)) {
        steeringRequestUrl = url;
        res.end(
          JSON.stringify({
            messages: [
              {
                body: "finish the migration before reporting success",
                status: "pending",
                createdAt: "2026-07-27T10:00:00.000Z",
              },
              {
                body: "do not abandon the failing test",
                status: "promoted",
                createdAt: "2026-07-27T10:01:00.000Z",
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not listen");

    try {
      const preamble = await buildResumeContextPreamble(
        `http://127.0.0.1:${address.port}`,
        "",
        parentId,
      );
      expect(steeringRequestUrl).toBe(
        `/api/tasks/${parentId}/steering-messages?status=pending,promoted`,
      );
      expect(preamble).toContain("### Undelivered Steering Messages");
      expect(preamble).toContain("finish the migration before reporting success");
      expect(preamble).toContain("do not abandon the failing test");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

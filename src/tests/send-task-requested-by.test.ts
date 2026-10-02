import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { linearContextKey } from "../tasks/context-key";
import { registerSendTaskTool } from "../tools/send-task";

const TEST_DB_PATH = "./test-send-task-requested-by.sqlite";

const LEAD_ID = "11111111-1111-4111-a111-111111111111";
const WORKER_ID = "22222222-2222-4222-a222-222222222222";

let userAId: string;
let userBId: string;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const headers: Record<string, string> = { "x-agent-id": callerAgentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers },
  };
  return tool.handler(args, extra);
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    task?: { id: string; requestedByUserId?: string };
    message: string;
  };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Test Lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "Test Worker", isLead: false, status: "idle" });
  userAId = (await createUser({ name: "User A", email: "user-a@example.com" })).id;
  userBId = (await createUser({ name: "User B", email: "user-b@example.com" })).id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("send-task: requestedByUserId inheritance", () => {
  const server = new McpServer({ name: "test-send-task", version: "1.0.0" });
  registerSendTaskTool(server);
  const requesterWasInherited = async (taskId: string): Promise<number | undefined> =>
    (
      await getDbClient().get<{ inherited: number }>(
        "SELECT requestedByUserIdInherited AS inherited FROM agent_tasks WHERE id = ?",
        [taskId],
      )
    )?.inherited;

  test("child pool task inherits requestedByUserId from caller's sourceTaskId", async () => {
    // Parent task has no agentId so the auto-route won't force a lead assignment.
    const parentTask = await createTaskExtended("parent pool task", {
      requestedByUserId: userAId,
    });

    const result = await callSendTask(
      server,
      { task: "child pool task — inherit", allowDuplicate: true },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    expect(s.task).toBeDefined();
    const created = await getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBe(userAId);
    expect(await requesterWasInherited(s.task!.id)).toBe(1);
  });

  test("explicit requestedByUserId in args wins over inherited value", async () => {
    const parentTask = await createTaskExtended("parent with user A", {
      requestedByUserId: userAId,
    });

    const result = await callSendTask(
      server,
      { task: "child with override user B", requestedByUserId: userBId, allowDuplicate: true },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBe(userBId);
    expect(await requesterWasInherited(s.task!.id)).toBe(0);
  });

  test("no crash when caller has no sourceTaskId and no requestedByUserId arg", async () => {
    const result = await callSendTask(
      server,
      { task: "anonymous task — no requester", allowDuplicate: true },
      LEAD_ID,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBeFalsy();
  });

  test("direct assignment to worker inherits requestedByUserId from caller's sourceTaskId", async () => {
    // Parent assigned to WORKER so auto-route would pick WORKER, but we pass agentId explicitly.
    const parentTask = await createTaskExtended("parent for direct assign", {
      requestedByUserId: userAId,
    });

    const result = await callSendTask(
      server,
      {
        task: "worker direct assign — inherit user",
        agentId: WORKER_ID,
        routingReason: "human_pinned",
        routingNote: "This test explicitly selects the target worker",
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBe(userAId);
    expect(await requesterWasInherited(s.task!.id)).toBe(1);
  });

  test("Linear tracker holder delegates two children in a row", async () => {
    for (const variant of ["implicit", "explicit-key", "explicit-parent"]) {
      const parentTask = await createTaskExtended("linear source task", {
        requestedByUserId: userAId,
        contextKey: linearContextKey({ issueIdentifier: `DES-203-${variant}` }),
      });
      const args =
        variant === "explicit-key"
          ? { key: "shared/linear-child/" }
          : variant === "explicit-parent"
            ? { parentTaskId: parentTask.id }
            : {};
      const result = await callSendTask(
        server,
        { task: "delegated linear child", allowDuplicate: true, ...args },
        LEAD_ID,
        parentTask.id,
      );
      const s = structuredOf(result);
      expect(s.success).toBe(true);
      expect(s.task?.id).not.toBe(parentTask.id);
      const created = await getTaskById(s.task!.id);
      expect(created?.parentTaskId).toBe(parentTask.id);
      const second = structuredOf(
        await callSendTask(
          server,
          { task: "second linear child", allowDuplicate: true, ...args },
          LEAD_ID,
          parentTask.id,
        ),
      );
      expect(second.success).toBe(true);
      expect(second.task?.id).not.toBe(s.task?.id);
      expect((await getTaskById(second.task!.id))?.parentTaskId).toBe(parentTask.id);
    }
  });

  test("Linear tracker child delegates a grandchild while the holder is active", async () => {
    const holder = await createTaskExtended("active holder", {
      contextKey: linearContextKey({ issueIdentifier: "DES-206" }),
    });
    const child = structuredOf(
      await callSendTask(server, { task: "child", allowDuplicate: true }, LEAD_ID, holder.id),
    );
    expect(child.success).toBe(true);
    const grandchild = structuredOf(
      await callSendTask(
        server,
        { task: "grandchild", allowDuplicate: true },
        LEAD_ID,
        child.task!.id,
      ),
    );
    expect(grandchild.success).toBe(true);
    expect((await getTaskById(grandchild.task!.id))?.parentTaskId).toBe(child.task!.id);
  });

  test("Linear tracker holder delegates after its completed child links an open PR", async () => {
    const holder = await createTaskExtended("holder awaiting review", {
      contextKey: linearContextKey({ issueIdentifier: "DES-207" }),
    });
    const child = structuredOf(
      await callSendTask(
        server,
        { task: "implementation", allowDuplicate: true },
        LEAD_ID,
        holder.id,
      ),
    );
    expect(child.success).toBe(true);
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'completed', vcsProvider = 'github', vcsRepo = 'desplega-ai/agent-swarm', vcsNumber = 875, vcsUrl = 'https://github.com/desplega-ai/agent-swarm/pull/875' WHERE id = ?",
      [child.task!.id],
    );
    const review = structuredOf(
      await callSendTask(
        server,
        { task: "review implementation", allowDuplicate: true },
        LEAD_ID,
        holder.id,
      ),
    );
    expect(review.success).toBe(true);
    expect((await getTaskById(review.task!.id))?.parentTaskId).toBe(holder.id);
  });

  test("Linear tracker delegation skips a different active task on the same key", async () => {
    const key = linearContextKey({ issueIdentifier: "DES-204" });
    const other = await createTaskExtended("other active linear task", { contextKey: key });
    const parent = await createTaskExtended("delegating linear holder");
    // Fixture bypasses creation dedup to represent two existing holders.
    await getDbClient().run("UPDATE agent_tasks SET contextKey = ? WHERE id = ?", [key, parent.id]);
    const before = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_tasks",
    );

    const result = await callSendTask(
      server,
      { task: "blocked linear child", allowDuplicate: true },
      LEAD_ID,
      parent.id,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("already has active task");
    expect(s.task?.id).toBe(other.id);
    expect(await getDbClient().get("SELECT COUNT(*) AS count FROM agent_tasks")).toEqual(before);
  });

  test("Linear tracker completed task with an unrelated linked PR blocks delegation", async () => {
    const key = linearContextKey({ issueIdentifier: "DES-205" });
    const parent = await createTaskExtended("linear holder with linked PR", {
      contextKey: key,
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 875,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/875",
    });
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [
      parent.id,
    ]);
    const unrelated = await createTaskExtended("unrelated caller");
    await getDbClient().run("UPDATE agent_tasks SET contextKey = ? WHERE id = ?", [
      key,
      unrelated.id,
    ]);
    const before = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_tasks",
    );

    const result = await callSendTask(
      server,
      { task: "blocked child after PR", allowDuplicate: true },
      LEAD_ID,
      unrelated.id,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("already has linked open PR");
    expect(s.task?.id).toBe(parent.id);
    expect(await getDbClient().get("SELECT COUNT(*) AS count FROM agent_tasks")).toEqual(before);
  });
});

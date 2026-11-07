import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getScheduledTaskByName,
  getTaskById,
  initDb,
} from "../be/db";
import { registerCreatePageTool } from "../tools/create-page";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

const server = new McpServer({ name: "caller-session-group", version: "1.0.0" });
registerCreateScheduleTool(server);
registerCreatePageTool(server);

function callTool(
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  sourceTaskId: string,
): Promise<CallToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(args, {
    sessionId: "caller-session-group",
    requestInfo: { headers: { "x-agent-id": agentId, "x-source-task-id": sourceTaskId } },
  });
}

let leadId: string;
let workerId: string;
let userId: string;

beforeAll(async () => {
  initDb(":memory:");
  leadId = (await createAgent({ name: "group-lead", isLead: true, status: "busy" })).id;
  workerId = (await createAgent({ name: "group-worker", isLead: false, status: "busy" })).id;
  userId = (await createUser({ name: "Use case owner" })).id;
});

afterAll(() => closeDb());

/** An Inbox planning session: a root with its default key and a child that inherits it. */
async function inboxSession() {
  const root = await createTaskExtended("Track our competitors twice a week", {
    agentId: leadId,
    source: "ui",
    requestedByUserId: userId,
  });
  const child = await createTaskExtended("Collect the competitor list", {
    agentId: workerId,
    parentTaskId: root.id,
    key: root.key,
    requestedByUserId: userId,
  });
  return { root, child };
}

function createSchedule(key: string | undefined, agentId: string, sourceTaskId: string) {
  const name = `competitor-watch-${crypto.randomUUID()}`;
  return {
    name,
    result: callTool(
      "create-schedule",
      {
        name,
        taskTemplate: "Scan the competitors",
        intervalMs: 3_600_000,
        ...(key ? { key } : {}),
      },
      agentId,
      sourceTaskId,
    ),
  };
}

const data = (result: CallToolResult) =>
  (result.structuredContent as { data?: Record<string, unknown> } | undefined)?.data ??
  (result.structuredContent as Record<string, unknown>);

describe("an explicit group key files the caller's session into the group", () => {
  test("create-schedule moves an Inbox planning session and its chain", async () => {
    const { root, child } = await inboxSession();
    expect(root.key).toBe(`shared/task:${root.id}/`);
    const { name, result } = createSchedule("shared/competitor-watch/", leadId, root.id);
    const outcome = await result;
    expect(outcome.isError).not.toBe(true);
    expect(data(outcome).movedSessionRootId).toBe(root.id);
    expect((await getScheduledTaskByName(name))?.key).toBe("shared/competitor-watch/");
    expect((await getTaskById(root.id))?.key).toBe("shared/competitor-watch/");
    expect((await getTaskById(child.id))?.key).toBe("shared/competitor-watch/");
  });

  test("a call from a lead follow-up task moves the whole session", async () => {
    const { root, child } = await inboxSession();
    // A follow-up created with no key inherits the session's default key.
    const followUp = await createTaskExtended("Worker finished", {
      agentId: leadId,
      parentTaskId: child.id,
    });
    expect(followUp.key).toBe(root.key);
    const { result } = createSchedule("shared/from-follow-up/", leadId, followUp.id);
    expect(data(await result).movedSessionRootId).toBe(root.id);
    for (const id of [root.id, child.id, followUp.id]) {
      expect((await getTaskById(id))?.key).toBe("shared/from-follow-up/");
    }
  });

  test("create_page moves an Inbox planning session", async () => {
    const { root } = await inboxSession();
    const outcome = await callTool(
      "create_page",
      {
        title: `Competitor report ${crypto.randomUUID()}`,
        key: "shared/page-group/",
        body: "<p>ok</p>",
        contentType: "text/html",
        authMode: "authed",
      },
      leadId,
      root.id,
    );
    expect(outcome.isError).not.toBe(true);
    expect(data(outcome).movedSessionRootId).toBe(root.id);
    expect((await getTaskById(root.id))?.key).toBe("shared/page-group/");
  });

  test("a session already in a group never moves", async () => {
    const root = await createTaskExtended("Grouped planning", {
      agentId: leadId,
      requestedByUserId: userId,
      key: "shared/research/",
    });
    const { result } = createSchedule("shared/other-group/", leadId, root.id);
    expect(data(await result).movedSessionRootId).toBeUndefined();
    expect((await getTaskById(root.id))?.key).toBe("shared/research/");
  });

  test("a chain task with a key of its own keeps it", async () => {
    const { root } = await inboxSession();
    const own = await createTaskExtended("Side research", {
      agentId: workerId,
      parentTaskId: root.id,
      key: "shared/side-research/",
    });
    const { result } = createSchedule("shared/main-group/", leadId, root.id);
    expect(data(await result).movedSessionRootId).toBe(root.id);
    expect((await getTaskById(root.id))?.key).toBe("shared/main-group/");
    expect((await getTaskById(own.id))?.key).toBe("shared/side-research/");
  });

  test("an inherited key, a resource key or a task the caller does not own moves nothing", async () => {
    const inherited = await inboxSession();
    expect(
      data(await createSchedule(undefined, leadId, inherited.root.id).result).movedSessionRootId,
    ).toBeUndefined();
    expect((await getTaskById(inherited.root.id))?.key).toBe(inherited.root.key);

    const leaf = await inboxSession();
    const leafKey = "shared/schedule:abc/";
    expect(
      data(await createSchedule(leafKey, leadId, leaf.root.id).result).movedSessionRootId,
    ).toBeUndefined();
    expect((await getTaskById(leaf.root.id))?.key).toBe(leaf.root.key);

    // The worker does not own the root, so the source task header is not trusted.
    const foreign = await inboxSession();
    expect(
      data(await createSchedule("shared/spoofed/", workerId, foreign.root.id).result)
        .movedSessionRootId,
    ).toBeUndefined();
    expect((await getTaskById(foreign.root.id))?.key).toBe(foreign.root.key);
  });

  test("a worker that may not mutate the chain moves nothing", async () => {
    const otherWorker = (await createAgent({ name: "other-worker", status: "busy" })).id;
    const root = await createTaskExtended("Planning by another agent", {
      agentId: otherWorker,
      requestedByUserId: userId,
    });
    const child = await createTaskExtended("Worker step", {
      agentId: workerId,
      parentTaskId: root.id,
      key: root.key,
    });
    const { result } = createSchedule("shared/worker-group/", workerId, child.id);
    const outcome = await result;
    expect(outcome.isError).not.toBe(true);
    expect(data(outcome).movedSessionRootId).toBeUndefined();
    expect((await getTaskById(root.id))?.key).toBe(root.key);
  });
});

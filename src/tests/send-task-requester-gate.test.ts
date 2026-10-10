/**
 * A task's requester drives attribution, cost reporting and admission. A non-lead agent may omit
 * `requestedByUserId` or pass the requester of its own current task. Only a lead, the operator or
 * a user may name any other registered user. Covers the send-task tool and POST /api/tasks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
import { handleTasks } from "../http/tasks";
import { registerSendTaskTool } from "../tools/send-task";
import { type HttpRequestAuth, setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-send-task-requester-gate.sqlite";

const LEAD_ID = "aaaa4000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb4000-0000-4000-8000-000000000002";
const OTHER_WORKER_ID = "cccc4000-0000-4000-8000-000000000003";

let userAId: string;
let userBId: string;
let mcp: McpServer;
let routeServer: Server;
let routeBaseUrl: string;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  args: Record<string, unknown>,
  callerAgentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (mcp as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const headers: Record<string, string> = { "x-agent-id": callerAgentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  return tool.handler(
    { allowDuplicate: true, ...args },
    { sessionId: "s", requestInfo: { headers } },
  );
}

const structuredOf = (result: CallToolResult) =>
  result.structuredContent as {
    success: boolean;
    message: string;
    task?: { id: string; requestedByUserId?: string };
  };

const taskCount = async () =>
  (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks"))?.n;

/** The swarm API key authenticates as the operator; workers add their X-Agent-ID on top of it. */
const KEYED_REQUEST: HttpRequestAuth = { kind: "operator", fingerprint: "test-key" };

async function postTask(
  caller: { agentId?: string; sourceTaskId?: string },
  body: Record<string, unknown>,
): Promise<{ status: number; body: { id?: string; requestedByUserId?: string } }> {
  const response = await fetch(`${routeBaseUrl}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(caller.agentId ? { "X-Agent-ID": caller.agentId } : {}),
      ...(caller.sourceTaskId ? { "X-Source-Task-Id": caller.sourceTaskId } : {}),
    },
    body: JSON.stringify({ task: "created over HTTP", ...body }),
  });
  return { status: response.status, body: await response.json() };
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // not there
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Requester Lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "Requester Worker", isLead: false, status: "idle" });
  await createAgent({
    id: OTHER_WORKER_ID,
    name: "Requester Other Worker",
    isLead: false,
    status: "idle",
  });
  userAId = (await createUser({ name: "Requester A", email: "req-a@example.com" })).id;
  userBId = (await createUser({ name: "Requester B", email: "req-b@example.com" })).id;

  mcp = new McpServer({ name: "test-send-task-requester-gate", version: "1.0.0" });
  registerSendTaskTool(mcp);

  routeServer = createServer(async (req, res) => {
    setRequestAuth(req, KEYED_REQUEST);
    const url = req.url ?? "/";
    const handled = await handleTasks(
      req,
      res,
      url.split("?")[0]?.split("/").filter(Boolean) ?? [],
      new URLSearchParams(url.split("?")[1] ?? ""),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  const address = routeServer.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  routeBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    routeServer.close((error) => (error ? reject(error) : resolve())),
  );
  closeDb();
  await removeDbFiles();
});

describe("send-task tool", () => {
  test("a worker cannot name a requester other than its current task's, and nothing is created", async () => {
    const current = await createTaskExtended("worker task for A", {
      agentId: WORKER_ID,
      requestedByUserId: userAId,
    });
    const before = await taskCount();

    for (const requestedByUserId of [userBId, "f".repeat(32)]) {
      const result = await callSendTask(
        { task: "child for someone else", requestedByUserId },
        WORKER_ID,
        current.id,
      );
      expect(result.isError, requestedByUserId).toBe(true);
      expect(structuredOf(result).message).toContain("Only lead agents");
    }
    expect(await taskCount()).toBe(before);
  });

  test("a worker whose task has no requester cannot name one", async () => {
    const current = await createTaskExtended("worker task with no requester", {
      agentId: WORKER_ID,
    });
    const result = await callSendTask(
      { task: "child attributed to B", requestedByUserId: userBId },
      WORKER_ID,
      current.id,
    );
    expect(result.isError).toBe(true);
  });

  test("a source task the worker does not own gives it no requester to pass", async () => {
    const foreign = await createTaskExtended("someone else's task", {
      agentId: OTHER_WORKER_ID,
      requestedByUserId: userAId,
    });
    for (const requestedByUserId of [userAId, userBId]) {
      const result = await callSendTask(
        { task: "child borrowing a foreign requester", requestedByUserId },
        WORKER_ID,
        foreign.id,
      );
      expect(result.isError, requestedByUserId).toBe(true);
    }
  });

  test("a worker can still omit it, or pass the requester of its current task", async () => {
    const current = await createTaskExtended("worker task for A (allowed)", {
      agentId: WORKER_ID,
      requestedByUserId: userAId,
    });

    const omitted = structuredOf(
      await callSendTask({ task: "child that inherits" }, WORKER_ID, current.id),
    );
    expect(omitted.success).toBe(true);
    expect((await getTaskById(omitted.task!.id))?.requestedByUserId).toBe(userAId);

    const explicit = structuredOf(
      await callSendTask(
        { task: "child naming the same requester", requestedByUserId: userAId },
        WORKER_ID,
        current.id,
      ),
    );
    expect(explicit.success).toBe(true);
    expect((await getTaskById(explicit.task!.id))?.requestedByUserId).toBe(userAId);
  });

  test("a lead can name any registered user, and an unknown one is still rejected", async () => {
    const current = await createTaskExtended("lead task for A", {
      agentId: LEAD_ID,
      requestedByUserId: userAId,
    });
    const named = structuredOf(
      await callSendTask({ task: "child for B", requestedByUserId: userBId }, LEAD_ID, current.id),
    );
    expect(named.success).toBe(true);
    expect((await getTaskById(named.task!.id))?.requestedByUserId).toBe(userBId);

    const unknown = await callSendTask(
      { task: "child for nobody", requestedByUserId: "f".repeat(32) },
      LEAD_ID,
      current.id,
    );
    expect(unknown.isError).toBe(true);
    expect(structuredOf(unknown).message).toContain("registered user");
  });
});

describe("POST /api/tasks with an X-Agent-ID on the swarm key", () => {
  test("a worker's body requestedByUserId is not honored when it has no requester of its own", async () => {
    const result = await postTask({ agentId: WORKER_ID }, { requestedByUserId: userBId });
    expect(result.status).toBe(201);
    expect(result.body.requestedByUserId).toBeUndefined();
  });

  test("a worker's body requestedByUserId still loses to the requester of its own task", async () => {
    const owned = await createTaskExtended("worker task for A (http)", {
      agentId: WORKER_ID,
      requestedByUserId: userAId,
    });
    const result = await postTask(
      { agentId: WORKER_ID, sourceTaskId: owned.id },
      { requestedByUserId: userBId },
    );
    expect(result.status).toBe(201);
    expect(result.body.requestedByUserId).toBe(userAId);
  });

  test("the operator and a lead can still attribute a task to a registered user", async () => {
    const operator = await postTask({}, { requestedByUserId: userBId });
    expect(operator.status).toBe(201);
    expect(operator.body.requestedByUserId).toBe(userBId);

    const lead = await postTask({ agentId: LEAD_ID }, { requestedByUserId: userBId });
    expect(lead.status).toBe(201);
    expect(lead.body.requestedByUserId).toBe(userBId);
  });
});

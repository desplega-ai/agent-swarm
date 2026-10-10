import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { type IdentityActor, mintToken, revokeToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleMcp } from "../http/mcp";
import { handleMcpUser } from "../http/mcp-user";
import { handlePoll } from "../http/poll";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-mcp-user-route.sqlite";
const API_KEY = "example-test-mcp-user-key";
const ACTOR: IdentityActor = { kind: "operator", id: "test" };

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createTestServer(): Server {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const transportsUser: Record<string, StreamableHTTPServerTransport> = {};
  const mcpSessionAgents: Record<string, string> = {};
  const sessionUsers: Record<string, string> = {};

  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleMcp(req, res, transports, {}, mcpSessionAgents)) return;
    if (await handleMcpUser(req, res, transportsUser, sessionUsers)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
}

let server: Server;
let port: number;

const originalSteeringEnabled = process.env.STEERING_ENABLED;

beforeAll(async () => {
  process.env.STEERING_ENABLED = "true";
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createTestServer();
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  if (originalSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
  else process.env.STEERING_ENABLED = originalSteeringEnabled;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  // Clean slate between tests for deterministic token and task state.
  const client = getDbClient();
  await client.run("DELETE FROM user_identity_events");
  await client.run("DELETE FROM user_tokens");
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM users");
  await client.run("DELETE FROM agents");
});

function endpoint(path = "/mcp-user"): string {
  return `http://localhost:${port}${path}`;
}

function parseMcpPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const data = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    return JSON.parse(data);
  }
  return JSON.parse(trimmed);
}

async function mcpPost(
  token: string | null,
  body: Record<string, unknown>,
  sessionId?: string,
  path = "/mcp-user",
  extraHeaders?: Record<string, string>,
): Promise<{ response: Response; payload: unknown; text: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(endpoint(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? parseMcpPayload(text) : null;
  return { response, payload, text };
}

async function callPoll(agentId: string): Promise<{
  status: number;
  body: { trigger: { type: string; [key: string]: unknown } | null } | { error: string };
}> {
  let status = 200;
  let bodyStr = "";
  const req = {
    method: "GET",
    url: "/api/poll",
    headers: { "x-agent-id": agentId },
  } as unknown as Parameters<typeof handlePoll>[0];
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(body?: string) {
      bodyStr = body ?? "";
    },
  } as unknown as Parameters<typeof handlePoll>[1];

  const handled = await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
  if (!handled) throw new Error("handlePoll did not handle the request");
  return { status, body: bodyStr ? JSON.parse(bodyStr) : { trigger: null } };
}

async function initialize(
  token: string,
  path = "/mcp-user",
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const { response, text } = await mcpPost(
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test", version: "1" },
        capabilities: {},
      },
    },
    undefined,
    path,
    extraHeaders,
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error(`missing mcp-session-id from initialize response: ${text}`);
  return sessionId;
}

async function notifyInitialized(
  token: string,
  sessionId: string,
  path = "/mcp-user",
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const { response } = await mcpPost(
    token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    path,
    extraHeaders,
  );
  expect([200, 202]).toContain(response.status);
}

describe("/mcp-user auth and tool surface", () => {
  test("request to /mcp-user with no token returns 401", async () => {
    const { response } = await mcpPost(null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test", version: "1" },
        capabilities: {},
      },
    });

    expect(response.status).toBe(401);
  });

  test("request to /mcp-user with a revoked token returns 401", async () => {
    const user = await createUser({ name: "Revoked User" });
    const token = await mintToken(user.id, "revoked", ACTOR);
    await revokeToken(token.tokenId, ACTOR);

    const { response } = await mcpPost(token.plaintext, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test", version: "1" },
        capabilities: {},
      },
    });

    expect(response.status).toBe(401);
  });

  test("request to /mcp-user with a suspended user's valid token returns 401", async () => {
    const user = await createUser({ name: "Suspended User", status: "suspended" });
    const token = await mintToken(user.id, "suspended", ACTOR);

    const { response } = await mcpPost(token.plaintext, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test", version: "1" },
        capabilities: {},
      },
    });

    expect(response.status).toBe(401);
  });

  test("request with a different user token than the opening session returns 401", async () => {
    const userA = await createUser({ name: "Session A" });
    const userB = await createUser({ name: "Session B" });
    const tokenA = (await mintToken(userA.id, "a", ACTOR)).plaintext;
    const tokenB = (await mintToken(userB.id, "b", ACTOR)).plaintext;
    const sessionId = await initialize(tokenA);

    const { response } = await mcpPost(
      tokenB,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );

    expect(response.status).toBe(401);
  });

  test("valid active-user token initializes and exposes the narrow send-task schema", async () => {
    const user = await createUser({ name: "Active User" });
    const token = (await mintToken(user.id, "active", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { response, payload } = await mcpPost(
      token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );

    expect(response.status).toBe(200);
    const result = payload as {
      result: {
        tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
      };
    };
    const names = result.result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      ["cancel-task", "get-task-details", "get-tasks", "send-task", "steer-task"].sort(),
    );
    const sendTask = result.result.tools.find((tool) => tool.name === "send-task");
    expect(Object.keys(sendTask?.inputSchema.properties ?? {}).sort()).toEqual(
      ["model", "modelTier", "outputSchema", "priority", "tags", "task", "taskType"].sort(),
    );
  });

  test("send-task assigns user work to the Lead with internal routing proof", async () => {
    const lead = await createAgent({
      id: "10000000-0000-4000-8000-000000000001",
      name: "User MCP Lead",
      isLead: true,
      status: "idle",
    });
    const user = await createUser({ name: "Lead Requester" });
    const token = (await mintToken(user.id, "lead-route", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { response, payload } = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send-task", arguments: { task: "route this through the lead" } },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    const result = payload as { result: { structuredContent: { task: { id: string } } } };
    const task = await getTaskById(result.result.structuredContent.task.id);
    expect(task).toMatchObject({
      status: "pending",
      agentId: lead.id,
      requestedByUserId: user.id,
      routingReason: "skill",
      routingSource: "engine_default",
      routingNote: "User MCP ingress assigns new work to the Lead for delegation.",
    });
    expect(task?.offeredTo).toBeUndefined();
    expect(task?.routingAffinity).toBeUndefined();
  });

  test("send-task queues for a busy Lead and poll starts it after capacity returns", async () => {
    const lead = await createAgent({
      id: "10000000-0000-4000-8000-000000000002",
      name: "Busy User MCP Lead",
      isLead: true,
      status: "idle",
      maxTasks: 1,
    });
    const activeTask = await createTaskExtended("existing lead work", { agentId: lead.id });
    expect((await startTask(activeTask.id))?.status).toBe("in_progress");
    const user = await createUser({ name: "Busy Lead Requester" });
    const token = (await mintToken(user.id, "busy-lead-route", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { payload } = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send-task", arguments: { task: "wait for the busy lead" } },
      },
      sessionId,
    );

    const result = payload as { result: { structuredContent: { task: { id: string } } } };
    const task = await getTaskById(result.result.structuredContent.task.id);
    expect(task).toMatchObject({ status: "pending", agentId: lead.id });

    const blockedPoll = await callPoll(lead.id);
    expect(blockedPoll.status).toBe(200);
    if ("error" in blockedPoll.body) throw new Error("unexpected poll error");
    expect(blockedPoll.body.trigger).toBeNull();
    expect((await getTaskById(task!.id))?.status).toBe("pending");

    await completeTask(activeTask.id, "capacity returned");
    const readyPoll = await callPoll(lead.id);
    expect(readyPoll.status).toBe(200);
    if ("error" in readyPoll.body) throw new Error("unexpected poll error");
    expect(readyPoll.body.trigger?.type).toBe("task_assigned");
    expect((readyPoll.body.trigger as { taskId: string }).taskId).toBe(task?.id);
    expect((await getTaskById(task!.id))?.status).toBe("in_progress");
  });

  test("send-task refuses with no Lead and creates no task", async () => {
    const user = await createUser({ name: "Task Requester" });
    const token = (await mintToken(user.id, "task", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { response, payload } = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send-task", arguments: { task: "user mcp task" } },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    const result = payload as {
      result: { isError?: boolean; structuredContent: { success: boolean; message: string } };
    };
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent).toMatchObject({
      success: false,
      message: "No online Lead is available. Start or register a Lead before sending a task.",
    });
    expect(
      (await getDbClient().get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_tasks"))
        ?.count,
    ).toBe(0);
  });

  test("send-task refuses with only an offline Lead and creates no task", async () => {
    await createAgent({
      id: "10000000-0000-4000-8000-000000000004",
      name: "Offline User MCP Lead",
      isLead: true,
      status: "offline",
    });
    const user = await createUser({ name: "Offline Lead Requester" });
    const token = (await mintToken(user.id, "offline-lead", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { payload } = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send-task", arguments: { task: "do not queue without a Lead" } },
      },
      sessionId,
    );

    const result = payload as {
      result: { isError?: boolean; structuredContent: { success: boolean; message: string } };
    };
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent.success).toBe(false);
    expect(
      (await getDbClient().get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_tasks"))
        ?.count,
    ).toBe(0);
  });

  test("send-task preserves requester ownership and get-tasks filters foreign work", async () => {
    const lead = await createAgent({ name: "Ownership Lead", isLead: true, status: "idle" });
    const user = await createUser({ name: "Task Requester" });
    const otherUser = await createUser({ name: "Other Task Requester" });
    const token = (await mintToken(user.id, "task-ownership", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const sent = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send-task", arguments: { task: "owned user mcp task" } },
      },
      sessionId,
    );
    const sentResult = sent.payload as {
      result: { structuredContent: { task: { id: string } } };
    };
    const taskId = sentResult.result.structuredContent.task.id;
    expect(await getTaskById(taskId)).toMatchObject({
      status: "pending",
      agentId: lead.id,
      requestedByUserId: user.id,
    });
    const foreignTask = await createTaskExtended("foreign user mcp task", {
      requestedByUserId: otherUser.id,
    });
    await createTaskExtended("owner-only task");

    const listResponse = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get-tasks", arguments: { includeFull: true, limit: 50 } },
      },
      sessionId,
    );

    expect(listResponse.response.status).toBe(200);
    const listResult = listResponse.payload as {
      result: { structuredContent: { tasks: Array<{ id: string; task?: string }> } };
    };
    const ids = listResult.result.structuredContent.tasks.map((task) => task.id);
    expect(ids).toContain(taskId);
    expect(ids).not.toContain(foreignTask.id);
    expect(listResult.result.structuredContent.tasks).toHaveLength(1);
  });

  test("send-task ignores injected routing fields and keeps internal routing authoritative", async () => {
    const lead = await createAgent({
      id: "10000000-0000-4000-8000-000000000003",
      name: "Authoritative User MCP Lead",
      isLead: true,
      status: "idle",
    });
    const attacker = await createAgent({
      id: "20000000-0000-4000-8000-000000000001",
      name: "Injected Target",
      isLead: false,
      status: "idle",
    });
    const user = await createUser({ name: "Injection Requester" });
    const foreignUser = await createUser({ name: "Foreign Requester" });
    const token = (await mintToken(user.id, "routing-injection", ACTOR)).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { response, payload } = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "send-task",
          arguments: {
            task: "keep server routing authoritative",
            agentId: attacker.id,
            routingReason: "human_pinned",
            routingNote: "Injected routing note must not survive.",
            offerMode: false,
            leadOnly: true,
            allowDuplicate: true,
            requestedByUserId: foreignUser.id,
          },
        },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    const result = payload as { result: { structuredContent: { task: { id: string } } } };
    const task = await getTaskById(result.result.structuredContent.task.id);
    expect(task).toMatchObject({
      status: "pending",
      agentId: lead.id,
      requestedByUserId: user.id,
      routingReason: "skill",
      routingSource: "engine_default",
      routingNote: "User MCP ingress assigns new work to the Lead for delegation.",
    });
    expect(task?.offeredTo).toBeUndefined();
    expect(task?.routingAffinity?.leadOnly).not.toBe(true);
  });

  test("owner /mcp initialize requires a known X-Agent-ID", async () => {
    const missing = await mcpPost(
      API_KEY,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "1" },
          capabilities: {},
        },
      },
      undefined,
      "/mcp",
    );
    expect(missing.response.status).toBe(401);

    const unknown = await mcpPost(
      API_KEY,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "1" },
          capabilities: {},
        },
      },
      undefined,
      "/mcp",
      { "X-Agent-ID": "00000000-0000-4000-8000-000000000001" },
    );
    expect(unknown.response.status).toBe(401);
  });

  test("owner /mcp returns method not found for sessionless server/discover", async () => {
    const { response, payload } = await mcpPost(
      API_KEY,
      { jsonrpc: "2.0", id: 7, method: "server/discover", params: {} },
      undefined,
      "/mcp",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(payload).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: 7,
    });
  });

  test("owner /mcp path initializes with a known agent and rejects a different X-Agent-ID on the session", async () => {
    const owner = await createAgent({ name: "Owner MCP Agent", isLead: false, status: "idle" });
    const other = await createAgent({ name: "Other MCP Agent", isLead: false, status: "idle" });
    const ownerHeaders = { "X-Agent-ID": owner.id };
    const sessionId = await initialize(API_KEY, "/mcp", ownerHeaders);
    await notifyInitialized(API_KEY, sessionId, "/mcp", ownerHeaders);

    const mismatch = await mcpPost(
      API_KEY,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
      "/mcp",
      { "X-Agent-ID": other.id },
    );
    expect(mismatch.response.status).toBe(401);

    const missing = await mcpPost(
      API_KEY,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      sessionId,
      "/mcp",
    );
    expect(missing.response.status).toBe(401);

    const { response, payload } = await mcpPost(
      API_KEY,
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      sessionId,
      "/mcp",
      ownerHeaders,
    );

    expect(response.status).toBe(200);
    const result = payload as { result: { tools: Array<{ name: string }> } };
    const names = result.result.tools.map((tool) => tool.name);
    expect(names).toContain("send-task");
  });
});

describe("MCP unknown-session handling (spec: 404 so clients re-initialize)", () => {
  const UNKNOWN_SESSION = "00000000-0000-4000-8000-0000000000aa";
  const NOT_FOUND_BODY = {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  };
  const NO_SESSION_BODY = {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: No valid session ID provided" },
    id: null,
  };
  const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

  async function userToken(): Promise<string> {
    const user = await createUser({ name: "Session 404 User" });
    return (await mintToken(user.id, "s404", ACTOR)).plaintext;
  }

  async function agentHeaders(): Promise<Record<string, string>> {
    const agent = await createAgent({ name: "Session 404 Agent", isLead: false, status: "idle" });
    return { "X-Agent-ID": agent.id };
  }

  async function bareRequest(
    method: "GET" | "DELETE",
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; contentType: string | null; json: unknown }> {
    const response = await fetch(endpoint(path), { method, headers });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      json: await response.json(),
    };
  }

  test("/mcp-user POST with unknown session id returns 404 and -32001", async () => {
    const token = await userToken();
    const { response, payload } = await mcpPost(token, toolsList, UNKNOWN_SESSION);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(payload).toEqual(NOT_FOUND_BODY);
  });

  test("/mcp-user GET and DELETE with unknown session id return 404", async () => {
    const token = await userToken();
    for (const method of ["GET", "DELETE"] as const) {
      const result = await bareRequest(method, "/mcp-user", {
        Authorization: `Bearer ${token}`,
        "mcp-session-id": UNKNOWN_SESSION,
      });
      expect(result.status).toBe(404);
      expect(result.contentType).toContain("application/json");
      expect(result.json).toEqual(NOT_FOUND_BODY);
    }
  });

  test("/mcp-user POST without session id and non-initialize body returns 400 with SDK wording", async () => {
    const token = await userToken();
    const { response, payload } = await mcpPost(token, toolsList);
    expect(response.status).toBe(400);
    expect(payload).toEqual(NO_SESSION_BODY);
  });

  test("/mcp-user GET and DELETE without session id return 400 with JSON body", async () => {
    const token = await userToken();
    for (const method of ["GET", "DELETE"] as const) {
      const result = await bareRequest(method, "/mcp-user", { Authorization: `Bearer ${token}` });
      expect(result.status).toBe(400);
      expect(result.json).toEqual(NO_SESSION_BODY);
    }
  });

  test("/mcp-user initialize still works", async () => {
    const token = await userToken();
    const sessionId = await initialize(token);
    expect(sessionId.length).toBeGreaterThan(0);
  });

  test("/mcp POST with unknown session id returns 404 and -32001", async () => {
    const headers = await agentHeaders();
    const { response, payload } = await mcpPost(
      API_KEY,
      toolsList,
      UNKNOWN_SESSION,
      "/mcp",
      headers,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(payload).toEqual(NOT_FOUND_BODY);
  });

  test("/mcp GET and DELETE with unknown session id return 404", async () => {
    const headers = await agentHeaders();
    for (const method of ["GET", "DELETE"] as const) {
      const result = await bareRequest(method, "/mcp", {
        Authorization: `Bearer ${API_KEY}`,
        "mcp-session-id": UNKNOWN_SESSION,
        ...headers,
      });
      expect(result.status).toBe(404);
      expect(result.json).toEqual(NOT_FOUND_BODY);
    }
  });

  test("/mcp POST without session id and non-initialize body returns 400 with SDK wording", async () => {
    const headers = await agentHeaders();
    const { response, payload } = await mcpPost(API_KEY, toolsList, undefined, "/mcp", headers);
    expect(response.status).toBe(400);
    expect(payload).toEqual(NO_SESSION_BODY);
  });

  test("/mcp GET and DELETE without session id return 400 with JSON body", async () => {
    const headers = await agentHeaders();
    for (const method of ["GET", "DELETE"] as const) {
      const result = await bareRequest(method, "/mcp", {
        Authorization: `Bearer ${API_KEY}`,
        ...headers,
      });
      expect(result.status).toBe(400);
      expect(result.json).toEqual(NO_SESSION_BODY);
    }
  });

  test("/mcp initialize still works", async () => {
    const headers = await agentHeaders();
    const sessionId = await initialize(API_KEY, "/mcp", headers);
    expect(sessionId.length).toBeGreaterThan(0);
  });
});

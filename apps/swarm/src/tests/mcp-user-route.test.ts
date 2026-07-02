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
  createAgent,
  createTaskExtended,
  createUser,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";
import { type IdentityActor, mintToken, revokeToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleMcp } from "../http/mcp";
import { handleMcpUser } from "../http/mcp-user";

const TEST_DB_PATH = "./test-mcp-user-route.sqlite";
const API_KEY = "test-mcp-user-key";
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

async function listen(server: Server): Promise<number> {
  const port = 15173;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
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

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createTestServer();
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  // Clean slate between tests for deterministic token and task state.
  const db = getDb();
  db.run("DELETE FROM user_identity_events");
  db.run("DELETE FROM user_tokens");
  db.run("DELETE FROM agent_tasks");
  db.run("DELETE FROM users");
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
    const user = createUser({ name: "Revoked User" });
    const token = mintToken(user.id, "revoked", ACTOR);
    revokeToken(token.tokenId, ACTOR);

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
    const user = createUser({ name: "Suspended User", status: "suspended" });
    const token = mintToken(user.id, "suspended", ACTOR);

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
    const userA = createUser({ name: "Session A" });
    const userB = createUser({ name: "Session B" });
    const tokenA = mintToken(userA.id, "a", ACTOR).plaintext;
    const tokenB = mintToken(userB.id, "b", ACTOR).plaintext;
    const sessionId = await initialize(tokenA);

    const { response } = await mcpPost(
      tokenB,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );

    expect(response.status).toBe(401);
  });

  test("valid active-user token initializes and tools/list returns exactly the 5 task tools", async () => {
    const user = createUser({ name: "Active User" });
    const token = mintToken(user.id, "active", ACTOR).plaintext;
    const sessionId = await initialize(token);
    await notifyInitialized(token, sessionId);

    const { response, payload } = await mcpPost(
      token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );

    expect(response.status).toBe(200);
    const result = payload as { result: { tools: Array<{ name: string }> } };
    const names = result.result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      ["cancel-task", "get-task-details", "get-tasks", "send-task", "task-action"].sort(),
    );
  });

  test("send-task over /mcp-user records requestedByUserId and get-tasks returns only that user's tasks", async () => {
    const user = createUser({ name: "Task Requester" });
    const otherUser = createUser({ name: "Other Task Requester" });
    const token = mintToken(user.id, "task", ACTOR).plaintext;
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
    const result = payload as { result: { structuredContent: { task: { id: string } } } };
    const taskId = result.result.structuredContent.task.id;
    expect(getTaskById(taskId)?.requestedByUserId).toBe(user.id);
    const foreignTask = createTaskExtended("foreign user mcp task", {
      requestedByUserId: otherUser.id,
    });
    createTaskExtended("owner-only task");

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

  test("owner /mcp path initializes with a known agent and rejects a different X-Agent-ID on the session", async () => {
    const owner = createAgent({ name: "Owner MCP Agent", isLead: false, status: "idle" });
    const other = createAgent({ name: "Other MCP Agent", isLead: false, status: "idle" });
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  Agent,
  createServer as createHttpServer,
  request as createNodeRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createPage, createUser, initDb } from "../be/db";
import { mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleKv } from "../http/kv";
import { handleMcpBridge } from "../http/mcp-bridge";
import { handleRooms } from "../http/rooms";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { closeRooms } from "../realtime/rooms";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { registerRoomDecodeTool } from "../tools/rooms";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-realtime-room-surfaces.sqlite";
const API_KEY = "test-realtime-room-key";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
  }
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, agentId, API_KEY)) return;
    const pathSegments = getPathSegments(req.url ?? "");
    const queryParams = parseQueryParams(req.url ?? "");
    if (await handleRooms(req, res, pathSegments, queryParams)) return;
    if (await handleMcpBridge(req, res, pathSegments, queryParams, agentId)) return;
    if (await handleKv(req, res, pathSegments, queryParams)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
}

let server: Server;
let port: number;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const agent = await createAgent({ name: "room-surfaces", isLead: false, status: "idle" });
  agentId = agent.id;
  server = createTestServer();
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRooms();
  closeDb();
  await removeDbFiles();
});

function request(path: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string, authorization = `Bearer ${API_KEY}`): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    headers: { Authorization: authorization, "X-Agent-ID": agentId },
  });
}

function chunkedRequest(
  agent: Agent,
  path: string,
  chunks: readonly (string | Buffer)[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = createNodeRequest({
      host: "localhost",
      port,
      path,
      method: "POST",
      agent,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "X-Agent-ID": agentId,
      },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      const body: Buffer[] = [];
      res.on("data", (chunk) => body.push(Buffer.from(chunk)));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(body).toString() }),
      );
      res.on("error", reject);
    });
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe("realtime room REST and MCP surfaces", () => {
  test("gets, changes, resets, and decodes a room", async () => {
    const initial = await request("/api/rooms/get", { name: "board" });
    expect(initial.status).toBe(404);

    const created = await request("/api/rooms/reset", { name: "board", state: {} });
    expect(created.status).toBe(200);

    const fetched = await request("/api/rooms/get", { name: "board" });
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).room.state).toEqual({});

    const changed = await request("/api/rooms/change", {
      name: "board",
      operations: [{ type: "set", path: ["title"], value: "Planning" }],
    });
    expect(changed.status).toBe(200);
    const changedBody = await changed.json();
    expect(changedBody.room.state).toEqual({ title: "Planning" });

    const reset = await request("/api/rooms/reset", {
      name: "board",
      state: { title: "Reset" },
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.room.state).toEqual({ title: "Reset" });

    const decoded = await request("/api/rooms/decode", {
      value: {
        format: "swarm-room-v1",
        schemaVersion: resetBody.room.schemaVersion,
        generation: resetBody.room.generation,
        snapshot: resetBody.room.snapshot,
      },
    });
    expect(decoded.status).toBe(200);
    expect(await decoded.json()).toMatchObject({
      schemaVersion: 1,
      generation: resetBody.room.generation,
      state: { title: "Reset" },
    });
  });

  test("rejects generic KV writes to room snapshot keys", async () => {
    const response = await fetch(
      `http://localhost:${port}/api/kv/${encodeURIComponent("_room/board")}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({ value: "blocked" }),
      },
    );
    expect(response.status).toBe(403);
  });

  test("bounds streamed room bodies and keeps the connection usable", async () => {
    const agent = new Agent({ keepAlive: true });
    try {
      const oversized = await chunkedRequest(agent, "/api/rooms/decode", [
        '{"value":"',
        Buffer.alloc(3 * 1024 * 1024, "x"),
        '"}',
      ]);
      expect(oversized.status).toBe(413);

      const healthy = await chunkedRequest(agent, "/api/rooms/reset", [
        JSON.stringify({ name: "after-stream-overflow", state: {} }),
      ]);
      expect(healthy.status).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  test("exposes room operations through the script SDK bridge", async () => {
    const sdk = createSwarmSdk(
      new SwarmConfig({
        system: {
          apiKey: { value: API_KEY, isSecret: true },
          agentId: { value: agentId, isSecret: false },
          mcpBaseUrl: { value: `http://localhost:${port}`, isSecret: false },
        },
        user: {},
      }),
    );

    await expect(sdk.room.get({ name: "sdk-missing" })).rejects.toThrow(/not found|does not exist/);

    const reset = (await sdk.room.reset({
      name: "sdk-room",
      state: { title: "SDK" },
    })) as { state: { title: string }; snapshot: string; generation: string };
    expect(reset.state).toEqual({ title: "SDK" });

    const view = (await sdk.room.get({ name: "sdk-room" })) as typeof reset;
    expect(view.state).toEqual({ title: "SDK" });

    const changed = (await sdk.room.change({
      name: "sdk-room",
      operations: [{ type: "set", path: ["ready"], value: true }],
    })) as { state: { title: string; ready: boolean } };
    expect(changed.state).toEqual({ title: "SDK", ready: true });

    const decoded = (await sdk.room.decode({
      value: {
        format: "swarm-room-v1",
        schemaVersion: 1,
        generation: reset.generation,
        snapshot: reset.snapshot,
      },
    })) as { state: { title: string } };
    expect(decoded.state).toEqual({ title: "SDK" });

    await expect(
      sdk.room.reset({ name: "sdk-room", state: { oversized: "x".repeat(2 * 1024 * 1024) } }),
    ).rejects.toThrow();
  });

  test("allows an RBAC user to read through GET and decode without a bearer", async () => {
    const user = await createUser({ name: "Room read user" });
    const token = await mintToken(user.id, "room-read", { kind: "operator", id: "room-test" });
    const previous = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = "true";
    try {
      const reset = await request("/api/rooms/reset", {
        name: "rbac-read",
        state: { visible: true },
      });
      expect(reset.status).toBe(200);
      const resetBody = await reset.json();
      const page = await createPage({
        agentId,
        slug: "room-rbac-page",
        title: "Room RBAC page",
        contentType: "text/html",
        body: "<p>room</p>",
      });
      const pageNamespace = `task:page:${page.id}`;
      const read = await getRequest(
        `/api/rooms/get?name=rbac-read&namespace=${encodeURIComponent(`task:agent:${agentId}`)}`,
        `Bearer ${token.plaintext}`,
      );
      expect(read.status).toBe(200);
      expect((await read.json()).room.namespace).toBe(`task:agent:${agentId}`);

      const userWrite = await fetch(`http://localhost:${port}/api/rooms/change`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.plaintext}`,
          "Content-Type": "application/json",
          "X-Agent-ID": agentId,
        },
        body: JSON.stringify({
          namespace: pageNamespace,
          name: "board",
          operations: [{ type: "set", path: ["blocked"], value: true }],
        }),
      });
      expect(userWrite.status).toBe(403);

      const operatorWrite = await request("/api/rooms/change", {
        namespace: pageNamespace,
        name: "board",
        operations: [{ type: "set", path: ["operator"], value: true }],
      });
      expect(operatorWrite.status).toBe(200);

      const publicDecode = await fetch(`http://localhost:${port}/api/rooms/decode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: {
            format: "swarm-room-v1",
            schemaVersion: resetBody.room.schemaVersion,
            generation: resetBody.room.generation,
            snapshot: resetBody.room.snapshot,
          },
        }),
      });
      expect(publicDecode.status).toBe(200);
      expect((await publicDecode.json()).state).toEqual({ visible: true });
    } finally {
      if (previous === undefined) delete process.env.RBAC_ENABLED;
      else process.env.RBAC_ENABLED = previous;
    }
  });

  test("returns a structured MCP error for an invalid snapshot", async () => {
    const server = new McpServer({ name: "room-surfaces", version: "1.0.0" });
    registerRoomDecodeTool(server);
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    const result = (await registered["room-decode"]!.handler(
      { value: "invalid" },
      { sessionId: "room-test", requestInfo: { headers: { "x-agent-id": agentId } } },
    )) as { isError: boolean; structuredContent: { success: boolean; message: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toMatch(/Parse error|invalid envelope/);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, createUser, getDbClient, initDb } from "../be/db";
import { type IdentityActor, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleMcp } from "../http/mcp";
import { handleMcpUser } from "../http/mcp-user";
import { MCP_MAX_REQUEST_BODY_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from "../mcp-limits";
import { listenOnFreePort } from "./test-net";

// GHSA-46jr-4wx8-v453: both MCP surfaces must bound tools/call argument size
// and the raw HTTP body they read themselves.

const TEST_DB_PATH = "./test-mcp-input-caps.sqlite";
const API_KEY = "example-test-mcp-caps-key";
const ACTOR: IdentityActor = { kind: "operator", id: "test" };
const TOO_LARGE_MESSAGE = `Payload Too Large: Request body must not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const transportsUser: Record<string, StreamableHTTPServerTransport> = {};
  const sessionAgents: Record<string, string> = {};
  const sessionUsers: Record<string, string> = {};
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleMcp(req, res, transports, {}, sessionAgents)) return;
    if (await handleMcpUser(req, res, transportsUser, sessionUsers)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM user_tokens");
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM users");
  await client.run("DELETE FROM agents");
});

type Surface = {
  name: string;
  path: "/mcp" | "/mcp-user";
  /** Credentials headers for a fresh caller on this surface. */
  headers: () => Promise<Record<string, string>>;
  /** A tools/call that should succeed with the given extra argument members. */
  call: (extra: Record<string, unknown>) => { name: string; arguments: Record<string, unknown> };
};

const surfaces: Surface[] = [
  {
    name: "agent MCP",
    path: "/mcp",
    headers: async () => {
      const agent = await createAgent({ name: "Caps Agent", isLead: false, status: "idle" });
      return { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agent.id };
    },
    call: (extra) => ({ name: "get-swarm", arguments: { ...extra } }),
  },
  {
    name: "user MCP",
    path: "/mcp-user",
    headers: async () => {
      await createAgent({ name: "Caps Lead", isLead: true, status: "idle" });
      const user = await createUser({ name: "Caps User" });
      const token = (await mintToken(user.id, "caps", ACTOR)).plaintext;
      return { Authorization: `Bearer ${token}` };
    },
    call: (extra) => ({ name: "send-task", arguments: { task: "caps check", ...extra } }),
  },
];

function parsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return JSON.parse(
      trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n"),
    );
  }
  return JSON.parse(trimmed);
}

async function post(
  path: string,
  headers: Record<string, string>,
  body: string,
  sessionId?: string,
): Promise<{ status: number; payload: unknown; sessionId: string | null }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? parsePayload(text) : null,
    sessionId: response.headers.get("mcp-session-id"),
  };
}

async function openSession(path: string, headers: Record<string, string>): Promise<string> {
  const init = await post(
    path,
    headers,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "caps-test", version: "1" },
        capabilities: {},
      },
    }),
  );
  expect(init.status).toBe(200);
  if (!init.sessionId) throw new Error("initialize returned no mcp-session-id");
  const ack = await post(
    path,
    headers,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    init.sessionId,
  );
  expect([200, 202]).toContain(ack.status);
  return init.sessionId;
}

/** POST a body with no Content-Length (chunked), so only the streaming cap can stop it. */
function postChunked(
  path: string,
  headers: Record<string, string>,
  totalBytes: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    // The server may close the socket mid-upload after answering 413.
    req.on("error", (error) => {
      if (!req.writableFinished) return;
      reject(error);
    });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < totalBytes) {
        sent += chunk.byteLength;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

for (const surface of surfaces) {
  describe(`${surface.name} input caps`, () => {
    test("a normal tools/call passes", async () => {
      const headers = await surface.headers();
      const sessionId = await openSession(surface.path, headers);
      const { status, payload } = await post(
        surface.path,
        headers,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: surface.call({}),
        }),
        sessionId,
      );
      expect(status).toBe(200);
      const result = payload as { result?: { isError?: boolean } };
      expect(result.result).toBeDefined();
      expect(result.result?.isError).not.toBe(true);
    });

    test("a tools/call over the element limit is rejected before the handler runs", async () => {
      const headers = await surface.headers();
      const sessionId = await openSession(surface.path, headers);
      const { status, payload } = await post(
        surface.path,
        headers,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: surface.call({ tags: new Array(MCP_MAX_TOOL_INPUT_ELEMENTS + 1).fill("t") }),
        }),
        sessionId,
      );
      expect(status).toBe(200);
      const result = payload as {
        result: { isError: boolean; content: Array<{ type: string; text: string }> };
      };
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0]?.text).toContain(
        `more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`,
      );
      const tasks = await getDbClient().query<{ id: string }>("SELECT id FROM agent_tasks");
      expect(tasks).toHaveLength(0);
    });

    test("a body over the cap with Content-Length gets 413 and a JSON-RPC error", async () => {
      const headers = await surface.headers();
      const oversized = JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: surface.call({ blob: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES) }),
      });
      const { status, payload } = await post(surface.path, headers, oversized);
      expect(status).toBe(413);
      expect(payload).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: TOO_LARGE_MESSAGE },
        id: null,
      });
    });

    test("a chunked body that crosses the cap gets 413", async () => {
      const headers = await surface.headers();
      const { status, body } = await postChunked(
        surface.path,
        headers,
        MCP_MAX_REQUEST_BODY_BYTES + 128 * 1024,
      );
      expect(status).toBe(413);
      expect(JSON.parse(body)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: TOO_LARGE_MESSAGE },
        id: null,
      });
    });
  });
}

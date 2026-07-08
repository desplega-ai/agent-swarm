import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createMcpServer, getDb, initDb, upsertSwarmConfig } from "../be/db";
import {
  getScriptMcpConnectionDescriptors,
  setScriptConnectionEnabled,
  upsertScriptConnection,
} from "../be/script-connections";
import { typecheckScript } from "../be/scripts/typecheck";
import { handleCore } from "../http/core";
import { handleScriptConnectionProxy } from "../http/script-connection-proxy";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { createMcpRegistryClient } from "../scripts-runtime/mcp-client";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { registerScriptConnectionsTool } from "../tools/script-connections";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-script-connections-mcp.sqlite";
const API_KEY = "test-script-connections-mcp-key-1234567890";
const SECRET_VALUE = "mcp-secret-value-1234567890";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type ToolResult = {
  structuredContent: {
    success: boolean;
    message: string;
    connections: Array<{ id: string; slug: string; generationError?: string | null }>;
  };
};

type CapturedMcpRequest = {
  method: string | undefined;
  tool: string | undefined;
  secretHeader: string | null;
  staticHeader: string | null;
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

function scriptConnectionsTool() {
  const server = new McpServer({ name: "script-connections-mcp-test", version: "1.0.0" });
  registerScriptConnectionsTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["script-connections"];
  if (!tool) throw new Error("script-connections tool not registered");
  return tool;
}

function meta(agentId: string) {
  return {
    sessionId: "script-connections-mcp-test-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

function startFakeMcpServer(opts: { failList?: boolean } = {}) {
  const requests: CapturedMcpRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      requests.push({
        method: body.method,
        tool: body.params?.name,
        secretHeader: req.headers.get("x-test-secret"),
        staticHeader: req.headers.get("x-static-header"),
      });

      if (body.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "fake-external-mcp", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": "fake-session" } },
        );
      }
      if (body.method === "notifications/initialized") {
        return Response.json({});
      }
      if (body.method === "tools/list") {
        if (opts.failList) {
          return Response.json({ error: "list failed" }, { status: 500 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo-tool",
                description: "Echo a message",
                inputSchema: {
                  type: "object",
                  required: ["message"],
                  properties: { message: { type: "string" } },
                },
              },
            ],
          },
        });
      }
      if (body.method === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  echo: body.params?.arguments?.message,
                  secret: req.headers.get("x-test-secret"),
                }),
              },
            ],
          },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    requests,
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop() {
      server.stop(true);
    },
  };
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

async function dispatchProxyApi(url: string, init: RequestInit = {}): Promise<Response> {
  const parsedUrl = new URL(url, "http://script-connections-mcp.test");
  const headers = Object.fromEntries(
    Object.entries(headersRecord(init.headers)).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const body = init.body === undefined ? undefined : String(init.body);
  const req = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
  req.headers = headers;

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const agentId = headers["x-agent-id"];
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleScriptConnectionProxy(req, res, pathSegments, queryParams, agentId))) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function seedExternalMcpServer(url: string) {
  upsertSwarmConfig({
    scope: "global",
    key: "MCP_TEST_SECRET",
    value: SECRET_VALUE,
    isSecret: true,
  });
  return createMcpServer({
    name: `external-${crypto.randomUUID()}`,
    transport: "http",
    scope: "global",
    url,
    headers: JSON.stringify({ "X-Static-Header": "static-ok" }),
    headerConfigKeys: JSON.stringify({ "X-Test-Secret": "MCP_TEST_SECRET" }),
  });
}

let savedEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM script_connections");
  db.run("DELETE FROM agent_mcp_servers");
  db.run("DELETE FROM mcp_servers");
  db.run("DELETE FROM swarm_config");
  db.run("DELETE FROM agents");
});

describe("script MCP connections", () => {
  test("upsert-mcp generates descriptors/types and resolves header config while listing tools", async () => {
    const fake = startFakeMcpServer();
    try {
      const lead = createAgent({ name: "mcp-lead", isLead: true, status: "idle" });
      const mcpServer = seedExternalMcpServer(fake.url);
      const tool = scriptConnectionsTool();

      const result = (await tool.handler(
        {
          action: "upsert-mcp",
          slug: "external",
          displayName: "External MCP",
          mcpServerId: mcpServer.id,
        },
        meta(lead.id),
      )) as ToolResult;

      expect(result.structuredContent.success).toBe(true);
      const connection = result.structuredContent.connections.find(
        (candidate) => candidate.slug === "external",
      );
      expect(connection).toBeDefined();
      const descriptor = getScriptMcpConnectionDescriptors({ agentId: lead.id }).find(
        (candidate) => candidate.slug === "external",
      );
      expect(descriptor).toEqual(
        expect.objectContaining({
          kind: "mcp",
          connectionId: connection?.id,
          tools: [
            expect.objectContaining({
              name: "echo-tool",
              description: "Echo a message",
            }),
          ],
        }),
      );

      const row = getDb()
        .prepare<{ generated_types: string | null }, [string]>(
          "SELECT generated_types FROM script_connections WHERE id = ?",
        )
        .get(connection!.id);
      expect(row?.generated_types).toContain("export interface ExternalMcp");
      expect(row?.generated_types).toContain("echoTool(args:");
      expect(fake.requests.some((request) => request.secretHeader === SECRET_VALUE)).toBe(true);
      expect(fake.requests.some((request) => request.staticHeader === "static-ok")).toBe(true);

      const typecheck = typecheckScript(
        `
          import type { ScriptMain } from "swarm-sdk";
          const main: ScriptMain = async (_args, ctx) => {
            const result = await ctx.mcp.external.echoTool({ message: "hi" });
            return result;
          };
          export default main;
        `,
        { agentId: lead.id },
      );
      expect(typecheck).toEqual({ ok: true });
    } finally {
      fake.stop();
    }
  });

  test("agent-scoped registration resolves discovery auth with the target agent's scoped config", async () => {
    const fake = startFakeMcpServer();
    try {
      const lead = createAgent({ name: "mcp-scope-lead", isLead: true, status: "idle" });
      const owner = createAgent({ name: "mcp-scope-owner", isLead: false, status: "idle" });
      // Secret visible ONLY in the owner agent's scope — not to the lead caller.
      upsertSwarmConfig({
        scope: "agent",
        scopeId: owner.id,
        key: "MCP_OWNER_ONLY_SECRET",
        value: "owner-only-secret",
        isSecret: true,
      });
      const mcpServer = createMcpServer({
        name: `external-owner-${crypto.randomUUID()}`,
        transport: "http",
        scope: "global",
        url: fake.url,
        headerConfigKeys: JSON.stringify({ "X-Test-Secret": "MCP_OWNER_ONLY_SECRET" }),
      });

      const connection = await upsertScriptConnection({
        slug: "ownerScopedDiscovery",
        kind: "mcp",
        scope: "agent",
        scopeId: owner.id,
        mcpServerId: mcpServer.id,
        agentId: lead.id,
      });

      expect(connection.generationError).toBeNull();
      const listRequest = fake.requests.find((request) => request.method === "tools/list");
      expect(listRequest?.secretHeader).toBe("owner-only-secret");
    } finally {
      fake.stop();
    }
  });

  test("proxy route lets a worker invoke a global MCP connection and forwards resolved secret headers", async () => {
    const fake = startFakeMcpServer();
    try {
      const lead = createAgent({ name: "mcp-lead", isLead: true, status: "idle" });
      const worker = createAgent({ name: "mcp-worker", isLead: false, status: "idle" });
      const mcpServer = seedExternalMcpServer(fake.url);
      const connection = await upsertScriptConnection({
        slug: "proxyExternal",
        kind: "mcp",
        scope: "global",
        mcpServerId: mcpServer.id,
        agentId: lead.id,
      });

      const response = await dispatchProxyApi(`/api/script-connections/${connection.id}/mcp-call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "X-Agent-ID": worker.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tool: "echo-tool", arguments: { message: "hello" } }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        result?: { content: Array<{ type: string; text?: string }> };
      };
      expect(body.ok).toBe(true);
      expect(body.result?.content[0]?.text).toBe(
        JSON.stringify({ echo: "hello", secret: SECRET_VALUE }),
      );
      expect(fake.requests.some((request) => request.method === "tools/call")).toBe(true);

      const unauthenticated = await dispatchProxyApi(
        `/api/script-connections/${connection.id}/mcp-call`,
        {
          method: "POST",
          headers: { "X-Agent-ID": worker.id, "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "echo-tool", arguments: {} }),
        },
      );
      expect(unauthenticated.status).toBe(401);
    } finally {
      fake.stop();
    }
  });

  test("proxy route rejects disabled connections and agent scope mismatches", async () => {
    const fake = startFakeMcpServer();
    try {
      const lead = createAgent({ name: "mcp-lead", isLead: true, status: "idle" });
      const worker = createAgent({ name: "mcp-worker", isLead: false, status: "idle" });
      const owner = createAgent({ name: "mcp-owner", isLead: false, status: "idle" });
      const mcpServer = seedExternalMcpServer(fake.url);
      const globalConnection = await upsertScriptConnection({
        slug: "disabledExternal",
        kind: "mcp",
        scope: "global",
        mcpServerId: mcpServer.id,
        agentId: lead.id,
      });
      setScriptConnectionEnabled(globalConnection.id, false);

      const disabled = await dispatchProxyApi(
        `/api/script-connections/${globalConnection.id}/mcp-call`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "X-Agent-ID": worker.id,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tool: "echo-tool", arguments: {} }),
        },
      );
      expect(disabled.status).toBe(403);

      const scopedConnection = await upsertScriptConnection({
        slug: "ownerExternal",
        kind: "mcp",
        scope: "agent",
        scopeId: owner.id,
        mcpServerId: mcpServer.id,
        agentId: lead.id,
      });

      const mismatch = await dispatchProxyApi(
        `/api/script-connections/${scopedConnection.id}/mcp-call`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "X-Agent-ID": worker.id,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tool: "echo-tool", arguments: {} }),
        },
      );
      expect(mismatch.status).toBe(403);

      const allowed = await dispatchProxyApi(
        `/api/script-connections/${scopedConnection.id}/mcp-call`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "X-Agent-ID": owner.id,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tool: "echo-tool", arguments: { message: "owner" } }),
        },
      );
      expect(allowed.status).toBe(200);
      expect(((await allowed.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      fake.stop();
    }
  });

  test("tool-list fetch failures are recorded as generation_error on the connection row", async () => {
    const fake = startFakeMcpServer({ failList: true });
    try {
      const lead = createAgent({ name: "mcp-lead", isLead: true, status: "idle" });
      const mcpServer = seedExternalMcpServer(fake.url);

      const connection = await upsertScriptConnection({
        slug: "brokenExternal",
        kind: "mcp",
        scope: "global",
        mcpServerId: mcpServer.id,
        agentId: lead.id,
      });

      expect(connection.generationError).toContain("MCP request failed: 500");
      expect(connection.generatedRuntimeJson).toBeNull();
      expect(connection.generatedTypes).toBeNull();
    } finally {
      fake.stop();
    }
  });

  test("runtime ctx.mcp registry posts the expected proxy request shape", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ ok: true, result: { content: [{ type: "text", text: "ok" }] } });
    }) as typeof globalThis.fetch;

    try {
      const config = new SwarmConfig({
        system: {
          apiKey: { value: API_KEY, isSecret: true },
          agentId: { value: "agent-runtime", isSecret: false },
          mcpBaseUrl: { value: "http://swarm.test/", isSecret: false },
        },
        user: {},
      });
      const registry = createMcpRegistryClient(
        [
          {
            slug: "external",
            kind: "mcp",
            connectionId: "conn-1",
            tools: [{ name: "echo-tool", inputSchema: {} }],
          },
        ],
        config,
      );

      const result = await registry.external!.echoTool({ message: "hi" });

      expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
      expect(calls).toEqual([
        {
          url: "http://swarm.test/api/script-connections/conn-1/mcp-call",
          headers: {
            authorization: `Bearer ${API_KEY}`,
            "content-type": "application/json",
            "x-agent-id": "agent-runtime",
          },
          body: { tool: "echo-tool", arguments: { message: "hi" } },
        },
      ]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

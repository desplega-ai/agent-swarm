import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, createMcpServer, initDb } from "../be/db";
import { listMcpServerTools } from "../be/mcp-proxy";
import { handleMcpServers } from "../http/mcp-servers";
import { McpHttpClient } from "../mcp-client/http-client";

const TEST_DB_PATH = "./test-mcp-server-ssrf.sqlite";
const originalFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const LEAD_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "00000000-0000-4000-8000-000000000002";
let routeServer: Server;
let routeBaseUrl: string;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function routeApi(
  method: string,
  path: string,
  agentId: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await originalFetch(`${routeBaseUrl}${path}`, {
    method,
    headers: {
      "X-Agent-ID": agentId,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  process.env.NODE_ENV = "production";
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "mcp-ssrf-lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "mcp-ssrf-worker", isLead: false, status: "idle" });
  routeServer = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathEnd = url.indexOf("?");
    const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
    const handled = await handleMcpServers(
      req,
      res,
      path.split("/").filter(Boolean),
      new URLSearchParams(pathEnd === -1 ? "" : url.slice(pathEnd + 1)),
    );
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  const address = routeServer.address();
  if (!address || typeof address === "string")
    throw new Error("Test route server has no TCP address");
  routeBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    routeServer.close((error) => (error ? reject(error) : resolve())),
  );
  closeDb();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await removeDbFiles(TEST_DB_PATH);
});

describe("MCP server proxy SSRF guard", () => {
  test("rejects unsafe URLs on registration and enforces create/update RBAC", async () => {
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://localhost/mcp",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      const result = await routeApi("POST", "/api/mcp-servers", LEAD_ID, {
        name: `unsafe-registration-${crypto.randomUUID()}`,
        transport: "http",
        url,
      });
      expect(result.status).toBe(400);
    }

    const deniedCreate = await routeApi("POST", "/api/mcp-servers", WORKER_ID, {
      name: `worker-create-${crypto.randomUUID()}`,
      transport: "http",
      url: "https://mcp.example.com/streamable",
    });
    expect(deniedCreate.status).toBe(403);

    const created = await routeApi("POST", "/api/mcp-servers", LEAD_ID, {
      name: `public-registration-${crypto.randomUUID()}`,
      transport: "http",
      url: "https://mcp.example.com/streamable",
    });
    expect(created.status).toBe(201);
    const serverId = (created.body as { server: { id: string } }).server.id;

    const deniedUpdate = await routeApi("PUT", `/api/mcp-servers/${serverId}`, WORKER_ID, {
      name: "worker-may-not-update-lead-server",
    });
    expect(deniedUpdate.status).toBe(403);

    const unsafeUpdate = await routeApi("PUT", `/api/mcp-servers/${serverId}`, LEAD_ID, {
      url: "https://127.0.0.1/mcp",
    });
    expect(unsafeUpdate.status).toBe(400);
  });

  test.each([
    ["loopback IP", "https://127.0.0.1/mcp"],
    ["loopback hostname", "https://localhost/mcp"],
    ["link-local IP", "https://169.254.169.254/latest/meta-data"],
  ])("rejects a %s URL before the MCP client fetches", async (_kind, url) => {
    const server = await createMcpServer({
      name: `unsafe-${crypto.randomUUID()}`,
      transport: "http",
      url,
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({});
    }) as typeof fetch;

    await expect(listMcpServerTools(server.id)).rejects.toThrow(/Refusing (loopback|private IPv4)/);
    expect(fetchCalls).toBe(0);
  });

  test("permits a public MCP URL and revalidates every outbound MCP request", async () => {
    const server = await createMcpServer({
      name: `public-${crypto.randomUUID()}`,
      transport: "http",
      url: "https://mcp.example.com/streamable",
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      }
      if (fetchCalls === 2) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    }) as typeof fetch;

    await expect(listMcpServerTools(server.id)).resolves.toEqual([]);
    expect(fetchCalls).toBe(3);
  });

  test("runs an external MCP URL validator before every request", async () => {
    let fetchCalls = 0;
    let validationCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      if (fetchCalls === 2) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    }) as typeof fetch;

    const client = new McpHttpClient("https://mcp.example.com/streamable", "", "", undefined, {
      omitEmptyAuthHeaders: true,
      validateUrl: () => {
        validationCalls += 1;
      },
    });
    client.useRawUrl = true;

    await client.initialize();
    await client.listTools();
    expect(validationCalls).toBe(fetchCalls);
  });
});

/**
 * An agent-scope stdio MCP server runs an arbitrary command on the worker, so creating or
 * changing one needs the same authorization as a swarm-scope server. Remote http/sse servers
 * at agent scope stay open to every agent. Covers the MCP tools and the HTTP update route.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createMcpServer,
  getAgentMcpServers,
  getMcpServerById,
  initDb,
  listMcpServers,
} from "../be/db";
import { handleMcpServers } from "../http/mcp-servers";
import { registerMcpServerCreateTool, registerMcpServerUpdateTool } from "../tools/mcp-servers";

const TEST_DB_PATH = "./test-mcp-server-stdio-gate.sqlite";

const LEAD_ID = "aaaa2000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb2000-0000-4000-8000-000000000002";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: { success: boolean; message: string; [key: string]: unknown };
  isError: boolean;
};

let mcp: McpServer;
let routeServer: Server;
let routeBaseUrl: string;

async function callTool(
  name: string,
  callerAgentId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (mcp as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  };
  return (await handler(args, extra)) as ToolResult;
}

async function putServer(
  id: string,
  agentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${routeBaseUrl}/api/mcp-servers/${id}`, {
    method: "PUT",
    headers: { "X-Agent-ID": agentId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function postServer(
  agentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${routeBaseUrl}/api/mcp-servers`, {
    method: "POST",
    headers: { "X-Agent-ID": agentId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

const DENIED = "Only lead agents can create or change stdio MCP servers.";

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Stdio Gate Lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "Stdio Gate Worker", isLead: false, status: "idle" });

  mcp = new McpServer({ name: "test-mcp-server-stdio-gate", version: "1.0.0" });
  registerMcpServerCreateTool(mcp);
  registerMcpServerUpdateTool(mcp);

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

describe("mcp-server-create: agent-scope stdio", () => {
  test("a worker cannot create an agent-scope stdio server, and nothing is stored or installed", async () => {
    const result = await callTool("mcp-server-create", WORKER_ID, {
      name: "gate-worker-stdio",
      transport: "stdio",
      command: "sh",
      args: JSON.stringify(["-c", "true"]),
      scope: "agent",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toBe(DENIED);
    expect(await listMcpServers({ search: "gate-worker-stdio" })).toHaveLength(0);
    expect((await getAgentMcpServers(WORKER_ID)).map((s) => s.name)).not.toContain(
      "gate-worker-stdio",
    );
  });

  test("scope defaults to agent, so omitting it does not bypass the gate", async () => {
    const result = await callTool("mcp-server-create", WORKER_ID, {
      name: "gate-worker-stdio-default-scope",
      transport: "stdio",
      command: "sh",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toBe(DENIED);
    expect(await listMcpServers({ search: "gate-worker-stdio-default-scope" })).toHaveLength(0);
  });

  test("a worker can still create agent-scope http and sse servers", async () => {
    for (const transport of ["http", "sse"] as const) {
      const result = await callTool("mcp-server-create", WORKER_ID, {
        name: `gate-worker-${transport}`,
        transport,
        url: "https://mcp.example.com/endpoint",
        scope: "agent",
      });
      expect(result.isError, `${transport}: ${result.structuredContent.message}`).toBe(false);
      expect(result.structuredContent.message).toContain("Created and installed MCP server");
    }
  });

  test("a lead can create an agent-scope stdio server", async () => {
    const result = await callTool("mcp-server-create", LEAD_ID, {
      name: "gate-lead-stdio",
      transport: "stdio",
      command: "echo",
      scope: "agent",
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent.message).toContain("Created and installed MCP server");
  });
});

describe("mcp-server-update: reaching stdio through an update", () => {
  test("an owner cannot turn its own http server into a stdio server", async () => {
    const created = await createMcpServer({
      name: "gate-update-http-to-stdio",
      transport: "http",
      url: "https://mcp.example.com/endpoint",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const result = await callTool("mcp-server-update", WORKER_ID, {
      id: created.id,
      transport: "stdio",
      command: "sh",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toBe(DENIED);
    const after = await getMcpServerById(created.id);
    expect(after?.transport).toBe("http");
    expect(after?.command).toBeNull();
  });

  test("an owner cannot change the command, args or env of a stdio server it owns", async () => {
    const created = await createMcpServer({
      name: "gate-update-stdio-command",
      transport: "stdio",
      command: "echo",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    for (const change of [
      { command: "sh" },
      { args: JSON.stringify(["-c", "true"]) },
      { envConfigKeys: JSON.stringify({ NODE_OPTIONS: "some-config-key" }) },
    ]) {
      const result = await callTool("mcp-server-update", WORKER_ID, { id: created.id, ...change });
      expect(result.isError, JSON.stringify(change)).toBe(true);
      expect(result.structuredContent.message).toBe(DENIED);
    }
    expect((await getMcpServerById(created.id))?.command).toBe("echo");
  });

  test("an owner can still rename, describe and toggle a stdio server, and edit an http one", async () => {
    const stdio = await createMcpServer({
      name: "gate-update-stdio-benign",
      transport: "stdio",
      command: "echo",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    const renamed = await callTool("mcp-server-update", WORKER_ID, {
      id: stdio.id,
      description: "new description",
      isEnabled: false,
    });
    expect(renamed.isError).toBe(false);

    const http = await createMcpServer({
      name: "gate-update-http-benign",
      transport: "http",
      url: "https://mcp.example.com/endpoint",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    const retargeted = await callTool("mcp-server-update", WORKER_ID, {
      id: http.id,
      url: "https://mcp.example.com/other",
    });
    expect(retargeted.isError).toBe(false);
  });

  test("an owner cannot switch a stdio server back on, but can resubmit unchanged values", async () => {
    const created = await createMcpServer({
      name: "gate-update-reenable",
      transport: "stdio",
      command: "echo",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    const disabled = await callTool("mcp-server-update", LEAD_ID, {
      id: created.id,
      isEnabled: false,
    });
    expect(disabled.isError).toBe(false);

    const reenable = await callTool("mcp-server-update", WORKER_ID, {
      id: created.id,
      isEnabled: true,
    });
    expect(reenable.isError).toBe(true);
    expect(reenable.structuredContent.message).toBe(DENIED);
    expect((await getMcpServerById(created.id))?.isEnabled).toBe(false);

    const unchanged = await callTool("mcp-server-update", WORKER_ID, {
      id: created.id,
      transport: "stdio",
      command: "echo",
      description: "same command, new text",
    });
    expect(unchanged.isError).toBe(false);
  });

  test("a lead can change the command of a worker's stdio server", async () => {
    const created = await createMcpServer({
      name: "gate-update-lead",
      transport: "stdio",
      command: "echo",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    const result = await callTool("mcp-server-update", LEAD_ID, { id: created.id, command: "ls" });
    expect(result.isError).toBe(false);
    expect((await getMcpServerById(created.id))?.command).toBe("ls");
  });
});

describe("HTTP routes with an X-Agent-ID", () => {
  test("POST /api/mcp-servers keeps refusing a worker's stdio server", async () => {
    const result = await postServer(WORKER_ID, {
      name: "gate-http-create-stdio",
      transport: "stdio",
      command: "sh",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    expect(result.status).toBe(403);
    expect(await listMcpServers({ search: "gate-http-create-stdio" })).toHaveLength(0);
  });

  test("PUT /api/mcp-servers/:id refuses an owner's command change, and allows a lead's", async () => {
    const created = await createMcpServer({
      name: "gate-http-update-stdio",
      transport: "stdio",
      command: "echo",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });

    const denied = await putServer(created.id, WORKER_ID, { command: "sh" });
    expect(denied.status).toBe(403);
    expect((await getMcpServerById(created.id))?.command).toBe("echo");

    const toStdio = await createMcpServer({
      name: "gate-http-update-http-to-stdio",
      transport: "http",
      url: "https://mcp.example.com/endpoint",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    const deniedSwitch = await putServer(toStdio.id, WORKER_ID, {
      transport: "stdio",
      command: "sh",
    });
    expect(deniedSwitch.status).toBe(403);
    expect((await getMcpServerById(toStdio.id))?.transport).toBe("http");

    const allowed = await putServer(created.id, LEAD_ID, { command: "ls" });
    expect(allowed.status).toBe(200);
    expect((await getMcpServerById(created.id))?.command).toBe("ls");
  });

  test("PUT /api/mcp-servers/:id still lets an owner edit non-executable fields", async () => {
    const created = await createMcpServer({
      name: "gate-http-update-benign",
      transport: "stdio",
      command: "echo",
      scope: "agent",
      ownerAgentId: WORKER_ID,
    });
    const result = await putServer(created.id, WORKER_ID, { description: "edited by owner" });
    expect(result.status).toBe(200);
  });
});

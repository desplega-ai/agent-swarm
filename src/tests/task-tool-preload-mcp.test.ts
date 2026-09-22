import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, createTaskExtended, initDb, upsertSwarmConfig } from "../be/db";
import { handleMcp } from "../http/mcp";
import { listenOnFreePort } from "./test-net";

const dbPath = "./test-task-tool-preload.sqlite";
const transports: Record<string, StreamableHTTPServerTransport> = {};
const agents: Record<string, string> = {};
const activity: Record<string, number> = {};
const clients: Client[] = [];
const server = createHttpServer(async (req, res) => {
  if (await handleMcp(req, res, transports, activity, agents)) return;
  res.writeHead(404).end();
});
let url: URL;
let agentId: string;
const savedEnv = {
  TASK_TOOL_PRELOAD_ENABLED: process.env.TASK_TOOL_PRELOAD_ENABLED,
  TASK_TOOL_MANIFESTS: process.env.TASK_TOOL_MANIFESTS,
  SCRIPTS_ONLY_MCP: process.env.SCRIPTS_ONLY_MCP,
};

beforeAll(async () => {
  delete process.env.TASK_TOOL_PRELOAD_ENABLED;
  delete process.env.TASK_TOOL_MANIFESTS;
  delete process.env.SCRIPTS_ONLY_MCP;
  initDb(dbPath);
  agentId = (await createAgent({ name: "manifest-worker", isLead: false, status: "idle" })).id;
  url = new URL(`http://127.0.0.1:${await listenOnFreePort(server, "127.0.0.1")}/mcp`);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(Object.values(transports).map((transport) => transport.close()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function connect(taskId?: string): Promise<Client> {
  const client = new Client({ name: "manifest-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          "X-Agent-ID": agentId,
          ...(taskId ? { "X-Source-Task-Id": taskId } : {}),
        },
      },
    }),
  );
  return client;
}

async function configure(key: string, value: string) {
  await upsertSwarmConfig({ scope: "agent", scopeId: agentId, key, value });
}

async function pins(client: Client): Promise<string[]> {
  return (await client.listTools()).tools
    .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
    .map((tool) => tool.name)
    .sort();
}

// Eight real MCP sessions approach the 10s CI default under parallel runner load.
// Keep the session-lifetime assertions together with room for connection setup.
test("wire response is default-on, per-task, additive, and fixed for one MCP session", async () => {
  const task = await createTaskExtended("review fixture", { agentId, taskType: "review" });
  const other = await createTaskExtended("other fixture", { agentId, taskType: "other" });
  const foreign = await createTaskExtended("unowned", { taskType: "review" });
  await configure("TASK_TOOL_MANIFESTS", '{"taskTypes":{"review":["script-run","get-tasks"]}}');
  const defaultOn = await connect(task.id);
  expect(await pins(defaultOn)).toEqual(["get-tasks", "script-run"]);
  await configure("TASK_TOOL_PRELOAD_ENABLED", "false");
  const off = await connect(task.id);
  const baseline = (await off.listTools()).tools;
  expect(baseline.some((tool) => tool.name === "script-run")).toBe(true);
  expect(await pins(off)).toEqual([]);
  expect(off.getInstructions()).toBeUndefined();

  await configure("TASK_TOOL_PRELOAD_ENABLED", "true");
  const [on, unmatched, unowned, missing] = await Promise.all([
    connect(task.id),
    connect(other.id),
    connect(foreign.id),
    connect(),
  ]);
  expect(await pins(on)).toEqual(["get-tasks", "script-run"]);
  expect(on.getInstructions()).toContain("call it directly");
  expect(await pins(unmatched)).toEqual([]);
  expect(await pins(unowned)).toEqual([]);
  expect(await pins(missing)).toEqual([]);
  expect(await pins(off)).toEqual([]);
  expect((await on.listTools()).tools.map((tool) => tool.name)).toEqual(
    baseline.map((tool) => tool.name),
  );
  const result = await on.callTool({ name: "get-tasks", arguments: { mineOnly: true } });
  expect(result.isError).toBe(false);

  // Explicit per-agent off wins even when the deployment default is on.
  process.env.TASK_TOOL_PRELOAD_ENABLED = "true";
  await configure("TASK_TOOL_PRELOAD_ENABLED", "false");
  expect(await pins(await connect(task.id))).toEqual([]);
  expect(await pins(on)).toEqual(["get-tasks", "script-run"]);

  await configure("TASK_TOOL_PRELOAD_ENABLED", "true");
  await configure("TASK_TOOL_MANIFESTS", "invalid deployment JSON");
  expect(await pins(await connect(task.id))).toEqual([]);
}, 30_000);

test("a manifest cannot expand the scripts-only capability surface", async () => {
  const task = await createTaskExtended("script fixture", { agentId, taskType: "script" });
  await configure("TASK_TOOL_PRELOAD_ENABLED", "true");
  await configure("TASK_TOOL_MANIFESTS", '{"taskTypes":{"script":["script-run","get-tasks"]}}');
  await configure("SCRIPTS_ONLY_MCP", "true");
  const client = await connect(task.id);
  expect(await pins(client)).toEqual(["script-run"]);
  expect((await client.listTools()).tools.some((tool) => tool.name === "get-tasks")).toBe(false);
});

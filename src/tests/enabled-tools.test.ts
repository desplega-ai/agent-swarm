import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { validateConfigValue } from "../be/swarm-config-guard";
import {
  _resetAutoReloadForTests,
  flushPendingIntegrationsReload,
  loadGlobalConfigsIntoEnv,
} from "../http/core";
import { handleMcp } from "../http/mcp";
import { createServer } from "../server";
import { parseEnabledTools } from "../utils/enabled-tools";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-enabled-tools.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function toolNames(opts: Parameters<typeof createServer>[0]): Promise<string[]> {
  const server = (await createServer(opts)) as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(server._registeredTools).sort();
}

function parseMcpPayload(text: string): unknown {
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

let httpServer: Server;
let baseUrl: string;
let savedEnv: string | undefined;
let savedCapabilities: string | undefined;

async function mcpPost(agentId: string, body: Record<string, unknown>, sessionId?: string) {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-Agent-ID": agentId,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: text ? parseMcpPayload(text) : null };
}

async function listSessionTools(agentId: string): Promise<string[]> {
  const init = await mcpPost(agentId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "enabled-tools", version: "1" },
      capabilities: {},
    },
  });
  const sessionId = init.response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing MCP session ID");
  await mcpPost(agentId, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  const listed = await mcpPost(
    agentId,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
  return (listed.payload as { result: { tools: Array<{ name: string }> } }).result.tools
    .map((tool) => tool.name)
    .sort();
}

beforeAll(async () => {
  // Drain any config reload a previous suite left queued (see
  // scripts-only-gating.test.ts) before touching the global config rows.
  const originalSlackDisable = process.env.SLACK_DISABLE;
  process.env.SLACK_DISABLE = "true";
  await flushPendingIntegrationsReload();
  _resetAutoReloadForTests();
  if (originalSlackDisable === undefined) delete process.env.SLACK_DISABLE;
  else process.env.SLACK_DISABLE = originalSlackDisable;

  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionAgents: Record<string, string> = {};
  httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (await handleMcp(req, res, transports, {}, sessionAgents)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(httpServer, "127.0.0.1")}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  savedEnv = process.env.SWARM_ENABLED_TOOLS;
  delete process.env.SWARM_ENABLED_TOOLS;
  // Pin the default capability set; worker containers export their own.
  savedCapabilities = process.env.CAPABILITIES;
  delete process.env.CAPABILITIES;
});

afterEach(async () => {
  await getDbClient().run("DELETE FROM swarm_config WHERE key = 'SWARM_ENABLED_TOOLS'");
  // Un-inject the global row so it cannot leak into later suites.
  await loadGlobalConfigsIntoEnv(true);
  if (savedEnv === undefined) delete process.env.SWARM_ENABLED_TOOLS;
  else process.env.SWARM_ENABLED_TOOLS = savedEnv;
  if (savedCapabilities === undefined) delete process.env.CAPABILITIES;
  else process.env.CAPABILITIES = savedCapabilities;
});

describe("parseEnabledTools", () => {
  test.each([
    [undefined, undefined],
    ["", undefined],
    ["  ", undefined],
    [" , ,", undefined],
    ["[]", undefined],
    ["get-tasks, store-progress", ["get-tasks", "store-progress"]],
    ["get-tasks,get-tasks,", ["get-tasks"]],
    ['["get-tasks", " store-progress "]', ["get-tasks", "store-progress"]],
  ] as Array<[string | undefined, string[] | undefined]>)("parses %#", (value, expected) => {
    expect(parseEnabledTools(value)).toEqual(expected);
  });

  test("rejects a JSON value that is not an array of strings", () => {
    expect(() => parseEnabledTools("[1, 2]")).toThrow();
    expect(() => parseEnabledTools("[not json")).toThrow();
    expect(validateConfigValue("SWARM_ENABLED_TOOLS", "[1]")).toContain("SWARM_ENABLED_TOOLS");
    expect(validateConfigValue("SWARM_ENABLED_TOOLS", "get-tasks,nope")).toBeNull();
  });
});

describe("SWARM_ENABLED_TOOLS on the MCP server", () => {
  test("unset keeps the capability-driven surface", async () => {
    const unset = await toolNames({});
    expect(unset).toContain("send-task");
    // messaging is a default-disabled capability
    expect(unset).not.toContain("post-message");
    expect(await toolNames({ enabledTools: undefined })).toEqual(unset);
  });

  test("set registers exactly the listed tools, ignoring capabilities", async () => {
    expect(await toolNames({ enabledTools: "get-tasks, post-message" })).toEqual([
      "get-tasks",
      "post-message",
    ]);
  });

  test("reads the deployment env when no session value is passed", async () => {
    process.env.SWARM_ENABLED_TOOLS = "store-progress";
    expect(await toolNames({})).toEqual(["store-progress"]);
  });

  test("overrides scripts-only mode", async () => {
    expect(await toolNames({ scriptsOnly: true, enabledTools: "get-tasks" })).toEqual([
      "get-tasks",
    ]);
  });

  test("does not affect the full-surface bridge server", async () => {
    const tools = await toolNames({ fullSurface: true, enabledTools: "get-tasks" });
    expect(tools).toContain("post-message");
    expect(tools.length).toBeGreaterThan(1);
  });

  test("warns once on unknown names and keeps the known ones", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const value = "get-tasks, no-such-tool-a1, no-such-tool-b2";
      expect(await toolNames({ enabledTools: value })).toEqual(["get-tasks"]);
      await toolNames({ enabledTools: value });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      const unknown = messages.filter((m) => m.includes("unknown tools"));
      expect(unknown).toEqual([
        "[MCP] SWARM_ENABLED_TOOLS names unknown tools, ignoring them: no-such-tool-a1, no-such-tool-b2",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("an empty value logs and behaves as unset", async () => {
    const unset = await toolNames({});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await toolNames({ enabledTools: " , " })).toEqual(unset);
      expect(await toolNames({ enabledTools: "" })).toEqual(unset);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("lists no tools; ignoring it")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("an agent-scoped value beats the swarm-wide one, per session", async () => {
    const scoped = await createAgent({ name: "allowlist-agent", isLead: false, status: "idle" });
    const neighbor = await createAgent({
      name: "allowlist-neighbor",
      isLead: false,
      status: "idle",
    });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ENABLED_TOOLS", value: "get-tasks" });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: scoped.id,
      key: "SWARM_ENABLED_TOOLS",
      value: "store-progress,post-message",
    });

    expect(await listSessionTools(scoped.id)).toEqual(["post-message", "store-progress"]);
    expect(await listSessionTools(neighbor.id)).toEqual(["get-tasks"]);

    // Reloadable: a config change applies on the next session, no restart.
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: scoped.id,
      key: "SWARM_ENABLED_TOOLS",
      value: "store-progress",
    });
    expect(await listSessionTools(scoped.id)).toEqual(["store-progress"]);
  });
});

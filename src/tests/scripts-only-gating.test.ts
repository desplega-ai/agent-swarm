import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, getDb, initDb, upsertSwarmConfig } from "../be/db";
import { _resetAutoReloadForTests, flushPendingIntegrationsReload } from "../http/core";
import { handleMcp } from "../http/mcp";
import { getBasePrompt } from "../prompts/base-prompt";
import { createServer } from "../server";
import { resolveScriptsOnlyMode } from "../utils/scripts-only-mode";

const TEST_DB_PATH = "./test-scripts-only-gating.sqlite";
const SCRIPT_TOOL_NAMES = [
  "get-script-run",
  "launch-script-run",
  "list-script-runs",
  "script-delete",
  "script-query-types",
  "script-run",
  "script-search",
  "script-upsert",
].sort();

type RegisteredTool = Record<string, unknown>;

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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function createTestServer(): Server {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionAgents: Record<string, string> = {};

  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (await handleMcp(req, res, transports, {}, sessionAgents)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
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

let server: Server;
let baseUrl: string;
let savedSlackBotToken: string | undefined;
let savedSlackAppToken: string | undefined;
let scriptsOnlyEnvQueue = Promise.resolve();

async function withScriptsOnlyMcpEnv<T>(
  value: string | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  const previous = scriptsOnlyEnvQueue;
  let release!: () => void;
  scriptsOnlyEnvQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  const savedValue = process.env.SCRIPTS_ONLY_MCP;
  if (value === undefined) delete process.env.SCRIPTS_ONLY_MCP;
  else process.env.SCRIPTS_ONLY_MCP = value;

  try {
    return await callback();
  } finally {
    if (savedValue === undefined) delete process.env.SCRIPTS_ONLY_MCP;
    else process.env.SCRIPTS_ONLY_MCP = savedValue;
    release();
  }
}

async function mcpPost(
  agentId: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response; payload: unknown }> {
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

async function listToolsWithCurrentEnv(agentId: string): Promise<string[]> {
  const initialize = await mcpPost(agentId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "scripts-only-gating", version: "1" },
      capabilities: {},
    },
  });
  expect(initialize.response.status).toBe(200);
  const sessionId = initialize.response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing MCP session ID");

  const initialized = await mcpPost(
    agentId,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expect([200, 202]).toContain(initialized.response.status);

  const listed = await mcpPost(
    agentId,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
  );
  expect(listed.response.status).toBe(200);
  return (listed.payload as { result: { tools: Array<{ name: string }> } }).result.tools
    .map((tool) => tool.name)
    .sort();
}

async function listTools(agentId: string, scriptsOnlyEnv?: string): Promise<string[]> {
  return withScriptsOnlyMcpEnv(scriptsOnlyEnv, () => listToolsWithCurrentEnv(agentId));
}

function expectFullSurface(toolNames: string[]): void {
  expect(toolNames).toContain("send-task");
  expect(toolNames.length).toBeGreaterThan(SCRIPT_TOOL_NAMES.length);
}

beforeAll(async () => {
  // Other HTTP integration tests can leave the process-global config reload
  // debounce queued after their server closes. Drain it before installing the
  // fake Slack credentials or mutating SCRIPTS_ONLY_MCP; otherwise the leaked
  // reload races this suite, attempts a real Slack connection, and rewrites
  // the gating environment between MCP initialize and tools/list.
  const originalSlackDisable = process.env.SLACK_DISABLE;
  const originalScriptsOnlyMcp = process.env.SCRIPTS_ONLY_MCP;
  process.env.SLACK_DISABLE = "true";
  await flushPendingIntegrationsReload();
  _resetAutoReloadForTests();
  if (originalSlackDisable === undefined) delete process.env.SLACK_DISABLE;
  else process.env.SLACK_DISABLE = originalSlackDisable;
  if (originalScriptsOnlyMcp === undefined) delete process.env.SCRIPTS_ONLY_MCP;
  else process.env.SCRIPTS_ONLY_MCP = originalScriptsOnlyMcp;

  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
  server = createTestServer();
  baseUrl = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await scriptsOnlyEnvQueue;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  // A retried test attempt can be abandoned while its async MCP handshake is
  // still resolving. Wait for that request before mutating the shared DB.
  await scriptsOnlyEnvQueue;
  savedSlackBotToken = process.env.SLACK_BOT_TOKEN;
  savedSlackAppToken = process.env.SLACK_APP_TOKEN;
  process.env.SLACK_BOT_TOKEN = "test-bot-token";
  process.env.SLACK_APP_TOKEN = "test-app-token";
  getDb().run("DELETE FROM swarm_config WHERE key = 'SCRIPTS_ONLY_MCP'");
});

afterEach(() => {
  if (savedSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = savedSlackBotToken;
  if (savedSlackAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
  else process.env.SLACK_APP_TOKEN = savedSlackAppToken;
});

describe("resolveScriptsOnlyMode", () => {
  test.each([
    [{}, false],
    [{ env: "true" }, true],
    [{ env: "false" }, false],
    [{ env: "", configValue: "true" }, true],
    [{ configValue: "true" }, true],
    [{ configValue: "false" }, false],
    [{ env: "false", configValue: "true" }, false],
    [{ env: "true", configValue: "false" }, true],
  ] satisfies Array<
    [Parameters<typeof resolveScriptsOnlyMode>[0], boolean]
  >)("resolves %#", (opts, expected) => {
    expect(resolveScriptsOnlyMode(opts)).toBe(expected);
  });
});

describe("scripts-only MCP gating", () => {
  test("uses the full surface with no environment override or config row", async () => {
    const agent = createAgent({ name: "full-surface-agent", isLead: false, status: "idle" });

    expectFullSurface(await listTools(agent.id));
  });

  test("isolates concurrent environment overrides across MCP handshakes", async () => {
    const scriptsOnlyAgent = createAgent({
      name: "concurrent-scripts-only-agent",
      isLead: false,
      status: "idle",
    });
    const fullSurfaceAgent = createAgent({
      name: "concurrent-full-surface-agent",
      isLead: false,
      status: "idle",
    });

    const [scriptsOnlyTools, fullSurfaceTools] = await Promise.all([
      listTools(scriptsOnlyAgent.id, "true"),
      listTools(fullSurfaceAgent.id),
    ]);

    expect(scriptsOnlyTools).toEqual(SCRIPT_TOOL_NAMES);
    expectFullSurface(fullSurfaceTools);
  });

  test("gates one configured agent without affecting another", async () => {
    const scriptsOnlyAgent = createAgent({
      name: "scripts-only-agent",
      isLead: false,
      status: "idle",
    });
    const fullSurfaceAgent = createAgent({
      name: "neighbor-agent",
      isLead: false,
      status: "idle",
    });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: scriptsOnlyAgent.id,
      key: "SCRIPTS_ONLY_MCP",
      value: "true",
    });

    expect(await listTools(scriptsOnlyAgent.id)).toEqual(SCRIPT_TOOL_NAMES);
    expectFullSurface(await listTools(fullSurfaceAgent.id));
  });

  test("uses a global config row when the agent has no override", async () => {
    const agent = createAgent({ name: "global-scripts-only-agent", isLead: false, status: "idle" });
    upsertSwarmConfig({ scope: "global", key: "SCRIPTS_ONLY_MCP", value: "true" });

    expect(await listTools(agent.id)).toEqual(SCRIPT_TOOL_NAMES);
  });

  test("gives a non-empty environment override precedence over an agent row", async () => {
    const agent = createAgent({ name: "env-wins-agent", isLead: false, status: "idle" });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: agent.id,
      key: "SCRIPTS_ONLY_MCP",
      value: "false",
    });
    expect(await listTools(agent.id, "true")).toEqual(SCRIPT_TOOL_NAMES);
  });

  test("treats an empty environment value as unset", async () => {
    const agent = createAgent({ name: "empty-env-agent", isLead: false, status: "idle" });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: agent.id,
      key: "SCRIPTS_ONLY_MCP",
      value: "true",
    });
    expect(await listTools(agent.id, "")).toEqual(SCRIPT_TOOL_NAMES);
  });

  test("keeps the scripts SDK bridge's explicit full surface", async () => {
    upsertSwarmConfig({ scope: "global", key: "SCRIPTS_ONLY_MCP", value: "true" });

    await withScriptsOnlyMcpEnv("true", () => {
      const tools = (
        createServer({ scriptsOnly: false }) as unknown as {
          _registeredTools: RegisteredTool;
        }
      )._registeredTools;
      expectFullSurface(Object.keys(tools));
    });
  });
});

describe("scripts-only prompt gating", () => {
  test("injects scripts-only guidance and suppresses named Slack-tool guidance", async () => {
    const prompt = await getBasePrompt({
      role: "worker",
      agentId: "scripts-only-prompt-agent",
      swarmUrl: "swarm.test",
      scriptsOnly: true,
    });

    expect(prompt).toContain("## Code-Mode: script tools ONLY");
    expect(prompt).not.toContain("#### Slack Tools");
  });

  test("respects an explicit false argument over a true process environment value", async () => {
    await withScriptsOnlyMcpEnv("true", async () => {
      const prompt = await getBasePrompt({
        role: "worker",
        agentId: "full-surface-prompt-agent",
        swarmUrl: "swarm.test",
        scriptsOnly: false,
      });

      expect(prompt).not.toContain("## Code-Mode: script tools ONLY");
      expect(prompt).toContain("#### Slack Tools");
    });
  });

  test("uses the scripts-only Slack variant for Slack-originated tasks", async () => {
    const prompt = await getBasePrompt({
      role: "worker",
      agentId: "scripts-only-slack-agent",
      swarmUrl: "swarm.test",
      scriptsOnly: true,
      slackContext: { channelId: "C123", threadTs: "123.456" },
    });

    expect(prompt).toContain("#### Slack Thread Updates (scripts-only)");
    expect(prompt).not.toContain("#### Slack Thread Updates\n");
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { drainBackground } from "../integrations/chat-sdk/background";
import { stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { isTrustedTeamsServiceUrl } from "../integrations/chat-sdk/teams-origin";
import { setChatSdkTestHooks } from "../integrations/chat-sdk/test-hooks";
import { registerChatPostTool } from "../tools/chat-post";
import { flushChatBuffers, postChatWebhook, snapshotChatSdkEnv } from "./chat-sdk-harness";
import { getFreePort } from "./test-net";

/*
 * Network: Teams `initialize()` only registers routes (no token or JWKS
 * fetch), and an inbound activity without `aadObjectId` in a new thread reads
 * nothing from Microsoft (no member lookup, no thread history). The Teams SDK
 * talks HTTP through axios and MSAL, not `fetch`, so a `fetch` stub would not
 * catch a call anyway. `apiUrl` points at a port nothing listens on
 * (from `getFreePort()`), so an unexpected connector call fails here. It
 * redirects connector calls only, not the MSAL token call to
 * login.microsoftonline.com. The tests send nothing outbound, so no token
 * call happens.
 *
 * No health-isolation case here: Teams `initialize()` only registers routes and
 * has no clean failure (the schema rejects blank ids), and a failing second
 * adapter needs a slow Slack WebClient retry or a real network call.
 */
const TEST_DB_PATH = "./test-chat-sdk-teams.sqlite";
const APP_ID = "00000000-0000-0000-0000-00000000a99";
let UNREACHABLE_API_URL = "";

const restoreEnv = snapshotChatSdkEnv();
let leadId: string;
let nextActivityId = 1_700_000_000_000;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

async function startTeams(teams: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({ teams, ...extra });
  await startChatSdk();
  await stopChatRelayWatcher();
}

/** A minimal Bot Framework `message` Activity that mentions the bot in a group chat. */
function teamsMention(conversationId: string, text: string): Record<string, unknown> {
  const bot = { id: `28:${APP_ID}`, name: "swarm" };
  return {
    type: "message",
    id: String(++nextActivityId),
    timestamp: new Date().toISOString(),
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    from: { id: "29:user-1", name: "Tester" },
    recipient: bot,
    conversation: { id: conversationId, conversationType: "groupChat", isGroup: true },
    text: `<at>swarm</at> ${text}`,
    entities: [{ type: "mention", mentioned: bot, text: "<at>swarm</at>" }],
  };
}

async function postActivity(activity: unknown) {
  return postChatWebhook("teams", JSON.stringify(activity), {
    "content-type": "application/json",
  });
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const lead = await createAgent({
    id: crypto.randomUUID(),
    name: "TeamsChatLead",
    isLead: true,
    status: "idle",
    capabilities: [],
  });
  leadId = lead.id;
  UNREACHABLE_API_URL = `http://127.0.0.1:${await getFreePort()}/`;
  process.env.CHAT_SDK_BUFFER_MS = "60000";
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ teams: UNREACHABLE_API_URL });
});

afterEach(async () => {
  await stopChatSdk();
  setChatSdkTestHooks({});
});

afterAll(async () => {
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("Chat SDK Teams adapter", () => {
  test("with the test verifier, a mention Activity creates a teams chat task", async () => {
    setChatSdkTestHooks({ teamsWebhookVerifier: () => true });
    await startTeams({ appId: APP_ID, appPassword: "teams-test-password" });
    expect(getChatSdkHealth().teams?.status).toBe("ok");

    const response = await postActivity(teamsMention("19:group-one@thread.v2", "triage the inbox"));
    expect(response.status).toBe(200);
    expect(await drainBackground(5_000)).toBe(true);
    await flushChatBuffers();

    const tasks = await getDbClient().query<{
      contextKey: string;
      source: string;
      agentId: string | null;
      task: string;
    }>("SELECT contextKey, source, agentId, task FROM agent_tasks WHERE contextKey GLOB ?", [
      "task:chat-sdk:teams:*",
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toBe("chat");
    expect(tasks[0]!.agentId).toBe(leadId);
    expect(tasks[0]!.task).toContain("triage the inbox");
  });

  test("without a verifier, an unsigned Activity is rejected with 401", async () => {
    await startTeams({ appId: APP_ID, appPassword: "teams-test-password" });
    expect(getChatSdkHealth().teams?.status).toBe("ok");
    const response = await postActivity(teamsMention("19:group-two@thread.v2", "should not land"));
    expect(response.status).toBe(401);
    const row = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE task LIKE '%should not land%'",
    );
    expect(row?.n).toBe(0);
  });
});

/** A Teams thread id in the adapter's encoding, pointing at `serviceUrl`. */
function teamsThreadId(conversationId: string, serviceUrl: string): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return `teams:${encode(conversationId)}:${encode(serviceUrl)}`;
}

/** An unsigned JWT the Teams SDK accepts from a token factory (it only decodes it). */
function fakeBotToken(): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp, aud: APP_ID })}.sig`;
}

interface ConnectorListener {
  url: string;
  requests: { method: string; path: string; authorization: string | null }[];
  stop: () => void;
}

/** A local stand-in for a connector host that records every request. */
function startConnectorListener(): ConnectorListener {
  const requests: ConnectorListener["requests"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ id: "activity-1" });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, requests, stop: () => server.stop(true) };
}

type ToolResult = {
  isError?: boolean;
  structuredContent: { success: boolean; message: string; [key: string]: unknown };
};

async function callChatPost(args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "chat-sdk-teams-test", version: "1.0.0" });
  registerChatPostTool(server);
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  return (await tools["chat-post"]!.handler(args, {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": leadId } },
  })) as ToolResult;
}

describe("Chat SDK Teams service URL allowlist", () => {
  test("only https Bot Framework hosts are trusted by default", () => {
    const saved = process.env.CHAT_SDK_API_URL_OVERRIDES;
    delete process.env.CHAT_SDK_API_URL_OVERRIDES;
    try {
      expect(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/teams/")).toBe(true);
      expect(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/emea/")).toBe(true);
      expect(isTrustedTeamsServiceUrl("https://smba.infra.gcc.teams.microsoft.com/teams")).toBe(
        true,
      );
      expect(isTrustedTeamsServiceUrl("http://smba.trafficmanager.net/teams/")).toBe(false);
      expect(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net.evil.test/")).toBe(false);
      expect(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net@evil.test/")).toBe(false);
      expect(isTrustedTeamsServiceUrl("http://127.0.0.1:8080/")).toBe(false);
      expect(isTrustedTeamsServiceUrl("not a url")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CHAT_SDK_API_URL_OVERRIDES;
      else process.env.CHAT_SDK_API_URL_OVERRIDES = saved;
    }
  });

  test("chat-post to a forged Teams id sends no request to its service URL", async () => {
    const listener = startConnectorListener();
    const saved = process.env.CHAT_SDK_API_URL_OVERRIDES;
    // Production shape: no apiUrl override, so the adapter would send to the id's service URL.
    delete process.env.CHAT_SDK_API_URL_OVERRIDES;
    try {
      setChatSdkTestHooks({ teamsToken: fakeBotToken });
      await startTeams({ appId: APP_ID, appPassword: "teams-test-password" });
      const threadId = teamsThreadId("19:forged@thread.v2", listener.url);

      const result = await callChatPost({ adapter: "teams", threadId, text: "leak test" });

      expect(result.isError).toBe(true);
      expect(result.structuredContent.message).toContain("not a Microsoft Bot Framework");
      expect(listener.requests).toHaveLength(0);
    } finally {
      listener.stop();
      if (saved === undefined) delete process.env.CHAT_SDK_API_URL_OVERRIDES;
      else process.env.CHAT_SDK_API_URL_OVERRIDES = saved;
    }
  });

  test("chat-post to a Teams id with a Bot Framework service URL still sends", async () => {
    const listener = startConnectorListener();
    const saved = process.env.CHAT_SDK_API_URL_OVERRIDES;
    // The override pins every connector call to the listener, whatever the id says.
    process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ teams: listener.url });
    try {
      setChatSdkTestHooks({ teamsToken: fakeBotToken });
      await startTeams({ appId: APP_ID, appPassword: "teams-test-password" });
      const threadId = teamsThreadId(
        "19:allowed@thread.v2",
        "https://smba.trafficmanager.net/teams/",
      );

      const result = await callChatPost({ adapter: "teams", threadId, text: "hello teams" });

      expect(result.isError).toBeFalsy();
      expect(listener.requests).toHaveLength(1);
      expect(listener.requests[0]!.method).toBe("POST");
      expect(listener.requests[0]!.path).toContain("/v3/conversations/");
      expect(listener.requests[0]!.authorization).toStartWith("Bearer ");
    } finally {
      listener.stop();
      if (saved === undefined) delete process.env.CHAT_SDK_API_URL_OVERRIDES;
      else process.env.CHAT_SDK_API_URL_OVERRIDES = saved;
    }
  });

  test("a Teams activity with an untrusted serviceUrl is refused before the adapter", async () => {
    setChatSdkTestHooks({ teamsWebhookVerifier: () => true });
    await startTeams({ appId: APP_ID, appPassword: "teams-test-password" });
    const activity = {
      ...teamsMention("19:group-three@thread.v2", "hostile tenant"),
      serviceUrl: "https://attacker.example/teams/",
    };
    const response = await postActivity(activity);
    expect(response.status).toBe(403);
    await flushChatBuffers();
    const row = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE task LIKE '%hostile tenant%'",
    );
    expect(row?.n).toBe(0);
  });
});

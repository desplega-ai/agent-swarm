import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { drainBackground } from "../integrations/chat-sdk/background";
import { stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { setChatSdkTestHooks } from "../integrations/chat-sdk/test-hooks";
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

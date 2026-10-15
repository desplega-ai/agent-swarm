import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { SlackMock } from "@desplega.ai/slack-mock";
import { closeDb, completeTask, createAgent, getDbClient, initDb } from "../be/db";
import { watchSocketConnection } from "../integrations/chat-sdk/adapters";
import { drainBackground } from "../integrations/chat-sdk/background";
import { createScrubbingLogger } from "../integrations/chat-sdk/logger";
import { processPendingChatRelays, stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { isChatThreadBuffered } from "../integrations/chat-sdk/thread-buffer";
import { getEnabledCapabilities } from "../server";
import { chatSdkContextKey } from "../tasks/context-key";
import { flushChatBuffers, postChatWebhook, snapshotChatSdkEnv } from "./chat-sdk-harness";

const TEST_DB_PATH = "./test-chat-sdk-slack.sqlite";
const SIGNING_SECRET = "mock-signing-secret";
const CHANNEL_ID = "C0GENERAL0";

let slack: SlackMock;
let leadId: string;
const restoreEnv = snapshotChatSdkEnv();

type TaskRow = {
  id: string;
  source: string;
  contextKey: string;
  agentId: string | null;
  task: string;
  dependsOn: string | null;
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

async function chatTasks(contextKey: string): Promise<TaskRow[]> {
  return getDbClient().query<TaskRow>(
    "SELECT id, source, contextKey, agentId, task, dependsOn FROM agent_tasks WHERE contextKey = ? ORDER BY createdAt, rowid",
    [contextKey],
  );
}

/**
 * Socket-mode events reach the handler after slack-mock has its ack, so poll
 * the thread buffer (bounded) instead of sleeping a fixed time.
 */
async function waitForBuffered(threadId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isChatThreadBuffered(threadId)) {
    if (Date.now() > deadline) throw new Error(`no buffered message for ${threadId}`);
    await Bun.sleep(10);
  }
  expect(await drainBackground(5_000)).toBe(true);
}

async function startSlackAdapter(mode: "socket" | "webhook"): Promise<void> {
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
    slack: {
      mode,
      botToken: slack.env.SLACK_BOT_TOKEN,
      ...(mode === "socket"
        ? { appToken: slack.env.SLACK_APP_TOKEN }
        : { signingSecret: SIGNING_SECRET }),
    },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ slack: slack.env.SLACK_API_URL });
  await startChatSdk();
  // Relay ticks are driven by the tests.
  await stopChatRelayWatcher();
  expect(getChatSdkHealth().slack?.status).toBe("ok");
}

function signedHeaders(body: string, secret = SIGNING_SECRET): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const lead = await createAgent({
    id: crypto.randomUUID(),
    name: "SlackChatLead",
    isLead: true,
    status: "idle",
    capabilities: [],
  });
  leadId = lead.id;
  slack = await SlackMock.start({
    port: 0,
    manifest: `${import.meta.dir}/../../slack-manifest.json`,
  });
  process.env.SLACK_DISABLE = "true";
  process.env.CHAT_SDK_BUFFER_MS = "60000";
});

afterAll(async () => {
  await stopChatSdk();
  await slack.stop();
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("socket connection watcher", () => {
  test("reconnecting stays info; unable_to_socket_mode_start reaches the warning sink", () => {
    const socketClient = new EventEmitter();
    const issues: string[] = [];
    const logger = createScrubbingLogger("slack", (level, message) =>
      issues.push(`${level}: ${message}`),
    );
    const quiet = spyOn(console, "info").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      watchSocketConnection({ socketClient } as never, logger);
      socketClient.emit("reconnecting");
      expect(issues).toEqual([]);
      socketClient.emit("unable_to_socket_mode_start");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("unable to start");
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("clash guard", () => {
  test("SLACK_DISABLE=true drops the built-in slack capability and keeps chat-sdk", () => {
    process.env.CHAT_SDK_ENABLED = "true";
    const capabilities = getEnabledCapabilities();
    expect(capabilities).not.toContain("slack");
    expect(capabilities).toContain("chat-sdk");
  });
});

describe("Chat SDK Slack adapter, socket mode", () => {
  let askTs: string;
  let firstTaskId: string;
  let contextKey: string;

  beforeAll(async () => {
    await startSlackAdapter("socket");
    await slack.waitForConnection();
  });

  afterAll(async () => {
    await stopChatSdk();
  });

  test("the webhook route answers the adapter's 405 in socket mode", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "c" });
    const response = await postChatWebhook("slack", body, signedHeaders(body));
    expect(response.status).toBe(405);
  });

  test("a mention creates one chat task with a slack contextKey", async () => {
    const ask = await slack.postMessage({
      channel: "general",
      user: "alice",
      text: `<@${slack.bot.userId}> summarize the open tasks`,
    });
    askTs = ask.ts;
    const threadId = `slack:${CHANNEL_ID}:${askTs}`;
    contextKey = chatSdkContextKey(threadId);
    expect(contextKey.startsWith("task:chat-sdk:slack:")).toBe(true);

    await waitForBuffered(threadId);
    await flushChatBuffers();

    const tasks = await chatTasks(contextKey);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toBe("chat");
    expect(tasks[0]!.agentId).toBe(leadId);
    expect(tasks[0]!.task).toContain("summarize the open tasks");
    firstTaskId = tasks[0]!.id;
  });

  test("a human reply while the task is pending becomes a follow-up with dependsOn", async () => {
    await slack.postMessage({
      channel: "general",
      user: "bob",
      thread_ts: askTs,
      text: "also include the failed ones",
    });
    await waitForBuffered(`slack:${CHANNEL_ID}:${askTs}`);
    await flushChatBuffers();

    const tasks = await chatTasks(contextKey);
    expect(tasks).toHaveLength(2);
    const followUp = tasks[1]!;
    expect(followUp.task).toContain("also include the failed ones");
    expect(JSON.parse(followUp.dependsOn ?? "[]")).toEqual([firstTaskId]);
  });

  test("completing the task posts its output in the Slack thread", async () => {
    await completeTask(firstTaskId, "Three tasks are open.");
    await processPendingChatRelays();
    const reply = await slack.waitForMessage(
      { channel: "general", thread_ts: askTs, from: "bot" },
      { timeoutMs: 5_000 },
    );
    expect(reply.text).toContain("Three tasks are open.");
  });
});

describe("Chat SDK Slack adapter, webhook mode", () => {
  beforeAll(async () => {
    await startSlackAdapter("webhook");
  });

  afterAll(async () => {
    await stopChatSdk();
  });

  test("a signed url_verification is answered with the challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-123" });
    const response = await postChatWebhook("slack", body, signedHeaders(body));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ challenge: "challenge-123" });
  });

  test("an unsigned or wrongly signed event_callback is rejected with 401", async () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
    const unsigned = await postChatWebhook("slack", body, { "content-type": "application/json" });
    expect(unsigned.status).toBe(401);
    const wrong = await postChatWebhook("slack", body, signedHeaders(body, "not-the-secret"));
    expect(wrong.status).toBe(401);
  });

  test("a signed app_mention creates a chat task", async () => {
    const ts = `${Math.floor(Date.now() / 1000)}.000777`;
    const body = JSON.stringify({
      type: "event_callback",
      team_id: slack.team.id,
      api_app_id: "A0MOCKAPP0",
      event_id: `Ev${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: "app_mention",
        user: "U0ALICE000",
        text: `<@${slack.bot.userId}> webhook hello`,
        ts,
        channel: CHANNEL_ID,
        event_ts: ts,
      },
    });
    const response = await postChatWebhook("slack", body, signedHeaders(body));
    expect(response.status).toBe(200);
    expect(await drainBackground(5_000)).toBe(true);
    await flushChatBuffers();

    const tasks = await chatTasks(chatSdkContextKey(`slack:${CHANNEL_ID}:${ts}`));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toBe("chat");
    expect(tasks[0]!.task).toContain("webhook hello");
  });
});

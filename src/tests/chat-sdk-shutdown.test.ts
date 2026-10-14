import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTelegramBotApiMock,
  type TelegramBotApiMock,
} from "../../scripts/dev/telegram-bot-api-mock";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDbClient,
  getPendingChatRelayTasks,
  initDb,
} from "../be/db";
import {
  getChatInstance,
  getChatSdkHealth,
  isChatSdkStopping,
  startChatSdk,
  stopChatSdk,
} from "../integrations/chat-sdk/runtime";
import { chatSdkContextKey } from "../tasks/context-key";
import type { Agent } from "../types";
import {
  postTelegramUpdate,
  snapshotChatSdkEnv,
  TELEGRAM_SECRET,
  telegramUpdate,
} from "./chat-sdk-harness";

const TEST_DB_PATH = join(tmpdir(), `test-chat-sdk-shutdown-${crypto.randomUUID()}.sqlite`);
const SEND_METHODS = /\/(sendMessage|sendRichMessage)$/;

type ObligationRow = {
  delivered_at: string | null;
  attempt_count: number;
  given_up_at: string | null;
  last_error: string | null;
};

let lead: Agent;
let mock: TelegramBotApiMock;
let proxy: ReturnType<typeof Bun.serve>;
/** While true, the proxy holds every send until `releaseHeld` answers it. */
let holdSends = false;
const held: Array<() => void> = [];
let restoreEnv: () => void;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

function releaseHeld(): void {
  for (const release of held.splice(0)) release();
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

async function obligation(taskId: string): Promise<ObligationRow | null> {
  return getDbClient().get<ObligationRow>(
    "SELECT delivered_at, attempt_count, given_up_at, last_error FROM chat_relay_obligations WHERE task_id = ?",
    [taskId],
  );
}

async function startChannel(): Promise<void> {
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
    telegram: { botToken: "t", secretToken: TELEGRAM_SECRET, mode: "webhook" },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({
    telegram: `http://127.0.0.1:${proxy.port}`,
  });
  process.env.CHAT_SDK_BUFFER_MS = "60000";
  await startChatSdk();
  expect(getChatInstance("telegram")).toBeDefined();
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  lead = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatShutdownLead",
    isLead: true,
    status: "idle",
    maxTasks: 10,
  });
  restoreEnv = snapshotChatSdkEnv();
  mock = startTelegramBotApiMock();
  // Forwards to the mock; a held send never answers until released.
  proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (holdSends && SEND_METHODS.test(url.pathname)) {
        await new Promise<void>((resolve) => held.push(resolve));
        return Response.json({ ok: false, error_code: 500, description: "held" }, { status: 500 });
      }
      return fetch(`${mock.url}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : await req.arrayBuffer(),
      });
    },
  });
});

afterAll(async () => {
  releaseHeld();
  await stopChatSdk(1_000);
  proxy.stop(true);
  mock.stop();
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("stopChatSdk", () => {
  test("a relay send that never answers cannot hold shutdown past the budget", async () => {
    await startChannel();
    holdSends = true;
    const chatId = 991_001;
    const task = await createTaskExtended("chat task", {
      agentId: lead.id,
      source: "chat",
      contextKey: chatSdkContextKey(`telegram:${chatId}`),
    });
    await completeTask(task.id, "an answer the platform never acknowledges");
    // The watcher claims the row and its send hangs in the proxy.
    await waitFor(() => held.length > 0, "the held relay send");

    const warn = spyOn(console, "warn");
    const budgetMs = 300;
    const started = performance.now();
    await stopChatSdk(budgetMs);
    const elapsed = performance.now() - started;
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();

    // Margin for scheduler jitter; without the bound this never resolves.
    expect(elapsed).toBeLessThan(budgetMs + 500);
    expect(warnings.some((line) => line.includes("abandoned: in-flight relay send"))).toBe(true);
    expect(getChatInstance("telegram")).toBeUndefined();

    // The claimed row is still pending, and it is eligible again after the
    // first backoff (3 s * 2^1), well inside the 24 h give-up age.
    const row = await obligation(task.id);
    expect(row?.delivered_at).toBeNull();
    expect(row?.given_up_at).toBeNull();
    expect(row?.attempt_count).toBe(1);
    const pending = await getPendingChatRelayTasks(Date.now() + 7_000, 200, ["telegram"]);
    expect(pending.map((entry) => entry.task.id)).toContain(task.id);

    // Let the abandoned send fail so its tick settles before the next test.
    holdSends = false;
    releaseHeld();
    await waitFor(
      async () => (await obligation(task.id))?.last_error != null,
      "the abandoned send to settle",
    );
    expect((await obligation(task.id))?.delivered_at).toBeNull();
  });

  test("with nothing in flight, shutdown flushes buffered threads and stops in order", async () => {
    await startChannel();
    const chatId = 991_002;
    const contextKey = chatSdkContextKey(`telegram:${chatId}`);
    await postTelegramUpdate(telegramUpdate({ id: chatId, type: "private" }, "please help"));
    const tasksForThread = async (): Promise<number> =>
      (
        await getDbClient().get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_tasks WHERE contextKey = ?",
          [contextKey],
        )
      )?.n ?? 0;
    // The 60 s buffer still holds the message.
    expect(await tasksForThread()).toBe(0);
    const sendsBefore = mock.calls.length;

    const warn = spyOn(console, "warn");
    await stopChatSdk(5_000);
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();

    expect(warnings.filter((line) => line.includes("Shutdown budget spent"))).toEqual([]);
    expect(isChatSdkStopping()).toBe(true);
    // The flush ran while the DB and adapters were up: the message became a task.
    expect(await tasksForThread()).toBe(1);
    expect(getChatInstance("telegram")).toBeUndefined();
    expect(getChatSdkHealth()).toEqual({});

    // The relay watcher is stopped: a later terminal task posts nothing.
    const late = await createTaskExtended("late", {
      agentId: lead.id,
      source: "chat",
      contextKey,
    });
    await completeTask(late.id, "after shutdown");
    await Bun.sleep(400);
    expect(
      mock.calls
        .slice(sendsBefore)
        // The typing action of the buffered DM may still be in flight when `sendsBefore` is read.
        .filter((call) => /send/.test(call.method) && call.method !== "sendChatAction"),
    ).toEqual([]);
    expect((await obligation(late.id))?.attempt_count).toBe(0);
  });
});

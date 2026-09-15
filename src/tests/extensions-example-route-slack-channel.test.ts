import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  createAgent,
  getDbClient,
  getKv,
  getMostRecentTaskInThread,
  initDb,
} from "../be/db";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { _resetForTests as resetSlackEventDedup } from "../slack/event-dedup";
import { registerMessageHandler, resetSlackHandlerCachesForTesting } from "../slack/handlers";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-example-route-slack-channel.sqlite";
const BOT_USER_ID = "U_EXTENSION_ROUTE_BOT";
const BOT_ID = "B_EXTENSION_ROUTE_BOT";

let messageHandler: ((args: Record<string, unknown>) => Promise<void>) | undefined;
let leadAgent: Awaited<ReturnType<typeof createAgent>>;
let workerAgent: Awaited<ReturnType<typeof createAgent>>;
let eventCounter = 0;

const handlerClient = {
  auth: { test: async () => ({ user_id: BOT_USER_ID, bot_id: BOT_ID }) },
  conversations: { replies: async () => ({ messages: [], ok: true }) },
  reactions: { add: async () => ({ ok: true }) },
  users: { info: async () => ({ ok: true, user: { profile: {} } }) },
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function sendMessage(channel: string, text: string): Promise<string> {
  const ts = `1700000000.${String(++eventCounter).padStart(6, "0")}`;
  await messageHandler!({
    event: { channel, ts, text, user: "U_EXTENSION_ROUTE_USER" },
    body: { event_id: `extension-route-${eventCounter}` },
    client: handlerClient,
    say: async () => ({}),
  });
  return ts;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out while waiting for extension event");
    await Bun.sleep(20);
  }
}

describe("extension Slack channel routing", () => {
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    process.env.ADDITIVE_SLACK = "false";
    process.env.SLACK_RENDER_V2 = "false";
    process.env.STEERING_ENABLED = "false";
    leadAgent = await createAgent({
      name: "extension-route-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    workerAgent = await createAgent({
      name: "extension-route-worker",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    registerMessageHandler({
      event: (eventType: string, handler: (args: Record<string, unknown>) => Promise<void>) => {
        if (eventType === "message") messageHandler = handler;
      },
    } as never);
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    await getDbClient().run("DELETE FROM agent_tasks");
    await getDbClient().run("DELETE FROM extensions");
    await getDbClient().run("DELETE FROM kv_entries");
    resetSlackEventDedup();
    resetSlackHandlerCachesForTesting();
  });

  test("routes the configured channel to its worker and leaves other channels with the lead", async () => {
    const bundle = await loadBundleFixture("route-channel-to-agent");
    const extension = (
      await installExtension({
        ...bundle,
        config: { channelId: "C1", agentId: workerAgent.id },
      })
    ).extension;
    await enableExtension(extension.id);

    const routedTs = await sendMessage("C1", `<@${BOT_USER_ID}> route this task`);
    expect(await getMostRecentTaskInThread("C1", routedTs)).toMatchObject({
      agentId: workerAgent.id,
      source: "slack",
    });
    expect(
      (await listExtensionRuns(extension.id)).some(
        (run) => run.event === "pre.slack.route" && run.action === "modify",
      ),
    ).toBe(true);

    const defaultTs = await sendMessage("C2", `<@${BOT_USER_ID}> use the normal route`);
    expect(await getMostRecentTaskInThread("C2", defaultTs)).toMatchObject({
      agentId: leadAgent.id,
      source: "slack",
    });
  });

  test("blocks messages in an ignored channel before task creation", async () => {
    const bundle = await loadBundleFixture("ignore-channel");
    const extension = (await installExtension({ ...bundle, config: { channelId: "C3" } }))
      .extension;
    await enableExtension(extension.id);

    const ts = await sendMessage("C3", `<@${BOT_USER_ID}> do not create a task`);
    expect(await getMostRecentTaskInThread("C3", ts)).toBeNull();
    expect(
      (await listExtensionRuns(extension.id)).some(
        (run) => run.event === "pre.slack.route" && run.action === "block",
      ),
    ).toBe(true);
  });

  test("falls back to the built-in router when an extension names an unknown agent", async () => {
    const bundle = await loadBundleFixture("route-channel-to-agent");
    const extension = (
      await installExtension({
        ...bundle,
        config: { channelId: "C4", agentId: "missing-agent" },
      })
    ).extension;
    await enableExtension(extension.id);
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const ts = await sendMessage("C4", `<@${BOT_USER_ID}> use the fallback`);
      expect(await getMostRecentTaskInThread("C4", ts)).toMatchObject({ agentId: leadAgent.id });
      expect(warn).toHaveBeenCalledWith(
        "[Slack] Extension selected an unknown agent. Using the built-in router:",
        "missing-agent",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("dispatches post.slack.message with the canonical channel and user fields", async () => {
    const bundle = await loadBundleFixture("route-channel-to-agent");
    const extension = (
      await installExtension({
        ...bundle,
        config: { channelId: "C5", agentId: workerAgent.id },
      })
    ).extension;
    const enabled = await enableExtension(extension.id);

    await sendMessage("C5", `<@${BOT_USER_ID}> record this message`);
    await waitFor(async () =>
      (await listExtensionRuns(extension.id)).some(
        (run) => run.event === "post.slack.message" && run.action === "continue",
      ),
    );
    expect(
      await getKv(`task:agent:${enabled.agentId}`, "ext:route-channel-to-agent:slack:C5"),
    ).toMatchObject({ value: "U_EXTENSION_ROUTE_USER" });
  });
});

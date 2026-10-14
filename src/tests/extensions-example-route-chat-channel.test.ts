import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, getKv, initDb } from "../be/db";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { chatSdkContextKey } from "../tasks/context-key";
import type { Agent } from "../types";
import {
  flushChatBuffers,
  postTelegramUpdate,
  startTelegramHarness,
  type TelegramHarness,
  telegramUpdate,
} from "./chat-sdk-harness";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-example-route-chat-channel.sqlite";

let harness: TelegramHarness;
let lead: Agent;
let worker: Agent;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

async function chatTask(chatId: number) {
  return getDbClient().get<{ agentId: string | null }>(
    "SELECT agentId FROM agent_tasks WHERE source = 'chat' AND contextKey = ? ORDER BY createdAt DESC LIMIT 1",
    [chatSdkContextKey(`telegram:${chatId}`)],
  );
}

/** A private-chat message, flushed out of the thread buffer. */
async function sendDm(chatId: number, text: string): Promise<void> {
  await postTelegramUpdate(telegramUpdate({ id: chatId, type: "private" }, text));
  await flushChatBuffers();
}

async function installRouteFixture(channelId: string, agentId: string) {
  const bundle = await loadBundleFixture("route-chat-channel-to-agent");
  const { extension } = await installExtension({
    ...bundle,
    config: { adapter: "telegram", channelId, agentId },
  });
  return { extension, enabled: await enableExtension(extension.id) };
}

describe("extension Chat SDK channel routing", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    lead = await createAgent({
      id: crypto.randomUUID(),
      name: "chat-route-lead",
      isLead: true,
      status: "idle",
    });
    worker = await createAgent({
      id: crypto.randomUUID(),
      name: "chat-route-worker",
      isLead: false,
      status: "idle",
    });
    harness = await startTelegramHarness();
  });

  afterAll(async () => {
    await harness.stop();
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    await getDbClient().run("DELETE FROM extensions");
  });

  test("routes the configured channel to its agent and leaves other channels with the lead", async () => {
    const { extension } = await installRouteFixture("telegram:3001", worker.id);

    await sendDm(3001, "route this to the worker");
    expect(await chatTask(3001)).toEqual({ agentId: worker.id });
    expect(
      (await listExtensionRuns(extension.id)).some(
        (run) => run.event === "pre.chat.route" && run.action === "modify",
      ),
    ).toBe(true);

    await sendDm(3002, "use the normal route");
    expect(await chatTask(3002)).toEqual({ agentId: lead.id });
  });

  test("a block creates no task", async () => {
    const bundle = await loadBundleFixture("minimal");
    const { extension } = await installExtension({
      manifest: { ...bundle.manifest, name: "block-chat-route", description: "blocks chat" },
      files: {
        "hooks.ts": `import { block, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.chat.route", () => block("chat is muted"));
};
export default extension;
`,
      },
    });
    await enableExtension(extension.id);

    await sendDm(3003, "this must not become a task");
    expect(await chatTask(3003)).toBeNull();
    const runs = await listExtensionRuns(extension.id);
    expect(runs.some((run) => run.event === "pre.chat.route" && run.action === "block")).toBe(true);
    // Ids only in the run subject: never the message text.
    expect(runs.every((run) => !run.subject?.includes("must not"))).toBe(true);
  });

  test("falls back to the built-in router when the extension names an unknown agent", async () => {
    await installRouteFixture("telegram:3004", "missing-agent");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sendDm(3004, "use the fallback");
      expect(await chatTask(3004)).toEqual({ agentId: lead.id });
      expect(warn).toHaveBeenCalledWith(
        "[chat-sdk] Extension selected an unknown agent missing-agent. Using the router.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("post.chat.message carries the inbound sender", async () => {
    const { extension, enabled } = await installRouteFixture("telegram:3005", worker.id);
    await sendDm(3005, "record this message");

    const deadline = Date.now() + 5_000;
    while (
      !(await listExtensionRuns(extension.id)).some(
        (run) => run.event === "post.chat.message" && run.action === "continue",
      ) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }
    expect(
      await getKv(
        `task:agent:${enabled.agentId}`,
        "ext:route-chat-channel-to-agent:chat:telegram:3005",
      ),
    ).toMatchObject({ value: "777001" });
  });
});

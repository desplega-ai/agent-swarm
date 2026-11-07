import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getMostRecentTaskInThread,
  initDb,
  startTask,
} from "../be/db";
import { installExtension, setExtensionState } from "../be/extensions/db";
import { registerLoaded, unregister } from "../extensions/dispatcher";
import { ensureExtensionAgent } from "../extensions/identity";
import { cleanExtensionTmpRoot, loadExtension } from "../extensions/loader";
import * as realSlackApp from "../slack/app";
import { loadBundleFixture } from "./fixtures/extensions/load";

// One helper marks a Slack message as seen but not taken: it drops the bot's
// acceptance reactions and adds SLACK_REACTION_SKIPPED (default `mute`). The
// `skipped` task status and a pre.task.create block both use it.

process.env.SLACK_RENDER_V2 = "false";

type ReactionCall = { method: "add" | "remove"; name: string; timestamp: string };
let calls: ReactionCall[] = [];

const client = {
  conversations: { replies: async () => ({ ok: true, messages: [] }) },
  users: { info: async () => ({ ok: true, user: { profile: {} } }) },
  chat: { postMessage: async () => ({ ok: true, ts: "9000.0099" }) },
  reactions: {
    add: async ({ name, timestamp }: { name: string; timestamp: string }) => {
      calls.push({ method: "add", name, timestamp });
      return { ok: true };
    },
    remove: async ({ name, timestamp }: { name: string; timestamp: string }) => {
      calls.push({ method: "remove", name, timestamp });
      return { ok: true };
    },
  },
};

mock.module("../slack/app", () => ({
  ...realSlackApp,
  getSlackApp: () => ({ client }),
}));

const { skipSlackMessageReaction, finalizeTerminalSlackReactions } = await import("../slack/ack");
const { bufferThreadMessage, instantFlush } = await import("../slack/thread-buffer");
const { completeTask, failTask, getTaskById, skipTask } = await import("../be/db");

const TEST_DB_PATH = "./test-slack-skip-reaction.sqlite";
const ACCEPTANCE_NAMES = ["eyes", "heavy_plus_sign", "zap", "speech_balloon"];
const originalSkipped = process.env.SLACK_REACTION_SKIPPED;

let workerId: string;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  await createAgent({ name: "skip-lead", isLead: true, status: "idle", capabilities: [] });
  workerId = (await createAgent({ name: "skip-worker", isLead: false, status: "idle" })).id;
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  if (originalSkipped === undefined) delete process.env.SLACK_REACTION_SKIPPED;
  else process.env.SLACK_REACTION_SKIPPED = originalSkipped;
});

beforeEach(() => {
  calls = [];
  delete process.env.SLACK_REACTION_SKIPPED;
});

async function loadBlockingExtension() {
  const bundle = await loadBundleFixture("minimal");
  const name = "slack-skip-reaction-block-test";
  bundle.manifest = { ...bundle.manifest, name };
  bundle.files[bundle.manifest.assets.hooks] = `
import { block, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => block("not for the swarm"));
};
export default extension;
`;
  const installed = await installExtension(bundle);
  const record = await setExtensionState(installed.extension.id, {
    agentId: await ensureExtensionAgent(name),
  });
  if (!record) throw new Error("Failed to load the blocking Slack test extension");
  const loaded = await loadExtension({ record, ...bundle });
  registerLoaded(loaded);
  return loaded;
}

/** Wait for the fire-and-forget reaction writes to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20 && !calls.some((call) => call.method === "add"); i++) {
    await Bun.sleep(10);
  }
}

describe("skipSlackMessageReaction", () => {
  test("drops the acceptance reactions, then adds mute by default", async () => {
    await skipSlackMessageReaction(client as never, "C1", "1.0001");
    expect(calls.filter((call) => call.method === "remove").map((call) => call.name)).toEqual(
      ACCEPTANCE_NAMES,
    );
    expect(calls.at(-1)).toEqual({ method: "add", name: "mute", timestamp: "1.0001" });
  });

  test("honours SLACK_REACTION_SKIPPED", async () => {
    process.env.SLACK_REACTION_SKIPPED = ":see_no_evil:";
    await skipSlackMessageReaction(client as never, "C1", "1.0002");
    expect(calls.at(-1)).toEqual({ method: "add", name: "see_no_evil", timestamp: "1.0002" });
  });
});

describe("pre.task.create block in the thread buffer", () => {
  test(
    "shows the configurable skip reaction instead of no_entry",
    async () => {
      const loaded = await loadBlockingExtension();
      const info = spyOn(console, "info").mockImplementation(() => {});
      try {
        bufferThreadMessage("C_SKIP_BLOCK", "15000.0001", "chatter", "U1", "15000.0002");
        await instantFlush("C_SKIP_BLOCK:15000.0001");
        expect(await getMostRecentTaskInThread("C_SKIP_BLOCK", "15000.0001")).toBeNull();
        expect(calls.map((call) => call.name)).not.toContain("no_entry");
        expect(calls.at(-1)).toEqual({ method: "add", name: "mute", timestamp: "15000.0002" });
        expect(calls.filter((call) => call.method === "remove").map((call) => call.name)).toEqual(
          ACCEPTANCE_NAMES,
        );

        calls = [];
        process.env.SLACK_REACTION_SKIPPED = "zipper_mouth_face";
        bufferThreadMessage("C_SKIP_BLOCK", "15000.0001", "more chatter", "U1", "15000.0003");
        await instantFlush("C_SKIP_BLOCK:15000.0001");
        expect(calls.at(-1)).toEqual({
          method: "add",
          name: "zipper_mouth_face",
          timestamp: "15000.0003",
        });
      } finally {
        unregister(loaded.record.id);
        await loaded.dispose();
        info.mockRestore();
        await cleanExtensionTmpRoot();
      }
    },
    { timeout: 15_000 },
  );
});

describe("terminal reaction for a skipped task", () => {
  async function slackTask(threadTs: string, trigger: string) {
    const row = await createTaskExtended("thread follow-up", {
      agentId: workerId,
      source: "slack",
      slackChannelId: "C_SKIP_TERMINAL",
      slackThreadTs: threadTs,
      slackTriggerMessageTs: trigger,
    });
    await startTask(row.id);
    return row;
  }

  test("every linked task skipped: the skip reaction", async () => {
    const task = await slackTask("16000.0001", "16000.0002");
    await skipTask(task.id, "Not mine.");
    await finalizeTerminalSlackReactions([(await getTaskById(task.id))!]);
    await settle();
    expect(calls.at(-1)).toEqual({ method: "add", name: "mute", timestamp: "16000.0002" });
  });

  test("a skip next to an answer does not mask it", async () => {
    const skipped = await slackTask("17000.0001", "17000.0002");
    const answered = await slackTask("17000.0001", "17000.0002");
    await skipTask(skipped.id, "Not mine.");
    await completeTask(answered.id, "Answered.");
    await finalizeTerminalSlackReactions([(await getTaskById(answered.id))!]);
    await settle();
    expect(calls.at(-1)).toEqual({
      method: "add",
      name: "white_check_mark",
      timestamp: "17000.0002",
    });

    calls = [];
    const failedSkip = await slackTask("18000.0001", "18000.0002");
    const failed = await slackTask("18000.0001", "18000.0002");
    await skipTask(failedSkip.id, "Not mine.");
    await failTask(failed.id, "Broke.");
    await finalizeTerminalSlackReactions([(await getTaskById(failed.id))!]);
    await settle();
    expect(calls.at(-1)?.name).toBe("x");
  });
});

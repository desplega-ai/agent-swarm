/**
 * Files shared on Slack reach the task as real attachments (MaximilianoAdaro/agent-swarm#1).
 *
 * Covers the download (bot token, size cap, Slack's HTML login page on a
 * scope miss, `files.info` fallback), the draft → promote window that keeps the
 * task unclaimable until its attachments exist, and both Slack ingress
 * handlers end to end against a real DB and the local file provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  getDbClient,
  getLogsByTaskId,
  getTaskAttachments,
  getTaskById,
  initDb,
} from "../be/db";
import { MAX_TASK_ATTACHMENT_BYTES } from "../be/task-attachment-store";
import { getFileStorageProvider, resetFileStorageProviderForTests } from "../fs/registry";
import { createAssistant } from "../slack/assistant";
import * as slackEnrichModule from "../slack/enrich";
import type { SlackFile } from "../slack/files";
import { registerMessageHandler, resetSlackHandlerCachesForTesting } from "../slack/handlers";
import {
  buildEffectiveText,
  createSlackTaskWithFiles,
  fetchSlackFiles,
  notifySlackFileFailures,
} from "../slack/inbound-files";
import { instantFlush } from "../slack/thread-buffer";

const TEST_DB_PATH = "./test-slack-inbound-files.sqlite";
const BOT_TOKEN = "xoxb-inbound-files-test";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let slackFiles: ReturnType<typeof Bun.serve>;
let fsDir: string;
const fileRequests: string[] = [];
const previousEnv = {
  AGENT_FS_LOCAL_DIR: process.env.AGENT_FS_LOCAL_DIR,
  AGENT_FS_API_URL: process.env.AGENT_FS_API_URL,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
};

// Mimics files.slack.com: the bytes with the right bearer token, Slack's HTML
// login page without it (that's what a missing `files:read` scope looks like).
function startFakeSlackFileHost() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      fileRequests.push(url.pathname);
      if (url.pathname.startsWith("/forbidden")) return new Response("nope", { status: 403 });
      if (req.headers.get("authorization") !== `Bearer ${BOT_TOKEN}`) {
        return new Response("<html><body>Sign in to Slack</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    },
  });
}

function slackFile(overrides: Partial<SlackFile> = {}): SlackFile {
  const id = overrides.id ?? "F0SHOT0001";
  return {
    id,
    name: "screenshot.png",
    mimetype: "image/png",
    filetype: "png",
    size: PNG_BYTES.byteLength,
    url_private: `${slackFiles.url}files-pri/T0-${id}/screenshot.png`,
    url_private_download: `${slackFiles.url}files-pri/T0-${id}/download/screenshot.png`,
    ...overrides,
  };
}

function slackClient(overrides: Record<string, unknown> = {}) {
  return {
    token: BOT_TOKEN,
    auth: { test: async () => ({ user_id: "U_SWARM_BOT", bot_id: "B_SWARM_BOT" }) },
    conversations: { replies: async () => ({ ok: true, messages: [] }) },
    reactions: { add: mock(async () => ({ ok: true })) },
    chat: { postMessage: mock(async () => ({ ok: true, ts: "9999999999.000001" })) },
    files: { info: mock(async () => ({ ok: false })) },
    ...overrides,
  };
}

async function readStoredBytes(taskId: string): Promise<Uint8Array[]> {
  const provider = getFileStorageProvider();
  const attachments = await getTaskAttachments(taskId);
  return Promise.all(
    attachments.map(async (a) => {
      const res = await provider.download({ taskId, name: a.name, key: a.providerKey });
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
}

async function wasDraft(taskId: string): Promise<boolean> {
  const logs = await getLogsByTaskId(taskId);
  return logs.some((l) => l.eventType === "task_status_change" && l.oldValue === "draft");
}

beforeAll(async () => {
  slackFiles = startFakeSlackFileHost();
  fsDir = await mkdtemp(join(tmpdir(), "slack-inbound-files-"));
  process.env.AGENT_FS_LOCAL_DIR = fsDir;
  delete process.env.AGENT_FS_API_URL;
  process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
  process.env.ADDITIVE_SLACK = "false";
  process.env.SLACK_RENDER_V2 = "false";
  resetFileStorageProviderForTests();
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  slackFiles.stop(true);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  await rm(fsDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetFileStorageProviderForTests();
  mock.restore();
});

beforeEach(async () => {
  fileRequests.length = 0;
  await getDbClient().run("DELETE FROM task_attachments");
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM agents");
});

describe("fetchSlackFiles", () => {
  test("downloads each file with the bot token", async () => {
    const file = slackFile();
    const inbound = await fetchSlackFiles(slackClient() as never, [file]);

    expect(inbound.failed).toEqual([]);
    expect(inbound.fetched).toHaveLength(1);
    expect(inbound.fetched[0]!.body).toEqual(PNG_BYTES);
    expect(inbound.files).toEqual([file]);
  });

  test("returns an empty result without touching Slack when there are no files", async () => {
    const inbound = await fetchSlackFiles(slackClient() as never, undefined);
    expect(inbound).toEqual({ files: [], fetched: [], failed: [] });
    expect(fileRequests).toEqual([]);
  });

  test("skips a file above the attachment cap without downloading it", async () => {
    const file = slackFile({ size: MAX_TASK_ATTACHMENT_BYTES + 1 });
    const inbound = await fetchSlackFiles(slackClient() as never, [file]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed).toHaveLength(1);
    expect(inbound.failed[0]!.reason).toContain("50 MB");
    expect(fileRequests).toEqual([]);
  });

  test("reports a non-2xx download", async () => {
    const file = slackFile({ url_private_download: `${slackFiles.url}forbidden/x.png` });
    const inbound = await fetchSlackFiles(slackClient() as never, [file]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("HTTP 403");
  });

  test("treats Slack's HTML login page as a failure, not as the file", async () => {
    const inbound = await fetchSlackFiles(slackClient({ token: "xoxb-wrong" }) as never, [
      slackFile(),
    ]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("files:read");
  });

  test("resolves a file that arrives without a download URL through files.info", async () => {
    const full = slackFile({ id: "F0CONNECT1" });
    const info = mock(async () => ({ ok: true, file: full }));
    const bare = { id: "F0CONNECT1" } as SlackFile;

    const inbound = await fetchSlackFiles(slackClient({ files: { info } }) as never, [bare]);

    expect(info).toHaveBeenCalledWith({ file: "F0CONNECT1" });
    expect(inbound.files[0]!.name).toBe("screenshot.png");
    expect(inbound.fetched).toHaveLength(1);
  });

  test("reports a file with no download URL anywhere", async () => {
    const bare = { id: "F0HIDDEN01", name: "hidden.png", mimetype: "image/png" } as SlackFile;
    const inbound = await fetchSlackFiles(slackClient() as never, [bare]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("download URL");
  });

  test("scrubs secrets out of a download error before it reaches the task or Slack", async () => {
    const file = slackFile({ url_private_download: "http://127.0.0.1:1/x.png" });
    const failing = spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      throw new Error(`upstream rejected ${BOT_TOKEN}`);
    });
    try {
      const inbound = await fetchSlackFiles(slackClient() as never, [file]);
      expect(inbound.failed[0]!.reason).toContain("download failed");
      expect(inbound.failed[0]!.reason).not.toContain(BOT_TOKEN);
    } finally {
      failing.mockRestore();
    }
  });
});

describe("buildEffectiveText", () => {
  test("marks the files that could not be attached", () => {
    const ok = slackFile({ id: "F0OK000001", name: "ok.png" });
    const bad = slackFile({ id: "F0BAD00001", name: "bad.png" });
    const text = buildEffectiveText("look", [ok, bad], [{ file: bad, reason: "HTTP 403" }]);

    expect(text).toContain("[File: ok.png (image/png, 11 B) id=F0OK000001]\n");
    expect(text).toContain(
      "[File: bad.png (image/png, 11 B) id=F0BAD00001] (not attached: HTTP 403)",
    );
  });

  test("still renders a readable line for a file Slack gave only an id for", () => {
    const bare = { id: "F0BARE0001" } as SlackFile;
    expect(
      buildEffectiveText("", [bare], [{ file: bare, reason: "Slack gave no download URL" }]),
    ).toBe(
      "[File: F0BARE0001 (unknown type, unknown size) id=F0BARE0001] (not attached: Slack gave no download URL)",
    );
  });
});

describe("createSlackTaskWithFiles", () => {
  test("holds the task in draft until its attachments land, then promotes it", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    const inbound = await fetchSlackFiles(slackClient() as never, [slackFile()]);

    const { task, unattached } = await createSlackTaskWithFiles(
      "please look",
      { agentId: lead.id, source: "slack" },
      inbound,
    );

    expect(unattached).toEqual([]);
    expect((await getTaskById(task.id))!.status).toBe("pending");
    expect(await wasDraft(task.id)).toBe(true);

    const [attachment] = await getTaskAttachments(task.id);
    expect(attachment).toMatchObject({
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
      intent: "user-upload",
    });
    expect(attachment!.sha256).toBe(new Bun.CryptoHasher("sha256").update(PNG_BYTES).digest("hex"));
    expect(await readStoredBytes(task.id)).toEqual([PNG_BYTES]);
  });

  test("creates the task normally when nothing was downloaded", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });

    const { task } = await createSlackTaskWithFiles(
      "just text",
      { agentId: lead.id, source: "slack" },
      { files: [], fetched: [], failed: [] },
    );

    expect(task.status).toBe("pending");
    expect(await wasDraft(task.id)).toBe(false);
    expect(await getTaskAttachments(task.id)).toEqual([]);
  });

  test("keeps two files that share a name", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    const inbound = await fetchSlackFiles(slackClient() as never, [
      slackFile({ id: "F0IMAGE001", name: "image.png" }),
      slackFile({ id: "F0IMAGE002", name: "image.png" }),
    ]);
    // Same bytes would dedupe by sha256; make the second one different.
    inbound.fetched[1]!.body = new Uint8Array([...PNG_BYTES, 4]);

    const { task } = await createSlackTaskWithFiles("two", { agentId: lead.id }, inbound);

    const names = (await getTaskAttachments(task.id)).map((a) => a.name).sort();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  test("reports download failures as unattached even when nothing was stored", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    const file = slackFile({ url_private_download: `${slackFiles.url}forbidden/x.png` });
    const inbound = await fetchSlackFiles(slackClient() as never, [file]);

    const { unattached } = await createSlackTaskWithFiles("x", { agentId: lead.id }, inbound);

    expect(unattached).toEqual(inbound.failed);
  });

  test("still promotes the task when storing an attachment fails", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    const inbound = await fetchSlackFiles(slackClient() as never, [slackFile()]);
    const upload = spyOn(getFileStorageProvider(), "upload").mockImplementationOnce(async () => {
      throw new Error("storage down");
    });

    try {
      const { task, unattached } = await createSlackTaskWithFiles(
        "x",
        { agentId: lead.id },
        inbound,
      );

      expect((await getTaskById(task.id))!.status).toBe("pending");
      expect(unattached).toHaveLength(1);
      expect(unattached[0]!.reason).toContain("storage down");
    } finally {
      upload.mockRestore();
    }
  });
});

describe("notifySlackFileFailures", () => {
  test("posts one thread reply naming every file that was not attached", async () => {
    const client = slackClient();
    await notifySlackFileFailures(client as never, "D0DM", "1700000000.000001", [
      { file: slackFile({ id: "F0A0000001", name: "a.png" }), reason: "HTTP 403" },
      { file: slackFile({ id: "F0B0000001", name: "b.pdf" }), reason: "larger than 50 MB" },
      // The same file failing on a second task is listed once.
      { file: slackFile({ id: "F0A0000001", name: "a.png" }), reason: "HTTP 403" },
    ]);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const [args] = client.chat.postMessage.mock.calls[0] as unknown as [
      { channel: string; thread_ts: string; text: string },
    ];
    expect(args.channel).toBe("D0DM");
    expect(args.thread_ts).toBe("1700000000.000001");
    expect(args.text).toContain("`a.png` (HTTP 403)");
    expect(args.text).toContain("`b.pdf` (larger than 50 MB)");
    expect(args.text.split("`a.png`")).toHaveLength(2);
  });

  test("stays quiet when every file was attached", async () => {
    const client = slackClient();
    await notifySlackFileFailures(client as never, "D0DM", "1700000000.000001", []);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe("Slack ingress with files", () => {
  const resolveSlackUserIdSpy = spyOn(slackEnrichModule, "resolveSlackUserId");
  let assistantMessage: (args: Record<string, unknown>) => Promise<void>;
  let channelMessage: (args: Record<string, unknown>) => Promise<void>;
  let seq = 0;

  beforeAll(() => {
    resolveSlackUserIdSpy.mockImplementation(async () => undefined);
    resetSlackHandlerCachesForTesting();
    assistantMessage = (
      createAssistant() as never as {
        userMessage: Array<(args: Record<string, unknown>) => Promise<void>>;
      }
    ).userMessage[0]!;
    registerMessageHandler({
      event: (type: string, handler: (args: Record<string, unknown>) => Promise<void>) => {
        if (type === "message") channelMessage = handler;
      },
    } as never);
  });

  afterAll(() => {
    resolveSlackUserIdSpy.mockRestore();
  });

  async function sendAssistantDm(message: Record<string, unknown>, client = slackClient()) {
    seq += 1;
    const ts = `1800000000.${String(seq).padStart(6, "0")}`;
    await assistantMessage({
      message: {
        channel: `D0ASSIST${seq}`,
        thread_ts: ts,
        ts,
        user: "U_HUMAN",
        subtype: "file_share",
        ...message,
      },
      body: { event_id: `evt_inbound_files_${seq}` },
      client,
      say: mock(async () => ({})),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
    });
    const row = await getDbClient().get<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE slackTriggerMessageTs = ?",
      [ts],
    );
    return { client, task: row ? await getTaskById(row.id) : null };
  }

  test("an image with no text creates a task that carries the image (case 1)", async () => {
    await createAgent({ name: "lead", isLead: true, status: "idle" });

    const { task } = await sendAssistantDm({ text: "", files: [slackFile()] });

    expect(task).not.toBeNull();
    expect(task!.task).toContain("[File: screenshot.png (image/png, 11 B) id=F0SHOT0001]");
    expect(task!.status).toBe("pending");
    expect(await readStoredBytes(task!.id)).toEqual([PNG_BYTES]);
  });

  test("an image with a caption keeps both the caption and the image (case 2)", async () => {
    await createAgent({ name: "lead", isLead: true, status: "idle" });

    const { task } = await sendAssistantDm({ text: "aaa", files: [slackFile()] });

    expect(task!.task.startsWith("aaa")).toBe(true);
    expect(task!.task).toContain("[File: screenshot.png");
    expect(await getTaskAttachments(task!.id)).toHaveLength(1);
  });

  test("a file that cannot be downloaded is flagged to the agent and to the user", async () => {
    await createAgent({ name: "lead", isLead: true, status: "idle" });
    const file = slackFile({ url_private_download: `${slackFiles.url}forbidden/x.png` });

    const { client, task } = await sendAssistantDm({ text: "", files: [file] });

    expect(task!.task).toContain("(not attached: download failed (HTTP 403))");
    expect(await getTaskAttachments(task!.id)).toEqual([]);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const [args] = client.chat.postMessage.mock.calls[0] as unknown as [{ text: string }];
    expect(args.text).toContain("`screenshot.png`");
  });

  test("a follow-up image to the agent already on the thread is attached too", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { task: first } = await sendAssistantDm({ subtype: undefined, text: "start" });
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);

    seq += 1;
    const ts = `1800000000.${String(seq).padStart(6, "0")}`;
    await assistantMessage({
      message: {
        channel: first!.slackChannelId,
        thread_ts: first!.slackThreadTs,
        ts,
        user: "U_HUMAN",
        subtype: "file_share",
        text: "",
        files: [slackFile()],
      },
      body: { event_id: `evt_inbound_files_${seq}` },
      client: slackClient(),
      say: mock(async () => ({})),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
    });

    const followUp = await getDbClient().get<{ id: string; agentId: string }>(
      "SELECT id, agentId FROM agent_tasks WHERE slackTriggerMessageTs = ?",
      [ts],
    );
    expect(followUp?.agentId).toBe(lead.id);
    expect(await getTaskAttachments(followUp!.id)).toHaveLength(1);
  });

  test("a follow-up queued by ADDITIVE_SLACK says its file was not attached", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { task: first } = await sendAssistantDm({ subtype: undefined, text: "start" });
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);
    process.env.ADDITIVE_SLACK = "true";
    const client = slackClient();

    try {
      seq += 1;
      await assistantMessage({
        message: {
          channel: first!.slackChannelId,
          thread_ts: first!.slackThreadTs,
          ts: `1800000000.${String(seq).padStart(6, "0")}`,
          user: "U_HUMAN",
          subtype: "file_share",
          text: "",
          files: [slackFile()],
        },
        body: { event_id: `evt_inbound_files_${seq}` },
        client,
        say: mock(async () => ({})),
        setStatus: mock(async () => {}),
        setTitle: mock(async () => {}),
        getThreadContext: mock(async () => ({})),
      });
    } finally {
      process.env.ADDITIVE_SLACK = "false";
    }

    expect(fileRequests).toEqual([]);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const [args] = client.chat.postMessage.mock.calls[0] as unknown as [{ text: string }];
    expect(args.text).toContain("`screenshot.png` (follow-ups queued by ADDITIVE_SLACK");

    // Drain the debounce buffer now, while the DB is still open.
    await instantFlush(`${first!.slackChannelId}:${first!.slackThreadTs}`);
    const queued = await getDbClient().get<{ task: string }>(
      "SELECT task FROM agent_tasks WHERE slackThreadTs = ? AND id != ? ORDER BY createdAt DESC",
      [first!.slackThreadTs, first!.id],
    );
    expect(queued?.task).toContain("(not attached: follow-ups queued by ADDITIVE_SLACK");
  });

  test("a channel message that mentions the bot with a file attaches it", async () => {
    await createAgent({ name: "lead", isLead: true, status: "idle" });
    seq += 1;
    const ts = `1900000000.${String(seq).padStart(6, "0")}`;

    await channelMessage({
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C0CHANNEL1",
        ts,
        user: "U_HUMAN",
        text: "<@U_SWARM_BOT> what is this?",
        files: [slackFile()],
      },
      body: { event_id: `evt_inbound_files_${seq}` },
      client: slackClient(),
      say: mock(async () => ({ ts: "1900000000.999999" })),
    });

    const row = await getDbClient().get<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE slackTriggerMessageTs = ?",
      [ts],
    );
    expect(row).not.toBeNull();
    expect(await readStoredBytes(row!.id)).toEqual([PNG_BYTES]);
  });
});

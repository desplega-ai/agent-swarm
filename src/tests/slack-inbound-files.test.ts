/**
 * Files shared on Slack reach the task as real attachments.
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
  createTaskExtended,
  getDbClient,
  getLogsByTaskId,
  getTaskAttachments,
  getTaskById,
  initDb,
  promoteAbandonedDraftTasks,
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
  setDraftLeaseRefreshMsForTests,
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
  STEERING_ENABLED: process.env.STEERING_ENABLED,
  SLACK_THREAD_STEERING: process.env.SLACK_THREAD_STEERING,
};

const HTML_FILE = new TextEncoder().encode("<html><body>quarterly report</body></html>");
const HUGE_BYTES = MAX_TASK_ATTACHMENT_BYTES + 16 * 1024 * 1024;
/** Per Slack file id bytes the fake host serves; PNG_BYTES by default. */
const bytesById = new Map<string, Uint8Array>();

// Mimics files.slack.com: the bytes with the right bearer token; without it
// (what a missing `files:read` scope looks like) a redirect to Slack's HTML
// sign-in page.
function startFakeSlackFileHost() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      fileRequests.push(url.pathname);
      const signIn = () =>
        new Response("<html><body>Sign in to Slack</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (url.pathname === "/signin") return signIn();
      // A sign-in page served in place, at the file's own URL.
      if (url.pathname.startsWith("/login-in-place")) return signIn();
      if (url.pathname.startsWith("/forbidden")) return new Response("nope", { status: 403 });
      if (req.headers.get("authorization") !== `Bearer ${BOT_TOKEN}`) {
        return Response.redirect(
          `${url.origin}/signin?redir=${encodeURIComponent(url.pathname)}`,
          302,
        );
      }
      if (url.pathname.includes("report.html")) {
        return new Response(HTML_FILE, { headers: { "content-type": "text/html" } });
      }
      const id = /\/T0-([A-Z0-9]+)\//.exec(url.pathname)?.[1] ?? "";
      return new Response(bytesById.get(id) ?? PNG_BYTES, {
        headers: { "content-type": "image/png" },
      });
    },
  });
}

/** Resolves once `release()` is called; lets a test hold a provider upload open. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
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

/** A real HTML file on Slack, served as `text/html` with the right token. */
function htmlReport(): SlackFile {
  return slackFile({
    id: "F0HTML0001",
    name: "report.html",
    mimetype: "text/html",
    size: HTML_FILE.byteLength,
    url_private_download: `${slackFiles.url}files-pri/T0-F0HTML0001/download/report.html`,
  });
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
  bytesById.clear();
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
    const [fetched] = inbound.fetched;
    expect(new Uint8Array(await Bun.file(fetched!.path).arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetched!.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(fetched!.sha256).toBe(new Bun.CryptoHasher("sha256").update(PNG_BYTES).digest("hex"));
    expect(inbound.files).toEqual([file]);

    // Disposing the batch removes the downloaded copies.
    await inbound[Symbol.asyncDispose]();
    expect(await Bun.file(fetched!.path).exists()).toBe(false);
  });

  test("keeps a real HTML file Slack serves", async () => {
    await using inbound = await fetchSlackFiles(slackClient() as never, [htmlReport()]);

    expect(inbound.failed).toEqual([]);
    expect(inbound.fetched).toHaveLength(1);
  });

  test("rejects Slack's sign-in page for an HTML file too", async () => {
    await using inbound = await fetchSlackFiles(slackClient({ token: "xoxb-wrong" }) as never, [
      htmlReport(),
    ]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("files:read");
  });

  test("rejects an HTML sign-in page served in place, by its size", async () => {
    const file = slackFile({
      id: "F0HTML0002",
      name: "notes.html",
      mimetype: "text/html",
      size: 4096,
      url_private_download: `${slackFiles.url}login-in-place/T0-F0HTML0002/notes.html`,
    });
    await using inbound = await fetchSlackFiles(slackClient() as never, [file]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("4096-byte file");
  });

  test("stops reading at the attachment cap instead of buffering the whole body", async () => {
    // Slack sometimes omits `size`; the cap still has to hold while streaming.
    // The body only produces a chunk when it is read, so `pulled` counts exactly
    // what the download consumed — independent of any HTTP server's buffering.
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= HUGE_BYTES) return controller.close();
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => new Response(body, { headers: { "content-type": "application/octet-stream" } }),
    );
    const file = slackFile({
      id: "F0HUGE0001",
      name: "huge.bin",
      mimetype: "application/octet-stream",
      size: 0,
    });

    try {
      await using inbound = await fetchSlackFiles(slackClient() as never, [file]);

      expect(inbound.fetched).toEqual([]);
      expect(inbound.failed[0]!.reason).toContain("50 MB");
      expect(cancelled).toBe(true);
      expect(pulled).toBeLessThanOrEqual(MAX_TASK_ATTACHMENT_BYTES + 2 * chunk.byteLength);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("returns an empty result without touching Slack when there are no files", async () => {
    await using inbound = await fetchSlackFiles(slackClient() as never, undefined);
    expect([inbound.files, inbound.fetched, inbound.failed]).toEqual([[], [], []]);
    expect(fileRequests).toEqual([]);
  });

  test("skips a file above the attachment cap without downloading it", async () => {
    const file = slackFile({ size: MAX_TASK_ATTACHMENT_BYTES + 1 });
    await using inbound = await fetchSlackFiles(slackClient() as never, [file]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed).toHaveLength(1);
    expect(inbound.failed[0]!.reason).toContain("50 MB");
    expect(fileRequests).toEqual([]);
  });

  test("reports a non-2xx download", async () => {
    const file = slackFile({ url_private_download: `${slackFiles.url}forbidden/x.png` });
    await using inbound = await fetchSlackFiles(slackClient() as never, [file]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("HTTP 403");
  });

  test("treats Slack's HTML login page as a failure, not as the file", async () => {
    await using inbound = await fetchSlackFiles(slackClient({ token: "xoxb-wrong" }) as never, [
      slackFile(),
    ]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("files:read");
  });

  test("resolves a file that arrives without a download URL through files.info", async () => {
    const full = slackFile({ id: "F0CONNECT1" });
    const info = mock(async () => ({ ok: true, file: full }));
    const bare = { id: "F0CONNECT1" } as SlackFile;

    await using inbound = await fetchSlackFiles(slackClient({ files: { info } }) as never, [bare]);

    expect(info).toHaveBeenCalledWith({ file: "F0CONNECT1" });
    expect(inbound.files[0]!.name).toBe("screenshot.png");
    expect(inbound.fetched).toHaveLength(1);
  });

  test("reports a file with no download URL anywhere", async () => {
    const bare = { id: "F0HIDDEN01", name: "hidden.png", mimetype: "image/png" } as SlackFile;
    await using inbound = await fetchSlackFiles(slackClient() as never, [bare]);

    expect(inbound.fetched).toEqual([]);
    expect(inbound.failed[0]!.reason).toContain("download URL");
  });

  test("scrubs secrets out of a download error before it reaches the task or Slack", async () => {
    const file = slackFile({ url_private_download: "http://127.0.0.1:1/x.png" });
    const failing = spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      throw new Error(`upstream rejected ${BOT_TOKEN}`);
    });
    try {
      await using inbound = await fetchSlackFiles(slackClient() as never, [file]);
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
    await using inbound = await fetchSlackFiles(slackClient() as never, [slackFile()]);

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
      await fetchSlackFiles(slackClient() as never, []),
    );

    expect(task.status).toBe("pending");
    expect(await wasDraft(task.id)).toBe(false);
    expect(await getTaskAttachments(task.id)).toEqual([]);
  });

  test("keeps two files that share a name", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    // Same bytes would dedupe by sha256; make the second one different.
    const second = new Uint8Array([...PNG_BYTES, 4]);
    bytesById.set("F0IMAGE002", second);
    await using inbound = await fetchSlackFiles(slackClient() as never, [
      slackFile({ id: "F0IMAGE001", name: "image.png" }),
      slackFile({ id: "F0IMAGE002", name: "image.png", size: second.byteLength }),
    ]);

    const { task } = await createSlackTaskWithFiles("two", { agentId: lead.id }, inbound);

    const names = (await getTaskAttachments(task.id)).map((a) => a.name).sort();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  test("reports download failures as unattached even when nothing was stored", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    const file = slackFile({ url_private_download: `${slackFiles.url}forbidden/x.png` });
    await using inbound = await fetchSlackFiles(slackClient() as never, [file]);

    const { unattached } = await createSlackTaskWithFiles("x", { agentId: lead.id }, inbound);

    expect(unattached).toEqual(inbound.failed);
  });

  test("still promotes the task when storing an attachment fails", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    await using inbound = await fetchSlackFiles(slackClient() as never, [slackFile()]);
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

  test("a slow upload keeps the draft out of the abandoned-draft sweep", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    await using inbound = await fetchSlackFiles(slackClient() as never, [slackFile()]);
    const provider = getFileStorageProvider();
    const realUpload = provider.upload.bind(provider);
    const held = gate();
    const upload = spyOn(provider, "upload").mockImplementation(async (...args) => {
      await held.opened;
      return realUpload(...args);
    });
    const previousInterval = setDraftLeaseRefreshMsForTests(20);

    try {
      const creating = createSlackTaskWithFiles("slow", { agentId: lead.id }, inbound);
      let draftId: string | undefined;
      for (let i = 0; i < 100 && !draftId; i++) {
        await Bun.sleep(5);
        draftId = (
          await getDbClient().get<{ id: string }>(
            "SELECT id FROM agent_tasks WHERE status = 'draft' AND task = 'slow'",
          )
        )?.id;
      }
      expect(draftId).toBeDefined();

      // Pretend the upload has been running for ten minutes.
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        tenMinutesAgo,
        draftId!,
      ]);
      // Wait for the lease to be renewed (the draft's clock moves forward again).
      let renewed = false;
      for (let i = 0; i < 400 && !renewed; i++) {
        await Bun.sleep(5);
        const row = await getDbClient().get<{ lastUpdatedAt: string }>(
          "SELECT lastUpdatedAt FROM agent_tasks WHERE id = ?",
          [draftId!],
        );
        renewed = !!row && row.lastUpdatedAt > tenMinutesAgo;
      }
      expect(renewed).toBe(true);

      expect(await promoteAbandonedDraftTasks(5)).toBe(0);
      expect((await getTaskById(draftId!))!.status).toBe("draft");

      held.release();
      const { task } = await creating;
      expect((await getTaskById(task.id))!.status).toBe("pending");
      expect(await getTaskAttachments(task.id)).toHaveLength(1);
    } finally {
      held.release();
      upload.mockRestore();
      setDraftLeaseRefreshMsForTests(previousInterval);
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

  function restoreSteeringEnv() {
    for (const key of ["STEERING_ENABLED", "SLACK_THREAD_STEERING"] as const) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

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
    // instantFlush steers into the running session when steering is on; this
    // asserts the task-creating path, so keep steering off whatever the env says.
    process.env.STEERING_ENABLED = "false";
    delete process.env.SLACK_THREAD_STEERING;
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

    try {
      await assertQueuedFollowUp();
    } finally {
      restoreSteeringEnv();
    }

    async function assertQueuedFollowUp() {
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
    }
  });

  test("a !now follow-up with a file says the file was not attached", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const threadTs = "1950000000.000001";
    const earlier = await createTaskExtended("earlier work", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C0NOWTEST1",
      slackThreadTs: threadTs,
    });
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      earlier.id,
    ]);
    process.env.ADDITIVE_SLACK = "true";
    process.env.STEERING_ENABLED = "false";
    delete process.env.SLACK_THREAD_STEERING;
    const client = slackClient();
    seq += 1;

    try {
      await channelMessage({
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C0NOWTEST1",
          thread_ts: threadTs,
          ts: `1950000001.${String(seq).padStart(6, "0")}`,
          user: "U_HUMAN",
          text: "!now here it is",
          files: [slackFile()],
        },
        body: { event_id: `evt_inbound_files_${seq}` },
        client,
        say: mock(async () => ({})),
      });
    } finally {
      process.env.ADDITIVE_SLACK = "false";
      restoreSteeringEnv();
    }

    expect(fileRequests).toEqual([]);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const [args] = client.chat.postMessage.mock.calls[0] as unknown as [{ text: string }];
    expect(args.text).toContain("`screenshot.png`");
    const flushed = await getDbClient().get<{ task: string }>(
      "SELECT task FROM agent_tasks WHERE slackThreadTs = ? AND task != 'earlier work'",
      [threadTs],
    );
    expect(flushed?.task).toContain("here it is");
    expect(flushed?.task).toContain("(not attached: follow-ups queued by ADDITIVE_SLACK");
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

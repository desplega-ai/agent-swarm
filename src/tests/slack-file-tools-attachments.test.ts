/**
 * `slack-download-file` and `slack-read` store Slack files as attachments of
 * the calling agent's task instead of on the API server's disk, where a worker
 * container can't read them (MaximilianoAdaro/agent-swarm#4).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskAttachments,
  initDb,
} from "../be/db";
import { getFileStorageProvider, resetFileStorageProviderForTests } from "../fs/registry";
import type { SlackFile } from "../slack/files";
import { createSlackTaskWithFiles, fetchSlackFiles } from "../slack/inbound-files";

const TEST_DB_PATH = "./test-slack-file-tools-attachments.sqlite";
const BOT_TOKEN = "xoxb-file-tools-test";
const AGENT_ID = "aaaaaaaa-0000-4000-8000-00000000f001";
const OTHER_ID = "aaaaaaaa-0000-4000-8000-00000000f002";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const PNG_2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8, 8]);

let host: ReturnType<typeof Bun.serve>;
let fsDir: string;
const slackFiles = new Map<string, SlackFile>();
const bytesById = new Map<string, Uint8Array>();
let threadMessages: Array<Record<string, unknown>> = [];

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      token: BOT_TOKEN,
      auth: { test: async () => ({ user_id: "U_BOT" }) },
      users: { info: async ({ user }: { user: string }) => ({ user: { real_name: user } }) },
      files: {
        info: async ({ file }: { file: string }) =>
          slackFiles.has(file) ? { ok: true, file: slackFiles.get(file) } : { ok: false },
      },
      conversations: {
        replies: async () => ({ messages: threadMessages }),
        history: async () => ({ messages: threadMessages }),
      },
    },
  }),
  initSlackApp: async () => null,
  startSlackApp: async () => {},
  stopSlackApp: async () => {},
}));

function addSlackFile(id: string, name: string, bytes: Uint8Array, path = "files-pri"): SlackFile {
  const file: SlackFile = {
    id,
    name,
    mimetype: "image/png",
    filetype: "png",
    size: bytes.byteLength,
    url_private: `${host.url}${path}/T0TEAM-${id}/${name}`,
    url_private_download: `${host.url}${path}/T0TEAM-${id}/download/${name}`,
  };
  slackFiles.set(id, file);
  bytesById.set(id, bytes);
  return file;
}

type ToolResult = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: unknown, extra: unknown) => Promise<ToolResult>;
let downloadTool: Handler;
let readTool: Handler;

function extra(headers: Record<string, string>) {
  return {
    sessionId: "file-tools-test",
    requestInfo: { headers: { "x-agent-id": AGENT_ID, ...headers } },
  };
}

async function storedBytes(taskId: string, name: string): Promise<Uint8Array> {
  const attachment = (await getTaskAttachments(taskId)).find((a) => a.name === name);
  if (!attachment) throw new Error(`no attachment named ${name}`);
  const res = await getFileStorageProvider().download({
    taskId,
    name: attachment.name,
    key: attachment.providerKey,
  });
  return new Uint8Array(await res.arrayBuffer());
}

let taskId: string;
let othersTaskId: string;

beforeAll(async () => {
  host = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/forbidden")) return new Response("nope", { status: 403 });
      if (req.headers.get("authorization") !== `Bearer ${BOT_TOKEN}`) {
        return new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } });
      }
      const id = /T0TEAM-([A-Z0-9]+)\//.exec(url.pathname)?.[1] ?? "";
      const bytes = bytesById.get(id);
      return bytes
        ? new Response(bytes, { headers: { "content-type": "image/png" } })
        : new Response("missing", { status: 404 });
    },
  });
  fsDir = await mkdtemp(join(tmpdir(), "slack-file-tools-"));
  process.env.AGENT_FS_LOCAL_DIR = fsDir;
  delete process.env.AGENT_FS_API_URL;
  process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
  resetFileStorageProviderForTests();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  initDb(TEST_DB_PATH);
  await createAgent({ id: AGENT_ID, name: "Worker", isLead: false, status: "idle" });
  await createAgent({ id: OTHER_ID, name: "Other", isLead: false, status: "idle" });

  const [{ registerSlackDownloadFileTool }, { registerSlackReadTool }] = await Promise.all([
    import("../tools/slack-download-file"),
    import("../tools/slack-read"),
  ]);
  const server = new McpServer({ name: "slack-file-tools", version: "1.0.0" });
  registerSlackDownloadFileTool(server);
  registerSlackReadTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })
    ._registeredTools;
  downloadTool = tools["slack-download-file"]!.handler;
  readTool = tools["slack-read"]!.handler;
});

afterAll(async () => {
  host.stop(true);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  await rm(fsDir, { recursive: true, force: true });
  delete process.env.AGENT_FS_LOCAL_DIR;
  delete process.env.SLACK_BOT_TOKEN;
  resetFileStorageProviderForTests();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM task_attachments");
  await getDbClient().run("DELETE FROM agent_tasks");
  slackFiles.clear();
  bytesById.clear();
  taskId = (
    await createTaskExtended("look at the thread", {
      agentId: AGENT_ID,
      slackChannelId: "C0THREAD",
      slackThreadTs: "1700000000.000100",
    })
  ).id;
  othersTaskId = (await createTaskExtended("not yours", { agentId: OTHER_ID })).id;
});

describe("slack-download-file", () => {
  test("attaches the file to the task the agent is working on", async () => {
    addSlackFile("F0SHOT0001", "screenshot.png", PNG);

    const result = await downloadTool(
      { fileId: "F0SHOT0001" },
      extra({ "x-source-task-id": taskId }),
    );

    expect(result.isError).toBeFalsy();
    const [attachment] = await getTaskAttachments(taskId);
    expect(attachment?.name).toBe("screenshot.png");
    expect(result.structuredContent.attachmentId).toBe(attachment!.id);
    expect(result.structuredContent.taskId).toBe(taskId);
    expect(String(result.structuredContent.fetchCommand)).toContain(
      `/api/fs/tasks/${taskId}/files/${attachment!.id}/raw" --create-dirs -o '/tmp/attachments/${attachment!.id}/screenshot.png'`,
    );
    expect(await storedBytes(taskId, "screenshot.png")).toEqual(PNG);
  });

  test("an explicit taskId the agent doesn't own is refused", async () => {
    addSlackFile("F0SHOT0001", "screenshot.png", PNG);

    const result = await downloadTool(
      { fileId: "F0SHOT0001", taskId: othersTaskId },
      extra({ "x-source-task-id": taskId }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent.message)).toContain("don't have context");
    expect(await getTaskAttachments(othersTaskId)).toEqual([]);
  });

  test("downloading the same file twice keeps one attachment", async () => {
    addSlackFile("F0SHOT0001", "screenshot.png", PNG);
    const first = await downloadTool(
      { fileId: "F0SHOT0001" },
      extra({ "x-source-task-id": taskId }),
    );
    const second = await downloadTool(
      { fileId: "F0SHOT0001" },
      extra({ "x-source-task-id": taskId }),
    );

    expect(second.structuredContent.attachmentId).toBe(first.structuredContent.attachmentId);
    expect(await getTaskAttachments(taskId)).toHaveLength(1);
  });

  test("a second file with a name already taken doesn't overwrite the first", async () => {
    addSlackFile("F0IMAGE001", "image.png", PNG);
    addSlackFile("F0IMAGE002", "image.png", PNG_2);
    await downloadTool({ fileId: "F0IMAGE001" }, extra({ "x-source-task-id": taskId }));
    await downloadTool({ fileId: "F0IMAGE002" }, extra({ "x-source-task-id": taskId }));

    const names = (await getTaskAttachments(taskId)).map((a) => a.name).sort();
    expect(names).toEqual(["F0IMAGE002-image.png", "image.png"]);
    expect(await storedBytes(taskId, "image.png")).toEqual(PNG);
    expect(await storedBytes(taskId, "F0IMAGE002-image.png")).toEqual(PNG_2);
  });

  test("a file Slack won't serve is an error, not an attachment", async () => {
    addSlackFile("F0DENIED01", "denied.png", PNG, "forbidden");

    const result = await downloadTool(
      { fileId: "F0DENIED01" },
      extra({ "x-source-task-id": taskId }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent.message)).toContain("HTTP 403");
    expect(await getTaskAttachments(taskId)).toEqual([]);
  });

  test("a url_private_download URL alone is enough", async () => {
    const file = addSlackFile("F0BYURL001", "by-url.png", PNG);

    const result = await downloadTool(
      { url: file.url_private_download },
      extra({ "x-source-task-id": taskId }),
    );

    expect(result.isError).toBeFalsy();
    expect(await storedBytes(taskId, "by-url.png")).toEqual(PNG);
  });

  test("without a task it still saves on the API server, and says so", async () => {
    addSlackFile("F0SHOT0001", "screenshot.png", PNG);
    const dir = join(fsDir, "legacy");

    const result = await downloadTool({ fileId: "F0SHOT0001", savePath: `${dir}/` }, extra({}));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.savedPath).toBe(`${dir}/screenshot.png`);
    expect(String(result.structuredContent.message)).toContain("on the API server");
    expect(String(result.structuredContent.nudge)).toContain("not in your container");
    expect(new Uint8Array(await Bun.file(`${dir}/screenshot.png`).arrayBuffer())).toEqual(PNG);
  });

  test("a source-task header for someone else's task falls back instead of attaching there", async () => {
    addSlackFile("F0SHOT0001", "screenshot.png", PNG);

    const result = await downloadTool(
      { fileId: "F0SHOT0001", savePath: `${join(fsDir, "legacy-2")}/` },
      extra({ "x-source-task-id": othersTaskId }),
    );

    expect(result.structuredContent.savedPath).toBeDefined();
    expect(await getTaskAttachments(othersTaskId)).toEqual([]);
  });

  test("a task the agent created for someone else accepts the file", async () => {
    addSlackFile("F0SHOT0001", "screenshot.png", PNG);
    const delegated = await createTaskExtended("delegated", {
      agentId: OTHER_ID,
      creatorAgentId: AGENT_ID,
    });

    const result = await downloadTool({ fileId: "F0SHOT0001", taskId: delegated.id }, extra({}));

    expect(result.isError).toBeFalsy();
    const [attachment] = await getTaskAttachments(delegated.id);
    expect(attachment).toMatchObject({ intent: "slack-file", agentId: AGENT_ID });
  });

  test("a URL that names no Slack file can't be attached", async () => {
    const result = await downloadTool(
      { url: `${host.url}elsewhere/some.png` },
      extra({ "x-source-task-id": taskId }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.structuredContent.message)).toContain("pass fileId");
  });

  test("the file a user already sent the bot is reused, not stored again", async () => {
    const file = addSlackFile("F0SHOT0001", "screenshot.png", PNG);
    await using inbound = await fetchSlackFiles({ token: BOT_TOKEN } as never, [file]);
    const { task } = await createSlackTaskWithFiles("from Slack", { agentId: AGENT_ID }, inbound);
    const [shared] = await getTaskAttachments(task.id);

    const result = await downloadTool(
      { fileId: "F0SHOT0001" },
      extra({ "x-source-task-id": task.id }),
    );

    expect(result.structuredContent.attachmentId).toBe(shared!.id);
    expect(await getTaskAttachments(task.id)).toHaveLength(1);
  });

  test("parallel downloads of different files with the same name keep both blobs intact", async () => {
    addSlackFile("F0IMAGE001", "image.png", PNG);
    addSlackFile("F0IMAGE002", "image.png", PNG_2);

    const results = await Promise.all([
      downloadTool({ fileId: "F0IMAGE001" }, extra({ "x-source-task-id": taskId })),
      downloadTool({ fileId: "F0IMAGE002" }, extra({ "x-source-task-id": taskId })),
    ]);
    // Both may end up named image.png; what matters is that fetching one
    // can't overwrite the other in the worker's /tmp.
    const [first, second] = results.map((r) => String(r.structuredContent.fetchCommand));
    expect(first).not.toBe(second);
    expect(first!.split(" -o ")[1]).not.toBe(second!.split(" -o ")[1]);

    const attachments = await getTaskAttachments(taskId);
    expect(attachments).toHaveLength(2);
    const provider = getFileStorageProvider();
    const stored = await Promise.all(
      attachments.map(async (a) => {
        const res = await provider.download({ taskId, name: a.name, key: a.providerKey });
        return { sha: a.sha256, bytes: new Uint8Array(await res.arrayBuffer()) };
      }),
    );
    for (const { sha, bytes } of stored) {
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sha!);
    }
  });
});

describe("slack-read", () => {
  test("stores the thread's files as attachments of the task, with a fetch command each", async () => {
    const file = addSlackFile("F0THREAD01", "diagram.png", PNG);
    threadMessages = [
      { user: "U_HUMAN", text: "see this", ts: "1700000000.000100", files: [file] },
    ];

    const result = await readTool({ taskId }, extra({}));

    const [attachment] = await getTaskAttachments(taskId);
    expect(attachment?.name).toBe("diagram.png");
    const messages = result.structuredContent.messages as Array<{
      files: Array<Record<string, string>>;
    }>;
    expect(messages[0]!.files[0]!.attachmentId).toBe(attachment!.id);
    expect(messages[0]!.files[0]!.fetchCommand).toContain(`/files/${attachment!.id}/raw`);
    expect(messages[0]!.files[0]!.localPath).toBeUndefined();
    expect(String(result.structuredContent.details)).toContain(`Task attachment ${attachment!.id}`);
  });

  test("a file that can't be downloaded is reported per file", async () => {
    const good = addSlackFile("F0GOOD0001", "good.png", PNG);
    const bad = addSlackFile("F0BAD00001", "bad.png", PNG_2, "forbidden");
    threadMessages = [
      { user: "U_HUMAN", text: "two", ts: "1700000000.000100", files: [good, bad] },
    ];

    const result = await readTool({ taskId }, extra({}));

    const files = (
      result.structuredContent.messages as Array<{ files: Array<Record<string, string>> }>
    )[0]!.files;
    expect(files.find((f) => f.id === "F0GOOD0001")?.attachmentId).toBeDefined();
    expect(files.find((f) => f.id === "F0BAD00001")?.notAttached).toContain("HTTP 403");
    expect(String(result.structuredContent.details)).toContain(
      "[Not attached: download failed (HTTP 403)]",
    );
    expect(await getTaskAttachments(taskId)).toHaveLength(1);
  });

  test("includeFiles: false stores nothing", async () => {
    threadMessages = [
      {
        user: "U_HUMAN",
        text: "x",
        ts: "1700000000.000100",
        files: [addSlackFile("F0SKIP0001", "s.png", PNG)],
      },
    ];

    await readTool({ taskId, includeFiles: false }, extra({}));

    expect(await getTaskAttachments(taskId)).toEqual([]);
  });

  test("attaches to the source task when reading by inbox/channel context", async () => {
    await getDbClient().run("UPDATE agents SET isLead = 1 WHERE id = ?", [AGENT_ID]);
    const file = addSlackFile("F0CHAN0001", "chan.png", PNG);
    threadMessages = [{ user: "U_HUMAN", text: "c", ts: "1700000000.000200", files: [file] }];

    try {
      await readTool({ channelId: "C0THREAD" }, extra({ "x-source-task-id": taskId }));
    } finally {
      await getDbClient().run("UPDATE agents SET isLead = 0 WHERE id = ?", [AGENT_ID]);
    }

    expect((await getTaskAttachments(taskId)).map((a) => a.name)).toEqual(["chan.png"]);
  });
});

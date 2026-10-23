import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramMockFilePart } from "../../scripts/dev/telegram-bot-api-mock";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  initDb,
  insertTaskAttachment,
  upsertSwarmConfig,
} from "../be/db";
import { recordTaskAttachmentUpload } from "../be/task-attachment-store";
import { getFileStorageProvider, resetFileStorageProviderForTests } from "../fs/registry";
import { formatUnsentFilesNote, telegramAttachmentType } from "../integrations/chat-sdk/outbound";
import {
  formatChatTaskTag,
  processPendingChatRelays,
  stopChatRelayWatcher,
} from "../integrations/chat-sdk/relay";
import { chatSdkContextKey } from "../tasks/context-key";
import { registerChatPostTool } from "../tools/chat-post";
import { registerChatReplyTool } from "../tools/chat-reply";
import type { Agent, AgentTask, TaskAttachment } from "../types";
import { startTelegramHarness, type TelegramHarness } from "./chat-sdk-harness";

const TEST_DB_PATH = "./test-chat-sdk-outbound-files.sqlite";
const MB = 1024 * 1024;
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% test document\n%%EOF\n");
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const savedEnv = new Map(
  [
    "AGENT_FS_LOCAL_DIR",
    "AGENT_FS_API_URL",
    "AGENT_FS_DEFAULT_ORG_ID",
    "AGENT_FS_DEFAULT_DRIVE_ID",
    "API_AGENT_FS_API_KEY",
  ].map((key) => [key, process.env[key]]),
);

let harness: TelegramHarness;
let lead: Agent;
let worker: Agent;
let leaky: Agent;
let server: McpServer;
let fsDir: string;
let nextChatId = 660_000;

// A stand-in agent-fs API. The API's own key reads every file; the worker's
// key reads only its own thoughts, as a per-agent agent-fs credential does.
const AGENT_FS_ORG = "shared-org";
const AGENT_FS_DRIVE = "shared-drive";
const API_FS_KEY = "api-owned-fs-key";
const WORKER_FS_KEY = "worker-fs-key";
const LEAD_FS_KEY = "lead-fs-key";
// Shorter than the global scrubber's floor, so only an exact-value scrub hides it.
const SHORT_FS_KEY = "local-pass";
const PRIVATE_BYTES = new TextEncoder().encode("private: not for the worker\n");
const agentFsFiles = new Map<string, { bytes: Uint8Array; type: string }>([
  ["thoughts/worker/reports/q3.pdf", { bytes: PDF_BYTES, type: "application/pdf" }],
  ["restricted/private.txt", { bytes: PRIVATE_BYTES, type: "text/plain" }],
]);
/** Every request the stand-in agent-fs received: the raw path and the bearer. */
const agentFsRequests: Array<{ path: string; auth: string | null }> = [];
let agentFs: ReturnType<typeof Bun.serve>;

function startAgentFs(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      agentFsRequests.push({ path, auth });
      const prefix = `/orgs/${AGENT_FS_ORG}/drives/${AGENT_FS_DRIVE}/files/`;
      if (!path.startsWith(prefix) || !path.endsWith("/raw")) {
        return new Response("not found", { status: 404 });
      }
      const key = decodeURIComponent(path.slice(prefix.length, -"/raw".length));
      if (key === "thoughts/leaky/broken.pdf") {
        return new Response(`storage failed using ${auth?.replace(/^Bearer /, "")}`, {
          status: 500,
        });
      }
      const file = agentFsFiles.get(key);
      if (!file) return new Response("not found", { status: 404 });
      const allowed =
        auth === `Bearer ${API_FS_KEY}` ||
        auth === `Bearer ${LEAD_FS_KEY}` ||
        (auth === `Bearer ${WORKER_FS_KEY}` && key.startsWith("thoughts/worker/"));
      if (!allowed) return new Response("forbidden", { status: 403 });
      return new Response(file.bytes, {
        headers: { "content-type": file.type, "content-length": String(file.bytes.byteLength) },
      });
    },
  });
}

type ToolResult = {
  structuredContent: { success: boolean; message: string; [key: string]: unknown };
};

async function callTool(
  name: string,
  headers: Record<string, string>,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  return (await handler(args, {
    sessionId: "test-session",
    requestInfo: { headers },
  })) as ToolResult;
}

/** Every Bot API call addressed to `chatId`, in order. */
function callsTo(chatId: number): Array<{ method: string; body: Record<string, unknown> }> {
  return harness.mock.calls
    .map((call) => ({ method: call.method, body: call.body as Record<string, unknown> }))
    .filter((call) => String(call.body.chat_id) === String(chatId));
}

function textOf(body: Record<string, unknown>): string {
  const rich = body.rich_message as { markdown?: string } | undefined;
  return String(rich?.markdown ?? body.text ?? "");
}

async function chatTask(chatId: number, agentId: string): Promise<AgentTask> {
  return createTaskExtended(`chat task for ${chatId}`, {
    agentId,
    source: "chat",
    contextKey: chatSdkContextKey(`telegram:${chatId}`),
  });
}

/**
 * Make the API's file provider an agent-fs provider on the stand-in, holding
 * the key that reads every file, as a deployment with agent-fs has. Path
 * attachments must still be read with the caller's key.
 */
function useApiAgentFsProvider(): void {
  process.env.AGENT_FS_API_URL = agentFs.url.origin;
  process.env.AGENT_FS_DEFAULT_ORG_ID = AGENT_FS_ORG;
  process.env.AGENT_FS_DEFAULT_DRIVE_ID = AGENT_FS_DRIVE;
  resetFileStorageProviderForTests();
  expect(getFileStorageProvider().id).toBe("agent-fs");
}

/** Back to the local provider the task attachment tests store their bytes in. */
function useLocalFileProvider(): void {
  delete process.env.AGENT_FS_API_URL;
  delete process.env.AGENT_FS_DEFAULT_ORG_ID;
  delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
  resetFileStorageProviderForTests();
}

/** Store bytes through the active provider and record them as an attachment of `taskId`. */
async function attach(
  taskId: string,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  options: { agentId?: string | null; intent?: string } = {},
): Promise<TaskAttachment> {
  const provider = getFileStorageProvider();
  const scope = { taskId, name };
  const uploaded = await provider.upload(scope, bytes, {
    contentType,
    sizeBytes: bytes.byteLength,
  });
  return recordTaskAttachmentUpload({
    provider,
    scope,
    uploaded,
    sizeBytes: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    contentType,
    agentId: options.agentId === undefined ? worker.id : options.agentId,
    intent: options.intent,
  });
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

beforeAll(async () => {
  await removeDbFiles();
  fsDir = await mkdtemp(join(tmpdir(), "chat-sdk-outbound-fs-"));
  process.env.AGENT_FS_LOCAL_DIR = fsDir;
  useLocalFileProvider();
  initDb(TEST_DB_PATH);
  lead = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatFilesLead",
    isLead: true,
    status: "idle",
  });
  worker = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatFilesWorker",
    isLead: false,
    status: "idle",
  });
  leaky = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatFilesShortKey",
    isLead: false,
    status: "idle",
  });
  agentFs = startAgentFs();
  // The API holds a key that reads everything; path attachments must not use it.
  process.env.API_AGENT_FS_API_KEY = API_FS_KEY;
  for (const [key, value] of [
    ["AGENT_FS_API_URL", agentFs.url.origin],
    ["AGENT_FS_DEFAULT_ORG_ID", AGENT_FS_ORG],
    ["AGENT_FS_DEFAULT_DRIVE_ID", AGENT_FS_DRIVE],
  ] as const) {
    await upsertSwarmConfig({ scope: "global", key, value });
  }
  for (const [agent, value] of [
    [worker, WORKER_FS_KEY],
    [lead, LEAD_FS_KEY],
  ] as const) {
    await upsertSwarmConfig({ scope: "agent", scopeId: agent.id, key: "AGENT_FS_API_KEY", value });
  }
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: leaky.id,
    key: "AGENT_FS_API_KEY",
    value: SHORT_FS_KEY,
    isSecret: true,
  });
  server = new McpServer({ name: "chat-files-test", version: "1.0.0" });
  registerChatReplyTool(server);
  registerChatPostTool(server);
  harness = await startTelegramHarness();
  // Relay ticks are driven by the tests.
  await stopChatRelayWatcher();
});

afterAll(async () => {
  await harness.stop();
  agentFs.stop(true);
  closeDb();
  await removeDbFiles();
  await rm(fsDir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetFileStorageProviderForTests();
});

beforeEach(() => {
  nextChatId += 1;
  agentFsRequests.length = 0;
});

describe("telegramAttachmentType", () => {
  test("only types Telegram's media methods take become photo, video or audio", () => {
    expect(telegramAttachmentType("image/png", 1_000)).toBe("image");
    expect(telegramAttachmentType("image/jpeg", 11 * MB)).toBe("file");
    expect(telegramAttachmentType("image/svg+xml", 1_000)).toBe("file");
    expect(telegramAttachmentType("video/mp4", 1_000)).toBe("video");
    expect(telegramAttachmentType("audio/mpeg", 1_000)).toBe("audio");
    expect(telegramAttachmentType("application/pdf", 1_000)).toBe("file");
  });
});

describe("formatUnsentFilesNote", () => {
  test("file names render as literal code spans, with no formatting or mentions", () => {
    const note = formatUnsentFilesNote([
      { name: "**[click](https://evil.example)** <!channel> @here.pdf", reason: "too big" },
      { name: "a`b``c.txt", reason: "refused" },
      { name: "line\n\n# Heading\n- item.md", reason: "bad @everyone\nreason" },
    ]);
    const lines = note.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Could not send 3 files:");
    expect(lines[1]).toBe(
      "- `**[click](https://evil.example)** <\u200b!channel> @\u200bhere.pdf`: too big",
    );
    expect(lines[2]).toBe("- ```a`b``c.txt```: refused");
    expect(lines[3]).toBe("- `line # Heading - item.md`: bad @\u200beveryone reason");
  });

  test("an edge backtick is padded away from the fence", () => {
    expect(formatUnsentFilesNote([{ name: "`x`", reason: "r" }])).toBe(
      "Could not send 1 file:\n- `` `x` ``: r",
    );
  });
});

describe("chat-reply agent-fs paths", () => {
  beforeEach(useApiAgentFsProvider);
  afterEach(useLocalFileProvider);

  test("an agent-fs PDF arrives as a document after the text", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "Here is the report.", attachments: ["/thoughts/worker/reports/q3.pdf"] },
    );

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.unsentFiles).toEqual([]);
    const calls = callsTo(chatId);
    expect(calls.map((call) => call.method)).toEqual([
      expect.stringMatching(/^send(Rich)?Message$/),
      "sendDocument",
    ]);
    expect(textOf(calls[0]!.body)).toBe("Here is the report.");
    expect(calls[1]!.body.document).toEqual({
      filename: "q3.pdf",
      type: "application/pdf",
      size: PDF_BYTES.byteLength,
    } satisfies TelegramMockFilePart);
    // Read from the caller's drive with the caller's own key.
    expect(agentFsRequests).toEqual([
      {
        path: `/orgs/${AGENT_FS_ORG}/drives/${AGENT_FS_DRIVE}/files/thoughts/worker/reports/q3.pdf/raw`,
        auth: `Bearer ${WORKER_FS_KEY}`,
      },
    ]);
  });

  test("a path the caller's own agent-fs key cannot read is not sent, though the API's key can read it", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "Here it is.", attachments: ["restricted/private.txt"] },
    );

    expect(result.structuredContent.success).toBe(true);
    const unsent = result.structuredContent.unsentFiles as Array<{ name: string; reason: string }>;
    expect(unsent).toEqual([
      {
        name: "private.txt",
        reason: "could not be read (your agent-fs credential cannot read this path)",
      },
    ]);
    const calls = callsTo(chatId);
    expect(calls.map((call) => call.method)).toEqual([
      expect.stringMatching(/^send(Rich)?Message$/),
      expect.stringMatching(/^send(Rich)?Message$/),
    ]);
    expect(textOf(calls[1]!.body)).toContain("`private.txt`: could not be read");
    expect(JSON.stringify(calls)).not.toContain("not for the worker");
    expect(agentFsRequests.map((request) => request.auth)).toEqual([`Bearer ${WORKER_FS_KEY}`]);
  });

  test("an encoded traversal path is refused before any agent-fs request or send", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);
    const headers = { "x-agent-id": worker.id, "x-source-task-id": task.id };

    for (const path of [
      "%2e%2e/%2e%2e/private-drive/files/private.txt",
      "thoughts/%2E%2E/%2E%2E/%2E%2E/private-drive/files/private.txt",
      "..%2f..%2fprivate-drive/files/private.txt",
    ]) {
      const result = await callTool("chat-reply", headers, { text: "x", attachments: [path] });
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toContain(`Path ${path}:`);
    }

    expect(agentFsRequests).toEqual([]);
    expect(callsTo(chatId)).toEqual([]);
  });

  test("a `?` or `#` in a path stays inside the file name", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);

    await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "x", attachments: ["thoughts/worker/a?b#c.pdf"] },
    );

    expect(agentFsRequests.map((request) => request.path)).toEqual([
      `/orgs/${AGENT_FS_ORG}/drives/${AGENT_FS_DRIVE}/files/thoughts/worker/a%3Fb%23c.pdf/raw`,
    ]);
  });

  test("a caller without its own agent-fs key cannot send a path", async () => {
    const chatId = nextChatId;
    const keyless = await createAgent({
      id: crypto.randomUUID(),
      name: "ChatFilesKeyless",
      isLead: false,
      status: "idle",
    });
    const task = await chatTask(chatId, keyless.id);

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": keyless.id, "x-source-task-id": task.id },
      { text: "x", attachments: ["restricted/private.txt"] },
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("no agent-fs credential");
    expect(agentFsRequests).toEqual([]);
    expect(callsTo(chatId)).toEqual([]);
  });

  /** The tool result and the thread's failure note for one path the read of which fails. */
  async function failedRead(path: string): Promise<{ result: string; note: string }> {
    const chatId = nextChatId;
    const task = await chatTask(chatId, leaky.id);
    const result = await callTool(
      "chat-reply",
      { "x-agent-id": leaky.id, "x-source-task-id": task.id },
      { text: "x", attachments: [path] },
    );
    expect(result.structuredContent.success).toBe(true);
    expect((result.structuredContent.unsentFiles as unknown[]).length).toBe(1);
    const calls = callsTo(chatId);
    expect(calls.map((call) => call.method)).toEqual([
      expect.stringMatching(/^send(Rich)?Message$/),
      expect.stringMatching(/^send(Rich)?Message$/),
    ]);
    return { result: JSON.stringify(result), note: textOf(calls[1]!.body) };
  }

  test("a storage error body naming the caller's short key does not leak it", async () => {
    const { result, note } = await failedRead("thoughts/leaky/broken.pdf");

    // The stand-in put the key in its 500 body; the key reached it as the bearer.
    expect(agentFsRequests.map((request) => request.auth)).toEqual([`Bearer ${SHORT_FS_KEY}`]);
    expect(note).toContain("`broken.pdf`: could not be read (storage failed using [REDACTED:");
    expect(result).not.toContain(SHORT_FS_KEY);
    expect(note).not.toContain(SHORT_FS_KEY);
  });

  test("a transport error naming the caller's short key does not leak it", async () => {
    const realFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/thoughts/leaky/offline.pdf/")) {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        throw new TypeError(`connect failed using ${auth.replace(/^Bearer /, "")}`);
      }
      return realFetch(input, init);
    }) as typeof fetch);
    try {
      const { result, note } = await failedRead("thoughts/leaky/offline.pdf");

      expect(note).toContain("`offline.pdf`: could not be read (connect failed using [REDACTED:");
      expect(result).not.toContain(SHORT_FS_KEY);
      expect(note).not.toContain(SHORT_FS_KEY);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("chat-reply attachments", () => {
  test("a task attachment id sends the file; an image goes as a photo", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);
    const png = await attach(task.id, "chart.png", PNG_BYTES, "image/png");

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "The chart.", attachments: [png.id] },
    );

    expect(result.structuredContent.success).toBe(true);
    const photo = callsTo(chatId).find((call) => call.method === "sendPhoto");
    expect((photo?.body.photo as TelegramMockFilePart).filename).toBe("chart.png");
  });

  test("several documents go as one media group; a photo goes on its own", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);
    const a = await attach(task.id, "a.pdf", PDF_BYTES, "application/pdf");
    // Different bytes: a task keeps one attachment row per sha256.
    const b = await attach(
      task.id,
      "b.pdf",
      new TextEncoder().encode("%PDF-1.4 b"),
      "application/pdf",
    );
    const png = await attach(task.id, "c.png", PNG_BYTES, "image/png");

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "Three files.", attachments: [a.id, png.id, b.id] },
    );

    expect(result.structuredContent.success).toBe(true);
    const uploads = callsTo(chatId).filter((call) => !/^send(Rich)?Message$/.test(call.method));
    expect(uploads.map((call) => call.method).sort()).toEqual(["sendMediaGroup", "sendPhoto"]);
    const group = uploads.find((call) => call.method === "sendMediaGroup")!;
    const media = JSON.parse(String(group.body.media)) as Array<{ type: string }>;
    expect(media.map((item) => item.type)).toEqual(["document", "document"]);
    expect((group.body.media0 as TelegramMockFilePart).filename).toBe("a.pdf");
    expect((group.body.media1 as TelegramMockFilePart).filename).toBe("b.pdf");
  });

  test("a file over Telegram's 50 MB limit is not sent and the thread gets a note", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);
    const big = await insertTaskAttachment({
      taskId: task.id,
      agentId: worker.id,
      name: "dump.zip",
      kind: "shared-fs",
      path: "never/read.zip",
      providerId: "local-fs",
      providerKey: "never/read.zip",
      mimeType: "application/zip",
      sizeBytes: 60 * MB,
    });

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "The dump.", attachments: [big.id] },
    );

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.unsentFiles).toEqual([
      { name: "dump.zip", reason: "60.0 MB, over the 50.0 MB upload limit of Telegram" },
    ]);
    expect(result.structuredContent.message).toContain("Could not send 1 file");
    const calls = callsTo(chatId);
    expect(calls.some((call) => call.method === "sendDocument")).toBe(false);
    expect(textOf(calls.at(-1)!.body)).toContain(
      "`dump.zip`: 60.0 MB, over the 50.0 MB upload limit",
    );
  });

  test("a platform refusal becomes a note, not a silent failure", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);
    const pdf = await attach(task.id, "refused.pdf", PDF_BYTES, "application/pdf");
    harness.mock.failUploads(1);

    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "A file.", attachments: [pdf.id] },
    );

    expect(result.structuredContent.success).toBe(true);
    const unsent = result.structuredContent.unsentFiles as Array<{ name: string; reason: string }>;
    expect(unsent.map((file) => file.name)).toEqual(["refused.pdf"]);
    expect(unsent[0]!.reason).toContain("refused by Telegram");
    expect(textOf(callsTo(chatId).at(-1)!.body)).toContain("`refused.pdf`: refused by Telegram");
  });

  test("an unknown attachment id or a traversal path is refused before anything is sent", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, worker.id);
    const headers = { "x-agent-id": worker.id, "x-source-task-id": task.id };

    const unknown = await callTool("chat-reply", headers, {
      text: "x",
      attachments: [crypto.randomUUID()],
    });
    expect(unknown.structuredContent.success).toBe(false);
    expect(unknown.structuredContent.message).toContain("is not an attachment of task");

    const traversal = await callTool("chat-reply", headers, {
      text: "x",
      attachments: ["../etc/passwd"],
    });
    expect(traversal.structuredContent.success).toBe(false);
    expect(traversal.structuredContent.message).toContain("parent path segments");

    expect(callsTo(chatId)).toEqual([]);
  });
});

describe("chat-post attachments", () => {
  test("the lead posts a file to another thread", async () => {
    const chatId = nextChatId;
    const leadTask = await createTaskExtended("lead work", { agentId: lead.id, source: "mcp" });
    const pdf = await attach(leadTask.id, "brief.pdf", PDF_BYTES, "application/pdf", {
      agentId: lead.id,
    });

    const result = await callTool(
      "chat-post",
      { "x-agent-id": lead.id, "x-source-task-id": leadTask.id },
      { adapter: "telegram", threadId: `telegram:${chatId}`, text: "FYI", attachments: [pdf.id] },
    );

    expect(result.structuredContent.success).toBe(true);
    expect(callsTo(chatId).map((call) => call.method)).toContain("sendDocument");
  });
});

describe("relay of output attachments", () => {
  test("a completed task relays its output attachments after the answer, not its input files", async () => {
    const chatId = nextChatId;
    const task = await chatTask(chatId, lead.id);
    await attach(task.id, "result.pdf", PDF_BYTES, "application/pdf", { agentId: lead.id });
    await attach(task.id, "from-user.png", PNG_BYTES, "image/png", {
      agentId: null,
      intent: "user-upload",
    });
    await attach(
      task.id,
      "fetched-from-slack.png",
      new Uint8Array([...PNG_BYTES, 5]),
      "image/png",
      {
        agentId: lead.id,
        intent: "slack-file",
      },
    );
    await completeTask(task.id, "Done, report attached.");

    await processPendingChatRelays();

    const calls = callsTo(chatId);
    expect(calls.map((call) => call.method)).toEqual([
      expect.stringMatching(/^send(Rich)?Message$/),
      "sendDocument",
    ]);
    // The line-leading tag is escaped so Telegram does not render it as a heading.
    expect(textOf(calls[0]!.body)).toBe(
      `\\${formatChatTaskTag(task, lead.name)}\n\nDone, report attached.`,
    );
    expect((calls[1]!.body.document as TelegramMockFilePart).filename).toBe("result.pdf");
  });
});

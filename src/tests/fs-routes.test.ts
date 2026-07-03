import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
} from "../be/db";
import { resetFileStorageProviderForTests } from "../fs/registry";
import { handleCore } from "../http/core";
import { handleFs } from "../http/fs";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { formatAttachmentsBlockForSlack } from "../slack/blocks";

const TEST_DB_PATH = "./test-fs-routes.sqlite";
const TEST_FS_DIR = "./test-fs-routes-data";
const API_KEY = "test-fs-key";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleFs(req, res, pathSegments, queryParams, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;
let agentId: string;
let taskId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  await rm(TEST_FS_DIR, { recursive: true, force: true });
  process.env.AGENT_FS_LOCAL_DIR = TEST_FS_DIR;
  delete process.env.AGENT_FS_API_URL;
  delete process.env.API_AGENT_FS_API_KEY;
  delete process.env.AGENT_FS_API_KEY;
  resetFileStorageProviderForTests();

  initDb(TEST_DB_PATH);
  server = createTestServer(API_KEY);
  port = await listen(server);

  const agent = createAgent({ name: "fs-route-worker", isLead: false, status: "idle" });
  agentId = agent.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  await rm(TEST_FS_DIR, { recursive: true, force: true });
  delete process.env.AGENT_FS_LOCAL_DIR;
  resetFileStorageProviderForTests();
});

beforeEach(async () => {
  await rm(TEST_FS_DIR, { recursive: true, force: true });
  resetFileStorageProviderForTests();
  taskId = createTaskExtended("fs route task", {
    agentId,
    source: "mcp",
  }).id;
});

function url(path: string): string {
  return `http://localhost:${port}${path}`;
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": agentId,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

function operatorFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

describe("/api/fs REST", () => {
  test("401 without Authorization header", async () => {
    const res = await fetch(url(`/api/fs/tasks/${taskId}/files`), {
      headers: { "X-Agent-ID": agentId },
    });
    expect(res.status).toBe(401);
  });

  test("upload to a missing task returns 404", async () => {
    const missing = crypto.randomUUID();
    const res = await authedFetch(`/api/fs/tasks/${missing}/files?name=missing.txt`, {
      method: "POST",
      body: Buffer.from("no task"),
      headers: { "Content-Type": "text/plain" },
    });
    expect(res.status).toBe(404);
  });

  test("local-fs upload, list, download, and delete round-trip", async () => {
    const upload = await authedFetch(`/api/fs/tasks/${taskId}/files?name=notes.txt&intent=input`, {
      method: "POST",
      body: Buffer.from("hello from local fs"),
      headers: { "Content-Type": "text/plain" },
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json();
    expect(attachment.providerId).toBe("local-fs");
    expect(attachment.kind).toBe("shared-fs");
    expect(attachment.intent).toBe("input");

    const rows = getTaskAttachments(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(attachment.id);

    const list = await authedFetch(`/api/fs/tasks/${taskId}/files`);
    expect(list.status).toBe(200);
    expect((await list.json()).attachments).toHaveLength(1);

    const download = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}/raw`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello from local fs");

    const del = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(getTaskAttachments(taskId)).toEqual([]);
  });

  test("operator API key can upload and delete without X-Agent-ID for dashboard use", async () => {
    const upload = await operatorFetch(`/api/fs/tasks/${taskId}/files?name=dashboard.txt`, {
      method: "POST",
      body: Buffer.from("from dashboard"),
      headers: { "Content-Type": "text/plain" },
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json();

    const del = await operatorFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(getTaskAttachments(taskId)).toEqual([]);
  });

  test("download resolves the row's stored key, not a reconstructed tasks/<id>/<name>", async () => {
    // Simulate an attachment whose bytes live at an arbitrary provider key that does
    // NOT match tasks/<taskId>/<name> — the common shape for agent-authored files.
    const storedKey = "misc/agent-authored/deep/report.md";
    const onDisk = join(TEST_FS_DIR, storedKey);
    await mkdir(dirname(onDisk), { recursive: true });
    await writeFile(onDisk, "resolved via stored key");

    const attachment = insertTaskAttachment({
      taskId,
      agentId,
      name: "report.md",
      kind: "shared-fs",
      path: storedKey,
      providerId: "local-fs",
      providerKey: storedKey,
    });

    const download = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}/raw`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("resolved via stored key");
  });

  test("cross-provider rows are not downloadable and delete is pointer-only (no orphaning)", async () => {
    // An agent-fs row while local-fs is the active provider: the active provider does
    // not back these bytes, so download must 404 and delete must NOT touch the provider.
    // Plant a decoy file where a reconstructed tasks/<id>/<name> scope WOULD point,
    // to prove delete never resolves+removes it.
    const decoy = join(TEST_FS_DIR, "tasks", taskId, "notes.md");
    await mkdir(dirname(decoy), { recursive: true });
    await writeFile(decoy, "unrelated decoy — must survive");

    const attachment = insertTaskAttachment({
      taskId,
      agentId,
      name: "notes.md",
      kind: "agent-fs",
      path: "misc/somewhere/notes.md",
      providerId: "agent-fs",
      providerKey: "misc/somewhere/notes.md",
      orgId: "org_1",
      driveId: "drive_1",
    });

    const download = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}/raw`);
    expect(download.status).toBe(404);

    const del = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(getTaskAttachments(taskId)).toEqual([]);
    // The decoy file was never resolved, so it must still exist.
    expect(await Bun.file(decoy).text()).toBe("unrelated decoy — must survive");
  });

  test("deleting a url pointer removes the row without a provider call", async () => {
    const attachment = insertTaskAttachment({
      taskId,
      agentId,
      name: "PR #42",
      kind: "url",
      url: "https://github.com/example/repo/pull/42",
    });

    const download = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}/raw`);
    expect(download.status).toBe(404);

    const del = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(getTaskAttachments(taskId)).toEqual([]);
  });

  test("deleting a provider-backed row whose blob is already gone still clears the pointer", async () => {
    // stored key points at a local-fs object that does not exist → provider NotFound.
    // Because the key is the row's real key, NotFound means truly gone → row cleared.
    const attachment = insertTaskAttachment({
      taskId,
      agentId,
      name: "vanished.txt",
      kind: "shared-fs",
      path: "tasks/ghost/vanished.txt",
      providerId: "local-fs",
      providerKey: "tasks/ghost/vanished.txt",
    });

    const del = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(getTaskAttachments(taskId)).toEqual([]);
  });

  test("provider-aware renderers keep local-fs on swarm URLs and agent-fs on live URLs", () => {
    const local = insertTaskAttachment({
      taskId,
      agentId,
      name: "local.txt",
      kind: "shared-fs",
      path: "tasks/x/local.txt",
      providerId: "local-fs",
      providerKey: "tasks/x/local.txt",
    });
    const agentFs = insertTaskAttachment({
      taskId,
      agentId,
      name: "agent.txt",
      kind: "agent-fs",
      path: "tasks/x/agent.txt",
      providerId: "agent-fs",
      providerKey: "tasks/x/agent.txt",
      orgId: "org_1",
      driveId: "drive_1",
    });

    const block = formatAttachmentsBlockForSlack([local, agentFs]);
    expect(block).toContain(`/api/fs/tasks/${taskId}/files/${local.id}/raw`);
    expect(block).toContain("live.agent-fs.dev/file/~/org_1/drive_1/tasks/x/agent.txt");
  });
});

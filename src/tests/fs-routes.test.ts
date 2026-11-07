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
  createPage,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
  upsertSwarmConfig,
} from "../be/db";
import { ensureRbacSeedsSynced, setUserRoles } from "../be/rbac-roles";
import { mintToken } from "../be/users";
import { resetFileStorageProviderForTests } from "../fs/registry";
import { handleCore } from "../http/core";
import { _resetFsKeyRateLimitForTests, handleFs } from "../http/fs";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { formatAttachmentsBlockForSlack } from "../slack/blocks";
import { attachmentContentDisposition } from "../utils/content-disposition";
import { signPageSession } from "../utils/page-session";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-fs-routes.sqlite";
const TEST_FS_DIR = "./test-fs-routes-data";
const API_KEY = "example-test-fs-key";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
  port = await listenOnFreePort(server);

  const agent = await createAgent({ name: "fs-route-worker", isLead: false, status: "idle" });
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
  taskId = (
    await createTaskExtended("fs route task", {
      agentId,
      source: "mcp",
    })
  ).id;
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
  test("RFC 6266 download filenames are Latin-1-safe and preserve UTF-8", () => {
    for (const filename of [
      "PR analytics backfill — dry-run report",
      "r\u00e9sum\u00e9.txt",
      "\u5831\u544a.md",
      'quote".txt',
      "newline\nname.txt",
      "plain-ascii.txt",
    ]) {
      const header = attachmentContentDisposition(filename);
      expect(header).toStartWith('attachment; filename="');
      expect(header).toContain("; filename*=UTF-8''");
      expect([...header].every((character) => character.charCodeAt(0) <= 0xff)).toBe(true);
    }

    expect(attachmentContentDisposition("PR analytics backfill — dry-run report")).toContain(
      "PR%20analytics%20backfill%20%E2%80%94%20dry-run%20report",
    );
    expect(attachmentContentDisposition('quote".txt')).not.toContain('quote".txt');
    expect(attachmentContentDisposition("newline\nname.txt")).not.toContain("\n");

    const unsafeFilename = 'evil";part\\folder%/file\r\n\0Injected: yes.txt';
    const unsafeHeader = attachmentContentDisposition(unsafeFilename);
    expect(unsafeHeader).toBe(
      "attachment; filename=\"evil;partfolder%/fileInjected: yes.txt\"; filename*=UTF-8''evil%22%3Bpart%5Cfolder%25%2FfileInjected%3A%20yes.txt",
    );
    expect(unsafeHeader).toContain("%22");
    expect(unsafeHeader).toContain("%5C");
    expect(unsafeHeader).toContain("%25");
    expect(unsafeHeader).toContain("%2F");
    expect(unsafeHeader).not.toMatch(/[\r\n\0]/);
    expect(unsafeHeader.split(/\r\n|\r|\n/)).toHaveLength(1);
  });

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

    const rows = await getTaskAttachments(taskId);
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
    expect(await getTaskAttachments(taskId)).toEqual([]);
  });

  test("agent-fs upload persists file metadata instead of the PUT response metadata", async () => {
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    let receivedBody: Buffer | undefined;
    const remote = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      receivedBody = Buffer.concat(chunks);
      const response = JSON.stringify({
        path: `tasks/${taskId}/image.jpg`,
        version: 7,
        contentHash: "hash-1",
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(response),
      });
      res.end(response);
    });
    const remotePort = await listenOnFreePort(remote);
    process.env.AGENT_FS_API_URL = `http://localhost:${remotePort}`;
    process.env.API_AGENT_FS_API_KEY = "af_test";
    process.env.AGENT_FS_DEFAULT_ORG_ID = "org-1";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive-1";
    resetFileStorageProviderForTests();

    try {
      const upload = await authedFetch(`/api/fs/tasks/${taskId}/files?name=image.jpg`, {
        method: "POST",
        body,
        headers: { "Content-Type": "image/jpeg" },
      });
      expect(upload.status).toBe(201);
      const attachment = await upload.json();
      expect(attachment.providerId).toBe("agent-fs");
      expect(attachment.mimeType).toBe("image/jpeg");
      expect(attachment.sizeBytes).toBe(body.byteLength);
      expect(receivedBody).toEqual(body);

      const rows = await getTaskAttachments(taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(attachment.id);
      expect(rows[0]?.mimeType).toBe("image/jpeg");
      expect(rows[0]?.sizeBytes).toBe(body.byteLength);
    } finally {
      delete process.env.AGENT_FS_API_URL;
      delete process.env.API_AGENT_FS_API_KEY;
      delete process.env.AGENT_FS_DEFAULT_ORG_ID;
      delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
      resetFileStorageProviderForTests();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
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
    expect(await getTaskAttachments(taskId)).toEqual([]);
  });

  test("download resolves the row's stored key, not a reconstructed tasks/<id>/<name>", async () => {
    // Simulate an attachment whose bytes live at an arbitrary provider key that does
    // NOT match tasks/<taskId>/<name> — the common shape for agent-authored files.
    const storedKey = "misc/agent-authored/deep/report.md";
    const onDisk = join(TEST_FS_DIR, storedKey);
    await mkdir(dirname(onDisk), { recursive: true });
    await writeFile(onDisk, "resolved via stored key");

    const attachment = await insertTaskAttachment({
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

  test("download accepts the reported em-dash attachment name", async () => {
    const storedKey = "thoughts/research/dry-run-report.md";
    const onDisk = join(TEST_FS_DIR, storedKey);
    await mkdir(dirname(onDisk), { recursive: true });
    await writeFile(onDisk, "report");
    const attachment = await insertTaskAttachment({
      taskId,
      agentId,
      name: "PR analytics backfill — dry-run report",
      kind: "shared-fs",
      path: storedKey,
      providerId: "local-fs",
      providerKey: storedKey,
      mimeType: "text/markdown",
    });

    const download = await authedFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}/raw`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(await download.text()).toBe("report");
  });

  test("cross-provider rows are not downloadable and delete is pointer-only (no orphaning)", async () => {
    // An agent-fs row while local-fs is the active provider: the active provider does
    // not back these bytes, so download must 404 and delete must NOT touch the provider.
    // Plant a decoy file where a reconstructed tasks/<id>/<name> scope WOULD point,
    // to prove delete never resolves+removes it.
    const decoy = join(TEST_FS_DIR, "tasks", taskId, "notes.md");
    await mkdir(dirname(decoy), { recursive: true });
    await writeFile(decoy, "unrelated decoy — must survive");

    const attachment = await insertTaskAttachment({
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
    expect(await getTaskAttachments(taskId)).toEqual([]);
    // The decoy file was never resolved, so it must still exist.
    expect(await Bun.file(decoy).text()).toBe("unrelated decoy — must survive");
  });

  test("deleting a url pointer removes the row without a provider call", async () => {
    const attachment = await insertTaskAttachment({
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
    expect(await getTaskAttachments(taskId)).toEqual([]);
  });

  test("deleting a provider-backed row whose blob is already gone still clears the pointer", async () => {
    // stored key points at a local-fs object that does not exist → provider NotFound.
    // Because the key is the row's real key, NotFound means truly gone → row cleared.
    const attachment = await insertTaskAttachment({
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
    expect(await getTaskAttachments(taskId)).toEqual([]);
  });

  test("provider-aware renderers keep local-fs on swarm URLs and agent-fs on live URLs", async () => {
    const local = await insertTaskAttachment({
      taskId,
      agentId,
      name: "local.txt",
      kind: "shared-fs",
      path: "tasks/x/local.txt",
      providerId: "local-fs",
      providerKey: "tasks/x/local.txt",
    });
    const agentFs = await insertTaskAttachment({
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

  test("upload against a stalled agent-fs provider answers 504", async () => {
    // A server that accepts the connection and never answers, i.e. exactly the
    // stall that used to hang task creation until the socket gave up.
    const stalled = createHttpServer(() => {});
    const stalledPort = await listenOnFreePort(stalled);

    process.env.AGENT_FS_API_URL = `http://localhost:${stalledPort}`;
    process.env.API_AGENT_FS_API_KEY = "af_test";
    process.env.AGENT_FS_DEFAULT_ORG_ID = "org-1";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive-1";
    process.env.AGENT_FS_REQUEST_TIMEOUT_MS = "200";
    resetFileStorageProviderForTests();

    try {
      const res = await authedFetch(`/api/fs/tasks/${taskId}/files?name=stalled.txt`, {
        method: "POST",
        body: Buffer.from("never lands"),
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(504);
      expect(((await res.json()) as { error: string }).error).toContain("did not respond");
      expect(await getTaskAttachments(taskId)).toEqual([]);
    } finally {
      delete process.env.AGENT_FS_API_URL;
      delete process.env.API_AGENT_FS_API_KEY;
      delete process.env.AGENT_FS_DEFAULT_ORG_ID;
      delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
      delete process.env.AGENT_FS_REQUEST_TIMEOUT_MS;
      resetFileStorageProviderForTests();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });
});

describe("personal agent-fs identity and keys", () => {
  const orgId = crypto.randomUUID();
  const driveId = crypto.randomUUID();
  const agentFsUserId = crypto.randomUUID();
  const bootstrapKey = `af_${"b".repeat(64)}`;
  const mintedKey = `af_${"c".repeat(64)}`;
  const configKeys = [
    "API_AGENT_FS_API_KEY",
    "AGENT_FS_DEFAULT_ORG_ID",
    "AGENT_FS_DEFAULT_DRIVE_ID",
  ];
  const envKeys = [
    ...configKeys,
    "AGENT_FS_API_URL",
    "AGENT_FS_LIVE_URL",
    "AGENT_FS_APP_URL",
    "AGENT_FS_PUBLIC_URL",
    "AGENT_FS_PROXY",
    "RBAC_ENABLED",
    "PAGE_SESSION_SECRET",
  ];
  let originalEnv: Record<string, string | undefined>;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let userId: string;
  let email: string;
  let token: string;
  let mode: "ready" | "pending" | "missing-member" | "unsupported" = "ready";
  const requests: Array<{
    path: string;
    method: string;
    authorization: string | null;
    body: unknown;
  }> = [];

  beforeAll(async () => {
    ensureRbacSeedsSynced({ quiet: true });
    await createUser({ name: "Filesystem Fixture Admin" });
  });

  beforeEach(async () => {
    upstream = undefined;
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    ensureRbacSeedsSynced({ quiet: true });
    _resetFsKeyRateLimitForTests();
    mode = "ready";
    requests.length = 0;
    email = `fs-${crypto.randomUUID()}@example.com`;
    const user = await createUser({ name: "Filesystem User", email });
    userId = user.id;
    await setUserRoles(userId, ["requester"], null);
    token = (await mintToken(userId, "fs routes", { kind: "operator", id: "fs-tests" })).plaintext;
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = request.method === "POST" ? await request.json() : undefined;
        requests.push({
          path,
          method: request.method,
          authorization: request.headers.get("authorization"),
          body,
        });
        if (path === `/orgs/${orgId}/members`)
          return Response.json({
            members: mode === "pending" ? [] : [{ userId: agentFsUserId, email, role: "editor" }],
          });
        if (path === "/auth/register")
          return Response.json(
            {
              error: "REGISTRATION_DOMAIN_NOT_ALLOWED",
              message: "Registration is not open for this email domain",
            },
            { status: 403 },
          );
        if (path === `/orgs/${orgId}/members/invite`)
          return Response.json({
            ok: true,
            status: "pending",
            inviteId: "invite-test",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            token: "example-pending-invite-token",
          });
        if (path === `/orgs/${orgId}/members/${agentFsUserId}/keys`) {
          if (mode === "unsupported") return new Response("404 Not Found", { status: 404 });
          if (mode === "missing-member")
            return Response.json(
              { error: "NOT_FOUND", message: `Org not found: ${orgId}` },
              { status: 404 },
            );
          return Response.json(
            {
              apiKey: mintedKey,
              id: "personal-key",
              label: (body as { label: string }).label,
              createdAt: new Date().toISOString(),
              userId: agentFsUserId,
              orgId,
            },
            { status: 201 },
          );
        }
        return Response.json(
          { error: "NOT_FOUND", message: `Org not found: ${orgId}` },
          { status: 404 },
        );
      },
    });
    process.env.AGENT_FS_API_URL = `http://127.0.0.1:${upstream.port}`;
    process.env.API_AGENT_FS_API_KEY = bootstrapKey;
    process.env.AGENT_FS_DEFAULT_ORG_ID = orgId;
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = driveId;
    process.env.RBAC_ENABLED = "false";
    process.env.PAGE_SESSION_SECRET = "example-personal-fs-page-secret";
    delete process.env.AGENT_FS_LIVE_URL;
    delete process.env.AGENT_FS_APP_URL;
    process.env.AGENT_FS_PUBLIC_URL = "https://fs-api.example.test/";
    delete process.env.AGENT_FS_PROXY;
    for (const [key, value] of [
      ["API_AGENT_FS_API_KEY", bootstrapKey],
      ["AGENT_FS_DEFAULT_ORG_ID", orgId],
      ["AGENT_FS_DEFAULT_DRIVE_ID", driveId],
    ]) {
      await upsertSwarmConfig({ scope: "global", key: key!, value: value! });
    }
  });

  afterEach(async () => {
    await upstream?.stop(true);
    for (const key of configKeys)
      await getDbClient().run("DELETE FROM swarm_config WHERE scope = 'global' AND key = ?", [key]);
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetFileStorageProviderForTests();
  });

  function personal(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url(path), {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  }

  function createKey(label: unknown = "laptop"): Promise<Response> {
    return personal("/api/fs/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
  }

  function continueTo(returnTo: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return personal("/api/fs/continue", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ returnTo }),
    });
  }

  test("continue returns the live URL with the named key as its only fragment", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    let response: Response;
    try {
      response = await continueTo(
        `https://live.agent-fs.dev/file/~/${orgId}/${driveId}/x.md?view=raw#old=1`,
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      redirectUrl: `https://live.agent-fs.dev/file/~/${orgId}/${driveId}/x.md?view=raw#key=${mintedKey}&apiUrl=${encodeURIComponent("https://fs-api.example.test")}`,
    });
    const keyRequest = requests.find((request) => request.path.endsWith("/keys"));
    expect(keyRequest?.body).toEqual({
      label: `live.agent-fs.dev · ${new Date().toISOString().slice(0, 10)}`,
    });
    expect(logged.some((line) => line.includes(mintedKey))).toBe(false);
  });

  test("continue only accepts the live app origin", async () => {
    for (const rejected of [
      "https://live.agent-fs.dev.evil.test/file/x.md",
      "https://evil.test/",
      "http://live.agent-fs.dev/file/x.md",
      "https://live.agent-fs.dev:8443/file/x.md",
      "javascript:alert(1)",
    ]) {
      const response = await continueTo(rejected);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_return_to" });
    }
    for (const invalid of ["not a url", 42, null])
      expect((await continueTo(invalid)).status).toBe(400);
    expect(requests).toHaveLength(0);

    process.env.AGENT_FS_LIVE_URL = "https://files.acme.test/";
    process.env.AGENT_FS_APP_URL = "http://localhost:7433";
    expect((await continueTo("https://live.agent-fs.dev/file/x.md")).status).toBe(400);
    // Without AGENT_FS_PUBLIC_URL the fragment carries the dashboard's URL: the API proxy, else agent-fs itself.
    delete process.env.AGENT_FS_PUBLIC_URL;
    process.env.AGENT_FS_PROXY = "false";
    const live = await continueTo("https://files.acme.test/files");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({
      redirectUrl: `https://files.acme.test/files#key=${mintedKey}&apiUrl=${encodeURIComponent(process.env.AGENT_FS_API_URL!)}`,
    });
    // AGENT_FS_APP_URL is the dashboard agent-fs opens, never a key target.
    expect((await continueTo("http://localhost:7433/file/x.md")).status).toBe(400);
  });

  test("continue sends a key only to the live app's own routes", async () => {
    // The live origin also serves user content; its scripts could read the fragment.
    for (const path of [
      "/site/abc/",
      "/share/tok",
      "/orgs/x/drives/y/files/raw/a.html",
      "/api/anything",
      "/file/x.md",
    ]) {
      const response = await continueTo(`https://live.agent-fs.dev${path}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_return_to" });
    }
    expect(requests).toHaveLength(0);
  });

  test("continue refuses a link for another agent-fs org before it mints", async () => {
    const otherOrg = crypto.randomUUID();
    for (const path of [
      `/file/~/${otherOrg}/${driveId}/x.md`,
      `/detail/~/${otherOrg}/${driveId}/x.md`,
      `/page/~/${otherOrg}/${driveId}/x.html`,
      `/sql/~/${otherOrg}/${driveId}`,
      `/members/~/${otherOrg}/${driveId}`,
      `/orgs/${otherOrg}/files/x.md`,
    ]) {
      const response = await continueTo(`https://live.agent-fs.dev${path}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "org_mismatch" });
    }
    expect(requests).toHaveLength(0);

    // This swarm's org, and a link that names no org, still continue.
    for (const path of [
      "/",
      "/files",
      `/orgs/${orgId}/files/x.md`,
      `/members/~/${orgId}/${driveId}`,
    ]) {
      expect((await continueTo(`https://live.agent-fs.dev${path}`)).status).toBe(200);
    }
  });

  test("continue needs a user, fs.join.own, a ready account, and a new agent-fs", async () => {
    const target = "https://live.agent-fs.dev/files";
    expect(
      (
        await operatorFetch("/api/fs/continue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ returnTo: target }),
        })
      ).status,
    ).toBe(401);
    expect(requests).toHaveLength(0);
    mode = "pending";
    expect((await continueTo(target)).status).toBe(409);
    mode = "unsupported";
    const old = await continueTo(target);
    expect(old.status).toBe(501);
    expect(await old.json()).toEqual({ error: "agent_fs_too_old" });
    delete process.env.AGENT_FS_API_URL;
    expect((await continueTo(target)).status).toBe(503);
    process.env.RBAC_ENABLED = "true";
    await getDbClient().run(
      "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      [userId],
    );
    expect((await continueTo(target)).status).toBe(403);
  });

  test("the eleventh continue per minute is limited per user", async () => {
    const target = "https://live.agent-fs.dev/files";
    for (let i = 0; i < 10; i++) expect((await continueTo(target)).status).toBe(200);
    expect((await continueTo(target)).status).toBe(429);
    expect((await createKey()).status).toBe(201);
  });

  test("the user token determines identity despite a different dashboard header", async () => {
    const other = await createUser({ name: "Other", email: "other-fs@example.com" });
    const response = await personal("/api/fs/me", { headers: { "X-Swarm-User-Id": other.id } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      email,
      agentFsUserId,
      orgId,
      driveId,
    });
    expect(requests.some((request) => request.path === `/orgs/${orgId}/members`)).toBe(true);
    expect(requests.every((request) => request.authorization === `Bearer ${bootstrapKey}`)).toBe(
      true,
    );
  });

  test("the operator can identify an active dashboard user", async () => {
    const response = await operatorFetch("/api/fs/me", { headers: { "X-Swarm-User-Id": userId } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready", email, agentFsUserId });
    const key = await operatorFetch("/api/fs/keys", {
      method: "POST",
      headers: { "X-Swarm-User-Id": userId, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "dashboard key" }),
    });
    expect(key.status).toBe(201);
    expect(key.headers.get("cache-control")).toBe("no-store");
    expect(await key.json()).toMatchObject({ apiKey: mintedKey, agentFsUserId, orgId, driveId });
  });

  test("missing identity, a worker, and inactive dashboard users receive 401", async () => {
    expect((await operatorFetch("/api/fs/me")).status).toBe(401);
    expect((await fetch(url("/api/fs/me"))).status).toBe(401);
    const keyBody = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "missing identity" }),
    };
    expect((await operatorFetch("/api/fs/keys", keyBody)).status).toBe(401);
    expect(
      (
        await authedFetch("/api/fs/keys", {
          ...keyBody,
          headers: { ...keyBody.headers, "X-Swarm-User-Id": userId },
        })
      ).status,
    ).toBe(401);
    expect(
      (await authedFetch("/api/fs/me", { headers: { "X-Swarm-User-Id": userId } })).status,
    ).toBe(401);
    for (const status of ["invited", "suspended"] as const) {
      const inactive = await createUser({ name: status, status });
      expect(
        (await operatorFetch("/api/fs/me", { headers: { "X-Swarm-User-Id": inactive.id } })).status,
      ).toBe(401);
    }
    expect(
      (await operatorFetch("/api/fs/me", { headers: { "X-Swarm-User-Id": "missing-user" } }))
        .status,
    ).toBe(401);
    expect(requests).toHaveLength(0);
  });

  test("page sessions cannot access personal filesystem identity or keys", async () => {
    const page = await createPage({
      agentId,
      slug: `fs-page-${crypto.randomUUID()}`,
      title: "FS page",
      contentType: "text/html",
      body: "<p>test</p>",
    });
    for (const identity of [{ op: true as const }, { uid: userId }]) {
      const session = await signPageSession({
        pageId: page.id,
        exp: Math.floor(Date.now() / 1000) + 60,
        ...identity,
      });
      const headers = {
        "X-Page-Session": session,
        "X-Page-Id": page.id,
        "X-Swarm-User-Id": userId,
      };
      expect((await operatorFetch("/api/fs/me", { headers })).status).toBe(401);
      expect(
        (
          await operatorFetch("/api/fs/keys", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ label: "page key" }),
          })
        ).status,
      ).toBe(401);
    }
    expect(requests).toHaveLength(0);
  });

  test("a personal key returns once with no-store and no bootstrap credential", async () => {
    const response = await createKey();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      apiKey: mintedKey,
      keyId: "personal-key",
      label: "laptop",
      agentFsUserId,
      orgId,
      driveId,
    });
    const keyRequest = requests.find((request) => request.path.endsWith("/keys"));
    expect(keyRequest?.body).toMatchObject({ label: "laptop" });
    expect(keyRequest?.authorization).toBe(`Bearer ${bootstrapKey}`);
  });

  test("invalid labels fail before upstream work", async () => {
    for (const label of ["", "x".repeat(101), 42, null])
      expect((await createKey(label)).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  test("pending membership returns 409 and an old server returns 501", async () => {
    mode = "pending";
    expect((await createKey()).status).toBe(409);
    mode = "missing-member";
    expect((await createKey()).status).toBe(409);
    mode = "unsupported";
    const response = await createKey();
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "agent_fs_too_old" });
  });

  test("disabled agent-fs returns 503", async () => {
    delete process.env.AGENT_FS_API_URL;
    expect((await createKey()).status).toBe(503);
    expect(requests).toHaveLength(0);
  });

  test("a user without fs.join.own gets no account check, also behind the operator key", async () => {
    process.env.RBAC_ENABLED = "true";
    await getDbClient().run(
      "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      [userId],
    );
    const own = await personal("/api/fs/me");
    expect(own.status).toBe(403);
    expect(await own.json()).toEqual({ error: "missing permission 'fs.join.own'" });
    const picked = { "X-Swarm-User-Id": userId, "Content-Type": "application/json" };
    expect((await operatorFetch("/api/fs/me", { headers: picked })).status).toBe(403);
    const mint = { method: "POST", headers: picked, body: JSON.stringify({ label: "picked" }) };
    expect((await operatorFetch("/api/fs/keys", mint)).status).toBe(403);
    const resume = JSON.stringify({ returnTo: "https://live.agent-fs.dev/files" });
    expect(
      (await operatorFetch("/api/fs/continue", { method: "POST", headers: picked, body: resume }))
        .status,
    ).toBe(403);
    expect(requests).toHaveLength(0);
  });

  test("the twenty-first account check per minute is limited per user", async () => {
    for (let i = 0; i < 20; i++) expect((await personal("/api/fs/me")).status).toBe(200);
    const count = requests.length;
    expect((await personal("/api/fs/me")).status).toBe(429);
    expect(requests).toHaveLength(count);
  });

  test("keys require fs.join.own permission", async () => {
    process.env.RBAC_ENABLED = "true";
    await getDbClient().run(
      "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      [userId],
    );
    const response = await createKey();
    expect(response.status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  test("the sixth key per minute is limited per user", async () => {
    for (let i = 0; i < 5; i++) expect((await createKey(`key-${i}`)).status).toBe(201);
    const count = requests.filter((request) => request.path.endsWith("/keys")).length;
    const response = await createKey("sixth");
    expect(response.status).toBe(429);
    expect(requests.filter((request) => request.path.endsWith("/keys"))).toHaveLength(count);
    email = `other-fs-${crypto.randomUUID()}@example.com`;
    const other = await createUser({ name: "Other key user", email });
    token = (await mintToken(other.id, "other", { kind: "operator", id: "fs-tests" })).plaintext;
    expect((await createKey()).status).toBe(201);
  });
});

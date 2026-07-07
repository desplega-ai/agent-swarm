// RBAC slice-1 characterization — HTTP-surface gates (Phase 2 of
// thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md).
//
// Pins TODAY's behavior of `canMutateTask` (src/http/fs.ts:432-444, appendix
// row 36). Decision order matters and is part of the characterization:
//
//   1. request auth kind "operator" (swarm key)  → allow — BEFORE any agent check,
//      so an operator bearer with a non-owner X-Agent-ID is still allowed.
//   2. request auth kind "user" (aswt_ token)    → allow.
//   3. otherwise (auth context unset): lead OR task-assignee OR task-creator
//      → allow; anything else → 403 {"error":"Caller cannot mutate this task's files"}.
//
// Branch 3 is only reachable when `getRequestAuth(req)` is null. Through the
// production pipeline `handleCore` 401s such requests first (every accepted
// bearer is operator or user), so we characterize it by invoking `handleFs`
// WITHOUT `handleCore` — the exact auth-null condition under which those
// branches decide. Phase 5 must preserve this full decision table in can().
// These tests must pass unchanged before AND after the Phase-5 migration.
//
// Other HTTP gates from the Phase-1 inventory:
// - kv `authorizeWrite` (src/http/kv.ts:329, appendix row 35): characterized
//   by the pre-existing kv-http.test.ts:269-311 — not duplicated here.
// - http/agents.ts: NO hard gates (all isLead hits are NON-AUTHZ —
//   registration schema / pass-through / telemetry), so no tests needed.
// - http/scripts.ts global write/delete: intentionally NOT characterized here;
//   the permissive behavior flips in Phase 5 (scripts-http.test.ts:319-345).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getTaskAttachments,
  initDb,
} from "../be/db";
import { type IdentityActor, mintToken } from "../be/users";
import { resetFileStorageProviderForTests } from "../fs/registry";
import { handleCore } from "../http/core";
import { handleFs } from "../http/fs";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-rbac-charact-http.sqlite";
const TEST_FS_DIR = "./test-rbac-charact-http-data";
const API_KEY = "test-rbac-http-key";
const ACTOR: IdentityActor = { kind: "operator", id: "test" };

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

// Full production pipeline: auth via handleCore, then handleFs
// (pattern: kv-http.test.ts:39-52).
function createPipelineServer(apiKey: string): Server {
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

// handleFs WITHOUT handleCore: `getRequestAuth(req)` stays null, which is the
// only condition under which canMutateTask's agent-identity branches
// (lead / assignee / creator / deny) decide. See header comment.
function createNoAuthContextServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleFs(req, res, pathSegments, queryParams, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let pipelineServer: Server;
let pipelinePort: number;
let bareServer: Server;
let barePort: number;
let assigneeId: string;
let creatorId: string;
let outsiderId: string;
let leadId: string;
let userToken: string;
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
  pipelineServer = createPipelineServer(API_KEY);
  pipelinePort = await listen(pipelineServer);
  bareServer = createNoAuthContextServer();
  barePort = await listen(bareServer);

  assigneeId = createAgent({ name: "rbac-fs-assignee", isLead: false, status: "idle" }).id;
  creatorId = createAgent({ name: "rbac-fs-creator", isLead: false, status: "idle" }).id;
  outsiderId = createAgent({ name: "rbac-fs-outsider", isLead: false, status: "idle" }).id;
  leadId = createAgent({ name: "rbac-fs-lead", isLead: true, status: "idle" }).id;

  const user = createUser({ name: "RBAC FS User" });
  userToken = mintToken(user.id, "rbac-charact", ACTOR).plaintext;
});

afterAll(async () => {
  await new Promise<void>((resolve) => pipelineServer.close(() => resolve()));
  await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  await rm(TEST_FS_DIR, { recursive: true, force: true });
  delete process.env.AGENT_FS_LOCAL_DIR;
  resetFileStorageProviderForTests();
});

beforeEach(async () => {
  await rm(TEST_FS_DIR, { recursive: true, force: true });
  resetFileStorageProviderForTests();
  taskId = createTaskExtended("rbac fs charact task", {
    agentId: assigneeId,
    creatorAgentId: creatorId,
    source: "mcp",
  }).id;
});

const DENY_BODY = { error: "Caller cannot mutate this task's files" };

function uploadPath(): string {
  return `/api/fs/tasks/${taskId}/files?name=charact.txt`;
}

function pipelineUpload(opts: { bearer?: string; agentId?: string }): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearer ?? API_KEY}`,
    "Content-Type": "text/plain",
  };
  if (opts.agentId !== undefined) headers["X-Agent-ID"] = opts.agentId;
  return fetch(`http://localhost:${pipelinePort}${uploadPath()}`, {
    method: "POST",
    body: Buffer.from("rbac characterization"),
    headers,
  });
}

function bareFetch(path: string, init: RequestInit & { agentId?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.agentId !== undefined) headers["X-Agent-ID"] = init.agentId;
  return fetch(`http://localhost:${barePort}${path}`, { ...init, headers });
}

function bareUpload(opts: { agentId?: string }): Promise<Response> {
  return bareFetch(uploadPath(), {
    method: "POST",
    body: Buffer.from("rbac characterization"),
    headers: { "Content-Type": "text/plain" },
    ...opts,
  });
}

describe("canMutateTask — real pipeline (handleCore auth → handleFs)", () => {
  test("operator (swarm key, no X-Agent-ID) is allowed", async () => {
    const res = await pipelineUpload({});
    expect(res.status).toBe(201);
  });

  test("operator bearer short-circuits BEFORE agent identity: non-owner X-Agent-ID is still allowed", async () => {
    const res = await pipelineUpload({ agentId: outsiderId });
    expect(res.status).toBe(201);
  });

  test("authenticated user (aswt_ token, no X-Agent-ID) is allowed", async () => {
    const res = await pipelineUpload({ bearer: userToken });
    expect(res.status).toBe(201);
  });

  test("authenticated user with a non-owner X-Agent-ID is still allowed", async () => {
    const res = await pipelineUpload({ bearer: userToken, agentId: outsiderId });
    expect(res.status).toBe(201);
  });
});

describe("canMutateTask — agent-identity branches (auth context unset)", () => {
  test("lead agent is allowed", async () => {
    const res = await bareUpload({ agentId: leadId });
    expect(res.status).toBe(201);
  });

  test("assignee agent (task.agentId) is allowed", async () => {
    const res = await bareUpload({ agentId: assigneeId });
    expect(res.status).toBe(201);
  });

  test("creator agent (task.creatorAgentId, not assignee) is allowed", async () => {
    const res = await bareUpload({ agentId: creatorId });
    expect(res.status).toBe(201);
  });

  test("non-owner worker is denied with 403 and the exact body; DB untouched", async () => {
    const res = await bareUpload({ agentId: outsiderId });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENY_BODY);
    expect(getTaskAttachments(taskId)).toEqual([]);
  });

  test("missing X-Agent-ID (no auth, no agent) is denied with 403", async () => {
    const res = await bareUpload({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENY_BODY);
  });

  test("DELETE: non-owner worker is denied before attachment lookup; row survives", async () => {
    const seeded = await bareUpload({ agentId: assigneeId });
    expect(seeded.status).toBe(201);
    const attachment = (await seeded.json()) as { id: string };

    const res = await bareFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
      agentId: outsiderId,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(DENY_BODY);
    expect(getTaskAttachments(taskId)).toHaveLength(1);
  });

  test("DELETE: assignee agent can delete", async () => {
    const seeded = await bareUpload({ agentId: assigneeId });
    const attachment = (await seeded.json()) as { id: string };

    const res = await bareFetch(`/api/fs/tasks/${taskId}/files/${attachment.id}`, {
      method: "DELETE",
      agentId: assigneeId,
    });
    expect(res.status).toBe(204);
    expect(getTaskAttachments(taskId)).toEqual([]);
  });
});

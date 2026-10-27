/**
 * RBAC HTTP admission tests (DES-445 increment 3).
 *
 * In-process handleCore wiring depends on routeRegistry population. Import the
 * route-owning handler modules used by this suite at file load so findRoute()
 * sees the same route() definitions that the real server imports at boot.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createUser, getDbClient, initDb } from "../be/db";
import { flushAuditBuffer } from "../be/rbac-audit";
import { attachRole, detachRole, ensureRbacSeedsSynced } from "../be/rbac-roles";
import {
  resetAgentFsProvisionFetchForTests,
  setAgentFsProvisionFetchForTests,
} from "../be/seed/agent-fs-provision";
import { type IdentityActor, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleDbQuery } from "../http/db-query";
import { handleFs } from "../http/fs";
import { handleInboxState } from "../http/inbox-state";
import { handleMcpOAuth } from "../http/mcp-oauth";
import { handleRealtimeTicket } from "../http/realtime";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { decideAdmission, decideToolAdmission, isRbacEnabled, type PermissionVerb } from "../rbac";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-rbac-admission.sqlite";
const API_KEY = "example-test-api-key";
const LEAD_ID = "aaaa7000-0000-4000-8000-000000000001";
const ACTOR: IdentityActor = { kind: "operator", id: "op:test" };
const MISSING_TASK_ID = "00000000-0000-4000-8000-000000000000";

type ApiResponse = {
  status: number;
  body: unknown;
};

type AdmissionAuditRow = {
  principalType: string;
  principalId: string | null;
  verb: string;
  resourceType: string | null;
  resourceId: string | null;
  decision: string;
  reason: string | null;
  source: string;
};

function grant(verbs: PermissionVerb[] = [], grantsAll = false) {
  return { grantsAll, verbs: new Set(verbs) };
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleTasks(req, res, pathSegments, queryParams, myAgentId)) return;
    if (await handleFs(req, res, pathSegments, queryParams, myAgentId)) return;
    if (await handleInboxState(req, res, pathSegments, queryParams)) return;
    if (await handleDbQuery(req, res, pathSegments, queryParams)) return;
    if (await handleMcpOAuth(req, res, pathSegments, queryParams)) return;
    if (await handleRealtimeTicket(req, res, pathSegments, queryParams)) return;

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

async function api(
  port: number,
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown; rawBody?: BodyInit } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearer ?? API_KEY}`,
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  } else if (opts.rawBody !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = opts.rawBody;
  }

  const res = await fetch(`http://localhost:${port}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave non-JSON responses as text.
    }
  }
  return { status: res.status, body: parsed };
}

async function createTokenForUser(name: string): Promise<{ userId: string; plaintext: string }> {
  const user = await createUser({ name });
  const { plaintext } = await mintToken(user.id, "admission", ACTOR);
  return { userId: user.id, plaintext };
}

async function narrowUserToRequester(userId: string): Promise<void> {
  await detachRole(userId, "admin");
  await attachRole(userId, "requester");
}

async function admissionAuditRows(): Promise<AdmissionAuditRow[]> {
  return getDbClient().query<AdmissionAuditRow>(
    `SELECT principalType, principalId, verb, resourceType, resourceId, decision, reason, source
       FROM permission_audit
       WHERE resourceType = 'http-route'
       ORDER BY ts, id`,
  );
}

let savedEnv: NodeJS.ProcessEnv;
let server: Server | undefined;
let port = 0;

beforeAll(() => {
  savedEnv = { ...process.env };
});

beforeEach(async () => {
  await closeServer(server);
  server = undefined;
  closeDb();
  await removeDbFiles();

  process.env.RBAC_ENABLED = "false";
  delete process.env.RBAC_AUDIT_DISABLED;
  delete process.env.RBAC_AUDIT_RETENTION_DAYS;

  initDb(TEST_DB_PATH);
  ensureRbacSeedsSynced({ quiet: true });
  await createAgent({ id: LEAD_ID, name: "Admission Lead", isLead: true, status: "idle" });
  await flushAuditBuffer();
  await getDbClient().run("DELETE FROM permission_audit");

  server = createTestServer();
  port = await listenOnFreePort(server);
});

afterEach(async () => {
  await flushAuditBuffer();
  await closeServer(server);
  server = undefined;
  closeDb();
  await removeDbFiles();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("decideAdmission", () => {
  test("allows a declared permission when the grant contains the verb", () => {
    expect(
      decideAdmission({
        method: "POST",
        rbac: { permission: "task.fs.mutate" },
        routeKnown: true,
        grant: grant(["task.fs.mutate"]),
      }),
    ).toEqual({ allow: true, verb: "task.fs.mutate" });
  });

  test("denies a declared permission when the grant lacks the verb", () => {
    expect(
      decideAdmission({
        method: "POST",
        rbac: { permission: "task.fs.mutate" },
        routeKnown: true,
        grant: grant(["task.read.own"]),
      }),
    ).toEqual({
      allow: false,
      reason: "admission: missing permission 'task.fs.mutate'",
      verb: "task.fs.mutate",
    });
  });

  test("declared GET permissions win over the GET fallback", () => {
    expect(
      decideAdmission({
        method: "GET",
        rbac: { permission: "mcp-oauth.authorize.any" },
        routeKnown: true,
        grant: grant(),
      }),
    ).toEqual({
      allow: false,
      reason: "admission: missing permission 'mcp-oauth.authorize.any'",
      verb: "mcp-oauth.authorize.any",
    });

    expect(
      decideAdmission({
        method: "GET",
        rbac: { permission: "mcp-oauth.authorize.any" },
        routeKnown: true,
        grant: grant(["mcp-oauth.authorize.any"]),
      }),
    ).toEqual({ allow: true, verb: "mcp-oauth.authorize.any" });
  });

  test("allows GET and HEAD fallback when no permission verb is declared", () => {
    expect(
      decideAdmission({
        method: "GET",
        rbac: undefined,
        routeKnown: true,
        grant: grant(),
      }),
    ).toEqual({ allow: true });
    expect(
      decideAdmission({
        method: "HEAD",
        rbac: { ungated: "self scoped" },
        routeKnown: true,
        grant: grant(),
      }),
    ).toEqual({ allow: true });
  });

  test("denies verb-less non-GET routes, including ungated and unknown routes", () => {
    const reason = "admission: route has no permission verb (operator-only)";
    expect(
      decideAdmission({
        method: "POST",
        rbac: { ungated: "self scoped" },
        routeKnown: true,
        grant: grant(),
      }),
    ).toEqual({ allow: false, reason });
    expect(
      decideAdmission({
        method: "PATCH",
        rbac: undefined,
        routeKnown: true,
        grant: grant(),
      }),
    ).toEqual({ allow: false, reason });
    expect(
      decideAdmission({
        method: "DELETE",
        rbac: undefined,
        routeKnown: false,
        grant: grant(),
      }),
    ).toEqual({ allow: false, reason });
  });

  test("grantsAll allows before permission or method checks", () => {
    expect(
      decideAdmission({
        method: "POST",
        rbac: undefined,
        routeKnown: false,
        grant: grant([], true),
      }),
    ).toEqual({ allow: true });
  });
});

describe("decideToolAdmission", () => {
  test("grantsAll allows before permission or read-only checks", () => {
    expect(
      decideToolAdmission({
        rbac: undefined,
        readOnly: false,
        grant: grant([], true),
      }),
    ).toEqual({ allow: true });
  });

  test("allows a declared permission when the grant contains the verb", () => {
    expect(
      decideToolAdmission({
        rbac: { permission: "task.create.own" },
        readOnly: false,
        grant: grant(["task.create.own"]),
      }),
    ).toEqual({ allow: true, verb: "task.create.own" });
  });

  test("denies a declared permission when the grant lacks the verb", () => {
    expect(
      decideToolAdmission({
        rbac: { permission: "task.create.own" },
        readOnly: false,
        grant: grant(["task.read.own"]),
      }),
    ).toEqual({
      allow: false,
      reason: "admission: missing permission 'task.create.own'",
      verb: "task.create.own",
    });
  });

  test("allows read-only tools without a permission verb", () => {
    expect(
      decideToolAdmission({
        rbac: undefined,
        readOnly: true,
        grant: grant(),
      }),
    ).toEqual({ allow: true });
  });

  test("denies non-read-only tools without a permission verb", () => {
    expect(
      decideToolAdmission({
        rbac: { ungated: "self scoped" },
        readOnly: false,
        grant: grant(),
      }),
    ).toEqual({
      allow: false,
      reason: "admission: tool has no permission verb (operator-only)",
    });
  });
});

describe("handleCore admission wiring", () => {
  test("flag off leaves narrowed user-token REST writes untouched and unaudited", async () => {
    const { userId, plaintext } = await createTokenForUser("Flag Off User");
    await detachRole(userId, "admin");

    const res = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "flag off admission bypass" },
    });

    expect(res.status).toBe(201);
    await flushAuditBuffer();
    expect(await admissionAuditRows()).toEqual([]);
  });

  test("OAuth authorize-url GET uses its declared verb instead of the GET fallback", async () => {
    const { userId: requesterId, plaintext: requesterToken } =
      await createTokenForUser("OAuth Requester User");
    await narrowUserToRequester(requesterId);

    process.env.RBAC_ENABLED = "true";

    const denied = await api(port, "GET", "/api/mcp-oauth/missing-server/authorize-url", {
      bearer: requesterToken,
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      error: "Forbidden: admission: missing permission 'mcp-oauth.authorize.any'",
    });

    const { plaintext: adminToken } = await createTokenForUser("OAuth Admin User");
    const admin = await api(port, "GET", "/api/mcp-oauth/missing-server/authorize-url", {
      bearer: adminToken,
    });
    expect(admin.status).not.toBe(403);
    expect(admin.status).toBe(404);

    process.env.RBAC_ENABLED = "false";

    const flagOff = await api(port, "GET", "/api/mcp-oauth/missing-server/authorize-url", {
      bearer: requesterToken,
    });
    expect(flagOff.status).not.toBe(403);
    expect(flagOff.status).toBe(404);

    await flushAuditBuffer();
    expect(
      (await admissionAuditRows()).find(
        (row) =>
          row.principalId === requesterId &&
          row.resourceId === "GET /api/mcp-oauth/{mcpServerId}/authorize-url",
      ),
    ).toMatchObject({
      verb: "mcp-oauth.authorize.any",
      decision: "deny",
      reason: "admission: missing permission 'mcp-oauth.authorize.any'",
      source: "http",
    });
  });

  test("flag on default-admin users bypass admission and preserve no-op behavior", async () => {
    process.env.RBAC_ENABLED = "true";
    const { plaintext } = await createTokenForUser("Default Admin User");

    const res = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "default admin admission bypass" },
    });

    expect(res.status).toBe(201);
    await flushAuditBuffer();
    expect(await admissionAuditRows()).toEqual([]);
  });

  test("flag on requester grant admits declared verbs and reads, denies verb-less writes, and audits each decision", async () => {
    process.env.RBAC_ENABLED = "true";
    const { userId, plaintext } = await createTokenForUser("Requester User");
    await narrowUserToRequester(userId);

    const created = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "requester creates its own task" },
    });
    expect(created.status).toBe(201);

    const denied = await api(port, "POST", "/api/db-query", {
      bearer: plaintext,
      body: { sql: "select 1" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      error: "Forbidden: admission: route has no permission verb (operator-only)",
    });

    const read = await api(port, "GET", "/api/tasks", { bearer: plaintext });
    expect(read.status).toBe(200);

    const declaredVerb = await api(
      port,
      "POST",
      `/api/fs/tasks/${MISSING_TASK_ID}/files?name=admission.txt`,
      { bearer: plaintext, rawBody: "hello" },
    );
    expect(declaredVerb.status).toBe(404);
    expect(declaredVerb.body).toEqual({ error: "Task not found" });

    await flushAuditBuffer();
    const rows = await admissionAuditRows();
    expect(rows).toHaveLength(4);

    expect(rows.find((row) => row.resourceId === "POST /api/tasks")).toMatchObject({
      principalType: "user",
      principalId: userId,
      verb: "task.create.own",
      decision: "allow",
      reason: null,
      source: "http",
    });
    expect(rows.find((row) => row.resourceId === "POST /api/db-query")).toMatchObject({
      principalType: "user",
      principalId: userId,
      verb: "(admission:no-verb)",
      decision: "deny",
      reason: "admission: route has no permission verb (operator-only)",
      source: "http",
    });
    expect(rows.find((row) => row.resourceId === "GET /api/tasks")).toMatchObject({
      principalType: "user",
      principalId: userId,
      verb: "(admission:no-verb)",
      decision: "allow",
      reason: null,
      source: "http",
    });
    expect(
      rows.find((row) => row.resourceId === "POST /api/fs/tasks/{taskId}/files"),
    ).toMatchObject({
      principalType: "user",
      principalId: userId,
      verb: "task.fs.mutate",
      decision: "allow",
      reason: null,
      source: "http",
    });
  });
});

describe("requester and viewer task lifecycle", () => {
  async function createTask(bearer: string, task: string): Promise<string> {
    const res = await api(port, "POST", "/api/tasks", { bearer, body: { task } });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  async function setStatus(taskId: string, status: string): Promise<void> {
    await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [status, taskId]);
  }

  async function lifecycle(bearer: string, taskId: string): Promise<Record<string, number>> {
    await setStatus(taskId, "in_progress");
    const pause = await api(port, "POST", `/api/tasks/${taskId}/pause`, { bearer });
    await setStatus(taskId, "paused");
    const resume = await api(port, "POST", `/api/tasks/${taskId}/resume`, { bearer });
    const steer = await api(port, "POST", `/api/tasks/${taskId}/steer`, {
      bearer,
      body: { message: "requester steer" },
    });
    const title = await api(port, "PATCH", `/api/tasks/${taskId}/title`, {
      bearer,
      body: { title: "requester title" },
    });
    const cancel = await api(port, "POST", `/api/tasks/${taskId}/cancel`, { bearer });
    return {
      pause: pause.status,
      resume: resume.status,
      steer: steer.status,
      title: title.status,
      cancel: cancel.status,
    };
  }

  test("a requester creates, pauses, resumes, steers, renames and cancels its own task", async () => {
    process.env.RBAC_ENABLED = "true";
    const { userId, plaintext } = await createTokenForUser("Lifecycle Requester");
    await narrowUserToRequester(userId);

    const taskId = await createTask(plaintext, "requester lifecycle");
    const owner = await getDbClient().get<{ requestedByUserId: string | null }>(
      "SELECT requestedByUserId FROM agent_tasks WHERE id = ?",
      [taskId],
    );
    expect(owner?.requestedByUserId).toBe(userId);

    expect(await lifecycle(plaintext, taskId)).toEqual({
      pause: 200,
      resume: 200,
      steer: 200,
      title: 200,
      cancel: 200,
    });
  });

  test("the same calls on another user's task hit the session wall, not admission", async () => {
    process.env.RBAC_ENABLED = "true";
    const other = await createTokenForUser("Task Owner");
    const foreignTaskId = await createTask(other.plaintext, "someone else's task");
    const { userId, plaintext } = await createTokenForUser("Foreign Requester");
    await narrowUserToRequester(userId);

    const calls: [string, string, unknown][] = [
      ["POST", `/api/tasks/${foreignTaskId}/pause`, undefined],
      ["POST", `/api/tasks/${foreignTaskId}/resume`, undefined],
      ["POST", `/api/tasks/${foreignTaskId}/steer`, { message: "not mine" }],
      ["PATCH", `/api/tasks/${foreignTaskId}/title`, { title: "not mine" }],
      ["POST", `/api/tasks/${foreignTaskId}/cancel`, undefined],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(port, method, path, { bearer: plaintext, body });
      const error = (res.body as { error?: string }).error ?? "";
      expect({ path, status: res.status, admission: error.includes("admission:") }).toEqual({
        path,
        status: 403,
        admission: false,
      });
    }
    const task = await getDbClient().get<{ status: string; title: string | null }>(
      "SELECT status, title FROM agent_tasks WHERE id = ?",
      [foreignTaskId],
    );
    expect(task?.status).not.toBe("cancelled");
    expect(task?.title).not.toBe("not mine");
  });

  // Regression: the session wall reads an ownerless root (Slack, schedules,
  // operator key) as everyone's, so without the handler ownership check a
  // requester could cancel, pause, resume or rename any such task.
  test("a requester cannot change an ownerless task, an admin user still can", async () => {
    process.env.RBAC_ENABLED = "true";
    const { userId, plaintext } = await createTokenForUser("Ownerless Requester");
    await narrowUserToRequester(userId);
    const admin = await createTokenForUser("Ownerless Admin");

    const taskId = await createTask(API_KEY, "operator task with no owner");
    const owner = await getDbClient().get<{ requestedByUserId: string | null }>(
      "SELECT requestedByUserId FROM agent_tasks WHERE id = ?",
      [taskId],
    );
    expect(owner?.requestedByUserId).toBeNull();

    await setStatus(taskId, "in_progress");
    const pause = await api(port, "POST", `/api/tasks/${taskId}/pause`, { bearer: plaintext });
    await setStatus(taskId, "paused");
    const resume = await api(port, "POST", `/api/tasks/${taskId}/resume`, { bearer: plaintext });
    const title = await api(port, "PATCH", `/api/tasks/${taskId}/title`, {
      bearer: plaintext,
      body: { title: "not mine" },
    });
    const cancel = await api(port, "POST", `/api/tasks/${taskId}/cancel`, { bearer: plaintext });
    expect({
      pause: pause.status,
      resume: resume.status,
      title: title.status,
      cancel: cancel.status,
    }).toEqual({ pause: 403, resume: 403, title: 403, cancel: 403 });
    const task = await getDbClient().get<{ status: string; title: string | null }>(
      "SELECT status, title FROM agent_tasks WHERE id = ?",
      [taskId],
    );
    expect(task?.status).toBe("paused");
    expect(task?.title).not.toBe("not mine");

    const adminTitle = await api(port, "PATCH", `/api/tasks/${taskId}/title`, {
      bearer: admin.plaintext,
      body: { title: "admin title" },
    });
    const adminCancel = await api(port, "POST", `/api/tasks/${taskId}/cancel`, {
      bearer: admin.plaintext,
    });
    expect({ title: adminTitle.status, cancel: adminCancel.status }).toEqual({
      title: 200,
      cancel: 200,
    });
  });

  test("a viewer cannot create a task", async () => {
    process.env.RBAC_ENABLED = "true";
    const { userId, plaintext } = await createTokenForUser("Viewer User");
    await detachRole(userId, "admin");
    await attachRole(userId, "viewer");

    const res = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "viewer should not create" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Forbidden: admission: missing permission 'task.create.own'",
    });
  });
});

describe("per-user inbox state", () => {
  const item = { itemType: "approval", itemId: "inbox-guard", status: "done" };

  test("a requester writes its own inbox state but not another user's", async () => {
    process.env.RBAC_ENABLED = "true";
    const other = await createUser({ name: "Inbox Other" });
    const { userId, plaintext } = await createTokenForUser("Inbox Requester");
    await narrowUserToRequester(userId);

    const own = await api(port, "PATCH", "/api/inbox-state", {
      bearer: plaintext,
      body: { ...item, userId },
    });
    expect(own.status).toBe(200);

    const foreign = await api(port, "PATCH", "/api/inbox-state", {
      bearer: plaintext,
      body: { ...item, userId: other.id },
    });
    expect(foreign.status).toBe(403);

    const foreignBulk = await api(port, "PATCH", "/api/inbox-state/bulk", {
      bearer: plaintext,
      body: { userId: other.id, items: [item] },
    });
    expect(foreignBulk.status).toBe(403);

    const rows = await getDbClient().query<{ userId: string }>(
      "SELECT userId FROM inbox_item_state WHERE itemId = 'inbox-guard'",
    );
    expect(rows.map((row) => row.userId)).toEqual([userId]);
  });

  test("the operator key and an admin user still write any user's inbox state", async () => {
    process.env.RBAC_ENABLED = "true";
    const other = await createUser({ name: "Inbox Target" });
    const admin = await createTokenForUser("Inbox Admin");

    const operator = await api(port, "PATCH", "/api/inbox-state", {
      body: { ...item, userId: other.id },
    });
    expect(operator.status).toBe(200);

    const adminCall = await api(port, "PATCH", "/api/inbox-state/bulk", {
      bearer: admin.plaintext,
      body: { userId: other.id, items: [{ ...item, itemId: "inbox-guard-2" }] },
    });
    expect(adminCall.status).toBe(200);
  });
});

describe("join the shared agent-fs drive", () => {
  const AGENT_FS_ENV_KEYS = [
    "AGENT_FS_API_URL",
    "API_AGENT_FS_API_KEY",
    "AGENT_FS_API_KEY",
    "AGENT_FS_DEFAULT_ORG_ID",
    "AGENT_FS_SHARED_ORG_ID",
    "AGENT_FS_DEFAULT_DRIVE_ID",
    "AGENT_FS_REGISTER_EMAIL",
  ];
  let invites: { email: string; role: string }[] = [];

  beforeEach(() => {
    invites = [];
    for (const key of AGENT_FS_ENV_KEYS) delete process.env[key];
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test";
    process.env.API_AGENT_FS_API_KEY = "example-afs-admin-key";
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";
    setAgentFsProvisionFetchForTests((async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/auth/me") return Response.json({ userId: "admin-user" });
      if (url.pathname === "/orgs" && method === "GET") {
        return Response.json({ orgs: [{ id: "shared-org", name: "swarm" }] });
      }
      if (url.pathname === "/orgs/shared-org/drives" && method === "GET") {
        return Response.json({ drives: [{ id: "shared-drive", name: "shared" }] });
      }
      if (url.pathname === "/orgs/shared-org/members" && method === "GET") {
        return Response.json({ members: [] });
      }
      if (url.pathname === "/orgs/shared-org/members/invite" && method === "POST") {
        invites.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected route" }, { status: 500 });
    }) as typeof fetch);
  });

  afterEach(() => {
    resetAgentFsProvisionFetchForTests();
    for (const key of AGENT_FS_ENV_KEYS) delete process.env[key];
  });

  async function tokenWithRole(name: string, email: string, role: string) {
    const user = await createUser({ name, email });
    const { plaintext } = await mintToken(user.id, "admission", ACTOR);
    if (role !== "admin") {
      await detachRole(user.id, "admin");
      await attachRole(user.id, role);
    }
    return plaintext;
  }

  test("a requester cannot invite another email", async () => {
    process.env.RBAC_ENABLED = "true";
    const bearer = await tokenWithRole("Join Requester", "Req.User@example.test", "requester");

    const res = await api(port, "POST", "/api/fs/members/invite", {
      bearer,
      body: { email: "someone-else@example.test", role: "admin" },
    });
    expect(res.status).toBe(403);
    expect(invites).toEqual([]);
  });

  test("a requester joins with its own email as editor, whatever role it asks for", async () => {
    process.env.RBAC_ENABLED = "true";
    const bearer = await tokenWithRole("Join Requester", "Req.User@example.test", "requester");

    const res = await api(port, "POST", "/api/fs/members/invite", {
      bearer,
      body: { email: "req.user@EXAMPLE.test", role: "admin" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId: "shared-org", invited: true, status: "added" });
    expect(invites).toEqual([{ email: "Req.User@example.test", role: "editor" }]);
  });

  test("a viewer joins with its own email as viewer", async () => {
    process.env.RBAC_ENABLED = "true";
    const bearer = await tokenWithRole("Join Viewer", "viewer@example.test", "viewer");

    const res = await api(port, "POST", "/api/fs/members/invite", {
      bearer,
      body: { email: "viewer@example.test" },
    });
    expect(res.status).toBe(200);
    expect(invites).toEqual([{ email: "viewer@example.test", role: "viewer" }]);
  });

  test("the operator key and an admin user invite any email at the requested role", async () => {
    process.env.RBAC_ENABLED = "true";
    const bearer = await tokenWithRole("Join Admin", "admin-user@example.test", "admin");

    const operator = await api(port, "POST", "/api/fs/members/invite", {
      body: { email: "teammate@example.test", role: "admin" },
    });
    expect(operator.status).toBe(200);
    const admin = await api(port, "POST", "/api/fs/members/invite", {
      bearer,
      body: { email: "another@example.test" },
    });
    expect(admin.status).toBe(200);
    expect(invites).toEqual([
      { email: "teammate@example.test", role: "admin" },
      { email: "another@example.test", role: "editor" },
    ]);
  });
});

describe("realtime ticket admission", () => {
  async function grantOnly(userId: string, verbs: PermissionVerb[]): Promise<void> {
    const roleId = `rbac-role-test-${crypto.randomUUID()}`;
    await detachRole(userId, "admin");
    await getDbClient().run(
      `INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, 'test', 0, 0)`,
      [roleId, roleId],
    );
    for (const verb of verbs) {
      await getDbClient().run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [
        roleId,
        verb,
      ]);
    }
    await getDbClient().run(
      `INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, ?)`,
      [userId, roleId],
    );
  }

  test("a role with either presence verb gets a ticket; a role with neither does not", async () => {
    process.env.RBAC_ENABLED = "true";
    const cases: [PermissionVerb[], number][] = [
      [["comb.presence"], 200],
      [["session.presence"], 200],
      [["task.read.own"], 403],
    ];
    for (const [verbs, expected] of cases) {
      const { userId, plaintext } = await createTokenForUser(`Presence ${verbs.join(",")}`);
      await grantOnly(userId, verbs);
      const response = await api(port, "POST", "/api/realtime/ticket", { bearer: plaintext });
      expect({ verbs, status: response.status }).toEqual({ verbs, status: expected });
    }
  });
});

test("RBAC defaults on and accepts explicit opt-outs", () => {
  const previous = process.env.RBAC_ENABLED;
  try {
    delete process.env.RBAC_ENABLED;
    expect(isRbacEnabled()).toBe(true);
    for (const value of ["false", "0"]) {
      process.env.RBAC_ENABLED = value;
      expect(isRbacEnabled()).toBe(false);
    }
  } finally {
    if (previous === undefined) delete process.env.RBAC_ENABLED;
    else process.env.RBAC_ENABLED = previous;
  }
});

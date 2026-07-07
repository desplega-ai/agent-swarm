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
import { closeDb, createAgent, createUser, getDb, initDb } from "../be/db";
import { flushAuditBuffer } from "../be/rbac-audit";
import { attachRole, detachRole, ensureRbacSeedsSynced } from "../be/rbac-roles";
import { type IdentityActor, mintToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleFs } from "../http/fs";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { decideAdmission, type PermissionVerb } from "../rbac";

const TEST_DB_PATH = "./test-rbac-admission.sqlite";
const API_KEY = "test-api-key";
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

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
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

function createTokenForUser(name: string): { userId: string; plaintext: string } {
  const user = createUser({ name });
  const { plaintext } = mintToken(user.id, "admission", ACTOR);
  return { userId: user.id, plaintext };
}

function narrowUserToRequester(userId: string): void {
  detachRole(userId, "admin");
  attachRole(userId, "requester");
}

function admissionAuditRows(): AdmissionAuditRow[] {
  return getDb()
    .prepare(
      `SELECT principalType, principalId, verb, resourceType, resourceId, decision, reason, source
       FROM permission_audit
       WHERE resourceType = 'http-route'
       ORDER BY ts, id`,
    )
    .all() as AdmissionAuditRow[];
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

  delete process.env.RBAC_ENABLED;
  delete process.env.RBAC_AUDIT_DISABLED;
  delete process.env.RBAC_AUDIT_RETENTION_DAYS;

  initDb(TEST_DB_PATH);
  ensureRbacSeedsSynced({ quiet: true });
  createAgent({ id: LEAD_ID, name: "Admission Lead", isLead: true, status: "idle" });
  flushAuditBuffer();
  getDb().run("DELETE FROM permission_audit");

  server = createTestServer();
  port = await listen(server);
});

afterEach(async () => {
  flushAuditBuffer();
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

describe("handleCore admission wiring", () => {
  test("flag off leaves narrowed user-token REST writes untouched and unaudited", async () => {
    const { userId, plaintext } = createTokenForUser("Flag Off User");
    detachRole(userId, "admin");

    const res = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "flag off admission bypass" },
    });

    expect(res.status).toBe(201);
    flushAuditBuffer();
    expect(admissionAuditRows()).toEqual([]);
  });

  test("flag on default-admin users bypass admission and preserve no-op behavior", async () => {
    process.env.RBAC_ENABLED = "true";
    const { plaintext } = createTokenForUser("Default Admin User");

    const res = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "default admin admission bypass" },
    });

    expect(res.status).toBe(201);
    flushAuditBuffer();
    expect(admissionAuditRows()).toEqual([]);
  });

  test("flag on requester grant denies verb-less writes, allows reads and declared verbs, and audits each decision", async () => {
    process.env.RBAC_ENABLED = "true";
    const { userId, plaintext } = createTokenForUser("Requester User");
    narrowUserToRequester(userId);

    const denied = await api(port, "POST", "/api/tasks", {
      bearer: plaintext,
      body: { task: "requester should not create generic tasks" },
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

    flushAuditBuffer();
    const rows = admissionAuditRows();
    expect(rows).toHaveLength(3);

    expect(rows.find((row) => row.resourceId === "POST /api/tasks")).toMatchObject({
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

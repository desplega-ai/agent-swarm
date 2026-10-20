import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  createUser,
  getActiveSessions,
  getDbClient,
  getTaskById,
  initDb,
  insertActiveSession,
  insertTaskAttachment,
} from "../be/db";
import { attachRole, detachRole, ensureRbacSeedsSynced } from "../be/rbac-roles";
import { setSessionShares } from "../be/session-shares";
import { mintToken } from "../be/users";
import { getFileStorageProvider, resetFileStorageProvider } from "../fs/registry";
import "../http/all-routes";
import { handleActiveSessions } from "../http/active-sessions";
import { handleApiKeys } from "../http/api-keys";
import { handleApprovalRequests } from "../http/approval-requests";
import { handleApps } from "../http/apps";
import { handleContext } from "../http/context";
import { handleCore } from "../http/core";
import { handleEvents } from "../http/events";
import { handleFs } from "../http/fs";
import { handleMcp } from "../http/mcp";
import { handleMemory } from "../http/memory";
import { handlePoll } from "../http/poll";
import { type RouteDef, routeRegistry } from "../http/route-def";
import { handleScriptRuns } from "../http/script-runs";
import {
  SESSION_AGENT_WIDE_DENIED,
  SESSION_READ_DENIED,
  SESSION_WRITE_DENIED,
  USER_AGENT_HEADER_DENIED,
} from "../http/session-access";
import { handleSessionData } from "../http/session-data";
import { handleSessions } from "../http/sessions";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { beginRequestAuthScope } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

// Walks the route registry. Every route keyed by a task, steering message or
// attachment, every write whose body names a task, and every active-session
// write (keyed by a row id or a whole agent) declares a session posture, and
// each posture holds against minted `aswt_` user tokens: an unshared user and
// a read-only sharee change nothing, the owner and a write sharee pass. A user
// token never acts as an agent through X-Agent-ID.

const OPERATOR_KEY = "session-posture-operator-key";
const TASK_PARAMS = new Set(["taskId", "rootTaskId", "parentTaskId", "attachmentId", "steeringId"]);
const BODY_TASK_KEYS = new Set(["taskId", "parentTaskId", "sourceTaskId", "rootTaskId"]);
const DENIALS = [SESSION_READ_DENIED, SESSION_WRITE_DENIED];

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  agentId: string | undefined,
) => Promise<boolean>;

const HANDLERS: Handler[] = [
  handlePoll,
  handleTasks,
  handleContext,
  handleSessionData,
  handleEvents,
  handleFs,
  handleActiveSessions,
  handleSessions,
  handleApps,
  (req, res, segments, query) => handleApprovalRequests(req, res, segments, query),
  (req, res, segments, query) => handleApiKeys(req, res, segments, query),
  (req, res, segments, query) => handleScriptRuns(req, res, segments, query),
  (req, res, segments, _query, agentId) => handleMemory(req, res, segments, agentId),
  (req, res) => handleMcp(req, res, {}, {}, {}),
];

const server = createServer(async (req, res) => {
  try {
    beginRequestAuthScope();
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, agentId, OPERATOR_KEY)) return;
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    for (const handler of HANDLERS) {
      if (await handler(req, res, segments, query, req.headers["x-agent-id"] as string)) return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});

type Who = "owner" | "writer" | "reader" | "viewer";

let port: number;
let agent: { id: string };
let owner: { id: string };
let writer: { id: string };
let reader: { id: string };
const tokens = {} as Record<Who, string>;
let filesDir: string;
const multiRuntime = process.env.MULTI_RUNTIME_ENABLED;

beforeAll(async () => {
  // Agent-wide cleanup deletes rows only in single-runtime mode.
  process.env.MULTI_RUNTIME_ENABLED = "false";
  filesDir = await mkdtemp(join(tmpdir(), "session-posture-"));
  process.env.AGENT_FS_LOCAL_DIR = filesDir;
  delete process.env.AGENT_FS_API_URL;
  delete process.env.API_AGENT_FS_API_KEY;
  delete process.env.AGENT_FS_API_KEY;
  resetFileStorageProvider();
  initDb(":memory:");
  ensureRbacSeedsSynced({ quiet: true });
  agent = await createAgent({ name: "Worker", isLead: false, status: "idle" });
  owner = await createUser({ name: "Owner" });
  writer = await createUser({ name: "Writer" });
  reader = await createUser({ name: "Reader" });
  const viewer = await createUser({ name: "Viewer" });
  const system = { kind: "system", id: "test" } as const;
  tokens.owner = (await mintToken(owner.id, "test", system)).plaintext;
  tokens.writer = (await mintToken(writer.id, "test", system)).plaintext;
  tokens.reader = (await mintToken(reader.id, "test", system)).plaintext;
  tokens.viewer = (await mintToken(viewer.id, "test", system)).plaintext;
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  resetFileStorageProvider();
  if (multiRuntime === undefined) delete process.env.MULTI_RUNTIME_ENABLED;
  else process.env.MULTI_RUNTIME_ENABLED = multiRuntime;
  await rm(filesDir, { recursive: true, force: true });
});

function pathParams(path: string): string[] {
  return path.match(/\{(\w+)\}/g)?.map((p) => p.slice(1, -1)) ?? [];
}

function idUnder(def: RouteDef, prefix: string): boolean {
  return def.path.startsWith(`${prefix}/{id}`);
}

/** Top-level keys of a body schema, and of the objects in its array fields. */
function bodyKeys(schema: z.ZodType | undefined): string[] {
  const shapeOf = (s: unknown): Record<string, unknown> | undefined => {
    let current = s as { shape?: Record<string, unknown>; def?: { innerType?: unknown } };
    while (current && !current.shape && current.def?.innerType) {
      current = current.def.innerType as typeof current;
    }
    return current?.shape;
  };
  const shape = shapeOf(schema);
  if (!shape) return [];
  const keys = Object.keys(shape);
  for (const value of Object.values(shape)) {
    const element = (value as { def?: { element?: unknown } })?.def?.element;
    keys.push(...Object.keys(shapeOf(element) ?? {}));
  }
  return keys;
}

function keyedByTaskPath(def: RouteDef): boolean {
  return (
    pathParams(def.path).some((name) => TASK_PARAMS.has(name)) ||
    idUnder(def, "/api/tasks") ||
    idUnder(def, "/api/steering-messages")
  );
}

/** A write naming a task in its body; a task-keyed path already gates its route. */
function namesTaskInBody(def: RouteDef): boolean {
  return (
    def.method !== "get" &&
    !keyedByTaskPath(def) &&
    bodyKeys(def.body).some((key) => BODY_TASK_KEYS.has(key))
  );
}

/** A write keyed by a task only indirectly: an active-session row id, or a whole agent. */
function activeSessionWrite(def: RouteDef): boolean {
  return (
    def.method !== "get" &&
    def.path.startsWith("/api/active-sessions") &&
    !keyedByTaskPath(def) &&
    !namesTaskInBody(def)
  );
}

/** A private root and child on `agent`: `writer` may write, `reader` may read, `viewer` nothing. */
async function privateSession(label: string) {
  const root = await createTaskExtended(`${label} root`, {
    requestedByUserId: owner.id,
    agentId: agent.id,
    source: "ui",
  });
  const child = await createTaskExtended(`${label} child`, {
    requestedByUserId: owner.id,
    agentId: agent.id,
    parentTaskId: root.id,
    source: "ui",
  });
  await setSessionShares(
    { id: root.id, requestedByUserId: owner.id },
    {
      everyone: "none",
      users: [
        { userId: writer.id, access: "write" },
        { userId: reader.id, access: "read" },
      ],
    },
    owner.id,
  );
  const steering = await createSteeringMessage({
    taskId: child.id,
    body: `${label} steering`,
    mode: "queue",
    source: "ui",
    createdByKind: "user",
    createdByUserId: owner.id,
  });
  const provider = getFileStorageProvider();
  const file = await provider.upload({ taskId: child.id, name: "notes.txt" }, Buffer.from(label), {
    contentType: "text/plain",
  });
  const attachment = await insertTaskAttachment({
    taskId: child.id,
    agentId: agent.id,
    kind: "shared-fs",
    name: "notes.txt",
    path: file.key,
    providerId: provider.id,
    providerKey: file.key,
  });
  return { root, child, steeringId: steering.id, attachmentId: attachment.id };
}

/** Every row any table holds for the session's tasks: a refused call must leave it identical. */
async function sessionState(taskIds: string[]): Promise<string> {
  const db = getDbClient();
  const tables = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const marks = taskIds.map(() => "?").join(", ");
  const parts: unknown[] = [];
  for (const { name } of tables) {
    const columns = await db.query<{ name: string }>(`PRAGMA table_info("${name}")`);
    const keyed = columns
      .map((column) => column.name)
      .filter(
        (column) => BODY_TASK_KEYS.has(column) || (name === "agent_tasks" && column === "id"),
      );
    for (const column of keyed) {
      parts.push(
        name,
        column,
        await db.query(`SELECT * FROM "${name}" WHERE "${column}" IN (${marks}) ORDER BY rowid`, [
          ...taskIds,
        ]),
      );
    }
  }
  return JSON.stringify(parts);
}

async function call(
  method: string,
  path: string,
  bearer: string,
  { body, agentId }: { body?: unknown; agentId?: string } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (agentId) headers["X-Agent-ID"] = agentId;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.text() };
}

const pathRoutes = routeRegistry.filter(keyedByTaskPath);
const bodyRoutes = routeRegistry.filter(namesTaskInBody);
const indirectRoutes = routeRegistry.filter(activeSessionWrite);

async function activeSessionRows(agentId: string): Promise<string[]> {
  return (await getActiveSessions(agentId)).map((row) => row.id);
}

describe("route registry session posture", () => {
  test("every task-keyed route and every task-naming write declares a session posture", () => {
    expect(pathRoutes.length).toBeGreaterThan(30);
    expect(bodyRoutes.length).toBeGreaterThan(8);
    const missing = [...pathRoutes, ...bodyRoutes]
      .filter((def) => !def.session)
      .map((def) => `${def.method.toUpperCase()} ${def.path}`);
    expect(missing).toEqual([]);
    const wrongParam = pathRoutes
      .filter((def) => {
        const posture = def.session;
        if (!posture) return false;
        const name =
          "taskParam" in posture
            ? posture.taskParam
            : "steeringParam" in posture
              ? posture.steeringParam
              : undefined;
        return name === undefined || !pathParams(def.path).includes(name);
      })
      .map((def) => `${def.method.toUpperCase()} ${def.path}`);
    expect(wrongParam).toEqual([]);
    const wrongBody = bodyRoutes
      .filter((def) => !(def.session && ("bodyTaskIds" in def.session || "none" in def.session)))
      .map((def) => `${def.method.toUpperCase()} ${def.path}`);
    expect(wrongBody).toEqual([]);
    expect(indirectRoutes.length).toBeGreaterThanOrEqual(3);
    const wrongIndirect = indirectRoutes
      .filter((def) => {
        const posture = def.session;
        if (!posture) return true;
        if ("activeSessionParam" in posture) {
          return !pathParams(def.path).includes(posture.activeSessionParam);
        }
        return !("agentWide" in posture || "none" in posture);
      })
      .map((def) => `${def.method.toUpperCase()} ${def.path}`);
    expect(wrongIndirect).toEqual([]);
  });

  for (const def of pathRoutes) {
    const label = `${def.method.toUpperCase()} ${def.path}`;
    test(`${label}: unshared and read-only users change nothing; owner and writer pass`, async () => {
      const session = await privateSession(label);
      const ids: Record<string, string> = {
        taskId: session.child.id,
        rootTaskId: session.root.id,
        attachmentId: session.attachmentId,
        id: def.session && "steeringParam" in def.session ? session.steeringId : session.child.id,
      };
      const path = def.path.replace(/\{(\w+)\}/g, (_, name: string) => ids[name] ?? "x");
      const method = def.method.toUpperCase();
      const isRead = method === "GET";
      const taskIds = [session.root.id, session.child.id];

      const refused: Who[] = isRead ? ["viewer"] : ["viewer", "reader"];
      for (const who of refused) {
        const before = await sessionState(taskIds);
        const res = await call(method, path, tokens[who]);
        expect({ label, who, status: res.status }).toEqual({ label, who, status: 403 });
        expect(res.body).toContain(isRead ? SESSION_READ_DENIED : SESSION_WRITE_DENIED);
        expect(await sessionState(taskIds)).toBe(before);
      }
      const passing: Who[] = isRead ? ["reader", "writer", "owner"] : ["writer", "owner"];
      for (const who of passing) {
        const res = await call(method, path, tokens[who]);
        const denied = DENIALS.some((denial) => res.body.includes(denial));
        expect({ label, who, denied }).toEqual({ label, who, denied: false });
      }
    });
  }

  for (const def of bodyRoutes) {
    const label = `${def.method.toUpperCase()} ${def.path}`;
    test(`${label}: a body naming a session task needs write access`, async () => {
      const session = await privateSession(label);
      const id = session.child.id;
      const posture = def.session;
      const path = def.path.replace(/\{(\w+)\}/g, "x");
      const method = def.method.toUpperCase();
      const taskIds = [session.root.id, session.child.id];
      if (posture && "none" in posture) {
        // Its handler refuses every user token outright.
        for (const who of ["viewer", "reader", "writer", "owner"] as const) {
          const before = await sessionState(taskIds);
          const res = await call(method, path, tokens[who], { body: { taskId: id } });
          expect({ label, who, ok: res.status < 300 }).toEqual({ label, who, ok: false });
          expect(await sessionState(taskIds)).toBe(before);
        }
        return;
      }
      if (!posture || !("bodyTaskIds" in posture)) throw new Error(`${label} has no body posture`);
      const candidates = [
        { taskId: id },
        { parentTaskId: id },
        { sourceTaskId: id },
        { rootTaskId: id },
        { events: [{ taskId: id }] },
      ];
      const body = candidates.find((candidate) => posture.bodyTaskIds(candidate).includes(id));
      expect({ label, body: body !== undefined }).toEqual({ label, body: true });

      for (const who of ["viewer", "reader"] as const) {
        const before = await sessionState(taskIds);
        const res = await call(method, path, tokens[who], { body });
        expect({ label, who, status: res.status }).toEqual({ label, who, status: 403 });
        expect(res.body).toContain(SESSION_WRITE_DENIED);
        expect(await sessionState(taskIds)).toBe(before);
      }
      for (const who of ["writer", "owner"] as const) {
        const res = await call(method, path, tokens[who], { body });
        expect({ label, who, denied: res.body.includes(SESSION_WRITE_DENIED) }).toEqual({
          label,
          who,
          denied: false,
        });
      }
    });
  }
});

describe("active-session writes keyed by a row id or a whole agent", () => {
  for (const def of indirectRoutes) {
    const label = `${def.method.toUpperCase()} ${def.path}`;
    test(`${label}: no user without session write access changes a row`, async () => {
      const session = await privateSession(label);
      const taskIds = [session.root.id, session.child.id];
      const worker = await createAgent({ name: `${label} worker`, isLead: false, status: "idle" });
      const row = await insertActiveSession({
        agentId: worker.id,
        taskId: session.child.id,
        triggerType: "task_assigned",
      });
      const posture = def.session;
      const method = def.method.toUpperCase();
      const path = def.path.replace("{id}", row.id);
      const body = { agentId: worker.id };

      if (posture && "activeSessionParam" in posture) {
        for (const who of ["viewer", "reader"] as const) {
          const before = await sessionState(taskIds);
          const res = await call(method, path, tokens[who]);
          expect({ label, who, status: res.status }).toEqual({ label, who, status: 403 });
          expect(res.body).toContain(SESSION_WRITE_DENIED);
          expect(await sessionState(taskIds)).toBe(before);
        }
        const writerRes = await call(method, path, tokens.writer);
        expect({ label, status: writerRes.status }).toEqual({ label, status: 200 });
        expect(await activeSessionRows(worker.id)).toEqual([]);

        // A row with no task is the agent's own: no user deletes it, the agent does.
        const own = await insertActiveSession({ agentId: worker.id, triggerType: "heartbeat" });
        const ownPath = def.path.replace("{id}", own.id);
        for (const who of ["viewer", "reader", "writer", "owner"] as const) {
          const res = await call(method, ownPath, tokens[who]);
          expect({ label, who, status: res.status }).toEqual({ label, who, status: 403 });
          expect(await activeSessionRows(worker.id)).toEqual([own.id]);
        }
        const agentRes = await call(method, ownPath, OPERATOR_KEY, { agentId: worker.id });
        expect(agentRes.status).toBe(200);
        expect(await activeSessionRows(worker.id)).toEqual([]);
        return;
      }

      for (const who of ["viewer", "reader", "writer", "owner"] as const) {
        const before = await sessionState(taskIds);
        const res = await call(method, path, tokens[who], { body });
        expect({ label, who, ok: res.status < 300 }).toEqual({ label, who, ok: false });
        if (posture && "agentWide" in posture)
          expect(res.body).toContain(SESSION_AGENT_WIDE_DENIED);
        expect(await sessionState(taskIds)).toBe(before);
        expect(await activeSessionRows(worker.id)).toEqual([row.id]);
      }
    });
  }
});

describe("B11 indirect active-session repros", () => {
  test("a read-only sharee cannot delete by row id what it cannot delete by task id", async () => {
    const session = await privateSession("delete by id");
    const row = await insertActiveSession({
      agentId: agent.id,
      taskId: session.child.id,
      triggerType: "task_assigned",
    });
    const listed = await call("GET", `/api/active-sessions?agentId=${agent.id}`, tokens.reader);
    expect(listed.status).toBe(200);
    expect(listed.body).toContain(row.id);

    const byTask = await call(
      "DELETE",
      `/api/active-sessions/by-task/${session.child.id}`,
      tokens.reader,
    );
    expect(byTask.status).toBe(403);
    const byId = await call("DELETE", `/api/active-sessions/${row.id}`, tokens.reader);
    expect({ status: byId.status, body: byId.body }).toEqual({
      status: 403,
      body: expect.stringContaining(SESSION_WRITE_DENIED),
    });
    expect(await activeSessionRows(agent.id)).toContain(row.id);
  });

  test("an unshared user cannot clean up an agent's private sessions", async () => {
    const session = await privateSession("cleanup");
    const worker = await createAgent({ name: "Cleanup worker", isLead: false, status: "idle" });
    const row = await insertActiveSession({
      agentId: worker.id,
      taskId: session.child.id,
      triggerType: "task_assigned",
    });
    const res = await call("POST", "/api/active-sessions/cleanup", tokens.viewer, {
      body: { agentId: worker.id },
    });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 403,
      body: expect.stringContaining(SESSION_AGENT_WIDE_DENIED),
    });
    expect(await activeSessionRows(worker.id)).toEqual([row.id]);

    // Control: the worker's own boot cleanup still deletes it.
    const boot = await call("POST", "/api/active-sessions/cleanup", OPERATOR_KEY, {
      body: { agentId: worker.id },
      agentId: worker.id,
    });
    expect({ status: boot.status, body: JSON.parse(boot.body) }).toEqual({
      status: 200,
      body: { cleaned: 1 },
    });
    expect(await activeSessionRows(worker.id)).toEqual([]);
  });
});

describe("a user token never acts as an agent", () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "posture-test", version: "1" },
    },
  };

  test("/api/poll refuses a user token naming the worker and leaves the task pending", async () => {
    const secret = "PRIVATE POLLED PROMPT";
    // A worker of its own, so no other test's pending task is polled first.
    const poller = await createAgent({ name: "Poller", isLead: false, status: "idle" });
    const task = await createTaskExtended(secret, {
      requestedByUserId: owner.id,
      agentId: poller.id,
      source: "ui",
    });
    expect((await getTaskById(task.id))?.status).toBe("pending");
    for (const who of ["viewer", "owner"] as const) {
      const res = await call("GET", "/api/poll", tokens[who], { agentId: poller.id });
      expect({ who, status: res.status }).toEqual({ who, status: 403 });
      expect(res.body).toContain(USER_AGENT_HEADER_DENIED);
      expect(res.body).not.toContain(secret);
      expect((await getTaskById(task.id))?.status).toBe("pending");
    }
    // Control: the worker itself still receives and starts it.
    const worker = await call("GET", "/api/poll", OPERATOR_KEY, { agentId: poller.id });
    expect(worker.status).toBe(200);
    expect(worker.body).toContain(secret);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("/mcp initialize refuses a user token, with or without X-Agent-ID", async () => {
    const task = await createTaskExtended("PRIVATE MCP TASK", {
      requestedByUserId: owner.id,
      agentId: agent.id,
      source: "ui",
    });
    for (const agentId of [agent.id, undefined]) {
      for (const who of ["viewer", "owner"] as const) {
        const res = await call("POST", "/mcp", tokens[who], { body: initialize, agentId });
        expect({ who, agentId, status: res.status }).toEqual({ who, agentId, status: 403 });
        expect(res.body).toContain(USER_AGENT_HEADER_DENIED);
      }
    }
    expect((await getTaskById(task.id))?.status).toBe("pending");
    // Control: the agent transport still opens for the agent.
    const worker = await call("POST", "/mcp", OPERATOR_KEY, {
      body: initialize,
      agentId: agent.id,
    });
    expect(worker.status).toBe(200);
  });

  test("worker-header routes refuse a user token naming the assigned worker", async () => {
    const session = await privateSession("worker header");
    const before = await sessionState([session.root.id, session.child.id]);
    const routes: [string, string][] = [
      ["POST", `/api/tasks/${session.child.id}/finish`],
      ["POST", `/api/steering-messages/${session.steeringId}/delivered`],
      ["POST", `/api/steering-messages/${session.steeringId}/handled`],
      ["POST", `/api/steering-messages/${session.steeringId}/undeliverable`],
      ["POST", `/api/tasks/${session.child.id}/context`],
      ["GET", "/api/paused-tasks"],
    ];
    for (const [method, path] of routes) {
      for (const who of ["viewer", "reader", "writer", "owner"] as const) {
        const res = await call(method, path, tokens[who], { agentId: agent.id });
        expect({ path, who, status: res.status }).toEqual({ path, who, status: 403 });
        expect(res.body).toContain(USER_AGENT_HEADER_DENIED);
      }
    }
    expect(await sessionState([session.root.id, session.child.id])).toBe(before);
  });

  test("the script playground admits a user token naming an agent only with agent.act.any", async () => {
    const narrowed = await createUser({ name: "Requester" });
    await detachRole(narrowed.id, "admin");
    await attachRole(narrowed.id, "requester");
    const system = { kind: "system", id: "test" } as const;
    const narrowedToken = (await mintToken(narrowed.id, "test", system)).plaintext;
    const run = { source: "export default async () => 1", intent: "posture" };

    const admin = await call("POST", "/api/scripts/run", tokens.owner, {
      body: run,
      agentId: agent.id,
    });
    expect(admin.body).not.toContain(USER_AGENT_HEADER_DENIED);
    const requester = await call("POST", "/api/scripts/run", narrowedToken, {
      body: run,
      agentId: agent.id,
    });
    expect(requester.status).toBe(403);
    expect(requester.body).toContain(USER_AGENT_HEADER_DENIED);
  });
});

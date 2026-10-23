import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeDb, createAgent, createUser, getDbClient, initDb } from "../be/db";
import { ensureRbacSeedsSynced, listUserRoles, setUserRoles } from "../be/rbac-roles";
import { type IdentityActor, listUserEvents, mintToken } from "../be/users";
import { handleApprovalRequests } from "../http/approval-requests";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { handleUserRoles } from "../http/user-roles";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const key = `user-roles-test-${crypto.randomUUID()}`;
const ACTOR: IdentityActor = { kind: "operator", id: "user-roles-test" };
let server: Server;
let baseUrl: string;
let leadId: string;

async function request(
  path: string,
  bearer: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body };
}

const putRoles = (userId: string, bearer: string, roles: string[], headers = {}) =>
  request(`/api/users/${userId}/roles`, bearer, { method: "PUT", body: { roles }, headers });

async function newUser(name: string, roles?: string[]) {
  const user = await createUser({ name });
  if (roles) await setUserRoles(user.id, roles, null);
  const token = (await mintToken(user.id, name, ACTOR)).plaintext;
  return { id: user.id, token };
}

async function dispatch(req: IncomingMessage, res: ServerResponse) {
  const id = req.headers["x-agent-id"] as string | undefined;
  if (await handleCore(req, res, id, key)) return;
  const segments = getPathSegments(req.url ?? "");
  const query = parseQueryParams(req.url ?? "");
  if (await handleUserRoles(req, res, segments, query)) return;
  if (await handleApprovalRequests(req, res, segments, query)) return;
  if (await handleTasks(req, res, segments, query, id)) return;
  res.writeHead(404).end();
}

beforeAll(async () => {
  initDb(":memory:");
  ensureRbacSeedsSynced({ quiet: true });
  leadId = (await createAgent({ name: "roles-lead", isLead: true, status: "idle" })).id;
  server = createServer((req, res) => {
    void dispatch(req, res).catch(() => res.writeHead(500).end());
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe("PUT /api/users/{id}/roles", () => {
  test("a role change changes what the user may do", async () => {
    await newUser("keeper-admin");
    const alice = await newUser("alice");
    const task = { task: "do a thing" };
    expect((await request("/api/tasks", alice.token, { body: task })).status).not.toBe(403);

    const set = await putRoles(alice.id, key, ["viewer"]);
    expect(set.status).toBe(200);
    expect(set.body.roles.map((r: { name: string }) => r.name)).toEqual(["viewer"]);
    expect((await request("/api/tasks", alice.token, { body: task })).status).toBe(403);
    expect((await request("/api/tasks", alice.token)).status).not.toBe(403);

    expect((await putRoles(alice.id, key, ["admin"])).status).toBe(200);
    expect((await request("/api/tasks", alice.token, { body: task })).status).not.toBe(403);
  });

  test("a demoted user can no longer answer approvals", async () => {
    const bob = await newUser("bob", ["requester"]);
    const res = await request(`/api/approval-requests/${crypto.randomUUID()}/respond`, bob.token, {
      body: { responses: {} },
    });
    expect(res.status).toBe(403);
    expect(res.text).toContain("approval.respond");
  });

  test("only an operator or a grant-all user may change roles", async () => {
    const target = await newUser("target");
    const requester = await newUser("requester-user", ["requester"]);
    const viewer = await newUser("viewer-user", ["viewer"]);
    const admin = await newUser("admin-user");
    expect((await putRoles(target.id, requester.token, ["viewer"])).status).toBe(403);
    expect((await putRoles(target.id, viewer.token, ["viewer"])).status).toBe(403);
    // The shared key acting as an agent is not the operator.
    expect((await putRoles(target.id, key, ["viewer"], { "X-Agent-ID": leadId })).status).toBe(403);
    expect((await putRoles(target.id, admin.token, ["requester"])).status).toBe(200);
  });

  test("a custom role holding user.role.manage cannot grant admin", async () => {
    const target = await newUser("grant-target");
    const manager = await newUser("manager", ["viewer"]);
    const client = getDbClient();
    await client.run(
      "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES ('role-rm', 'role-manager', 'x', 0, 0)",
    );
    await client.run(
      "INSERT INTO role_permissions (roleId, verb) VALUES ('role-rm', 'user.role.manage')",
    );
    await client.run(
      "INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, 'role-rm')",
      [manager.id],
    );
    expect((await putRoles(target.id, manager.token, ["admin"])).status).toBe(403);
  });

  test("last-admin guard", async () => {
    const client = getDbClient();
    await client.run("UPDATE users SET status = 'suspended'");
    const sole = await newUser("sole-admin");
    expect((await putRoles(sole.id, key, ["viewer"])).status).toBe(409);
    expect((await listUserRoles(sole.id)).map((r) => r.name)).toEqual(["admin"]);

    const second = await newUser("second-admin");
    expect((await putRoles(sole.id, key, ["viewer"])).status).toBe(200);
    // second is now the sole active admin; a suspended admin may still be demoted.
    await client.run("UPDATE users SET status = 'suspended' WHERE id = ?", [second.id]);
    const third = await newUser("third");
    await client.run("UPDATE users SET status = 'suspended' WHERE id = ?", [third.id]);
    expect((await putRoles(third.id, key, ["requester"])).status).toBe(200);
    await client.run("UPDATE users SET status = 'active'");
  });

  test("validation", async () => {
    const user = await newUser("validated");
    for (const roles of [[], ["nope"], ["admin", "viewer"]]) {
      expect((await putRoles(user.id, key, roles)).status).toBe(400);
    }
    expect((await putRoles("missing-user", key, ["viewer"])).status).toBe(404);
    expect((await listUserRoles(user.id)).map((r) => r.name)).toEqual(["admin"]);
  });

  test("agent rows in principal_roles are neither listed nor counted as admins", async () => {
    const client = getDbClient();
    await client.run("UPDATE users SET status = 'suspended'");
    const sole = await newUser("sole-with-agent-twin");
    await client.run(
      `INSERT INTO principal_roles (principalType, principalId, roleId)
       VALUES ('agent', 'agent-twin', 'rbac-role-admin')`,
    );
    const twin = await client.get<{ id: string }>("SELECT id FROM users WHERE id = ?", [sole.id]);
    await client.run("UPDATE principal_roles SET principalId = ? WHERE principalType = 'agent'", [
      twin!.id,
    ]);
    expect((await putRoles(sole.id, key, ["viewer"])).status).toBe(409);
    const roles = await request(`/api/users/${sole.id}/roles`, key);
    expect(roles.body.roles.map((r: { name: string }) => r.name)).toEqual(["admin"]);
    await client.run("DELETE FROM principal_roles WHERE principalType = 'agent'");
    await client.run("UPDATE users SET status = 'active'");
  });

  test("audit event and role catalog", async () => {
    const user = await newUser("audited");
    await putRoles(user.id, key, ["requester"]);
    const events = await listUserEvents(user.id);
    const change = events.find((e) => e.eventType === "profile_changed");
    expect(JSON.stringify(change)).toContain("requester");
    expect(JSON.stringify(change)).toContain("admin");

    const catalog = await request("/api/rbac/roles", key);
    const primary = catalog.body.roles.filter((r: { primary: boolean }) => r.primary);
    expect(primary.map((r: { name: string }) => r.name).sort()).toEqual([
      "admin",
      "requester",
      "viewer",
    ]);
  });

  test("persists with RBAC disabled", async () => {
    process.env.RBAC_ENABLED = "false";
    try {
      const user = await newUser("rbac-off");
      expect((await putRoles(user.id, key, ["viewer"])).status).toBe(200);
      expect((await listUserRoles(user.id)).map((r) => r.name)).toEqual(["viewer"]);
    } finally {
      delete process.env.RBAC_ENABLED;
    }
  });
});

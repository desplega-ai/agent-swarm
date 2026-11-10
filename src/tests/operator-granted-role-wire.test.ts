/**
 * Operator-only boundary for the built-in `auditor` role, over the wire.
 *
 * Every new user is a grant-all admin, so the role is only worth something if
 * an admin token cannot reach it sideways: by minting a credential for an
 * auditor, by binding its own identity to one, or by spending a code it made
 * before the role was added. One real server subprocess (scratch DB, RBAC on,
 * real handleCore auth with `aswt_` user tokens); each refusal has a control
 * that shows the same call passes for a user without the role.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  makeScratchDir,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

let dir: string;
let server: SwarmServer;
let base: string;
/** A default grant-all admin and its own MCP token. */
let adminId: string;
let adminToken: string;
/** Holds admin + auditor, added with the operator key. */
let auditorId: string;
/** A plain default admin: the control target. */
let plainId: string;

async function createUser(name: string, email: string): Promise<string> {
  const res = await api(base, "POST", "/api/users", { body: { name, email } });
  expect(res.status).toBe(200);
  return res.body.user.id;
}

async function readsAllUsers(token: string): Promise<boolean> {
  const res = await fetch(`${base}/api/whoami`, {
    headers: { Authorization: `Bearer ${token}`, "X-Swarm-Session-Scope": "all" },
  });
  expect(res.status).toBe(200);
  return (await res.json()).sessionReadAll === true;
}

async function roleNames(userId: string): Promise<string[]> {
  const res = await api(base, "GET", `/api/users/${userId}/roles`);
  expect(res.status).toBe(200);
  return res.body.roles.map((r: { name: string }) => r.name);
}

beforeAll(async () => {
  dir = await makeScratchDir();
  server = await spawnSwarmServer({
    dbPath: join(dir, "auditor.sqlite"),
    logPath: join(dir, "server.log"),
    env: {
      RBAC_ENABLED: "true",
      PUBLIC_MCP_BASE_URL: "https://swarm.example.test",
      CONNECTOR_CONNECT_URL: "https://connect.example.test/connect",
    },
  });
  base = server.base;

  adminId = await createUser("Admin", "admin@example.test");
  auditorId = await createUser("Auditor", "auditor@example.test");
  plainId = await createUser("Plain", "plain@example.test");
  const minted = await api(base, "POST", `/api/users/${adminId}/mcp-tokens`, { body: {} });
  expect(minted.status).toBe(200);
  adminToken = minted.body.plaintext;
  const granted = await api(base, "PUT", `/api/users/${auditorId}/roles`, {
    body: { roles: ["admin", "auditor"] },
  });
  expect(granted.status).toBe(200);
});

afterAll(async () => {
  if (server) await server.stop();
  if (dir) await removeScratchDir(dir);
});

describe("an admin token cannot reach an auditor's grant", () => {
  test("the admin itself does not read all users, and cannot add auditor", async () => {
    expect(await readsAllUsers(adminToken)).toBe(false);
    const self = await api(base, "PUT", `/api/users/${adminId}/roles`, {
      bearer: adminToken,
      body: { roles: ["admin", "auditor"] },
    });
    expect(self.status).toBe(403);
    expect(await roleNames(adminId)).toEqual(["admin"]);
  });

  test("POST /api/users/{id}/mcp-tokens: refused for an auditor, allowed for a plain admin", async () => {
    const refused = await api(base, "POST", `/api/users/${auditorId}/mcp-tokens`, {
      bearer: adminToken,
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("operator key");
    expect(refused.body.plaintext).toBeUndefined();

    const control = await api(base, "POST", `/api/users/${plainId}/mcp-tokens`, {
      bearer: adminToken,
      body: {},
    });
    expect(control.status).toBe(200);
    expect(control.body.plaintext).toStartWith("aswt_");
    expect(await readsAllUsers(control.body.plaintext)).toBe(false);

    // The operator key may mint one, and that token does read all users.
    const operator = await api(base, "POST", `/api/users/${auditorId}/mcp-tokens`, { body: {} });
    expect(operator.status).toBe(200);
    expect(await readsAllUsers(operator.body.plaintext)).toBe(true);
  });

  test("POST /api/users/{id}/connector-codes: refused for an auditor, allowed for a plain admin", async () => {
    const refused = await api(base, "POST", `/api/users/${auditorId}/connector-codes`, {
      bearer: adminToken,
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBeUndefined();

    const control = await api(base, "POST", `/api/users/${plainId}/connector-codes`, {
      bearer: adminToken,
      body: {},
    });
    expect(control.status).toBe(201);
    expect(control.body.code).toBeString();
  });

  test("identity binding into an auditor is refused; the same calls pass for a plain admin", async () => {
    const cases: Array<[string, string, (target: string) => unknown, number]> = [
      ["POST", "/identities", () => ({ kind: "slack", externalId: "U-ADMIN-1" }), 200],
      ["PATCH", "", () => ({ identities: [{ kind: "slack", externalId: "U-ADMIN-2" }] }), 200],
      ["PATCH", "", () => ({ email: "admin-alias@example.test" }), 200],
      ["PATCH", "", () => ({ emailAliases: ["admin-other@example.test"] }), 200],
    ];
    for (const [method, suffix, body, ok] of cases) {
      const refused = await api(base, method, `/api/users/${auditorId}${suffix}`, {
        bearer: adminToken,
        body: body(auditorId),
      });
      expect(refused.status).toBe(403);
      const control = await api(base, method, `/api/users/${plainId}${suffix}`, {
        bearer: adminToken,
        body: body(plainId),
      });
      expect(control.status).toBe(ok);
      // Undo the control so the next case can reuse the same identity.
      if (method === "PATCH") {
        await api(base, "PATCH", `/api/users/${plainId}`, {
          body: { identities: [], emailAliases: [], email: "plain@example.test" },
        });
      } else {
        await api(base, "DELETE", `/api/users/${plainId}/identities/slack/U-ADMIN-1`);
      }
    }

    // A profile edit that binds no identity stays open.
    const rename = await api(base, "PATCH", `/api/users/${auditorId}`, {
      bearer: adminToken,
      body: { notes: "audits sessions" },
    });
    expect(rename.status).toBe(200);
    // Unmapped resolve into an auditor is refused too.
    const resolve = await api(base, "POST", "/api/users/unmapped/slack/U-ADMIN-3/resolve", {
      bearer: adminToken,
      body: { userId: auditorId },
    });
    expect(resolve.status).toBe(403);
    const auditor = await api(base, "GET", `/api/users/${auditorId}`);
    expect(auditor.body.user.identities).toEqual([]);
    expect(auditor.body.user.email).toBe("auditor@example.test");
  });

  test("merging another user into an auditor is refused", async () => {
    const donor = await createUser("Donor", "donor@example.test");
    const refused = await api(base, "POST", `/api/users/${auditorId}/merge`, {
      bearer: adminToken,
      body: { sourceUserId: donor },
    });
    expect(refused.status).toBe(403);
    expect((await api(base, "GET", `/api/users/${donor}`)).status).toBe(200);

    const control = await api(base, "POST", `/api/users/${plainId}/merge`, {
      bearer: adminToken,
      body: { sourceUserId: donor },
    });
    // The merge is queued (202); the source row goes with the background job.
    expect(control.status).toBe(202);
  });

  test("an invite code an admin made stops working once the operator adds auditor", async () => {
    const inviteFor = async (email: string) => {
      const res = await api(base, "POST", "/api/invites", {
        bearer: adminToken,
        body: { email, role: "requester" },
      });
      expect(res.status).toBe(201);
      const code = new URL(res.body.inviteUrl).pathname.split("/").pop() as string;
      return { userId: res.body.user.id as string, code };
    };
    const exchange = (code: string) =>
      api(base, "POST", "/api/invites/exchange", { bearer: "", body: { code } });

    const later = await inviteFor("later-auditor@example.test");
    const granted = await api(base, "PUT", `/api/users/${later.userId}/roles`, {
      body: { roles: ["requester", "auditor"] },
    });
    expect(granted.status).toBe(200);
    const refused = await exchange(later.code);
    expect(refused.status).toBe(404);
    expect(refused.body.token).toBeUndefined();

    const control = await inviteFor("plain-invitee@example.test");
    const ok = await exchange(control.code);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toStartWith("aswt_");
  });
});

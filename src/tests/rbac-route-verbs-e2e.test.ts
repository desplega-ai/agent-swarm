/**
 * Admission for routes that left the RBAC backlog, over real HTTP.
 *
 * A custom role can only be created in the database (no public route makes
 * one), so this boots the real server on a scratch DB and writes the role
 * rows directly, like rbac-admission-e2e.test.ts.
 *
 *  1. A route that got an existing verb admits a custom role holding it and
 *     refuses one without it.
 *  2. A custom role holding `user.manage` still cannot bind its chat identity
 *     onto a grant-all admin: user and identity admin stay operator-only.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  makeScratchDir,
  registerAgent,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  WORKER_A,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

let dir: string | undefined;
let server: SwarmServer | undefined;

/** Replace the user's roles with one custom role holding exactly `verbs`. */
function setCustomRole(dbPath: string, userId: string, roleId: string, verbs: string[]): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, isBuiltin, grantsAll)
         VALUES (?, ?, 'test custom role', 0, 0)`,
      ).run(roleId, roleId);
      for (const verb of verbs) {
        db.prepare("INSERT OR IGNORE INTO role_permissions (roleId, verb) VALUES (?, ?)").run(
          roleId,
          verb,
        );
      }
      db.prepare(
        "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      ).run(userId);
      db.prepare(
        "INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, ?)",
      ).run(userId, roleId);
    })();
  } finally {
    db.close();
  }
}

describe("RBAC admission for routes that left the backlog", () => {
  afterAll(async () => {
    await server?.stop();
    server = undefined;
    if (dir) await removeScratchDir(dir);
  });

  test("verb admits a custom role, missing verb is 403, user.manage cannot rebind onto an admin", async () => {
    dir = await makeScratchDir();
    const dbPath = join(dir, "route-verbs.sqlite");
    server = await spawnSwarmServer({
      dbPath,
      logPath: join(dir, "server.log"),
      env: { RBAC_ENABLED: "true" },
    });
    await registerAgent(server.base, WORKER_A, "rbac-route-verbs-worker", false);

    const admin = await api(server.base, "POST", "/api/users", {
      body: { name: "route-verbs-admin", email: "rbac-route-verbs-admin@example.com" },
    });
    expect(admin.status).toBe(200);
    const adminId = admin.body.user.id as string;

    const user = await api(server.base, "POST", "/api/users", {
      body: {
        name: "route-verbs-user",
        email: "rbac-route-verbs-user@example.com",
        identities: [{ kind: "slack", externalId: "U-ROUTE-VERBS" }],
      },
    });
    expect(user.status).toBe(200);
    const userId = user.body.user.id as string;

    const minted = await api(server.base, "POST", `/api/users/${userId}/mcp-tokens`, { body: {} });
    expect(minted.status).toBe(200);
    const bearer = minted.body.plaintext as string;

    // 1. PUT /api/agents/{id}/name declares agent.profile.update.any.
    setCustomRole(dbPath, userId, "rbac-test-no-verbs", ["favorite.write.own"]);
    const denied = await api(server.base, "PUT", `/api/agents/${WORKER_A}/name`, {
      bearer,
      body: { name: "renamed-denied" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("missing permission 'agent.profile.update.any'");

    setCustomRole(dbPath, userId, "rbac-test-profile-editor", ["agent.profile.update.any"]);
    const allowed = await api(server.base, "PUT", `/api/agents/${WORKER_A}/name`, {
      bearer,
      body: { name: "renamed-allowed" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.name).toBe("renamed-allowed");

    // 2. user.manage does not admit identity moves: unbinding its own Slack id
    // and binding it onto the grant-all admin are both refused.
    setCustomRole(dbPath, userId, "rbac-test-user-manager", ["user.manage"]);
    const unbind = await api(
      server.base,
      "DELETE",
      `/api/users/${userId}/identities/slack/U-ROUTE-VERBS`,
      { bearer },
    );
    expect(unbind.status).toBe(403);
    expect(unbind.body.error).toContain("route has no permission verb (operator-only)");

    const rebind = await api(server.base, "POST", `/api/users/${adminId}/identities`, {
      bearer,
      body: { kind: "slack", externalId: "U-ROUTE-VERBS-2" },
    });
    expect(rebind.status).toBe(403);
    expect(rebind.body.error).toContain("route has no permission verb (operator-only)");

    const mintAdmin = await api(server.base, "POST", "/api/users", {
      bearer,
      body: { name: "minted-admin" },
    });
    expect(mintAdmin.status).toBe(403);

    const adminIdentities = await api(server.base, "GET", `/api/users/${adminId}`);
    expect(adminIdentities.status).toBe(200);
    expect(JSON.stringify(adminIdentities.body)).not.toContain("U-ROUTE-VERBS");
  });
});

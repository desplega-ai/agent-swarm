/**
 * RBAC increment-3 admission wire e2e (DES-445).
 *
 * Spawns the real HTTP server with RBAC_ENABLED=true, narrows a user to the
 * requester role in the scratch DB, and proves central HTTP admission gates
 * user-token REST calls before the handler runs. A second boot with the flag
 * off proves the narrowed user still has legacy behavior when admission is
 * disabled.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  makeScratchDir,
  readAuditRows,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  waitForAuditCount,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

const REQUESTER_ROLE_ID = "rbac-role-requester";
const CONFIG_SECRET_READER_ROLE_ID = "rbac-test-config-secret-reader";
const CONFIG_SECRET_KEY = "RBAC_ADMISSION_SECRET";
const CONFIG_SECRET_VALUE = "rbac-admission-secret-value";

let dir: string;
let server: SwarmServer | undefined;

function configValue(
  body: { configs?: Array<{ key: string; value?: unknown }> },
  key: string,
): string | undefined {
  const row = body.configs?.find((config) => config.key === key);
  return typeof row?.value === "string" ? row.value : undefined;
}

function rewriteUserToRequester(dbPath: string, userId: string): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.transaction(() => {
      db.prepare(
        "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      ).run(userId);
      db.prepare(
        `INSERT INTO principal_roles (principalType, principalId, roleId)
         VALUES ('user', ?, ?)`,
      ).run(userId, REQUESTER_ROLE_ID);
    })();
  } finally {
    db.close();
  }
}

function grantUserConfigSecretRead(dbPath: string, userId: string): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, isBuiltin, grantsAll)
         VALUES (?, ?, ?, 0, 0)`,
      ).run(CONFIG_SECRET_READER_ROLE_ID, "config-secret-reader", "Test config secret reader");
      db.prepare("INSERT OR IGNORE INTO role_permissions (roleId, verb) VALUES (?, ?)").run(
        CONFIG_SECRET_READER_ROLE_ID,
        "config.read.secrets",
      );
      db.prepare(
        `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
         VALUES ('user', ?, ?)`,
      ).run(userId, CONFIG_SECRET_READER_ROLE_ID);
    })();
  } finally {
    db.close();
  }
}

describe("RBAC admission over real HTTP", () => {
  afterAll(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
    if (dir) await removeScratchDir(dir);
  });

  test("flag-on admission narrows user-token writes and flag-off preserves legacy behavior", async () => {
    dir = await makeScratchDir();
    const dbPath = join(dir, "admission.sqlite");

    server = await spawnSwarmServer({
      dbPath,
      logPath: join(dir, "server-on.log"),
      env: { RBAC_ENABLED: "true" },
    });

    const user = await api(server.base, "POST", "/api/users", {
      body: { name: "admission-user", email: "rbac-admission-e2e@example.com" },
    });
    expect(user.status).toBe(200);
    const userId = user.body.user.id as string;

    const minted = await api(server.base, "POST", `/api/users/${userId}/mcp-tokens`, {
      body: {},
    });
    expect(minted.status).toBe(200);
    const userToken = minted.body.plaintext as string;
    expect(userToken).toStartWith("aswt_");

    const upsertSecret = await api(server.base, "PUT", "/api/config?includeSecrets=true", {
      body: {
        scope: "global",
        key: CONFIG_SECRET_KEY,
        value: CONFIG_SECRET_VALUE,
        isSecret: true,
      },
    });
    expect(upsertSecret.status).toBe(200);
    expect(upsertSecret.body.value).toBe(CONFIG_SECRET_VALUE);

    const grantsAllSecretRead = await api(
      server.base,
      "GET",
      "/api/config?scope=global&includeSecrets=true",
      { bearer: userToken },
    );
    expect(grantsAllSecretRead.status).toBe(200);
    expect(configValue(grantsAllSecretRead.body, CONFIG_SECRET_KEY)).toBe(CONFIG_SECRET_VALUE);
    expect(grantsAllSecretRead.body.message).toBeUndefined();

    const defaultCreate = await api(server.base, "POST", "/api/tasks", {
      bearer: userToken,
      body: { task: "rbac admission default role no-op" },
    });
    expect(defaultCreate.status).toBe(201);
    const taskId = defaultCreate.body.id as string;

    rewriteUserToRequester(dbPath, userId);

    const deniedTaskCreate = await api(server.base, "POST", "/api/tasks", {
      bearer: userToken,
      body: { task: "rbac admission denied task" },
    });
    expect(deniedTaskCreate.status).toBe(403);
    expect(deniedTaskCreate.body.error).toContain("admission: route has no permission verb");

    const deniedFavorite = await api(server.base, "PUT", "/api/favorites", {
      bearer: userToken,
      body: { itemType: "workflow", itemId: "wf-rbac-admission", favorite: true },
    });
    expect(deniedFavorite.status).toBe(403);
    expect(deniedFavorite.body.error).toContain("admission: route has no permission verb");

    const listTasks = await api(server.base, "GET", `/api/tasks?requestedByUserId=${userId}`, {
      bearer: userToken,
    });
    expect(listTasks.status).toBe(200);

    const maskedSecretRead = await api(
      server.base,
      "GET",
      "/api/config?scope=global&includeSecrets=true",
      { bearer: userToken },
    );
    expect(maskedSecretRead.status).toBe(200);
    expect(configValue(maskedSecretRead.body, CONFIG_SECRET_KEY)).toBe("********");
    expect(maskedSecretRead.body.message).toContain("secret values masked");
    expect(maskedSecretRead.body.message).toContain(
      "reading unmasked secrets requires the lead agent",
    );

    grantUserConfigSecretRead(dbPath, userId);

    const grantedSecretRead = await api(
      server.base,
      "GET",
      "/api/config?scope=global&includeSecrets=true",
      { bearer: userToken },
    );
    expect(grantedSecretRead.status).toBe(200);
    expect(configValue(grantedSecretRead.body, CONFIG_SECRET_KEY)).toBe(CONFIG_SECRET_VALUE);
    expect(grantedSecretRead.body.message).toBeUndefined();

    const fsUpload = await api(
      server.base,
      "POST",
      `/api/fs/tasks/${taskId}/files?name=admission.txt`,
      { bearer: userToken, rawBody: Buffer.from("rbac admission file") },
    );
    expect(fsUpload.status).toBe(201);

    const operatorCreate = await api(server.base, "POST", "/api/tasks", {
      body: { task: "rbac admission operator bypass" },
    });
    expect(operatorCreate.status).toBe(201);

    expect(await waitForAuditCount(dbPath, 2)).toBeGreaterThanOrEqual(2);
    const denyRows = readAuditRows(dbPath).filter(
      (row) =>
        row.principalType === "user" &&
        row.principalId === userId &&
        row.source === "http" &&
        row.resourceType === "http-route" &&
        row.decision === "deny",
    );
    expect(denyRows.map((row) => row.resourceId).sort()).toEqual([
      "POST /api/tasks",
      "PUT /api/favorites",
    ]);

    rewriteUserToRequester(dbPath, userId);

    await server.stop();
    server = undefined;

    server = await spawnSwarmServer({
      dbPath,
      logPath: join(dir, "server-off.log"),
    });

    const flagOffCreate = await api(server.base, "POST", "/api/tasks", {
      bearer: userToken,
      body: { task: "rbac admission flag off legacy create" },
    });
    expect(flagOffCreate.status).toBe(201);

    const flagOffSecretRead = await api(
      server.base,
      "GET",
      "/api/config?scope=global&includeSecrets=true",
      { bearer: userToken },
    );
    expect(flagOffSecretRead.status).toBe(200);
    expect(configValue(flagOffSecretRead.body, CONFIG_SECRET_KEY)).toBe(CONFIG_SECRET_VALUE);
    expect(flagOffSecretRead.body.message).toBeUndefined();
  });
});

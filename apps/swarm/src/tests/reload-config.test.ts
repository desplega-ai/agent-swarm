import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { initAgentMail, resetAgentMail } from "../agentmail";
import { closeDb, deleteSwarmConfig, getDb, initDb, upsertSwarmConfig } from "../be/db";
import { initGitHub, resetGitHub } from "../github";
import {
  _autoReloadStatsForTests,
  _resetAutoReloadForTests,
  flushPendingIntegrationsReload,
  loadGlobalConfigsIntoEnv,
  scheduleIntegrationsReload,
} from "../http/core";

const TEST_DB_PATH = "./test-reload-config.sqlite";
const TEST_PORT = 13023;
const INTEGRATION_DISABLE_KEYS = [
  "AGENTMAIL_DISABLE",
  "GITHUB_DISABLE",
  "JIRA_DISABLE",
  "LINEAR_DISABLE",
  "SLACK_DISABLE",
] as const;
const originalIntegrationDisableValues = new Map<
  (typeof INTEGRATION_DISABLE_KEYS)[number],
  string | undefined
>();

beforeAll(() => {
  for (const key of INTEGRATION_DISABLE_KEYS) {
    originalIntegrationDisableValues.set(key, process.env[key]);
    process.env[key] = "true";
  }
  _resetAutoReloadForTests();
});

afterAll(() => {
  for (const key of INTEGRATION_DISABLE_KEYS) {
    const originalValue = originalIntegrationDisableValues.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
  originalIntegrationDisableValues.clear();
});

function insertLegacyReservedRow(key: string, value = "legacy"): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt)
     VALUES (?, ?, NULL, ?, ?, 0, NULL, NULL, ?, ?)`,
    [id, "global", key, value, now, now],
  );
  return id;
}

function insertUnreadableReservedSecretRow(key: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
     VALUES (?, ?, NULL, ?, ?, 1, NULL, NULL, ?, ?, 1)`,
    [id, "global", key, "definitely-not-valid-ciphertext", now, now],
  );
  return id;
}

// Minimal HTTP handler for the reload-config endpoint
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/internal/reload-config") {
      try {
        const updated = loadGlobalConfigsIntoEnv(true);

        const integrations: string[] = [];

        resetAgentMail();
        if (initAgentMail()) integrations.push("agentmail");

        resetGitHub();
        if (initGitHub()) integrations.push("github");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            configsLoaded: updated.length,
            keysUpdated: updated,
            integrationsReinitialized: integrations,
          }),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to reload config", details: message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

describe("reload-config", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  // Track env keys we set so we can clean them up
  const envKeysToClean: string[] = [];

  beforeAll(async () => {
    initDb(TEST_DB_PATH);

    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    server.close();
    closeDb();
    // Clean up env vars we set
    for (const key of envKeysToClean) {
      delete process.env[key];
    }
    await unlink(TEST_DB_PATH).catch(() => {});
  });

  test("POST /internal/reload-config returns 200 with empty DB", async () => {
    const res = await fetch(`${baseUrl}/internal/reload-config`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.configsLoaded).toBe(0);
    expect(body.keysUpdated).toEqual([]);
  });

  test("loadGlobalConfigsIntoEnv loads DB configs into process.env", () => {
    const testKey = `__TEST_RELOAD_KEY_${Date.now()}`;
    envKeysToClean.push(testKey);

    upsertSwarmConfig({
      scope: "global",
      key: testKey,
      value: "test-value-123",
    });

    const updated = loadGlobalConfigsIntoEnv(false);
    expect(updated).toContain(testKey);
    expect(process.env[testKey]).toBe("test-value-123");
  });

  test("loadGlobalConfigsIntoEnv does not override existing env vars when override=false", () => {
    const testKey = `__TEST_NO_OVERRIDE_${Date.now()}`;
    envKeysToClean.push(testKey);

    process.env[testKey] = "original-value";

    upsertSwarmConfig({
      scope: "global",
      key: testKey,
      value: "db-value",
    });

    const updated = loadGlobalConfigsIntoEnv(false);
    expect(updated).not.toContain(testKey);
    expect(process.env[testKey]).toBe("original-value");
  });

  test("loadGlobalConfigsIntoEnv overrides existing env vars when override=true", () => {
    const testKey = `__TEST_OVERRIDE_${Date.now()}`;
    envKeysToClean.push(testKey);

    process.env[testKey] = "original-value";

    upsertSwarmConfig({
      scope: "global",
      key: testKey,
      value: "new-db-value",
    });

    const updated = loadGlobalConfigsIntoEnv(true);
    expect(updated).toContain(testKey);
    expect(process.env[testKey]).toBe("new-db-value");
  });

  test("loadGlobalConfigsIntoEnv skips legacy reserved keys instead of injecting them", () => {
    insertLegacyReservedRow("API_KEY", "legacy-api-key");

    delete process.env.API_KEY;
    const updated = loadGlobalConfigsIntoEnv(true);

    expect(updated).not.toContain("API_KEY");
    expect(process.env.API_KEY).toBeUndefined();
  });

  test("loadGlobalConfigsIntoEnv skips unreadable reserved secret rows before decrypting them", () => {
    const id = insertUnreadableReservedSecretRow("SECRETS_ENCRYPTION_KEY");

    try {
      delete process.env.SECRETS_ENCRYPTION_KEY;
      const updated = loadGlobalConfigsIntoEnv(true);
      expect(updated).not.toContain("SECRETS_ENCRYPTION_KEY");
      expect(process.env.SECRETS_ENCRYPTION_KEY).toBeUndefined();
    } finally {
      getDb().run("DELETE FROM swarm_config WHERE id = ?", [id]);
    }
  });

  test("POST /internal/reload-config loads configs and returns summary", async () => {
    const testKey = `__TEST_RELOAD_ENDPOINT_${Date.now()}`;
    envKeysToClean.push(testKey);

    upsertSwarmConfig({
      scope: "global",
      key: testKey,
      value: "endpoint-test-value",
    });

    const res = await fetch(`${baseUrl}/internal/reload-config`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.configsLoaded).toBeGreaterThan(0);
    expect(body.keysUpdated).toContain(testKey);
    expect(process.env[testKey]).toBe("endpoint-test-value");
  });

  test("unknown endpoint returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("auto-reload debouncer", () => {
  // The reload path reinitializes every integration. Keep these tests focused
  // on debounce semantics rather than local .env / CI credential side effects.

  beforeEach(async () => {
    // Drain any reload state that leaked from earlier test files in the full
    // suite (e.g. swarm-config-reserved-keys.test.ts does global PUT/DELETE on
    // /api/config, which schedules a 250ms reload). If we reset() while a
    // prior timer was still mid-flight, the leaked .finally() can race against
    // our test body and stomp the module state — first symptom is
    // `expect(pending).toBe(true)` failing because `inFlightReload` was still
    // truthy when `scheduleIntegrationsReload` ran. Flush first, then reset.
    await flushPendingIntegrationsReload();
    _resetAutoReloadForTests();
  });

  test("scheduleIntegrationsReload runs reload after the debounce window", async () => {
    const testKey = `__TEST_AUTO_RELOAD_RUNS_${Date.now()}`;
    upsertSwarmConfig({ scope: "global", key: testKey, value: "fresh" });
    delete process.env[testKey];

    scheduleIntegrationsReload(50);
    expect(_autoReloadStatsForTests().pending).toBe(true);

    await flushPendingIntegrationsReload();

    expect(_autoReloadStatsForTests().invocations).toBe(1);
    expect(process.env[testKey]).toBe("fresh");

    delete process.env[testKey];
  });

  test("rapid scheduleIntegrationsReload calls coalesce into one reload", async () => {
    const testKey = `__TEST_COALESCE_${Date.now()}`;
    upsertSwarmConfig({ scope: "global", key: testKey, value: "v1" });

    scheduleIntegrationsReload(100);
    scheduleIntegrationsReload(100);
    scheduleIntegrationsReload(100);
    scheduleIntegrationsReload(100);

    expect(_autoReloadStatsForTests().invocations).toBe(0);

    await flushPendingIntegrationsReload();

    expect(_autoReloadStatsForTests().invocations).toBe(1);

    delete process.env[testKey];
  });

  test("schedule during in-flight reload triggers exactly one rerun", async () => {
    const testKey = `__TEST_RERUN_${Date.now()}`;
    upsertSwarmConfig({ scope: "global", key: testKey, value: "first" });

    scheduleIntegrationsReload(20);
    // Wait just past the debounce so the first reload is in-flight, then
    // schedule again. The second call should defer to a rerun, not a parallel
    // reload.
    await new Promise((r) => setTimeout(r, 25));
    scheduleIntegrationsReload(20);
    scheduleIntegrationsReload(20); // collapses with the rerun-pending flag

    await flushPendingIntegrationsReload();

    // First run + one rerun = 2 invocations total.
    expect(_autoReloadStatsForTests().invocations).toBe(2);

    delete process.env[testKey];
  });

  test("flushPendingIntegrationsReload is a no-op when nothing is queued", async () => {
    expect(_autoReloadStatsForTests().pending).toBe(false);
    await flushPendingIntegrationsReload();
    expect(_autoReloadStatsForTests().invocations).toBe(0);
  });

  test("auto-reload picks up a brand-new config row at runtime", async () => {
    const testKey = `__TEST_NEW_ROW_${Date.now()}`;
    delete process.env[testKey];

    // Simulate the upsert path's behavior: write the row, then schedule.
    upsertSwarmConfig({ scope: "global", key: testKey, value: "live-update" });
    scheduleIntegrationsReload(20);

    await flushPendingIntegrationsReload();

    expect(process.env[testKey]).toBe("live-update");
    delete process.env[testKey];
  });

  test("auto-reload reflects an updated value (override semantics)", async () => {
    const testKey = `__TEST_OVERRIDE_LIVE_${Date.now()}`;
    process.env[testKey] = "shipped-by-deploy";

    // Pre-existing env should win at startup, but reload uses override=true.
    upsertSwarmConfig({ scope: "global", key: testKey, value: "from-config" });
    scheduleIntegrationsReload(20);

    await flushPendingIntegrationsReload();

    expect(process.env[testKey]).toBe("from-config");
    delete process.env[testKey];
  });

  test("delete + reload removes value from active env (well, doesn't re-inject it)", async () => {
    const testKey = `__TEST_DELETE_${Date.now()}`;
    delete process.env[testKey];

    const config = upsertSwarmConfig({ scope: "global", key: testKey, value: "to-be-deleted" });
    scheduleIntegrationsReload(20);
    await flushPendingIntegrationsReload();
    expect(process.env[testKey]).toBe("to-be-deleted");

    deleteSwarmConfig(config.id);
    // Mimic the delete handler in src/http/config.ts.
    scheduleIntegrationsReload(20);
    await flushPendingIntegrationsReload();

    // Caveat: process.env keeps the previously-injected value. Reload only
    // overwrites keys that still exist in DB. This test pins that behavior so
    // anyone changing the loader has to make a deliberate decision about
    // whether to also unset removed keys.
    expect(process.env[testKey]).toBe("to-be-deleted");
    delete process.env[testKey];
  });
});

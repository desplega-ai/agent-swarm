import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { initAgentMail, resetAgentMail } from "../agentmail";
import { closeDb, getResolvedConfig, initDb, upsertSwarmConfig } from "../be/db";
import { initGitHub, resetGitHub } from "../github";

const TEST_DB_PATH = "./test-reload-config.sqlite";
const TEST_PORT = 13023;

/**
 * Mirrors the loadGlobalConfigsIntoEnv logic from http.ts
 */
function loadGlobalConfigsIntoEnv(override = false): string[] {
  const globalConfigs = getResolvedConfig();
  const updated: string[] = [];
  for (const config of globalConfigs) {
    if (override || !process.env[config.key]) {
      process.env[config.key] = config.value;
      updated.push(config.key);
    }
  }
  return updated;
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

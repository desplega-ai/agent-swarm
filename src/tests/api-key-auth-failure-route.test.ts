/**
 * HTTP contract for the Codex pool auth-failure bench:
 * POST /api/keys/report-auth-failure and the clearAuthBench flag on
 * POST /api/keys/clear-rate-limit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, initDb } from "../be/db";
import { clearCodexAuthBench, readCodexAuthFailureFence } from "../commands/codex-login";
import { handleApiKeys } from "../http/api-keys";
import { listenOnFreePort } from "./test-net";

const TEST_DB = `./test-api-key-auth-failure-route-${Date.now()}.sqlite`;

describe("API key auth-failure routes", () => {
  let server: Server;
  let baseUrl = "";

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const key = { keyType: "CODEX_OAUTH", keySuffix: "qa001" };

  beforeAll(async () => {
    process.env.DB_PATH = TEST_DB;
    initDb(TEST_DB);
    server = createHttpServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const pathSegments = url.pathname.split("/").filter(Boolean);
      const handled = await handleApiKeys(req, res, pathSegments, url.searchParams);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await listenOnFreePort(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await unlink(TEST_DB).catch(() => {});
    await unlink(`${TEST_DB}-wal`).catch(() => {});
    await unlink(`${TEST_DB}-shm`).catch(() => {});
  });

  test("benches on the second report in a row", async () => {
    const first = await post("/api/keys/report-auth-failure", { ...key, keyIndex: 1 });
    expect(first).toMatchObject({ success: true, consecutiveAuthFailures: 1, benched: false });

    const second = await post("/api/keys/report-auth-failure", { ...key, keyIndex: 1 });
    expect(second).toMatchObject({ success: true, consecutiveAuthFailures: 2, benched: true });
    expect(typeof second.rateLimitedUntil).toBe("string");

    const available = await get("/api/keys/available?keyType=CODEX_OAUTH&totalKeys=3");
    expect(available.availableIndices).toEqual([0, 2]);
  });

  test("clear-rate-limit without clearAuthBench leaves the auth bench", async () => {
    const result = await post("/api/keys/clear-rate-limit", key);
    expect(result).toMatchObject({ success: true, cleared: false });
  });

  test("clear-rate-limit with clearAuthBench but no authFence leaves the auth bench", async () => {
    const result = await post("/api/keys/clear-rate-limit", { ...key, clearAuthBench: true });
    expect(result).toMatchObject({ success: true, cleared: false });
  });

  test("clear-rate-limit with clearAuthBench and a current authFence lifts the bench", async () => {
    const { authFailureFence } = await get("/api/keys/available?keyType=CODEX_OAUTH&totalKeys=3");
    expect(typeof authFailureFence).toBe("number");
    const result = await post("/api/keys/clear-rate-limit", {
      ...key,
      clearAuthBench: true,
      authFence: authFailureFence,
    });
    expect(result).toMatchObject({ success: true, cleared: true });

    const status = await get("/api/keys/status?keyType=CODEX_OAUTH");
    const row = (status.keys as Array<Record<string, unknown>>).find(
      (k) => k.keySuffix === "qa001",
    );
    expect(row).toMatchObject({ status: "available", consecutiveAuthFailures: 0 });
    expect(row!.lastAuthFailureAt).not.toBeNull();
  });

  test("a codex-login re-login lifts the auth bench", async () => {
    const relog = { keyType: "CODEX_OAUTH", keySuffix: "relog" };
    await post("/api/keys/report-auth-failure", { ...relog, keyIndex: 4 });
    const benched = await post("/api/keys/report-auth-failure", { ...relog, keyIndex: 4 });
    expect(benched).toMatchObject({ benched: true });

    const fence = await readCodexAuthFailureFence(baseUrl, "test-key");
    expect(await clearCodexAuthBench(baseUrl, "test-key", "relog", 4, fence)).toBe(true);

    const status = await get("/api/keys/status?keyType=CODEX_OAUTH");
    const row = (status.keys as Array<Record<string, unknown>>).find(
      (k) => k.keySuffix === "relog",
    );
    expect(row).toMatchObject({ status: "available", consecutiveAuthFailures: 0 });
  });

  test("a late codex-login clear keeps failures on the fresh login", async () => {
    const relog = { keyType: "CODEX_OAUTH", keySuffix: "relo2" };
    await post("/api/keys/report-auth-failure", { ...relog, keyIndex: 5 });
    await post("/api/keys/report-auth-failure", { ...relog, keyIndex: 5 });
    // codex-login reads the fence, then stores the fresh credentials.
    const fence = await readCodexAuthFailureFence(baseUrl, "test-key");
    // Two tasks fail on the fresh login before the clear lands.
    await post("/api/keys/report-auth-failure", { ...relog, keyIndex: 5 });
    await post("/api/keys/report-auth-failure", { ...relog, keyIndex: 5 });
    expect(await clearCodexAuthBench(baseUrl, "test-key", "relo2", 5, fence)).toBe(false);

    const status = await get("/api/keys/status?keyType=CODEX_OAUTH");
    const row = (status.keys as Array<Record<string, unknown>>).find(
      (k) => k.keySuffix === "relo2",
    );
    expect(row).toMatchObject({ status: "rate_limited", consecutiveAuthFailures: 4 });
  });

  test("rejects an invalid body", async () => {
    const res = await fetch(`${baseUrl}/api/keys/report-auth-failure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyType: "CODEX_OAUTH", keySuffix: "qa001" }),
    });
    expect(res.status).toBe(400);
  });
});

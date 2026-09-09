import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handleCore } from "../http/core";
import { handleStats } from "../http/stats";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { isMultiRuntimeEnabled } from "../utils/multi-runtime";

const TEST_DB_PATH = `/tmp/agent-swarm-multi-runtime-stats-${process.pid}.sqlite`;
const originalDatabasePath = process.env.DATABASE_PATH;
const originalMultiRuntime = process.env.MULTI_RUNTIME_ENABLED;
let server: Server;
let baseUrl: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Run `body` with MULTI_RUNTIME_ENABLED set to an exact raw value, or unset
 * when `raw` is undefined, restoring the previous value afterwards so the flag
 * never leaks into another test in this file or another file.
 */
async function withMultiRuntime<T>(raw: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.MULTI_RUNTIME_ENABLED;
  restoreEnv("MULTI_RUNTIME_ENABLED", raw);
  try {
    return await body();
  } finally {
    restoreEnv("MULTI_RUNTIME_ENABLED", previous);
  }
}

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // SQLite only creates sidecars after a write.
    }
  }
}

async function api(
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  await removeTestDb();
  process.env.DATABASE_PATH = TEST_DB_PATH;
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, agentId, "test-key")) return;
    const pathSegments = getPathSegments(req.url ?? "");
    const queryParams = parseQueryParams(req.url ?? "");
    if (await handleStats(req, res, pathSegments, queryParams, agentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  restoreEnv("MULTI_RUNTIME_ENABLED", originalMultiRuntime);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  restoreEnv("DATABASE_PATH", originalDatabasePath);
  await removeTestDb();
});

describe("MULTI_RUNTIME_ENABLED on the authenticated stats endpoint", () => {
  test("reports false when the flag is unset — multi-runtime is opt-in", async () => {
    await withMultiRuntime(undefined, async () => {
      const stats = await api("GET", "/api/stats");
      expect(stats.status).toBe(200);
      expect(stats.body.multiRuntimeEnabled).toBe(false);
    });
  });

  test("reports false when the flag is explicitly falsy", async () => {
    for (const raw of ["false", "0"]) {
      await withMultiRuntime(raw, async () => {
        const stats = await api("GET", "/api/stats");
        expect(stats.status).toBe(200);
        expect(stats.body.multiRuntimeEnabled).toBe(false);
      });
    }
  });

  test("reports true when the flag is explicitly truthy", async () => {
    for (const raw of ["true", "1"]) {
      await withMultiRuntime(raw, async () => {
        const stats = await api("GET", "/api/stats");
        expect(stats.status).toBe(200);
        expect(stats.body.multiRuntimeEnabled).toBe(true);
      });
    }
  });

  test("agrees with the helper the server itself branches on", async () => {
    // The field must not be a second parse of the same variable: a hand-rolled
    // check here could disagree with `isMultiRuntimeEnabled` on exactly the
    // values `parseEnvFlag` normalizes, and the API would then report a mode
    // the server is not in. Compared against the helper, not a literal.
    for (const raw of [undefined, "false", "0", "true", "1", "TRUE", " true ", "treu", ""]) {
      await withMultiRuntime(raw, async () => {
        const stats = await api("GET", "/api/stats");
        expect(stats.body.multiRuntimeEnabled).toBe(isMultiRuntimeEnabled());
      });
    }
  });

  test("is read per request, so a mid-process change is reflected", async () => {
    // The value must not be captured at module load. `swarm_config` reloads
    // mutate `process.env` in a running server, and a cached read would report
    // the boot-time mode forever after.
    await withMultiRuntime("true", async () => {
      expect((await api("GET", "/api/stats")).body.multiRuntimeEnabled).toBe(true);
    });
    await withMultiRuntime("false", async () => {
      expect((await api("GET", "/api/stats")).body.multiRuntimeEnabled).toBe(false);
    });
  });

  test("never leaks the flag on the unauthenticated health endpoint", async () => {
    // /health is public — server configuration must not be discoverable there.
    for (const raw of ["true", "false", undefined]) {
      await withMultiRuntime(raw, async () => {
        const health = await api("GET", "/health");
        expect(health.status).toBe(200);
        expect(health.body.multiRuntimeEnabled).toBeUndefined();
      });
    }
  });

  test("leaves the existing steering flag on the payload untouched", async () => {
    await withMultiRuntime("true", async () => {
      const stats = await api("GET", "/api/stats");
      expect(stats.body.steeringEnabled).toBeDefined();
      expect(typeof stats.body.steeringEnabled).toBe("boolean");
      expect(stats.body.agents).toBeDefined();
      expect(stats.body.tasks).toBeDefined();
    });
  });
});

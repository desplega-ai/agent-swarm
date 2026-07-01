import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, resetDbForTests } from "../db/client.ts";
import { createRun, getRun, setRunStatus } from "../db/queries.ts";
import { addActiveRunForTests, resetActiveRunsForTests, startServer } from "./server.ts";

const ENV_KEYS = [
  "EVALS_API_KEY",
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
  "EVALS_MAX_CONCURRENT_RUNS",
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function baseUrl(server: { port?: number }): string {
  if (server.port === undefined) throw new Error("test server did not expose a port");
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  resetDbForTests();
  resetActiveRunsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
});

afterEach(() => {
  resetActiveRunsForTests();
  resetDbForTests();
  restoreEnv();
});

describe("evals API auth and run cap", () => {
  test("EVALS_API_KEY protects /api/* and accepts the correct bearer token", async () => {
    process.env.EVALS_API_KEY = "test-master-key";
    const server = await startServer(0);
    try {
      const unauthenticated = await fetch(`${baseUrl(server)}/api/runs`);
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(`${baseUrl(server)}/api/runs`, {
        headers: { Authorization: "Bearer test-master-key" },
      });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("without EVALS_API_KEY, /api/* stays open for local dev and tests", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(`${baseUrl(server)}/api/runs`);
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/runs returns 429 when active runs are at EVALS_MAX_CONCURRENT_RUNS", async () => {
    process.env.EVALS_API_KEY = "test-master-key";
    process.env.EVALS_MAX_CONCURRENT_RUNS = "1";
    addActiveRunForTests("already-running");
    const server = await startServer(0);
    try {
      const res = await fetch(`${baseUrl(server)}/api/runs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-master-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        error?: string;
        activeRuns?: number;
        maxConcurrentRuns?: number;
      };
      expect(body.error).toContain("max concurrent eval runs reached");
      expect(body.activeRuns).toBe(1);
      expect(body.maxConcurrentRuns).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/runs/:id/cancel force-cancels an inactive running run", async () => {
    const server = await startServer(0, {
      forceCancelInactiveRun: async (db, runId) => {
        await setRunStatus(db, runId, "cancelled");
        return 3;
      },
    });
    try {
      const db = getDb();
      await createRun(db, {
        id: "run-orphaned",
        scenarioIds: ["scenario-a"],
        configIds: ["config-a"],
        attemptsPerCell: 1,
        concurrency: 1,
      });
      await setRunStatus(db, "run-orphaned", "running");

      const res = await fetch(`${baseUrl(server)}/api/runs/run-orphaned/cancel`, {
        method: "POST",
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        runId: "run-orphaned",
        cancelled: true,
        forced: true,
        swept: 3,
      });
      expect((await getRun(db, "run-orphaned"))?.status).toBe("cancelled");
    } finally {
      server.stop(true);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, resetDbForTests } from "../db/client.ts";
import { createRun, getRun, setRunStatus } from "../db/queries.ts";
import { setDbConfigs } from "../registry.ts";
import { addActiveRunForTests, resetActiveRunsForTests, startServer } from "./server.ts";

const ENV_KEYS = [
  "EVALS_API_KEY",
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
  "EVALS_MAX_CONCURRENT_RUNS",
  "EVALS_ALLOW_OPEN_API",
  "EVALS_MODEL_CATALOG_REFRESH",
  "EVALS_PUBLIC_URL",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

const OTHER_ORIGIN = "http://unrelated.invalid";
const PI_CONFIG = {
  provider: "pi",
  model: "openrouter/deepseek/deepseek-v4-flash",
  id: "pi-origin-check",
};

function baseUrl(server: { port?: number }): string {
  if (server.port === undefined) throw new Error("test server did not expose a port");
  return `http://127.0.0.1:${server.port}`;
}

async function seedRunningRun(id: string): Promise<void> {
  const db = getDb();
  await createRun(db, {
    id,
    scenarioIds: ["scenario-a"],
    configIds: ["config-a"],
    attemptsPerCell: 1,
    concurrency: 1,
  });
  await setRunStatus(db, id, "running");
}

const forceCancelStub = {
  forceCancelInactiveRun: async (db: ReturnType<typeof getDb>, runId: string) => {
    await setRunStatus(db, runId, "cancelled");
    return 0;
  },
};

beforeEach(() => {
  resetDbForTests();
  resetActiveRunsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  // Open mode: no EVALS_API_KEY.
  process.env.EVALS_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.EVALS_MODEL_CATALOG_REFRESH = "off";
});

afterEach(() => {
  resetActiveRunsForTests();
  resetDbForTests();
  setDbConfigs(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("open-mode evals API writes from another origin", () => {
  test("POST /api/configs rejects a text/plain body from another origin", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(`${baseUrl(server)}/api/configs`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: OTHER_ORIGIN },
        body: JSON.stringify(PI_CONFIG),
      });
      expect([403, 415]).toContain(res.status);
      const list = (await (await fetch(`${baseUrl(server)}/api/configs`)).json()) as {
        id: string;
      }[];
      expect(list.some((c) => c.id === PI_CONFIG.id)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/runs rejects a text/plain body from another origin", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(`${baseUrl(server)}/api/runs`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: OTHER_ORIGIN },
        // An unknown scenario keeps execution from starting on today's code: a 400 here
        // proves the handler parsed and acted on the body.
        body: JSON.stringify({ scenarioIds: ["no-such-scenario"], configIds: ["no-such-config"] }),
      });
      expect([403, 415]).toContain(res.status);
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/runs/:id/cancel rejects another origin and leaves the run running", async () => {
    const server = await startServer(0, forceCancelStub);
    try {
      await seedRunningRun("run-origin-cancel");
      const res = await fetch(`${baseUrl(server)}/api/runs/run-origin-cancel/cancel`, {
        method: "POST",
        headers: { origin: OTHER_ORIGIN },
      });
      expect(res.status).toBe(403);
      expect((await getRun(getDb(), "run-origin-cancel"))?.status).toBe("running");
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/runs/:id/resume rejects another origin", async () => {
    const server = await startServer(0);
    try {
      await seedRunningRun("run-origin-resume");
      // Marked active so today's code answers 409 instead of starting execution.
      addActiveRunForTests("run-origin-resume");
      const res = await fetch(`${baseUrl(server)}/api/runs/run-origin-resume/resume`, {
        method: "POST",
        headers: { origin: OTHER_ORIGIN },
      });
      expect(res.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  test("POST /api/configs rejects a same-origin non-JSON body with 415", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(`${baseUrl(server)}/api/configs`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: baseUrl(server) },
        body: JSON.stringify(PI_CONFIG),
      });
      expect(res.status).toBe(415);
    } finally {
      server.stop(true);
    }
  });

  test("with EVALS_API_KEY set, the bearer alone gates writes", async () => {
    process.env.EVALS_API_KEY = "example-test-master-key";
    const server = await startServer(0, forceCancelStub);
    try {
      await seedRunningRun("run-origin-keyed");
      const res = await fetch(`${baseUrl(server)}/api/runs/run-origin-keyed/cancel`, {
        method: "POST",
        headers: { origin: OTHER_ORIGIN, authorization: "Bearer example-test-master-key" },
      });
      expect(res.status).toBe(202);
    } finally {
      server.stop(true);
    }
  });

  test("control: same-origin JSON config write and an Origin-less cancel still work", async () => {
    const server = await startServer(0, forceCancelStub);
    try {
      const created = await fetch(`${baseUrl(server)}/api/configs`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl(server) },
        body: JSON.stringify(PI_CONFIG),
      });
      expect(created.status).toBe(201);

      await seedRunningRun("run-origin-control");
      const cancelled = await fetch(`${baseUrl(server)}/api/runs/run-origin-control/cancel`, {
        method: "POST",
      });
      expect(cancelled.status).toBe(202);
      expect((await getRun(getDb(), "run-origin-control"))?.status).toBe("cancelled");
    } finally {
      server.stop(true);
    }
  });
});

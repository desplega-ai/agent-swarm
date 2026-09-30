import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, resetDbForTests } from "../db/client.ts";
import { createRun, insertAttempt, setRunStatus, updateAttempt } from "../db/queries.ts";
import { resetActiveRunsForTests, startServer } from "./server.ts";

const ENV_KEYS = [
  "EVALS_API_KEY",
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(() => {
  resetDbForTests();
  resetActiveRunsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
});
afterEach(() => {
  resetActiveRunsForTests();
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function seed(id: string, preset: string | undefined, status: "running" | "done" | "failed") {
  const db = getDb();
  await createRun(db, {
    id,
    scenarioIds: ["sql-audit"],
    configIds: ["claude-opus-5.5"],
    attemptsPerCell: 3,
    concurrency: 2,
    maxMeteredUsd: 2,
    preset,
  });
  for (let i = 0; i < 3; i++) {
    const attemptId = `${id}_${i}`;
    await insertAttempt(db, {
      id: attemptId,
      runId: id,
      scenarioId: "sql-audit",
      configId: "claude-opus-5.5",
      attemptIndex: i,
      scenarioVersion: 1,
      suiteVersion: "1.0",
    });
    await updateAttempt(db, attemptId, {
      status: status === "failed" ? "error" : "passed",
      score: 0.9,
      passed: true,
      costUsd: 0.1,
      resolvedModel: "claude-opus-5-5",
    });
  }
  await setRunStatus(db, id, status);
}

describe("GET /api/runs/:id/regression", () => {
  test("404 for an unknown run, 400 for a run that is not from a scheduled preset", async () => {
    const server = await startServer(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/runs/nope/regression`)).status).toBe(404);
      await seed("adhoc", undefined, "done");
      await seed("ui-preset", "frontier", "done");
      for (const id of ["adhoc", "ui-preset"]) {
        const res = await fetch(`${base}/api/runs/${id}/regression`);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("scheduled preset");
      }
    } finally {
      server.stop(true);
    }
  });

  test("requires the bearer token when EVALS_API_KEY is set", async () => {
    process.env.EVALS_API_KEY = "example-test-master-key";
    const server = await startServer(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      await seed("tonight", "nightly-canary", "done");
      expect((await fetch(`${base}/api/runs/tonight/regression`)).status).toBe(401);
      const ok = await fetch(`${base}/api/runs/tonight/regression`, {
        headers: { Authorization: "Bearer example-test-master-key" },
      });
      expect(ok.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("a run still executing is not final and has no report", async () => {
    const server = await startServer(0);
    try {
      await seed("tonight", "nightly-canary", "running");
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/tonight/regression`);
      expect(await res.json()).toEqual({
        runId: "tonight",
        preset: "nightly-canary",
        status: "running",
        summaryPostedAt: null,
        final: false,
        report: null,
        text: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test("a finished run returns its report and the Slack text", async () => {
    const server = await startServer(0);
    try {
      await seed("tonight", "nightly-canary", "done");
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/tonight/regression`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        final: boolean;
        summaryPostedAt: string | null;
        report: { cells: Array<{ status: string; passed: number }>; page: boolean };
        text: string;
      };
      expect(body.final).toBe(true);
      expect(body.summaryPostedAt).toBeNull();
      expect(body.report.page).toBe(false);
      expect(body.report.cells).toMatchObject([{ status: "no-baseline", passed: 3 }]);
      expect(body.text).toContain("*Nightly canary: clean*");
      expect(body.text).toContain("Baseline still building");
    } finally {
      server.stop(true);
    }
  });

  test("a failed run returns the failure text", async () => {
    const server = await startServer(0);
    try {
      await seed("tonight", "weekly-matrix", "failed");
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/tonight/regression`);
      const body = (await res.json()) as { final: boolean; report: unknown; text: string };
      expect(body.final).toBe(true);
      expect(body.report).toBeNull();
      expect(body.text).toContain(":x: *Weekly matrix: run failed*");
    } finally {
      server.stop(true);
    }
  });
});

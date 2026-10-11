import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../api/server.ts";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import {
  createRun,
  getRun,
  insertAttempt,
  listAttempts,
  listRuns,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import {
  CANCEL_REASON_DEAD_RUN,
  claimAutoResumableRuns,
  MAX_AUTO_RESUMES,
  reconcileOrphanedRuns,
} from "./index.ts";

const ENV_KEYS = ["EVALS_DB_PATH", "EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(async () => {
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  await initDb();
});

afterEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("orphaned eval run recovery", () => {
  test("reconcileOrphanedRuns sweeps DB-running runs and marks them failed", async () => {
    const db = getDb();
    await createRun(db, {
      id: "run-orphaned",
      scenarioIds: ["scenario-a"],
      configIds: ["config-a"],
      attemptsPerCell: 1,
      concurrency: 1,
    });
    await setRunStatus(db, "run-orphaned", "running");

    const sweptRunIds: string[] = [];
    const logs: string[] = [];
    const count = await reconcileOrphanedRuns(
      db,
      (msg) => logs.push(msg),
      async (runId) => {
        sweptRunIds.push(runId);
        return 2;
      },
    );

    expect(count).toBe(1);
    expect(sweptRunIds).toEqual(["run-orphaned"]);
    expect((await getRun(db, "run-orphaned"))?.status).toBe("failed");
    expect(logs.join("\n")).toContain('run run-orphaned was left "running"');
    expect(logs.join("\n")).toContain("swept 2 sandbox(es), marked failed");
  });

  describe("boot resume of runs a restart cut", () => {
    const noSweep = async () => 0;
    const silent = () => {};

    async function runningRun(id: string, preset?: string, createdAt?: string) {
      const db = getDb();
      await createRun(db, {
        id,
        scenarioIds: ["scenario-a"],
        configIds: ["config-a"],
        attemptsPerCell: 3,
        concurrency: 1,
        ...(preset ? { preset } : {}),
      });
      if (createdAt) {
        await db.execute({
          sql: "UPDATE eval_runs SET created_at = ? WHERE id = ?",
          args: [createdAt, id],
        });
      }
      for (let i = 0; i < 3; i++) {
        await insertAttempt(db, {
          id: `${id}_${i}`,
          runId: id,
          scenarioId: "scenario-a",
          configId: "config-a",
          attemptIndex: i,
        });
      }
      await setRunStatus(db, id, "running");
    }

    /** What startServer does: snapshot the running runs, reap, then claim. */
    async function boot(limit = 1): Promise<string[]> {
      const db = getDb();
      const orphans = (await listRuns(db)).filter((run) => run.status === "running");
      await reconcileOrphanedRuns(db, silent, noSweep);
      return claimAutoResumableRuns(db, orphans, limit, silent);
    }

    test("a scheduled run is picked and only its reaped attempts go back to pending", async () => {
      const db = getDb();
      await runningRun("run-weekly", "weekly-matrix");
      await updateAttempt(db, "run-weekly_0", { status: "passed" });
      await updateAttempt(db, "run-weekly_1", { status: "error", error: "real harness failure" });

      expect(await boot()).toEqual(["run-weekly"]);
      const byId = new Map((await listAttempts(db, "run-weekly")).map((a) => [a.id, a]));
      expect(byId.get("run-weekly_0")?.status).toBe("passed");
      expect(byId.get("run-weekly_1")?.status).toBe("error");
      expect(byId.get("run-weekly_2")?.status).toBe("pending");
      expect(byId.get("run-weekly_2")?.error).toBeNull();
      expect((await getRun(db, "run-weekly"))?.autoResumes).toBe(1);
    });

    test("a manual run is reaped but not resumed", async () => {
      const db = getDb();
      await runningRun("run-manual");
      expect(await boot()).toEqual([]);
      expect((await getRun(db, "run-manual"))?.status).toBe("failed");
      const [reaped] = (await listAttempts(db, "run-manual")).filter((a) => a.attemptIndex === 0);
      expect(reaped?.error).toBe(CANCEL_REASON_DEAD_RUN);
    });

    test("the oldest scheduled run wins when only one may execute", async () => {
      await runningRun("run-newer", "nightly-canary", "2026-10-11T02:00:00.000Z");
      await runningRun("run-older", "weekly-matrix", "2026-10-11T01:00:00.000Z");
      expect(await boot(1)).toEqual(["run-older"]);
    });

    test(`a run that keeps dying stays failed after ${MAX_AUTO_RESUMES} boot resumes`, async () => {
      const db = getDb();
      await runningRun("run-loop", "weekly-matrix");
      for (let i = 0; i < MAX_AUTO_RESUMES; i++) {
        expect(await boot()).toEqual(["run-loop"]);
        await setRunStatus(db, "run-loop", "running");
      }
      expect(await boot()).toEqual([]);
      expect((await getRun(db, "run-loop"))?.status).toBe("failed");
    });
  });

  test("startServer hands the runs it found running to the boot-resume claim", async () => {
    await runningRunForServer("run-at-boot");
    const seen: { ids: string[]; limit: number }[] = [];
    const server = await startServer(0, {
      reconcileOrphanedRuns: async () => 1,
      claimAutoResumableRuns: async (_db, orphans, limit) => {
        seen.push({ ids: orphans.map((run) => run.id), limit });
        return [];
      },
    });
    server.stop(true);
    expect(seen).toEqual([{ ids: ["run-at-boot"], limit: 1 }]);
  });
});

async function runningRunForServer(id: string) {
  const db = getDb();
  await createRun(db, {
    id,
    scenarioIds: ["scenario-a"],
    configIds: ["config-a"],
    attemptsPerCell: 1,
    concurrency: 1,
    preset: "weekly-matrix",
  });
  await setRunStatus(db, id, "running");
}

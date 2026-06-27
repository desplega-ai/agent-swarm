import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, initDb, REPLICA_PATH, resetDbForTests } from "./client.ts";

const ENV_KEYS = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;

// Snapshot the real env (evals/.env is auto-loaded by Bun) so tests can
// freely mutate and we always restore. Values are never logged or asserted.
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

function clearDbEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreDbEnv(): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

beforeEach(() => {
  resetDbForTests();
  clearDbEnv();
});

afterEach(() => {
  resetDbForTests();
  restoreDbEnv();
});

afterAll(() => {
  resetDbForTests();
  restoreDbEnv();
});

describe("getDb env resolution", () => {
  test("no env → clear error naming all config vars (never a silent default DB)", () => {
    expect(() => getDb()).toThrow(/EVALS_DB_SYNC_URL/);
    expect(() => getDb()).toThrow(/EVALS_DB_AUTH_TOKEN/);
    expect(() => getDb()).toThrow(/EVALS_DB_PATH/);
  });

  test("EVALS_DB_SYNC_URL without EVALS_DB_AUTH_TOKEN → fail fast", () => {
    process.env.EVALS_DB_SYNC_URL = "libsql://example.invalid";
    expect(() => getDb()).toThrow("EVALS_DB_SYNC_URL is set but EVALS_DB_AUTH_TOKEN is missing");
  });

  test("sync URL takes precedence over EVALS_DB_PATH (missing token still fails)", () => {
    process.env.EVALS_DB_SYNC_URL = "libsql://example.invalid";
    process.env.EVALS_DB_PATH = ":memory:";
    expect(() => getDb()).toThrow(/EVALS_DB_AUTH_TOKEN is missing/);
  });

  test("EVALS_DB_PATH escape hatch opens a plain local client", async () => {
    process.env.EVALS_DB_PATH = ":memory:";
    const db = getDb();
    const res = await db.execute("SELECT 1 AS one");
    expect(res.rows[0]?.one).toBe(1);
  });

  test("client is module-cached until resetDbForTests()", () => {
    process.env.EVALS_DB_PATH = ":memory:";
    const a = getDb();
    expect(getDb()).toBe(a);
    resetDbForTests();
    expect(getDb()).not.toBe(a);
  });

  test("REPLICA_PATH points at evals/evals-replica.db regardless of cwd", () => {
    expect(REPLICA_PATH.endsWith("/evals/evals-replica.db")).toBe(true);
    expect(REPLICA_PATH).not.toContain("evals.db-");
    expect(REPLICA_PATH.endsWith("evals/evals.db")).toBe(false);
  });
});

describe("initDb on a local client", () => {
  test("applies schema + column migrations idempotently", async () => {
    process.env.EVALS_DB_PATH = ":memory:";
    const db = await initDb();
    // Schema tables exist.
    await db.execute(
      "INSERT INTO eval_runs (id, scenario_ids, config_ids) VALUES ('r1', '[]', '[]')",
    );
    // Migrated column (judge_model) exists.
    await db.execute("UPDATE eval_runs SET judge_model = 'x' WHERE id = 'r1'");
    const row = (await db.execute("SELECT judge_model FROM eval_runs WHERE id = 'r1'")).rows[0];
    expect(row?.judge_model).toBe("x");
    // v8.0 OutcomeSpec v2 columns (judgments.dimension/weight) exist + round-trip.
    await db.execute(
      `INSERT INTO attempts (id, run_id, scenario_id, config_id, attempt_index)
       VALUES ('a1', 'r1', 's1', 'c1', 0)`,
    );
    await db.execute(
      `INSERT INTO judgments (id, attempt_id, kind, name, pass, dimension, weight)
       VALUES ('j-dim', 'a1', 'llm', 'correctness', 1, 'correctness', 2.5)`,
    );
    const dimRow = (await db.execute("SELECT dimension, weight FROM judgments WHERE id = 'j-dim'"))
      .rows[0];
    expect(dimRow?.dimension).toBe("correctness");
    expect(dimRow?.weight).toBe(2.5);
    // Gate / pre-v2 row shape: omitting both columns reads back NULL on both.
    await db.execute(
      "INSERT INTO judgments (id, attempt_id, kind, name, pass) VALUES ('j-gate', 'a1', 'deterministic', 'tasks-completed', 1)",
    );
    const gateRow = (
      await db.execute("SELECT dimension, weight FROM judgments WHERE id = 'j-gate'")
    ).rows[0];
    expect(gateRow?.dimension).toBeNull();
    expect(gateRow?.weight).toBeNull();
    // Second init is a no-op (CREATE IF NOT EXISTS + tolerated ALTERs).
    await initDb();
    const count = (await db.execute("SELECT COUNT(*) AS n FROM eval_runs")).rows[0];
    expect(count?.n).toBe(1);
    // Columns remain usable after the second init (idempotent ALTERs).
    const stillThere = (
      await db.execute("SELECT dimension, weight FROM judgments WHERE id = 'j-dim'")
    ).rows[0];
    expect(stillThere?.dimension).toBe("correctness");
    expect(stillThere?.weight).toBe(2.5);
  });

  test("no WAL requirement for the plain-file escape hatch (:memory: reports 'memory')", async () => {
    process.env.EVALS_DB_PATH = ":memory:";
    const db = await initDb();
    const res = await db.execute("PRAGMA journal_mode");
    expect(String(res.rows[0]?.journal_mode)).toBe("memory");
  });
});

// Real Turso embedded-replica connectivity. Network + real credentials, so it
// is opt-in (EVALS_DB_REPLICA_TEST=1) on top of the env being present — plain
// `bun test src/` stays hermetic even with evals/.env auto-loaded.
const replicaEnvReady =
  process.env.EVALS_DB_REPLICA_TEST === "1" &&
  !!saved.EVALS_DB_SYNC_URL &&
  !!saved.EVALS_DB_AUTH_TOKEN;

describe.skipIf(!replicaEnvReady)("embedded replica (opt-in, real Turso)", () => {
  test(
    "initDb syncs, asserts WAL, and sees historical data",
    async () => {
      restoreDbEnv();
      delete process.env.EVALS_DB_PATH;
      resetDbForTests();
      const db = await initDb();
      const mode = (await db.execute("PRAGMA journal_mode")).rows[0];
      expect(String(mode?.journal_mode)).toBe("wal");
      const attempts = (await db.execute("SELECT COUNT(*) AS n FROM attempts")).rows[0];
      expect(Number(attempts?.n)).toBeGreaterThanOrEqual(102);
    },
    // First bootstrap pulls the full remote DB (transcript artifacts are
    // multi-MB) — well beyond bun's 5 s default.
    { timeout: 180_000 },
  );
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresClient, MIGRATION_LOCK_KEY, runPostgresMigrations } from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// The Postgres migration runner on the real chain (src/be/migrations/postgres):
// the generated baseline applies to an empty database, a second run is a
// no-op, a second runner waits on the advisory lock, a changed file warns.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");
const quiet = { log: () => {}, warn: () => {} };
// Migrations in the chain: the baseline and every file after it.
const CHAIN_LENGTH = readdirSync(CHAIN_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).length;
// Applying the full baseline takes seconds; two at once, more. A budget, not a retry.
const APPLY_TIMEOUT_MS = 60_000;

describe("runPostgresMigrations", () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase("migrate");
  });

  afterAll(async () => {
    await scratch.drop();
  });

  test(
    "applies the baseline to an empty database, then a second run is a no-op",
    async () => {
      const client = createPostgresClient(scratch.url, { max: 2 });
      try {
        const first = await runPostgresMigrations(client, { migrationsDir: CHAIN_DIR, ...quiet });
        expect(first.applied[0]).toMatch(/^\d+_baseline$/);
        expect(first.alreadyApplied).toEqual([]);

        const recorded = await client.query<{ version: string; name: string; checksum: string }>(
          "SELECT version, name, checksum FROM _migrations ORDER BY version",
        );
        expect(recorded.map((r) => r.name)).toEqual(first.applied);
        expect(recorded[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

        // The baseline built the schema: tables, the view, the triggers, the seeds.
        const tables = await client.get<{ n: string }>(
          "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        );
        expect(Number(tables?.n)).toBeGreaterThan(100);
        const view = await client.get<{ n: string }>(
          "SELECT count(*) AS n FROM information_schema.views WHERE table_name = 'session_summary_recompute'",
        );
        expect(Number(view?.n)).toBe(1);
        const roles = await client.query<{ id: string }>("SELECT id FROM roles ORDER BY id");
        expect(roles.map((r) => r.id)).toContain("rbac-role-admin");

        const second = await runPostgresMigrations(client, { migrationsDir: CHAIN_DIR, ...quiet });
        expect(second.applied).toEqual([]);
        expect(second.alreadyApplied).toEqual(first.applied);
        const after = await client.get<{ n: string }>("SELECT count(*) AS n FROM _migrations");
        expect(Number(after?.n)).toBe(recorded.length);
      } finally {
        await client.close();
      }
    },
    APPLY_TIMEOUT_MS,
  );

  test(
    "a second runner waits while another session holds the migration lock",
    async () => {
      const db = await createScratchDatabase("migrate_lock");
      const holder = new Bun.SQL(db.url);
      const client = createPostgresClient(db.url, { max: 2 });
      try {
        const held = await holder.reserve();
        await held.unsafe("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        let done = false;
        const run = runPostgresMigrations(client, { migrationsDir: CHAIN_DIR, ...quiet }).then(
          (result) => {
            done = true;
            return result;
          },
        );
        // The runner's connection blocks on pg_advisory_lock: it shows as a
        // waiting advisory-lock request, and nothing is applied yet.
        let waiting = 0;
        for (let i = 0; i < 50 && waiting === 0; i++) {
          await Bun.sleep(50);
          const rows = await held.unsafe(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
          );
          waiting = Number(rows[0]?.n ?? 0);
        }
        expect(waiting).toBe(1);
        expect(done).toBe(false);
        const tables = await held.unsafe(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'agent_tasks'",
        );
        expect(Number(tables[0]?.n)).toBe(0);

        await held.unsafe("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        held.release();
        const result = await run;
        expect(result.applied.length).toBe(CHAIN_LENGTH);
      } finally {
        await client.close();
        await holder.close();
        await db.drop();
      }
    },
    APPLY_TIMEOUT_MS,
  );

  test(
    "two runners started together apply the chain once",
    async () => {
      const db = await createScratchDatabase("migrate_race");
      const a = createPostgresClient(db.url, { max: 2 });
      const b = createPostgresClient(db.url, { max: 2 });
      try {
        const [ra, rb] = await Promise.all([
          runPostgresMigrations(a, { migrationsDir: CHAIN_DIR, ...quiet }),
          runPostgresMigrations(b, { migrationsDir: CHAIN_DIR, ...quiet }),
        ]);
        expect([ra.applied.length, rb.applied.length].sort()).toEqual([0, CHAIN_LENGTH]);
        const n = await a.get<{ n: string }>("SELECT count(*) AS n FROM _migrations");
        expect(Number(n?.n)).toBe(CHAIN_LENGTH);
      } finally {
        await a.close();
        await b.close();
        await db.drop();
      }
    },
    APPLY_TIMEOUT_MS,
  );

  test("a changed applied file warns; a new file applies in its own transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-chain-"));
    const db = await createScratchDatabase("migrate_files");
    const client = createPostgresClient(db.url, { max: 2 });
    try {
      writeFileSync(join(dir, "001_first.sql"), "CREATE TABLE one (id bigint PRIMARY KEY);");
      await runPostgresMigrations(client, { migrationsDir: dir, ...quiet });

      writeFileSync(
        join(dir, "001_first.sql"),
        "CREATE TABLE one (id bigint PRIMARY KEY); -- edited",
      );
      // A failing file rolls back whole, and is not recorded.
      writeFileSync(
        join(dir, "002_broken.sql"),
        "CREATE TABLE two (id bigint); INSERT INTO missing_table VALUES (1);",
      );
      const warnings: string[] = [];
      await expect(
        runPostgresMigrations(client, {
          migrationsDir: dir,
          log: () => {},
          warn: (line) => warnings.push(line),
        }),
      ).rejects.toThrow(/Migration 2 \(002_broken\) failed/);
      expect(warnings.some((w) => w.includes("001_first checksum mismatch"))).toBe(true);
      const two = await client.get<{ n: string }>(
        "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'two'",
      );
      expect(Number(two?.n)).toBe(0);
      const versions = await client.query<{ version: string }>(
        "SELECT version FROM _migrations ORDER BY version",
      );
      expect(versions.map((v) => Number(v.version))).toEqual([1]);

      writeFileSync(join(dir, "002_broken.sql"), "CREATE TABLE two (id bigint);");
      const fixed = await runPostgresMigrations(client, { migrationsDir: dir, ...quiet });
      expect(fixed.applied).toEqual(["002_broken"]);
    } finally {
      await client.close();
      await db.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a duplicate ordinal in the chain is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-chain-dup-"));
    try {
      cpSync(CHAIN_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
      writeFileSync(join(dir, "001_b.sql"), "SELECT 1;");
      const client = { reserve: () => Promise.reject(new Error("not reached")) };
      await expect(runPostgresMigrations(client, { migrationsDir: dir, ...quiet })).rejects.toThrow(
        /ordinal 1 is used twice/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

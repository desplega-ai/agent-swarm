import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNotEmptyDatabase,
  resolveMigrationsDir,
  runMigrations,
} from "../be/migrations/runner";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * Regression coverage for the 2026-08-27 P0: every new-org swarm provision
 * failed for 6 days because `runMigrations` silently skipped every migration
 * on a fresh database, which crashed the process several layers downstream
 * in `ensureAgentProfileColumns` (`no such table: agents`) instead of at the
 * real cause.
 *
 * Root cause: `import.meta.dir` resolves to `/$bunfs/root` inside a
 * `bun build --compile` binary (the shape the production API ships as). The
 * runner used to detect that by calling `readdirSync` and catching the
 * exception it threw there, falling back to `MIGRATIONS_DIR` (set by the
 * Dockerfile to the real on-disk copy of the `.sql` files) only on catch.
 * Bun 1.4 (adopted in #1216, between the 1.133.1 last-known-good and the
 * 1.135.0 first-known-bad golden images) changed `readdirSync` to succeed on
 * `/$bunfs/` instead of throwing — so the catch branch, and therefore
 * `MIGRATIONS_DIR`, was never reached. The `.sql` filter then matched
 * nothing in the virtual filesystem and `runMigrations` returned having
 * created no tables at all.
 */

const REPO_MIGRATIONS_DIR = join(import.meta.dir, "..", "be", "migrations");

describe("resolveMigrationsDir", () => {
  test("uses import.meta.dir when it is a real, readable directory", () => {
    expect(resolveMigrationsDir(REPO_MIGRATIONS_DIR)).toBe(REPO_MIGRATIONS_DIR);
  });

  test("falls back to MIGRATIONS_DIR for a /$bunfs/ path, even though readdirSync would succeed on it", () => {
    // The bug: readdirSync(import.meta.dir) no longer throws under Bun 1.4 in
    // a compiled binary, so detection must not depend on that exception.
    // import.meta.dir itself (a real, populated directory) stands in for
    // "readdirSync succeeds but the fallback must still win" — the prefix
    // check must short-circuit before readdirSync is ever consulted.
    expect(resolveMigrationsDir(`/$bunfs/root`, REPO_MIGRATIONS_DIR)).toBe(REPO_MIGRATIONS_DIR);
  });

  test("returns null for a /$bunfs/ path with no MIGRATIONS_DIR set", () => {
    expect(resolveMigrationsDir(`/$bunfs/root`, undefined)).toBeNull();
  });

  test("falls back to MIGRATIONS_DIR for a nonexistent real path", () => {
    const bogus = join(tmpdir(), `does-not-exist-${crypto.randomUUID()}`);
    expect(resolveMigrationsDir(bogus, REPO_MIGRATIONS_DIR)).toBe(REPO_MIGRATIONS_DIR);
  });
});

describe("runMigrations still applies migrations normally in a real bun test run", () => {
  test("a fresh in-memory database gets the baseline schema", () => {
    // `import.meta.dir` always resolves to the real, readable migrations
    // directory in a `bun test` run, so the silent-skip branches this
    // incident lived in are unreachable here — that's exactly why the bug
    // shipped without a `bun test` failure. Confirms the fix didn't break
    // the ordinary path; the /$bunfs/ compiled-binary tests below cover the
    // actual regression.
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      const row = db
        .prepare<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
        )
        .get();
      expect(row?.name).toBe("agents");
    } finally {
      db.close();
    }
  });
});

describe("assertNotEmptyDatabase", () => {
  test("throws on a database with no tables", () => {
    const db = new Database(":memory:");
    try {
      expect(() => assertNotEmptyDatabase(db, "no migrations directory could be located")).toThrow(
        "Refusing to boot",
      );
    } finally {
      db.close();
    }
  });

  test("is a no-op once the database has at least one table", () => {
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE agents (id TEXT PRIMARY KEY)");
      expect(() =>
        assertNotEmptyDatabase(db, "no migrations directory could be located"),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("compiled binary — the exact failure mode this incident shipped in", () => {
  const workDir = mkdtempSync(join(tmpdir(), "migration-bunfs-"));
  const fixtureBinary = join(
    workDir,
    `compiled-migrations-boot${process.platform === "win32" ? ".exe" : ""}`,
  );
  const fixtureSrc = join(import.meta.dir, "fixtures", "compiled-migrations-boot.ts");
  const apiBinary = join(
    workDir,
    `compiled-source-schema-boot${process.platform === "win32" ? ".exe" : ""}`,
  );
  const apiFixtureSrc = join(import.meta.dir, "fixtures", "compiled-source-schema-boot.ts");
  const legacyDir = join(workDir, "legacy-migrations");
  const emptyDir = join(workDir, "empty-migrations");

  beforeAll(async () => {
    mkdirSync(legacyDir);
    mkdirSync(emptyDir);
    for (const file of readdirSync(REPO_MIGRATIONS_DIR)) {
      if (file.endsWith(".sql") && Number.parseInt(file, 10) < 342) {
        await Bun.write(join(legacyDir, file), Bun.file(join(REPO_MIGRATIONS_DIR, file)));
      }
    }
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test(
    "builds",
    async () => {
      for (const [source, binary] of [
        [fixtureSrc, fixtureBinary],
        [apiFixtureSrc, apiBinary],
      ]) {
        const result = await runChild(
          [
            "bun",
            "build",
            source,
            "--compile",
            "--outfile",
            binary,
            // Exercise the Linux API image's virtual path on Windows too, where
            // Bun otherwise uses B:\\~BUN\\root instead of /$bunfs/root.
            ...(process.platform === "win32" ? ["--define", 'import.meta.dir="/$bunfs/root"'] : []),
          ],
          { timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS },
        );
        expectChildOk(result, "bun build --compile of the migrations fixture");
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 2 + 5_000,
  );

  test(
    "boots successfully when MIGRATIONS_DIR points at the real .sql files",
    async () => {
      const dbPath = join(workDir, "healthy.sqlite");
      const result = await runChild([fixtureBinary, dbPath], {
        env: { MIGRATIONS_DIR: REPO_MIGRATIONS_DIR },
        timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
      });
      expectChildOk(result, "compiled migrations fixture (MIGRATIONS_DIR set)");
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.hasAgentsTable).toBe(true);
    },
    CHILD_PROCESS_TEST_BUDGET_MS + 5_000,
  );

  test(
    "fails loud instead of booting into a table-less database when MIGRATIONS_DIR is unset",
    async () => {
      const dbPath = join(workDir, "unrecoverable.sqlite");
      const env = { ...process.env };
      delete env.MIGRATIONS_DIR;
      const result = await runChild([fixtureBinary, dbPath], {
        env,
        timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
      });
      // The fixture itself always exits 0 (it catches and reports the error
      // as JSON) so the exit code alone can't distinguish "healthy" from
      // "the old silent-skip bug" — this is the deliberate proof: the
      // no-MIGRATIONS_DIR case must come back as `ok: false` with a clear
      // cause, never as `ok: true, hasAgentsTable: false`.
      expectChildOk(result, "compiled migrations fixture (MIGRATIONS_DIR unset)");
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Refusing to boot");
      expect(parsed.error).toContain("no tables yet");
    },
    CHILD_PROCESS_TEST_BUDGET_MS + 5_000,
  );

  test.each(["omitted", "empty", "unset", "missing table", "missing hash column"])(
    "refuses a legacy database before runtime reads when migration 342 is %s",
    async (mode) => {
      const dbPath = join(workDir, `legacy-${mode}.sqlite`);
      // The standalone runner can prepare historical schemas. Actual API boot
      // must reject them before handing a handle to its source readers.
      expectChildOk(
        await runChild([fixtureBinary, dbPath], {
          env: { ...process.env, MIGRATIONS_DIR: legacyDir },
          timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
        }),
        "prepare pre-342 database",
      );
      if (mode === "missing table" || mode === "missing hash column") {
        const legacy = new Database(dbPath);
        try {
          legacy.run(
            mode === "missing table"
              ? "ALTER TABLE script_runs ADD COLUMN sourceHash TEXT"
              : "CREATE TABLE script_run_sources (hash TEXT PRIMARY KEY, source TEXT NOT NULL)",
          );
        } finally {
          legacy.close(true);
        }
      }
      const env = { ...process.env };
      if (mode === "unset") delete env.MIGRATIONS_DIR;
      else env.MIGRATIONS_DIR = mode === "empty" ? emptyDir : legacyDir;

      const result = await runChild([apiBinary, dbPath], {
        env,
        timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
      });
      expectChildOk(result, "compiled fixture with incomplete migrations");
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("342_script_run_sources.sql");
      expect(parsed.error).toContain("MIGRATIONS_DIR");
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 2 + 5_000,
  );

  test.each(["omitted", "empty", "unset"])(
    "reuses and backfills an upgraded database when migration 342 is %s",
    async (mode) => {
      const dbPath = join(workDir, `upgraded-${mode}.sqlite`);
      const seeded = await runChild([apiBinary, dbPath], {
        env: { ...process.env, MIGRATIONS_DIR: REPO_MIGRATIONS_DIR },
        timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
      });
      expectChildOk(seeded, "prepare upgraded database");
      expect(JSON.parse(seeded.stdout.trim()).ok).toBe(true);
      const source = "export default () => '雪';\n";
      const legacy = new Database(dbPath);
      try {
        legacy.run("INSERT INTO script_runs (id, agentId, source) VALUES ('legacy', 'agent', ?)", [
          source,
        ]);
      } finally {
        legacy.close(true);
      }
      const env = { ...process.env };
      if (mode === "unset") delete env.MIGRATIONS_DIR;
      else env.MIGRATIONS_DIR = mode === "empty" ? emptyDir : legacyDir;

      const result = await runChild([apiBinary, dbPath], {
        env,
        timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
      });
      expectChildOk(result, "compiled fixture reusing upgraded source schema");
      expect(JSON.parse(result.stdout.trim()).ok).toBe(true);
      const reopened = new Database(dbPath);
      const storedSource = reopened.prepare(`SELECT r.source AS legacySource, s.source
        FROM script_runs r LEFT JOIN script_run_sources s ON s.hash = r.sourceHash
        WHERE r.id = 'legacy'`);
      try {
        expect(storedSource.get()).toEqual({ legacySource: "", source });
      } finally {
        storedSource.finalize();
        reopened.close(true);
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 2 + 5_000,
  );
});

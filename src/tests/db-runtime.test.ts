import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as facade from "../be/db";
import * as runtime from "../be/db/runtime";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const runtimeExports = [
  "__resetSqliteVecExtensionPathCacheForTests",
  "closeDb",
  "getDb",
  "getDbClient",
  "initDb",
  "isSqliteVecAvailable",
  "resolveSqliteVecExtensionPath",
] as const;

afterEach(() => runtime.closeDb());

describe("database runtime facade", () => {
  test("re-exports the same seven runtime bindings", () => {
    expect(Object.keys(runtime).sort()).toEqual([...runtimeExports].sort());
    expect(facade.__resetSqliteVecExtensionPathCacheForTests).toBe(
      runtime.__resetSqliteVecExtensionPathCacheForTests,
    );
    expect(facade.closeDb).toBe(runtime.closeDb);
    expect(facade.getDb).toBe(runtime.getDb);
    expect(facade.getDbClient).toBe(runtime.getDbClient);
    expect(facade.initDb).toBe(runtime.initDb);
    expect(facade.isSqliteVecAvailable).toBe(runtime.isSqliteVecAvailable);
    expect(facade.resolveSqliteVecExtensionPath).toBe(runtime.resolveSqliteVecExtensionPath);
  });

  test("shares one connection and reuses the async client across close/reopen", async () => {
    const first = runtime.initDb(":memory:");
    expect(facade.getDb()).toBe(first);
    expect(facade.initDb(":memory:")).toBe(first);
    const client = facade.getDbClient();
    expect(runtime.getDbClient()).toBe(client);
    await client.run("CREATE TABLE runtime_probe (value TEXT)");
    await client.run("INSERT INTO runtime_probe VALUES (?)", ["first"]);
    expect(await client.get("SELECT value FROM runtime_probe")).toEqual({ value: "first" });

    facade.closeDb();
    expect(runtime.isSqliteVecAvailable()).toBe(false);
    runtime.closeDb();
    const second = facade.initDb(":memory:");
    expect(second).not.toBe(first);
    expect(runtime.getDb()).toBe(second);
    expect(runtime.getDbClient()).toBe(client);
    expect(
      await client.get("SELECT name FROM sqlite_master WHERE name = 'runtime_probe'"),
    ).toBeNull();
    await client.run("CREATE TABLE runtime_probe (value TEXT)");
    await client.run("INSERT INTO runtime_probe VALUES (?)", ["second"]);
    expect(await client.get("SELECT value FROM runtime_probe")).toEqual({ value: "second" });
  });

  test("cold initialization still seeds templates", () => {
    const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
    const template = globals.__testMigrationTemplate;
    runtime.closeDb();
    globals.__testMigrationTemplate = undefined;
    try {
      runtime.initDb(":memory:");
      const templates = facade.getPromptTemplates({ scope: "global" });
      expect(templates.length).toBeGreaterThan(0);
    } finally {
      runtime.closeDb();
      globals.__testMigrationTemplate = template;
    }
  });

  // rbac-admission-e2e restarted its server on an existing DB and the server
  // died with "Encryption key not resolved yet": boot hit SQLITE_BUSY before
  // resolving the key, and the db-client's BUSY retry reused the half-booted
  // handle instead of booting again. Child processes boot cold (no test
  // template) and leave no in-process connection blocking the lock below.
  test(
    "a cold boot that hits SQLITE_BUSY boots again before serving queries",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "db-runtime-busy-"));
      const dbPath = join(dir, "boot.sqlite");
      const child = (source: string) =>
        runChild([process.execPath, "--eval", source], {
          cwd: new URL("../../", import.meta.url).pathname,
          env: { ...process.env, DATABASE_PATH: dbPath, AGENT_SWARM_TELEMETRY_DISABLED: "1" },
        });
      try {
        expectChildOk(
          await child(`
            const db = await import("./src/be/db");
            db.initDb(process.env.DATABASE_PATH);
            await db.upsertSwarmConfig({ scope: "global", key: "BOOT_BUSY_SECRET", value: "boot-busy-value", isSecret: true });
            db.closeDb();
          `),
          "seed",
        );

        const holder = new Database(dbPath);
        holder.run("PRAGMA locking_mode = EXCLUSIVE");
        holder.run("BEGIN EXCLUSIVE");
        let released = false;
        const releaseLock = () => {
          if (released) return;
          released = true;
          holder.run("COMMIT");
          holder.close();
        };
        const release = setTimeout(releaseLock, 500);
        try {
          const read = await child(`
            const db = await import("./src/be/db");
            const configs = await db.getInjectableGlobalConfigs();
            console.log("VALUE=" + configs.find((c) => c.key === "BOOT_BUSY_SECRET")?.value);
          `);
          expect(read.stderr).not.toContain("Encryption key not resolved yet");
          expect(read.stdout).toContain("VALUE=boot-busy-value");
        } finally {
          clearTimeout(release);
          releaseLock();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 2,
  );
});

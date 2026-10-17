import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";

const MIGRATION = "src/be/migrations/223_swarm_config_exposure.sql";

test("migration 223 keeps existing swarm_config rows and reads them as NULL exposure", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE swarm_config (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
      scopeId TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      isSecret INTEGER NOT NULL DEFAULT 0,
      envPath TEXT,
      description TEXT,
      createdAt TEXT NOT NULL,
      lastUpdatedAt TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope, scopeId, key)
    )`);
    db.run(
      "INSERT INTO swarm_config (id, scope, key, value, isSecret, createdAt, lastUpdatedAt) VALUES ('existing', 'global', 'SOME_KEY', 'v', 0, 'now', 'now')",
    );
    db.exec(await Bun.file(MIGRATION).text());

    expect(db.query("SELECT id, key, exposure FROM swarm_config").all()).toEqual([
      { id: "existing", key: "SOME_KEY", exposure: null },
    ]);
    for (const exposure of ["worker", "lead", "api"]) {
      db.run("UPDATE swarm_config SET exposure = ? WHERE id = 'existing'", [exposure]);
    }
    expect(() =>
      db.run("UPDATE swarm_config SET exposure = 'bogus' WHERE id = 'existing'"),
    ).toThrow(/CHECK constraint failed/);
    db.run("UPDATE swarm_config SET exposure = NULL WHERE id = 'existing'");
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});

test("a fresh database has the exposure column with its CHECK", async () => {
  const path = `./test-migration-223-${crypto.randomUUID()}.sqlite`;
  initDb(path);
  try {
    const columns = getDb()
      .query<{ name: string }, []>("PRAGMA table_info(swarm_config)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("exposure");
    expect(() =>
      getDb().run(
        "INSERT INTO swarm_config (id, scope, key, value, createdAt, lastUpdatedAt, exposure) VALUES ('x', 'global', 'K', 'v', 'now', 'now', 'bogus')",
      ),
    ).toThrow(/CHECK constraint failed/);
  } finally {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) await unlink(path + suffix).catch(() => {});
  }
});

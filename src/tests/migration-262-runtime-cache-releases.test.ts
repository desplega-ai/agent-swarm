import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

test("migration 262 adds audited cache releases to a fresh database", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    const columns = db.query("PRAGMA table_info(runtime_cache_releases)").all();
    for (const name of ["runtime_ids", "state", "created_by", "updated_by"])
      expect(columns).toContainEqual(expect.objectContaining({ name, type: "TEXT" }));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("migration 262 preserves configured caches and cleanup survives pool deletion", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    for (const file of [...new Bun.Glob("*.sql").scanSync("src/be/migrations")]
      .sort()
      .filter((file) => Number(file.split("_")[0]) <= 260)) {
      const sql = await Bun.file(`src/be/migrations/${file}`).text();
      db.transaction(() => {
        db.exec(sql);
        db.run("INSERT INTO _migrations VALUES (?, ?, ?, ?)", [
          Number(file.split("_")[0]),
          file.replace(".sql", ""),
          new Date().toISOString(),
          new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
        ]);
      }).immediate();
    }
    db.run(
      "INSERT INTO runtime_controllers (id, name, kind, placement) VALUES ('controller', 'docker', 'docker', 'builtin')",
    );
    db.run(
      `INSERT INTO runtime_pools (id, name, kind, placements, image, lifecycle, cache)
       VALUES ('pool', 'cached', 'docker', '["controller"]', 'worker:test', 'idle', '{"mountPath":"/cache"}')`,
    );
    runMigrations(db);
    expect(db.query("SELECT cache FROM runtime_pools WHERE id = 'pool'").get()).toEqual({
      cache: '{"mountPath":"/cache"}',
    });
    db.run(
      `INSERT INTO runtime_cache_releases (id, pool_id, controller_id, owner_id, cache_key, runtime_ids)
       VALUES ('job', 'pool', 'controller', 'owner', 'swarm-cache-pool', '[]')`,
    );
    db.run("DELETE FROM runtime_pools WHERE id = 'pool'");
    expect(db.query("SELECT state FROM runtime_cache_releases").get()).toEqual({
      state: "pending",
    });
    expect(() => db.run("DELETE FROM runtime_controllers WHERE id = 'controller'")).toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

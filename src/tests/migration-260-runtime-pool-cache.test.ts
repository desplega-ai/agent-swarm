import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";
import {
  ControllerClientMessageSchema,
  ControllerCommandSchema,
} from "../runtime-providers/controller-protocol";

test("migration 260 adds an optional JSON cache and the release table to a fresh database", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    expect(db.query("PRAGMA table_info(runtime_pools)").all()).toContainEqual(
      expect.objectContaining({ name: "cache", type: "TEXT", notnull: 0 }),
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const name of ["runtime_ids", "state", "created_by", "updated_by"])
      expect(db.query("PRAGMA table_info(runtime_cache_releases)").all()).toContainEqual(
        expect.objectContaining({ name, type: "TEXT" }),
      );
  } finally {
    db.close();
  }
});

test("migration 260 preserves existing pools with caching disabled", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    for (const file of [...new Bun.Glob("*.sql").scanSync("src/be/migrations")]
      .sort()
      .filter((file) => Number(file.split("_")[0]) <= 259)) {
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
      "INSERT INTO runtime_pools (id, name, kind, placements, image, resources, env, lifecycle) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')",
      [
        "existing-pool",
        "existing",
        "docker",
        '["controller"]',
        "worker:test",
        '{"cpu":2}',
        '{"CUSTOM":"kept"}',
      ],
    );
    runMigrations(db);
    expect(db.query("SELECT name, image, resources, env, cache FROM runtime_pools").get()).toEqual({
      name: "existing",
      image: "worker:test",
      resources: '{"cpu":2}',
      env: '{"CUSTOM":"kept"}',
      cache: null,
    });
    expect(() => db.run("UPDATE runtime_pools SET cache = 'invalid json'")).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM runtime_cache_releases").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("cache release runtime IDs accept arrays and reject other JSON values", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    db.run(
      "INSERT INTO runtime_controllers (id, name, kind, placement) VALUES ('controller', 'controller', 'docker', 'builtin')",
    );
    db.run(`INSERT INTO runtime_cache_releases (id, pool_id, controller_id, owner_id, cache_key, runtime_ids)
      VALUES ('release', 'pool', 'controller', 'owner', 'cache', '[]')`);
    for (const invalid of ["null", "{}", "42", "true", '"runtime"', "invalid json"])
      expect(() =>
        db.run("UPDATE runtime_cache_releases SET runtime_ids = ?", [invalid]),
      ).toThrow();
    db.run("UPDATE runtime_cache_releases SET runtime_ids = ?", ['["runtime-a","runtime-b"]']);
    expect(db.query("SELECT runtime_ids FROM runtime_cache_releases").get()).toEqual({
      runtime_ids: '["runtime-a","runtime-b"]',
    });
  } finally {
    db.close();
  }
});

test("controller protocol accepts legacy hello messages and retains optional cache metadata", () => {
  const legacy = ControllerClientMessageSchema.parse({
    type: "hello",
    controllerId: "controller",
    kind: "docker",
    version: 1,
    traits: { canProvision: true, ephemeralDisk: true, supportsPause: false },
  });
  if (legacy.type !== "hello") throw new Error("Expected hello");
  expect(legacy.traits.persistentCache).toBeUndefined();
  const payload = {
    runtimeId: "runtime",
    agentId: "agent",
    poolId: "pool",
    ownerId: "owner",
    image: "worker:test",
    env: {},
    labels: {},
    cache: { key: "swarm-cache-pool", mountPath: "/cache" },
  };
  expect(
    ControllerCommandSchema.parse({ type: "cmd", id: "command", op: "provision", payload }),
  ).toMatchObject({ payload: { cache: payload.cache } });
});

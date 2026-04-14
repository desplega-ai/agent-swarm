import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";

// Phase 3 of the swarm-config encryption plan adds an `encrypted` column to
// the `swarm_config` table via migration 038. This test uses a file-backed DB
// so the migration runner actually executes — the in-memory template fast path
// bypasses migrations and wouldn't exercise the schema change.

const TEST_DB_PATH = "./test-swarm-config-schema.sqlite";

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

async function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore — file may not exist
    }
  }
}

describe("swarm_config.encrypted column (migration 038)", () => {
  beforeAll(async () => {
    await cleanupDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await cleanupDb();
  });

  test("PRAGMA table_info includes encrypted column with default 0", () => {
    const cols = getDb().prepare<TableInfoRow, []>("PRAGMA table_info(swarm_config)").all();

    const encrypted = cols.find((c) => c.name === "encrypted");
    expect(encrypted).toBeDefined();
    expect(encrypted?.type.toUpperCase()).toBe("INTEGER");
    expect(encrypted?.notnull).toBe(1);
    // SQLite stores ALTER TABLE defaults as text literals, so "0" (not 0).
    expect(encrypted?.dflt_value).toBe("0");
  });

  test("legacy rows inserted without encrypted column get encrypted=0", () => {
    // Simulate a legacy row written before the encryption feature existed.
    // We insert without referencing the `encrypted` column so the column's
    // DEFAULT 0 kicks in, matching how ALTER TABLE ADD COLUMN backfills
    // pre-existing rows.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt)
       VALUES (?, ?, NULL, ?, ?, 0, NULL, NULL, ?, ?)`,
      [id, "global", "LEGACY_PLAINTEXT_KEY", "legacy-value", now, now],
    );

    const rawRow = getDb()
      .prepare<{ encrypted: number }, [string]>("SELECT encrypted FROM swarm_config WHERE id = ?")
      .get(id);
    expect(rawRow?.encrypted).toBe(0);

    // And getSwarmConfigs() exposes it as the boolean false on the domain type.
    const all = getSwarmConfigs();
    const mapped = all.find((c) => c.id === id);
    expect(mapped).toBeDefined();
    expect(mapped?.encrypted).toBe(false);
    expect(mapped?.isSecret).toBe(false);
  });

  test("upsertSwarmConfig (non-secret) returns encrypted=false", () => {
    const config = upsertSwarmConfig({
      scope: "global",
      key: "PHASE3_NON_SECRET",
      value: "hello",
      isSecret: false,
    });
    expect(config.encrypted).toBe(false);
    expect(config.isSecret).toBe(false);
    expect(config.value).toBe("hello");

    // Confirm the raw row also reflects encrypted=0 (no write-path wiring
    // exists yet in Phase 3, so the column should fall through to default).
    const raw = getDb()
      .prepare<{ encrypted: number }, [string]>("SELECT encrypted FROM swarm_config WHERE id = ?")
      .get(config.id);
    expect(raw?.encrypted).toBe(0);
  });

  test("upsertSwarmConfig (isSecret=true) encrypts at rest and round-trips plaintext", () => {
    // Phase 4: secret writes are encrypted with AES-256-GCM before hitting
    // SQLite. The returned config object still carries plaintext (thanks to
    // rowToSwarmConfig's transparent decrypt), but the raw row holds
    // ciphertext and `encrypted = 1`.
    const config = upsertSwarmConfig({
      scope: "global",
      key: "PHASE4_SECRET",
      value: "super-secret",
      isSecret: true,
    });
    expect(config.isSecret).toBe(true);
    expect(config.encrypted).toBe(true);
    expect(config.value).toBe("super-secret");

    const raw = getDb()
      .prepare<{ encrypted: number; value: string }, [string]>(
        "SELECT encrypted, value FROM swarm_config WHERE id = ?",
      )
      .get(config.id);
    expect(raw?.encrypted).toBe(1);
    // Raw stored value must not equal plaintext — it's base64-encoded
    // iv || ciphertext || authTag.
    expect(raw?.value).not.toBe("super-secret");
    expect(raw?.value.length ?? 0).toBeGreaterThan(0);
  });

  test("migration 038 is recorded in _migrations exactly once", () => {
    const rows = getDb()
      .prepare<{ version: number; name: string }, []>(
        "SELECT version, name FROM _migrations WHERE version = 38",
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("038_encrypted_secrets");
  });
});

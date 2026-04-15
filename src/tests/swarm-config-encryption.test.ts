import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetEncryptionKeyForTests, resolveEncryptionKey } from "../be/crypto";
import {
  autoEncryptLegacyPlaintextSecrets,
  closeDb,
  deleteSwarmConfig,
  getDb,
  getResolvedConfig,
  getSwarmConfigById,
  initDb,
  maskSecrets,
  upsertSwarmConfig,
} from "../be/db";

// Fixture keys. The default fixture key is set in src/tests/preload.ts so the
// template fast-path works. Tests that need raw SQL tampering use a file-backed
// DB to bypass the template — migration-run path is exercised there instead.
const FIXTURE_KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ALT_KEY_B64 = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=";

const FILE_DB_PATH = "./test-swarm-config-encryption.sqlite";

const testTemplateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedTemplate?: Uint8Array;
};

async function cleanupFileDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${path}${suffix}`);
    } catch {
      // ignore
    }
  }
}

/** Unique keys keep each test independent when they share the template DB. */
let testCounter = 0;
function uniqueKey(prefix: string): string {
  testCounter += 1;
  return `${prefix}_${testCounter}_${Date.now()}`;
}

describe("swarm_config encryption (Phase 4) — template fast-path", () => {
  beforeAll(() => {
    // Ensure the fixture key is available (preload.ts already set it, but
    // tests may run in any order and cache state may have been cleared).
    if (!process.env.SECRETS_ENCRYPTION_KEY) {
      process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
    }
    initDb(":memory:");
  });

  afterAll(() => {
    closeDb();
  });

  test("write path: secret upsert produces ciphertext row with encrypted=1", () => {
    const key = uniqueKey("OPENAI_API_KEY");
    const config = upsertSwarmConfig({
      scope: "global",
      key,
      value: "sk-abc-123",
      isSecret: true,
    });
    expect(config.isSecret).toBe(true);
    expect(config.encrypted).toBe(true);
    expect(config.value).toBe("sk-abc-123");

    const raw = getDb()
      .prepare<{ value: string; encrypted: number }, [string]>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
      )
      .get(config.id);
    expect(raw?.encrypted).toBe(1);
    expect(raw?.value).not.toBe("sk-abc-123");
    // Ciphertext is base64-encoded (iv || ct || tag) — min length ~40 chars.
    expect((raw?.value ?? "").length).toBeGreaterThan(20);
  });

  test("read path: getSwarmConfigById decrypts transparently", () => {
    const key = uniqueKey("ANTHROPIC_API_KEY");
    const written = upsertSwarmConfig({
      scope: "global",
      key,
      value: "claude-secret-xyz",
      isSecret: true,
    });
    const read = getSwarmConfigById(written.id);
    expect(read).not.toBeNull();
    expect(read?.value).toBe("claude-secret-xyz");
    expect(read?.encrypted).toBe(true);
  });

  test("non-secret path: value unchanged and encrypted=0", () => {
    const key = uniqueKey("MODEL");
    const config = upsertSwarmConfig({
      scope: "global",
      key,
      value: "gpt-4o",
      isSecret: false,
    });
    const raw = getDb()
      .prepare<{ value: string; encrypted: number }, [string]>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
      )
      .get(config.id);
    expect(raw?.encrypted).toBe(0);
    expect(raw?.value).toBe("gpt-4o");
    expect(config.value).toBe("gpt-4o");
    expect(config.encrypted).toBe(false);
  });

  test("roundtrip via getResolvedConfig", () => {
    const key = uniqueKey("RESOLVED_SECRET");
    upsertSwarmConfig({ scope: "global", key, value: "resolved-plaintext", isSecret: true });
    const resolved = getResolvedConfig();
    const found = resolved.find((c) => c.key === key);
    expect(found).toBeDefined();
    expect(found?.value).toBe("resolved-plaintext");
    expect(found?.encrypted).toBe(true);
  });

  test("maskSecrets still masks after decryption", () => {
    const key = uniqueKey("MASKED_SECRET");
    const config = upsertSwarmConfig({
      scope: "global",
      key,
      value: "should-be-hidden",
      isSecret: true,
    });
    const masked = maskSecrets([config])[0];
    expect(masked?.value).toBe("********");
  });

  test("update path: non-secret -> secret re-encrypts stored value", () => {
    const key = uniqueKey("UPGRADED_SECRET");
    const initial = upsertSwarmConfig({
      scope: "global",
      key,
      value: "plain-value",
      isSecret: false,
    });
    let raw = getDb()
      .prepare<{ value: string; encrypted: number }, [string]>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
      )
      .get(initial.id);
    expect(raw?.value).toBe("plain-value");
    expect(raw?.encrypted).toBe(0);

    const upgraded = upsertSwarmConfig({
      scope: "global",
      key,
      value: "now-secret",
      isSecret: true,
    });
    expect(upgraded.id).toBe(initial.id);
    expect(upgraded.value).toBe("now-secret");
    expect(upgraded.encrypted).toBe(true);

    raw = getDb()
      .prepare<{ value: string; encrypted: number }, [string]>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
      )
      .get(initial.id);
    expect(raw?.encrypted).toBe(1);
    expect(raw?.value).not.toBe("now-secret");
  });

  test("writeEnvFile writes plaintext to disk, not ciphertext", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "swarm-config-encryption-"));
    const envPath = join(tmpDir, "test.env");
    try {
      const key = uniqueKey("ENV_FILE_SECRET");
      upsertSwarmConfig({
        scope: "global",
        key,
        value: "env-file-plaintext",
        isSecret: true,
        envPath,
      });
      const content = readFileSync(envPath, "utf8");
      expect(content).toContain(`${key}=env-file-plaintext`);
      // Precisely verify the line holds plaintext, not base64 ciphertext.
      const line = content.split("\n").find((l) => l.startsWith(`${key}=`));
      expect(line).toBe(`${key}=env-file-plaintext`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadGlobalConfigsIntoEnv-style roundtrip injects plaintext into process.env", () => {
    const key = uniqueKey("ENV_INJECT_SECRET");
    upsertSwarmConfig({
      scope: "global",
      key,
      value: "env-inject-plaintext",
      isSecret: true,
    });
    // Mirror of loadGlobalConfigsIntoEnv in src/http/core.ts
    const resolved = getResolvedConfig();
    for (const c of resolved) {
      if (c.key === key) {
        process.env[c.key] = c.value;
      }
    }
    expect(process.env[key]).toBe("env-inject-plaintext");
    delete process.env[key];
  });
});

describe("swarm_config encryption (Phase 4) — raw SQL tampering", () => {
  beforeAll(async () => {
    await cleanupFileDb(FILE_DB_PATH);
    // Save and clear the template so file-backed initDb runs real migrations.
    // The fixture key in process.env is still in use.
    __resetEncryptionKeyForTests();
    process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
    // Temporarily hide the template so the main-path initDb runs.
    testTemplateGlobals.__savedTemplate = testTemplateGlobals.__testMigrationTemplate;
    testTemplateGlobals.__testMigrationTemplate = undefined;
    initDb(FILE_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    // Restore template for any subsequent test suites.
    testTemplateGlobals.__testMigrationTemplate = testTemplateGlobals.__savedTemplate;
    delete testTemplateGlobals.__savedTemplate;
    // Re-resolve fixture key into cache for any subsequent suites.
    __resetEncryptionKeyForTests();
    process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
    await cleanupFileDb(FILE_DB_PATH);
  });

  test("auto-migrate: legacy plaintext secret is encrypted on next boot", () => {
    // Insert a row that looks like pre-encryption legacy data.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
       VALUES (?, 'global', NULL, 'LEGACY_PLAINTEXT_SECRET', 'legacy-plain', 1, NULL, NULL, ?, ?, 0)`,
      [id, now, now],
    );

    // Sanity: row is plaintext right now.
    const preRow = getDb()
      .prepare<{ value: string; encrypted: number }, [string]>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
      )
      .get(id);
    expect(preRow?.value).toBe("legacy-plain");
    expect(preRow?.encrypted).toBe(0);

    // Run the auto-migrate hook directly (simulates the second boot).
    autoEncryptLegacyPlaintextSecrets(getDb());

    const postRow = getDb()
      .prepare<{ value: string; encrypted: number }, [string]>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
      )
      .get(id);
    expect(postRow?.encrypted).toBe(1);
    expect(postRow?.value).not.toBe("legacy-plain");

    // Transparent decrypt returns the original plaintext.
    const decrypted = getSwarmConfigById(id);
    expect(decrypted?.value).toBe("legacy-plain");
  });

  test("auto-migrate is idempotent (no-op on already-encrypted rows)", () => {
    // Run again — should not throw, no rows to encrypt.
    autoEncryptLegacyPlaintextSecrets(getDb());
    const rowsStillPlain = getDb()
      .prepare<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM swarm_config WHERE isSecret = 1 AND encrypted = 0",
      )
      .get();
    expect(rowsStillPlain?.c).toBe(0);
  });

  test("tamper: corrupting a ciphertext byte produces a clear, key-named error", () => {
    const config = upsertSwarmConfig({
      scope: "global",
      key: "TAMPER_TARGET",
      value: "tamper-plaintext",
      isSecret: true,
    });

    // Mangle one character in the stored ciphertext by flipping a base64 char.
    const raw = getDb()
      .prepare<{ value: string }, [string]>("SELECT value FROM swarm_config WHERE id = ?")
      .get(config.id);
    expect(raw).not.toBeNull();
    const original = raw?.value ?? "";
    // Flip the char at position 10 to guarantee auth-tag verification failure.
    const flipped = original.slice(0, 10) + (original[10] === "A" ? "B" : "A") + original.slice(11);
    getDb().run("UPDATE swarm_config SET value = ? WHERE id = ?", [flipped, config.id]);

    expect(() => getSwarmConfigById(config.id)).toThrow(/Failed to decrypt config 'TAMPER_TARGET'/);

    // Clean up so subsequent tests don't trip over this row.
    deleteSwarmConfig(config.id);
  });

  test("wrong key: rotating key without re-encryption produces clear error on read", () => {
    // Encrypt with the fixture key.
    const config = upsertSwarmConfig({
      scope: "global",
      key: "ROTATED_KEY_TEST",
      value: "rotated-plaintext",
      isSecret: true,
    });
    expect(getSwarmConfigById(config.id)?.value).toBe("rotated-plaintext");

    // Rotate: reset cache, swap env var to a different valid 32-byte key,
    // and re-resolve. The DB path is irrelevant here because the env var wins.
    __resetEncryptionKeyForTests();
    const prevKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = ALT_KEY_B64;
    resolveEncryptionKey(FILE_DB_PATH);

    try {
      expect(() => getSwarmConfigById(config.id)).toThrow(
        /Failed to decrypt config 'ROTATED_KEY_TEST'/,
      );
    } finally {
      // Restore fixture key for remaining tests in this suite.
      __resetEncryptionKeyForTests();
      process.env.SECRETS_ENCRYPTION_KEY = prevKey ?? FIXTURE_KEY_B64;
      resolveEncryptionKey(FILE_DB_PATH);

      // Clean up the now-unreadable row so it doesn't pollute further tests.
      getDb().run("DELETE FROM swarm_config WHERE id = ?", [config.id]);
    }
  });

  test("initDb refuses to auto-generate a new key for an existing DB that already has encrypted secret rows", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "swarm-config-existing-secrets-"));
    const dbPath = join(tmpDir, "existing.sqlite");
    const keyFilePath = join(tmpDir, ".encryption-key");

    try {
      closeDb();
      __resetEncryptionKeyForTests();
      process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
      initDb(dbPath);

      upsertSwarmConfig({
        scope: "global",
        key: "EXISTING_SECRET_BEFORE_RESTART",
        value: "should-require-original-key",
        isSecret: true,
      });

      closeDb();
      __resetEncryptionKeyForTests();
      delete process.env.SECRETS_ENCRYPTION_KEY;
      delete process.env.SECRETS_ENCRYPTION_KEY_FILE;

      expect(() => initDb(dbPath)).toThrow(/existing database with encrypted secret rows/i);
      expect(existsSync(keyFilePath)).toBe(false);
    } finally {
      closeDb();
      __resetEncryptionKeyForTests();
      process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("initDb auto-generates a key and migrates legacy plaintext secret rows on first upgrade boot", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "swarm-config-legacy-plaintext-"));
    const dbPath = join(tmpDir, "legacy.sqlite");
    const keyFilePath = join(tmpDir, ".encryption-key");

    try {
      closeDb();
      __resetEncryptionKeyForTests();
      process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
      initDb(dbPath);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      getDb().run(
        `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
         VALUES (?, 'global', NULL, 'LEGACY_SECRET_FIRST_UPGRADE', 'legacy-plain', 1, NULL, NULL, ?, ?, 0)`,
        [id, now, now],
      );

      closeDb();
      __resetEncryptionKeyForTests();
      delete process.env.SECRETS_ENCRYPTION_KEY;
      delete process.env.SECRETS_ENCRYPTION_KEY_FILE;

      initDb(dbPath);

      expect(existsSync(keyFilePath)).toBe(true);
      const migrated = getDb()
        .prepare<{ value: string; encrypted: number }, [string]>(
          "SELECT value, encrypted FROM swarm_config WHERE id = ?",
        )
        .get(id);
      expect(migrated?.encrypted).toBe(1);
      expect(migrated?.value).not.toBe("legacy-plain");
      expect(getSwarmConfigById(id)?.value).toBe("legacy-plain");
    } finally {
      closeDb();
      __resetEncryptionKeyForTests();
      process.env.SECRETS_ENCRYPTION_KEY = FIXTURE_KEY_B64;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

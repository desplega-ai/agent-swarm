#!/usr/bin/env bun
/**
 * Fresh-DB end-to-end check for Phase 4 encryption:
 *   1. Delete any prior test DB + key file
 *   2. Unset SECRETS_ENCRYPTION_KEY so the key must be auto-generated on disk
 *   3. initDb() → writes a new .encryption-key file
 *   4. upsertSwarmConfig with isSecret=true
 *   5. Read row back, verify plaintext roundtrip and encrypted=1 in raw column
 *   6. Clean up
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb, getSwarmConfigById, initDb, upsertSwarmConfig } from "../src/be/db";

const DB_PATH = "./test-fresh-encryption.sqlite";
const KEY_PATH = join(".", ".encryption-key");

function cleanupFiles() {
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, KEY_PATH]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch (err) {
        console.warn(`[warn] could not remove ${p}: ${(err as Error).message}`);
      }
    }
  }
}

cleanupFiles();
delete process.env.SECRETS_ENCRYPTION_KEY;
delete process.env.SECRETS_ENCRYPTION_KEY_FILE;
// The harness template is not set when running this script directly.

initDb(DB_PATH);
console.log(`[test] Initialized fresh DB at ${DB_PATH}`);

if (!existsSync(KEY_PATH)) {
  console.error(`[test] FAIL: expected ${KEY_PATH} to be auto-generated but it is missing`);
  closeDb();
  cleanupFiles();
  process.exit(1);
}
console.log(`[test] OK: ${KEY_PATH} auto-generated`);

const config = upsertSwarmConfig({
  scope: "global",
  key: "FRESH_SECRET_TEST",
  value: "hello-plaintext",
  isSecret: true,
});
console.log(`[test] Upserted secret config id=${config.id}`);

const rawRow = getDb()
  .prepare<{ value: string; encrypted: number }, [string]>(
    "SELECT value, encrypted FROM swarm_config WHERE id = ?",
  )
  .get(config.id);

if (!rawRow || rawRow.encrypted !== 1) {
  console.error(`[test] FAIL: expected encrypted=1, got ${rawRow?.encrypted}`);
  closeDb();
  cleanupFiles();
  process.exit(1);
}
if (rawRow.value === "hello-plaintext") {
  console.error(`[test] FAIL: raw row value is plaintext, not ciphertext`);
  closeDb();
  cleanupFiles();
  process.exit(1);
}
console.log(`[test] OK: raw value is ciphertext (${rawRow.value.slice(0, 16)}...), encrypted=1`);

const readBack = getSwarmConfigById(config.id);
if (readBack?.value !== "hello-plaintext") {
  console.error(`[test] FAIL: read-back plaintext mismatch, got ${readBack?.value}`);
  closeDb();
  cleanupFiles();
  process.exit(1);
}
console.log(`[test] OK: roundtrip plaintext = '${readBack.value}'`);

closeDb();
cleanupFiles();
console.log("[test] PASS: fresh-DB encryption roundtrip works end-to-end");

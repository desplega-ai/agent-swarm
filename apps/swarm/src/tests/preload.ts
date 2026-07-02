import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { closeDb, getDb, initDb } from "../be/db";

// macOS ships a system libsqlite3 compiled WITHOUT dynamic extension loading, so
// `require("sqlite-vec").load(db)` throws and the hybrid-search vector arm is
// silently disabled — the memory-hybrid tests then see retrievalSource "fts"
// instead of "hybrid" and fail. Homebrew's sqlite IS built with extension
// support, so point bun:sqlite at it before the first Database opens
// (setCustomSQLite must run exactly once, before any connection). Guarded to
// darwin + file-exists, so this is a no-op on Linux CI and on machines without
// Homebrew sqlite (which keep the existing in-memory-cosine fallback behavior).
if (process.platform === "darwin") {
  for (const candidate of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ]) {
    if (existsSync(candidate)) {
      try {
        Database.setCustomSQLite(candidate);
      } catch {
        // Already loaded or unavailable — fall back to in-memory cosine.
      }
      break;
    }
  }
}

const testTemplateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};

// Prevent tests from making real network calls to LLM providers.
// The RawLlmExecutor tests already handle both success and failure paths,
// so removing the key just forces the fast failure path (~0ms vs ~2s of API calls).
delete process.env.OPENROUTER_API_KEY;

// Fixed fixture key for deterministic test runs (32 bytes of 0x00, base64-encoded).
// Never used in production — the key bootstrap's `:memory:` special case requires
// an explicit env-var key, so we set one here before initDb runs. Individual tests
// may swap this out via __resetEncryptionKeyForTests + env mutation.
process.env.SECRETS_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// Build one fully-migrated AND fully-seeded SQLite template per worker.
// initDb runs all migrations, ensureAgentProfileColumns, seedContextVersions,
// seedDefaultTemplates, etc. We serialize the result so each test suite can
// restore from it instantly — no per-suite migration or seeding work at all.
initDb(":memory:");
testTemplateGlobals.__testMigrationTemplate = getDb().serialize();
closeDb();

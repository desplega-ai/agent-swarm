import { closeDb, getDb, initDb } from "../be/db";

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

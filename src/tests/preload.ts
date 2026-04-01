import { closeDb, getDb, initDb } from "../be/db";

// Prevent tests from making real network calls to LLM providers.
// The RawLlmExecutor tests already handle both success and failure paths,
// so removing the key just forces the fast failure path (~0ms vs ~2s of API calls).
delete process.env.OPENROUTER_API_KEY;

// Build one fully-migrated AND fully-seeded SQLite template per worker.
// initDb runs all migrations, ensureAgentProfileColumns, seedContextVersions,
// seedDefaultTemplates, etc. We serialize the result so each test suite can
// restore from it instantly — no per-suite migration or seeding work at all.
initDb(":memory:");
(globalThis as any).__testMigrationTemplate = getDb().serialize();
closeDb();

import { closeDb, getDb, initDb } from "../be/db";

// Build one fully-migrated AND fully-seeded SQLite template per worker.
// initDb runs all migrations, ensureAgentProfileColumns, seedContextVersions,
// seedDefaultTemplates, etc. We serialize the result so each test suite can
// restore from it instantly — no per-suite migration or seeding work at all.
initDb(":memory:");
(globalThis as any).__testMigrationTemplate = getDb().serialize();
closeDb();

import { Database } from "bun:sqlite";
import { runMigrations } from "../be/migrations/runner";

// Build one fully-migrated SQLite template per worker.
// initDb checks for this global to restore from it instead of
// re-running all 31 migrations for every test suite.
const template = new Database(":memory:");
runMigrations(template);
(globalThis as any).__testMigrationTemplate = template.serialize();
template.close();

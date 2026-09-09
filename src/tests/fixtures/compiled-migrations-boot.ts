/**
 * Fixture compiled with `bun build --compile` by
 * `migration-bunfs-compat.test.ts`. Deliberately minimal: it exercises only
 * `runMigrations` against a fresh on-disk database, not the full `initDb`
 * (which also touches the sqlite-vec extension path and the encryption key —
 * unrelated compiled-binary surfaces that would make this test fragile for
 * reasons that have nothing to do with the migrations-directory bug it
 * targets).
 *
 * Prints a single JSON line to stdout, after silencing the runner's own
 * `console.log`/`console.debug`/`console.warn` progress lines (they'd
 * otherwise share stdout with our result line), so the parent test can
 * `JSON.parse` the last line without scraping logs.
 */
import { Database } from "bun:sqlite";
import { runMigrations } from "../../be/migrations/runner";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: compiled-migrations-boot <db-path>");
  process.exit(2);
}

const realLog = console.log;
console.log = () => {};
console.debug = () => {};
console.warn = () => {};

const db = new Database(dbPath, { create: true });
try {
  runMigrations(db);
  const row = db
    .prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
    )
    .get();
  realLog(JSON.stringify({ ok: true, hasAgentsTable: Boolean(row) }));
} catch (error) {
  realLog(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  db.close();
}

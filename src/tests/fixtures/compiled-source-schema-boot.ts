// Exercise the API's real database boot against a packaged migration directory.
import { closeDb, initDb } from "../../be/db";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: compiled-source-schema-boot <db-path>");

const realLog = console.log;
console.log = () => {};
console.debug = () => {};
console.warn = () => {};

try {
  initDb(dbPath);
  realLog(JSON.stringify({ ok: true }));
} catch (error) {
  realLog(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  closeDb();
}

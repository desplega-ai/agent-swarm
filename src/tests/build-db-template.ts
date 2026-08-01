import { Database } from "bun:sqlite";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Usage: bun run src/tests/build-db-template.ts <output-path>");
}

// Match preload.ts: sqlite-vec needs Homebrew SQLite on macOS, and the custom
// library must be selected before the first Database is opened.
if (process.platform === "darwin") {
  for (const candidate of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ]) {
    if (await Bun.file(candidate).exists()) {
      try {
        Database.setCustomSQLite(candidate);
      } catch {
        // Already loaded or unavailable — fall back to in-memory cosine.
      }
      break;
    }
  }
}

delete process.env.OPENROUTER_API_KEY;
process.env.SECRETS_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const { closeDb, getDb, initDb } = await import("../be/db");

try {
  initDb(":memory:");
  await Bun.write(outputPath, getDb().serialize());
} finally {
  closeDb();
}

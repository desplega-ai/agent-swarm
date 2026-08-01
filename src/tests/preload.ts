import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { closeDb, getDb, initDb } from "../be/db";

// @hono/node-server (pulled in transitively by @modelcontextprotocol/sdk's
// streamableHttp transport) replaces globalThis.Response/Request with its own
// lightweight Node-adapter classes the first time getRequestListener() runs.
// Bun.serve rejects those ("Expected a Response object, but received
// '_Response'"), so every suite that constructs a `new Response()` AFTER an
// MCP-HTTP test fails — but only under file orders where the MCP tests run
// first, which is why this bites Linux CI and not macOS (bun's test-file order
// is platform-dependent and not controllable via CLI args). Pin the natives
// back after every test.
const nativeResponse = globalThis.Response;
const nativeRequest = globalThis.Request;
afterEach(() => {
  if (globalThis.Response !== nativeResponse) {
    globalThis.Response = nativeResponse;
  }
  if (globalThis.Request !== nativeRequest) {
    globalThis.Request = nativeRequest;
  }
});

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

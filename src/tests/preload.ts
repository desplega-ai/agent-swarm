import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb } from "../be/db";
import { getAllTemplateDefinitions } from "../prompts/registry";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";

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
  clearVolatileSecretsForTesting();
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

// Build one fully-migrated AND fully-seeded SQLite template per process.
// initDb runs all migrations, ensureAgentProfileColumns, seedContextVersions,
// seedDefaultTemplates, etc. We serialize the result so each test suite can
// restore from it instantly — no per-suite migration or seeding work at all.
//
// Under `bun test --parallel` (which implies --isolate) this preload runs once
// PER TEST FILE, so the serialized template is cached on disk under $TMPDIR,
// keyed by a hash of everything that shapes it. A cache hit is a single file
// read instead of 130+ migrations plus seeding. AGENT_SWARM_TEST_TEMPLATE_CACHE=0
// bypasses the cache (no read, no write) for the run.
testTemplateGlobals.__testMigrationTemplate = loadOrBuildMigrationTemplate();
// Building the template cold runs initDb, which also sets process-wide state
// (encryption-key cache, prompt-resolver DI, sqlite-vec load, startup audit).
// A cache hit skips that, so open the template once through initDb's fast path
// to reproduce the same side effects, then close it. Tests that call
// getEncryptionKey() before their own initDb() depend on this.
initDb(":memory:");
closeDb();

function migrationTemplateCacheKey(): string {
  const hash = createHash("sha256");
  hash.update(`bun:${Bun.version}\n`);
  const inputs = [
    join(import.meta.dir, "preload.ts"),
    join(import.meta.dir, "../be/db.ts"),
    join(import.meta.dir, "../be/seed-prompt-templates.ts"),
  ];
  const migrationsDir = join(import.meta.dir, "../be/migrations");
  for (const name of readdirSync(migrationsDir).sort()) {
    inputs.push(join(migrationsDir, name));
  }
  for (const file of inputs) {
    hash.update(`${file}\n`);
    hash.update(readFileSync(file));
    hash.update("\n");
  }
  // seedDefaultTemplates bakes the prompt-template registry into the DB; the
  // registry is populated by side-effect imports (db.ts -> seed-prompt-templates),
  // so its current content is hashed directly instead of guessing source files.
  hash.update(JSON.stringify(getAllTemplateDefinitions()));
  return hash.digest("hex").slice(0, 32);
}

function loadOrBuildMigrationTemplate(): Uint8Array {
  const cacheEnabled = process.env.AGENT_SWARM_TEST_TEMPLATE_CACHE !== "0";
  const cacheDir = join(tmpdir(), "agent-swarm-test-template");
  const key = cacheEnabled ? migrationTemplateCacheKey() : null;
  const cachePath = key ? join(cacheDir, `${key}.sqlite`) : null;

  if (cachePath && existsSync(cachePath)) {
    try {
      return new Uint8Array(readFileSync(cachePath));
    } catch {
      // Partial or unreadable entry: rebuild below and overwrite it.
    }
  }

  initDb(":memory:");
  const template = getDb().serialize();
  closeDb();

  if (cachePath && key) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      // Atomic publish: parallel workers that miss at the same time each write
      // their own temp file, and rename makes the final path appear whole.
      const tmpPath = join(cacheDir, `${key}.${process.pid}.tmp`);
      writeFileSync(tmpPath, template);
      renameSync(tmpPath, cachePath);
      // Evict entries untouched for a day (other branches' keys, orphaned
      // .tmp files from killed workers). Pruning by age instead of "everything
      // but my key" lets two checkouts with different migrations share the dir.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of readdirSync(cacheDir)) {
        const entry = join(cacheDir, name);
        if (entry === cachePath) continue;
        try {
          if (statSync(entry).mtimeMs < cutoff) unlinkSync(entry);
        } catch {}
      }
    } catch {
      // Cache is an optimization only; the in-memory template is already built.
    }
  }

  return template;
}

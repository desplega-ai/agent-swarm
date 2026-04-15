---
date: 2026-04-14
author: Taras (plan drafted by Claude)
status: completed
tags: [security, encryption, swarm_config, hardening, migration]
autonomy: critical
last_updated: 2026-04-15
last_updated_by: Claude (implementation orchestrator, all 5 phases + E2E)
---

# Encrypt at-rest secrets in `swarm_config` + reject reserved keys

## Overview

Today, rows in `swarm_config` flagged `isSecret=1` (OpenAI keys, OAuth tokens, webhook secrets, MCP server env values, etc.) are stored as **plaintext** in the SQLite database at `src/be/db.ts:4485-4488`. Anyone with filesystem access to `agent-swarm-db.sqlite` can read every secret with a trivial `sqlite3` query. The only protection is:

1. The bearer-token `API_KEY` on the HTTP layer
2. `maskSecrets()` at `src/be/db.ts:4338-4340` that redacts values in API *responses* (not at rest)
3. OS file permissions on the DB file

This plan:

- **(A) Encrypts** `isSecret=1` values at rest using AES-256-GCM with a dedicated `SECRETS_ENCRYPTION_KEY` (decoupled from `API_KEY` so rotating the bearer token never destroys stored secrets).
- **(B) Hardens** the config API by refusing to create/update/delete rows whose key is `API_KEY` or `SECRETS_ENCRYPTION_KEY` — these are environment-only values and must never live in `swarm_config`.

The API surface stays identical: callers still pass and receive plaintext values through `set-config`, `get-config`, HTTP routes, and `writeEnvFile`. Encryption happens transparently inside the DB layer.

## Current State

### Schema
`src/be/migrations/001_initial.sql:246-258`:
```sql
CREATE TABLE IF NOT EXISTS swarm_config (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
    scopeId TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,              -- plaintext today
    isSecret INTEGER NOT NULL DEFAULT 0,
    envPath TEXT,
    description TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    UNIQUE(scope, scopeId, key)
);
```

### DB layer (`src/be/db.ts`)
- `SwarmConfigRow` type: `:4307-4318`
- `rowToSwarmConfig()`: `:4320-4333` — plain pass-through, no decryption
- `maskSecrets()`: `:4338-4340` — replaces value with `"********"` for display
- `writeEnvFile()`: `:4346-4380` — mirrors configs to `.env` files on disk when `envPath` is set (uses plaintext `config.value`)
- `getSwarmConfigs()` / `getSwarmConfigById()` / `getResolvedConfig()`: read sites
- `upsertSwarmConfig()`: `:4428-4505` — insert/update path, currently binds raw `data.value`
- `deleteSwarmConfig(id)`: `:4510-4513` — deletes by ID only (key not visible to caller)

### MCP tools
All in `src/tools/swarm-config/`:
- `set-config.ts:79` calls `upsertSwarmConfig()`
- `get-config.ts:58` calls `getResolvedConfig()` → already masks via `maskSecrets` unless `includeSecrets=true`
- `delete-config.ts:49` calls `deleteSwarmConfig()`
- `list-config.ts:49` calls `getSwarmConfigs()`

### HTTP routes (`src/http/config.ts`)
- `GET /api/config/resolved` — `:16-30` → `getResolvedConfig()`
- `GET /api/config/{id}` — `:32-46` → `getSwarmConfigById()`
- `GET /api/config` — `:48-62` → `getSwarmConfigs()`
- `PUT /api/config` — `:64-83` → `upsertSwarmConfig()` at `:161`
- `DELETE /api/config/{id}` — `:85-96` → `deleteSwarmConfig()` at `:181`

### Other internal callers
- `src/http/index.ts:219-225` — telemetry init writes `posthog_distinct_id`-style keys via `upsertSwarmConfig({ scope: "global", key, value })`. **Not affected by reserved-key guard** (keys don't match `API_KEY` / `SECRETS_ENCRYPTION_KEY`).
- `src/http/core.ts:27` — loads global configs at server startup via `getResolvedConfig`
- `src/http/mcp-servers.ts:170` — resolves MCP server env vars via `getResolvedConfig`
- `src/http/index.ts:210` — `loadGlobalConfigsIntoEnv(false)` reads configs and injects into `process.env`

### Test pattern
`src/tests/preload.ts:1-14`:
```typescript
delete process.env.OPENROUTER_API_KEY;
initDb(":memory:");
(globalThis as any).__testMigrationTemplate = getDb().serialize();
closeDb();
```
Tests use the fast path at `src/be/db.ts:79-85` (deserialize template, skip migrations). **The preload must be updated in Phase 4** to set a fixed `SECRETS_ENCRYPTION_KEY` before `initDb(":memory:")`.

### Init sequence (`src/be/db.ts:71-108`)
1. `initDb(dbPath)` opens the SQLite DB
2. `PRAGMA journal_mode = WAL`
3. Load `sqlite-vec` extension
4. `runMigrations(database)` at `:108`
5. `ensureAgentProfileColumns(database)` at `:111`
6. Various legacy compatibility guards

The auto-encrypt-on-boot hook goes **after step 6**, immediately before `initDb` returns.

### Highest migration
`src/be/migrations/037_swarm_version.sql`. New migration number: `038`.

### Current version
`package.json:3` → `1.66.1`. Target after Phase 5: `1.67.0` (minor bump for feature addition; backward-compatible for API consumers).

## Desired End State

- `isSecret=1` rows in `swarm_config` are stored as `base64(iv[12] || ciphertext || authTag[16])` in the `value` column
- A new `encrypted INTEGER NOT NULL DEFAULT 1` column on `swarm_config` flags whether decryption is needed on read
- The `SECRETS_ENCRYPTION_KEY` is resolved at startup from env → env file → `<data-dir>/.encryption-key` → auto-generated 32 random bytes written with mode `0600`
- On first boot after upgrade, existing plaintext `isSecret=1` rows are automatically encrypted in a transaction
- `upsertSwarmConfig`, `set-config`, `delete-config`, `PUT /api/config`, `DELETE /api/config/{id}` all refuse keys matching `API_KEY` or `SECRETS_ENCRYPTION_KEY` (case-insensitive) with a clear error
- All API surfaces continue to work with plaintext values — encryption is transparent to callers
- `writeEnvFile` continues to produce correct plaintext `.env` files
- Test suite passes with a fixed fixture key
- Version bumped to `1.67.0` with CHANGELOG entry
- Docs updated in `CLAUDE.md`, `docker-compose.example.yml`, `.env.example`, `README.md` / `CONTRIBUTING.md`

### Verification
After all phases ship, a fresh boot with no env vars and no `.encryption-key` file should:
1. Log `[secrets] Generated new encryption key at <path>. BACK THIS FILE UP. Losing it means losing all encrypted secrets.`
2. Accept a `set-config` for an `isSecret=true` key
3. Writing `sqlite3 agent-swarm-db.sqlite "SELECT value, encrypted FROM swarm_config WHERE key = '<key>'"` shows base64 ciphertext with `encrypted=1`
4. Reading back via `get-config --includeSecrets=true` returns the original plaintext
5. `set-config API_KEY=foo` returns an error with the reserved-key message

## What We're NOT Doing

- **Key rotation CLI** (`cli rotate-encryption-key`) — the schema and ciphertext format support it, but the command itself is a follow-up
- **Encrypting non-secret rows** — only `isSecret=1` rows are touched; repo URLs, model names, etc. stay plaintext and greppable
- **Encrypting other tables** — `agent_memory`, `agent_tasks`, `swarm_repos`, etc. are out of scope
- **KMS / Vault / cloud key management** — local file / env var only
- **UI changes in `new-ui/`** — plaintext flows as before, no dashboard changes needed
- **Changing `mcp_servers.envConfigKeys` indirection** — already references secrets by key name; decryption happens transparently in `getResolvedConfig`
- **Removing `API_KEY` from logs or error messages** — already audited safe (see `2026-04-14` audit notes)

## Implementation Approach

Phases are ordered so each is independently mergeable where possible:

| Phase | Depends on | Can ship alone? |
|-------|------------|-----------------|
| 1. Hardening (reserved-key guards) | — | ✅ |
| 2. Cipher helper + key bootstrap | — | ✅ (no wiring yet) |
| 3. Schema migration (add `encrypted` column) | — | ✅ (column unused) |
| 4. Wire encryption + auto-migrate on boot | 2, 3 | ❌ |
| 5. Docs + version bump | 1, 2, 3, 4 | ✅ |

---

## Phase 1: Hardening — Reject Reserved Keys

### Goal
Block any create/update/delete of `swarm_config` rows whose key is `API_KEY` or `SECRETS_ENCRYPTION_KEY` (case-insensitive match). Return a clear error at every entry point.

### Changes

1. **New helper** — `src/be/swarm-config-guard.ts`:
   ```typescript
   const RESERVED_KEYS = new Set(["API_KEY", "SECRETS_ENCRYPTION_KEY"]);

   export function isReservedConfigKey(key: string): boolean {
     return RESERVED_KEYS.has(key.toUpperCase());
   }

   export function reservedKeyError(key: string): Error {
     return new Error(
       `Key '${key}' is reserved and cannot be stored in swarm_config. ` +
       `Set it as an environment variable instead.`
     );
   }
   ```

2. **`src/be/db.ts:4428` `upsertSwarmConfig`** — guard at the top of the function, before any SQL:
   ```typescript
   if (isReservedConfigKey(data.key)) {
     throw reservedKeyError(data.key);
   }
   ```

3. **`src/be/db.ts:4510` `deleteSwarmConfig`** — SELECT the key first, then check:
   ```typescript
   const row = getDb()
     .prepare<{ key: string }, [string]>("SELECT key FROM swarm_config WHERE id = ?")
     .get(id);
   if (row && isReservedConfigKey(row.key)) {
     throw reservedKeyError(row.key);
   }
   // existing delete logic
   ```

4. **`src/http/config.ts:64-83` PUT /api/config** — check `body.key` before calling `upsertSwarmConfig`, return `400` with JSON `{ error: "..." }` on reserved key.

5. **`src/http/config.ts:85-96` DELETE /api/config/{id}** — fetch the row first (via `getSwarmConfigById`), check key, return `400` if reserved. The DB helper catches this too as defense-in-depth.

6. **`src/tools/swarm-config/set-config.ts:79`** — add an early check and return a clear error message in the MCP tool response structure (see `get-config.ts:48-55` for the error-return pattern).

7. **`src/tools/swarm-config/delete-config.ts:49`** — same: fetch row, check key, return structured error. The DB helper also catches this.

### Tests
Create `src/tests/swarm-config-reserved-keys.test.ts`:
- DB helper: `upsertSwarmConfig({ key: "API_KEY", ... })` throws with the reserved-key message
- DB helper: case variants `"api_key"`, `"Api_Key"`, `"secrets_encryption_key"` all throw
- DB helper: inserting a row, then calling `deleteSwarmConfig(id)` on a reserved-key row throws
- MCP tool: `set-config` returns `{ success: false, message: "..." }` for reserved keys
- MCP tool: `delete-config` returns `{ success: false, message: "..." }` for reserved keys
- HTTP: `PUT /api/config` with `{"key": "API_KEY", ...}` returns 400 with error JSON
- HTTP: `DELETE /api/config/{id}` on a reserved-key row returns 400
- Confirm non-reserved keys (`OPENAI_API_KEY`, `telemetry_user_id`) still work

Use the existing isolated-SQLite test pattern (see `src/tests/reload-config.test.ts`, `src/tests/model-control.test.ts`).

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] New guard tests pass: `bun test src/tests/swarm-config-reserved-keys.test.ts`
- [x] Existing config tests still pass: `bun test src/tests/reload-config.test.ts src/tests/model-control.test.ts src/tests/mcp-server-resolved-env.test.ts`
- [x] DB boundary still clean: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Start server `bun run start:http`, hit `PUT /api/config` with `{"scope":"global","key":"API_KEY","value":"x","isSecret":true}` → expect 400 JSON
- [ ] Same with `"api_key"` and `"Api_Key"` → expect 400
- [ ] Confirm `"OPENAI_API_KEY"` still works (accepted, stored)
- [ ] Confirm telemetry still initializes without errors in server logs

**Implementation Note**: Pause here for Taras to review before starting Phase 2. Commit message: `feat(swarm-config): reject reserved keys (API_KEY, SECRETS_ENCRYPTION_KEY)`.

### QA Spec (optional):
- Verify 400 responses include the exact message `"Key 'API_KEY' is reserved and cannot be stored in swarm_config. Set it as an environment variable instead."`
- Verify case-insensitive matching works across MCP, HTTP, DB layers
- Verify non-reserved config operations remain unaffected

---

## Phase 2: Cipher Helper + Key Bootstrap (No DB Integration)

### Goal
Ship a standalone, unit-tested crypto module that can encrypt/decrypt strings and bootstrap an encryption key from multiple sources. Zero integration into `swarm_config` yet — this phase only adds the building blocks.

### Changes

1. **New file** — `src/be/crypto/secrets-cipher.ts`:
   - `encryptSecret(plaintext: string, key: Buffer): string` — returns `base64(iv || ciphertext || authTag)`
   - `decryptSecret(encoded: string, key: Buffer): string` — inverse; throws on auth-tag failure
   - Uses `node:crypto` `createCipheriv("aes-256-gcm", key, iv)` / `createDecipheriv`
   - IV: `crypto.randomBytes(12)` per encryption
   - Auth tag: 16 bytes via `cipher.getAuthTag()`
   - Explicit constant `AES_KEY_BYTES = 32`, `IV_BYTES = 12`, `TAG_BYTES = 16`

2. **New file** — `src/be/crypto/key-bootstrap.ts`:
   - `resolveEncryptionKey(dbPath: string): Buffer` — called once at server init
   - Resolution order:
     1. `process.env.SECRETS_ENCRYPTION_KEY` (base64 string; must decode to exactly 32 bytes)
     2. `process.env.SECRETS_ENCRYPTION_KEY_FILE` (path to a file containing base64; must decode to exactly 32 bytes)
     3. `path.join(path.dirname(dbPath), ".encryption-key")` — read if exists, decode, validate
     4. **Auto-generate**: `crypto.randomBytes(32)`, write base64 to the file path from step 3 with `fs.writeFileSync(path, content, { flag: "wx", mode: 0o600 })` — the `wx` flag causes failure if the file already appeared between the existence check and the write (prevents TOCTOU races). If the write fails because the file now exists (another process won the race), re-read it and use its contents. Then `console.warn` with the exact text: `[secrets] Generated new encryption key at <path>. BACK THIS FILE UP. Losing it means losing all encrypted secrets.`
   - **Special case**: if `dbPath === ":memory:"` AND steps 1-2 both failed, throw with: `In-memory database requires SECRETS_ENCRYPTION_KEY or SECRETS_ENCRYPTION_KEY_FILE to be set explicitly`. (Prevents writing `.encryption-key` into repo during tests.)
   - **Malformed key at any source**: if steps 1, 2, or 3 return content that doesn't base64-decode to exactly 32 bytes, throw with `Invalid encryption key at <source>: expected 32 bytes after base64 decode, got N bytes`. Do NOT fall through to auto-generation — that would silently replace a user's broken-but-present key and destroy their data.
   - Cache the key in a module-level variable so repeated calls are cheap
   - Expose `getEncryptionKey(): Buffer` that throws if `resolveEncryptionKey` hasn't been called yet
   - Export `__resetEncryptionKeyForTests()` that clears the cached key — used by integration tests that simulate rotation, missing-key, or wrong-key scenarios

3. **New file** — `src/be/crypto/index.ts` — barrel export of the public surface (`encryptSecret`, `decryptSecret`, `resolveEncryptionKey`, `getEncryptionKey`, `isReservedConfigKey` if we move the guard here — otherwise keep it separate).

### Tests
Create `src/tests/secrets-cipher.test.ts`:
- Roundtrip: `decryptSecret(encryptSecret("hello", key), key) === "hello"`
- Roundtrip with UTF-8 multibyte chars, empty string, 1-byte string, 1MB string
- Tamper detection: flip one byte in the ciphertext → `decryptSecret` throws
- Tamper detection: flip one byte in the IV portion → throws
- Tamper detection: flip one byte in the auth tag → throws
- IV uniqueness: encrypt the same plaintext twice with the same key → different ciphertexts (proves fresh IV)
- Wrong key: encrypted with key A, decrypted with key B → throws
- Rejects invalid key lengths (31 bytes, 33 bytes, empty buffer)

Create `src/tests/key-bootstrap.test.ts`:
- Env var precedence: `SECRETS_ENCRYPTION_KEY` set → uses it, ignores file
- Env var file precedence: only `SECRETS_ENCRYPTION_KEY_FILE` set → reads file, ignores next layer
- `.encryption-key` file precedence: only file on disk → reads it
- Auto-generate: nothing set → creates file with mode `0o600`, verifies content is exactly 32 bytes base64, verifies warning logged
- Auto-generate idempotency: second call with nothing new returns same key (reads the file written first time)
- Invalid key size in env var: throws with clear error
- `:memory:` special case: no env vars → throws the in-memory error
- Each test uses a temp directory via `fs.mkdtempSync(path.join(os.tmpdir(), "swarm-crypto-"))`, cleans up in `afterEach`

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Cipher tests pass: `bun test src/tests/secrets-cipher.test.ts`
- [x] Key bootstrap tests pass: `bun test src/tests/key-bootstrap.test.ts`
- [x] Existing tests still pass: `bun test`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh` — crypto module must not import `bun:sqlite` or `src/be/db.ts`

#### Manual Verification:
- [ ] Run `bun test src/tests/secrets-cipher.test.ts --verbose` and confirm tamper detection fires with a clear `Error` (not a silent failure)
- [ ] Run `bun test src/tests/key-bootstrap.test.ts` and confirm the warning text matches spec
- [ ] Manually write a test script that calls `resolveEncryptionKey("/tmp/test.sqlite")`, confirm `.encryption-key` file is created at `/tmp/.encryption-key` with mode `0600` (`ls -la /tmp/.encryption-key`)
- [ ] Delete the file, re-run, confirm a new key is generated

**Implementation Note**: Pause here. The crypto module must be bulletproof before Phase 4 wires it into the DB. Commit message: `feat(crypto): add AES-256-GCM secrets cipher and key bootstrap`.

### QA Spec (optional):
- Manually corrupt a `.encryption-key` file (truncate to 31 bytes) and confirm startup fails with a clear error pointing at the file path
- Verify file mode is exactly `0600` on macOS and Linux (`stat -f '%A' file` vs `stat -c '%a' file`)

---

## Phase 3: Schema Migration — Add `encrypted` Column

### Goal
Add the `encrypted` column to `swarm_config` without changing any code behavior. The column accepts writes but nothing reads it yet. This ships independently so the schema change is de-risked from the code wiring.

### Changes

1. **New migration** — `src/be/migrations/038_encrypted_secrets.sql`:
   ```sql
   -- Add encryption flag to swarm_config
   -- Values with encrypted=1 are stored as base64(iv || ciphertext || authTag) AES-256-GCM
   -- Legacy plaintext rows default to encrypted=0 and will be auto-migrated on next boot
   -- (see initDb() auto-encrypt hook).

   ALTER TABLE swarm_config ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;

   -- New rows default to 0 because existing rows added by this migration are plaintext.
   -- The auto-encrypt hook in initDb() will promote isSecret=1 rows to encrypted=1.
   -- From then on, the write path sets encrypted=1 explicitly for isSecret=1 rows.
   ```

   **Note on the default**: `DEFAULT 0` (not 1) because `ALTER TABLE ADD COLUMN` applies the default to all existing rows, and those rows ARE plaintext. New writes will set `encrypted` explicitly in the INSERT after Phase 4 ships.

2. **Update `SwarmConfigRow` type** at `src/be/db.ts:4307-4318`:
   ```typescript
   type SwarmConfigRow = {
     // ... existing fields
     encrypted: number;   // SQLite boolean: 0 = plaintext, 1 = AES-256-GCM ciphertext
   };
   ```

3. **Update `rowToSwarmConfig`** to carry the field through (unused for now):
   - Add `encrypted: row.encrypted === 1` to the returned object
   - Update the `SwarmConfig` TypeScript type in `src/types.ts:529-543` to include `encrypted: boolean`

4. **Do NOT wire encryption yet.** This phase is intentionally schema-only.

5. **Verify no consumers break from the new field**: grep for `SwarmConfig` type usages across `src/`, `new-ui/`, `templates-ui/`. Widening the interface shouldn't break consumers, but any object literals that construct a `SwarmConfig` (e.g. mocked test fixtures) will need the new `encrypted` field. Fix any TS errors that appear.

### Tests
Add to an existing migration test or create `src/tests/swarm-config-schema.test.ts`. Use a **file-backed DB** (`initDb("./test-swarm-config-schema.sqlite")`) — not the template fast path — so migrations actually run for the test:
- Fresh DB: `PRAGMA table_info(swarm_config)` includes `encrypted` with default `0`
- Legacy DB simulation: delete the DB, create one with the old schema, run `initDb`, confirm column is added and all pre-existing rows have `encrypted=0`
- `getSwarmConfigs()` returns rows with `encrypted: false` for legacy data
- Inserting a row via `upsertSwarmConfig` (unchanged) still works; returned `config.encrypted === false` (because the INSERT doesn't set it, so it falls through to default `0`)

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Schema test passes: `bun test src/tests/swarm-config-schema.test.ts`
- [x] Existing config tests pass: `bun test src/tests/reload-config.test.ts src/tests/model-control.test.ts src/tests/mcp-server-resolved-env.test.ts`
- [x] Full suite passes: `bun test`
- [x] Fresh-DB boot works: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http` — verify server starts and `sqlite3 agent-swarm-db.sqlite ".schema swarm_config"` shows the new column

#### Manual Verification:
- [ ] Start server with a pre-existing DB (copy one from a working install if needed), confirm server starts without errors and the migration runs exactly once
- [ ] Query `SELECT id, key, encrypted FROM swarm_config` on both fresh and legacy DBs; all rows should show `encrypted=0`
- [ ] Stop server, restart, confirm migration is not re-applied (check `_migrations` table)

**Implementation Note**: Commit after verification. Commit message: `feat(db): add encrypted column to swarm_config (migration 038)`.

### QA Spec (optional):
- Confirm `_migrations` table records checksum for `038_encrypted_secrets.sql` after first boot
- Confirm a second boot skips re-application

---

## Phase 4: Wire Encryption into Read/Write + Auto-Migrate on Boot

### Goal
Make encryption real: `upsertSwarmConfig` encrypts on write, `rowToSwarmConfig` decrypts on read, and `initDb` auto-migrates legacy plaintext secrets after running migrations. This is the phase where the actual secret-at-rest protection starts.

### Changes

1. **Initialize the encryption key in `initDb` — TWO call sites**. The key-bootstrap must run on both the template fast-path and the main path, otherwise tests that deserialize from the template and then call `__resetEncryptionKeyForTests()` will break.

   **Site A — template fast-path** (`src/be/db.ts:79-85`), just before `return db;`:
   ```typescript
   const templateBytes = (globalThis as any).__testMigrationTemplate as Uint8Array | undefined;
   if (templateBytes) {
     db = Database.deserialize(templateBytes);
     db.run("PRAGMA foreign_keys = ON;");
     configureDbResolver(resolvePromptTemplate);
     resolveEncryptionKey(dbPath);   // ← NEW — cache may be empty if reset
     return db;
   }
   ```

   **Site B — main path** (`src/be/db.ts:87`, just after opening the DB, before `runMigrations`):
   ```typescript
   db = new Database(dbPath, { create: true });
   // ...PRAGMA, sqlite-vec...
   resolveEncryptionKey(dbPath);   // ← NEW — must run before migrations so auto-encrypt hook has a key
   runMigrations(database);
   ```

   Import at the top of `src/be/db.ts`: `import { resolveEncryptionKey, getEncryptionKey } from "./crypto/key-bootstrap";` (prefer `import` over `require` — Bun supports both but the rest of the file uses `import`).

   The key is cached in the crypto module; subsequent code calls `getEncryptionKey()`. Repeated calls to `resolveEncryptionKey` with the same `dbPath` are idempotent (cached key is returned as-is).

2. **Update `upsertSwarmConfig`** at `src/be/db.ts:4428`:
   - After the reserved-key guard (Phase 1), if `data.isSecret`, compute `storedValue = encryptSecret(data.value, getEncryptionKey())` and `encryptedFlag = 1`. Otherwise `storedValue = data.value` and `encryptedFlag = 0`.
   - Add `encrypted` to the INSERT column list and VALUES, and to the UPDATE SET clause.
   - Bind `storedValue` and `encryptedFlag` to the prepared statements.
   - **Keep `data.value` as plaintext** in the `config` object returned to the caller — `rowToSwarmConfig` will decrypt the row's stored value correctly, and downstream code (`writeEnvFile`) gets plaintext for free.

3. **Update `rowToSwarmConfig`** at `src/be/db.ts:4320-4333`:
   ```typescript
   function rowToSwarmConfig(row: SwarmConfigRow): SwarmConfig {
     const isEncrypted = row.encrypted === 1;
     const value = isEncrypted
       ? decryptSecret(row.value, getEncryptionKey())
       : row.value;
     return {
       id: row.id,
       scope: row.scope as "global" | "agent" | "repo",
       scopeId: row.scopeId ?? null,
       key: row.key,
       value,
       isSecret: row.isSecret === 1,
       encrypted: isEncrypted,
       envPath: row.envPath ?? null,
       description: row.description ?? null,
       createdAt: row.createdAt,
       lastUpdatedAt: row.lastUpdatedAt,
     };
   }
   ```
   All readers (`getSwarmConfigs`, `getSwarmConfigById`, `getResolvedConfig`, MCP tools, HTTP routes) receive decrypted plaintext transparently.

4. **Auto-migrate hook** — add a new function in `src/be/db.ts` and call it from `initDb` **after** step 6 (legacy compatibility guards), immediately before returning:
   ```typescript
   function autoEncryptLegacyPlaintextSecrets(database: Database): void {
     const rows = database
       .prepare<{ id: string; value: string }, []>(
         "SELECT id, value FROM swarm_config WHERE isSecret = 1 AND encrypted = 0"
       )
       .all();
     if (rows.length === 0) return;

     const key = getEncryptionKey();
     console.log(`[secrets] Encrypting ${rows.length} legacy plaintext secret(s)...`);

     const txn = database.transaction((items: { id: string; value: string }[]) => {
       const stmt = database.prepare<unknown, [string, string]>(
         "UPDATE swarm_config SET value = ?, encrypted = 1 WHERE id = ?"
       );
       for (const r of items) {
         stmt.run(encryptSecret(r.value, key), r.id);
       }
     });
     txn(rows);
     console.log(`[secrets] Auto-migrated ${rows.length} secret(s) to encrypted storage.`);
   }
   ```
   Called from `initDb` after all compatibility guards. Wrapped in `try/catch`; on failure, log `[secrets] FATAL: failed to auto-encrypt legacy secrets: <error>` and **`throw`** the original error (do NOT `process.exit(1)`). In production, the uncaught throw during server boot causes Node to exit with the stack trace. In tests, the thrown error surfaces as a proper assertion failure instead of killing the test process.

5. **Update `src/tests/preload.ts`** to set a fixed test key before `initDb(":memory:")`:
   ```typescript
   import { closeDb, getDb, initDb } from "../be/db";

   delete process.env.OPENROUTER_API_KEY;

   // Fixed fixture key for deterministic test runs.
   // 32 bytes, base64-encoded. Never used in production.
   process.env.SECRETS_ENCRYPTION_KEY =
     "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

   initDb(":memory:");
   (globalThis as any).__testMigrationTemplate = getDb().serialize();
   closeDb();
   ```
   This also means the template (built from `:memory:`) will work because the key bootstrap's `:memory:` special case is satisfied by the env var.

6. **Verify `SwarmConfigSchema` Zod validator** in `src/types.ts:529-543` has `encrypted: z.boolean()`. Phase 3 added it to the TypeScript interface; double-check it's on the Zod schema too, since HTTP request validation goes through Zod.

### Tests
Create `src/tests/swarm-config-encryption.test.ts`:
- **Write path**: `upsertSwarmConfig({ key: "OPENAI_API_KEY", value: "sk-abc", isSecret: true })` → read the row directly via `getDb().prepare("SELECT value, encrypted FROM swarm_config WHERE id = ?").get(config.id)` → assert `value !== "sk-abc"` (base64 ciphertext) and `encrypted === 1`
- **Read path**: after the above, `getSwarmConfigById(config.id).value === "sk-abc"` (transparent decryption)
- **Non-secret path**: `upsertSwarmConfig({ key: "MODEL", value: "gpt-4", isSecret: false })` → raw row `value === "gpt-4"`, `encrypted === 0`
- **Roundtrip via getResolvedConfig**: same assertion
- **writeEnvFile integration**: `upsertSwarmConfig({ key: "FOO", value: "bar", isSecret: true, envPath: "/tmp/test.env" })` → `/tmp/test.env` contains `FOO=bar` (plaintext), not ciphertext
- **maskSecrets still works**: `maskSecrets([config])[0].value === "********"` even after decryption
- **Update path**: insert a plaintext non-secret, then update it to `isSecret=true` with a new value → stored as ciphertext with `encrypted=1`
- **Auto-migrate**: create a fresh DB, manually INSERT a row with `isSecret=1, encrypted=0, value='plain'`, call a helper that re-runs the auto-encrypt hook, confirm the row is now `encrypted=1` and the stored value is base64. Then `getSwarmConfigById` returns `'plain'`.
- **Tamper**: after encrypting, manually corrupt one byte of the stored `value` via raw SQL, then `getSwarmConfigById` throws with a GCM auth error
- **Wrong key**: encrypt with fixture key, call `__resetEncryptionKeyForTests()`, swap `SECRETS_ENCRYPTION_KEY` to a different value, call `resolveEncryptionKey` again, confirm reads throw with the clearer error from `rowToSwarmConfig` (message includes the config key name). This simulates the "user rotated key without migration" scenario — correct behavior is a loud, specific failure.
- **loadGlobalConfigsIntoEnv round-trip**: insert an `isSecret=true` config, call `loadGlobalConfigsIntoEnv(true)` from `src/http/index.ts`, assert `process.env.<KEY>` holds the plaintext (not ciphertext). This proves the server-startup env-injection path decrypts correctly before publishing values to the environment.

All tests use the isolated-SQLite pattern from `src/tests/reload-config.test.ts`, each setting the fixture key in `beforeAll`.

### Tricky bits / gotchas
- The `getEncryptionKey` module-level cache must be resettable for tests (add a `__resetForTests()` export guarded behind `NODE_ENV === "test"` or always exported — the latter is simpler since the function just clears the cache). Tests need to swap keys.
- The auto-migrate hook must NOT run when using the `__testMigrationTemplate` fast path (it returns at `src/be/db.ts:83-85` before reaching the hook). Confirm this is fine — templates start empty of user data, so there's nothing to encrypt.
- Telemetry callback at `src/http/index.ts:219-225` might write non-secret keys; since `isSecret` defaults to `false`, they stay plaintext. Confirm by reading the telemetry lib's call site.
- `loadGlobalConfigsIntoEnv` at `src/http/index.ts:210` injects config values into `process.env`. Since `rowToSwarmConfig` returns plaintext, this continues to work unchanged. Verify via test.
- `writeEnvFile` uses `config.value` (plaintext after decryption). Verify the `.env` file contains plaintext, not base64.
- **Decrypt failure propagation**: if `decryptSecret` throws (corrupted row, wrong key, missing key file), the error bubbles through `rowToSwarmConfig` → `getSwarmConfigs` → HTTP/MCP callers. Wrap the decrypt call in `rowToSwarmConfig` with a try/catch that re-throws a clearer error: `Failed to decrypt config '<key>' (id=<id>): check SECRETS_ENCRYPTION_KEY matches the key used at encryption time`. Keep the original stack via `Error.cause`. HTTP layer translates this to 500 with the clear message in the response body; users see exactly what went wrong without exposing key material.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Encryption tests pass: `bun test src/tests/swarm-config-encryption.test.ts`
- [x] Full suite passes: `bun test`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Fresh DB + no env var: `bun run scripts/test-encryption-fresh-db.ts` → auto-generates `.encryption-key`, upserts a secret, verifies raw row ciphertext + plaintext roundtrip
- [x] Legacy plaintext auto-migrate: covered by `swarm-config-encryption.test.ts` "auto-migrate: legacy plaintext secret is encrypted on next boot" (raw SQL insert + `autoEncryptLegacyPlaintextSecrets(getDb())` + post-assert)

#### Manual Verification:
- [ ] `curl -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"scope":"global","key":"FOO_SECRET","value":"sk-live-abc123","isSecret":true}' http://localhost:3013/api/config` → 200
- [ ] `sqlite3 agent-swarm-db.sqlite "SELECT key, value, encrypted FROM swarm_config WHERE key = 'FOO_SECRET'"` → `encrypted=1`, `value` is base64 (not `sk-live-abc123`)
- [ ] `curl -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?includeSecrets=true"` → returns `sk-live-abc123` (or masked without `includeSecrets`)
- [ ] Restart the server, confirm the value is still readable (proves decryption works across process boundaries using the persisted `.encryption-key` file)
- [ ] Create a config with `envPath` set, verify the `.env` file on disk contains plaintext not ciphertext
- [ ] Delete `.encryption-key` file, restart server → confirm a NEW key is generated and existing encrypted secrets now fail to decrypt (expected, demonstrates correct key-is-required behavior). Then restore the old file and confirm they work again.

**Implementation Note**: Pause here for Taras's review. This is the riskiest phase. Commit message: `feat(swarm-config): encrypt secrets at rest with AES-256-GCM`.

### QA Spec (optional):
- Boot server, set 3 secrets, stop server, inspect `agent-swarm-db.sqlite` with sqlite3 to confirm all 3 are ciphertext
- Corrupt one byte in one ciphertext row, restart server, try to read that config → expect clean error, not crash
- Swap `.encryption-key` for an invalid file (31 bytes) → server refuses to start with clear error
- Confirm `loadGlobalConfigsIntoEnv` logs the correct injected count (means it successfully decrypted during boot)

---

## Phase 5: Docs + Version Bump

### Goal
Document the new feature, publish a changelog entry, update example config files, and bump the package version to `1.67.0`.

### Changes

1. **`package.json`** — bump `version` from `1.66.1` to `1.67.0`.

2. **`CLAUDE.md`** — in the "Local development" section (`<important if="you are setting up local development...">`), add `SECRETS_ENCRYPTION_KEY` / `SECRETS_ENCRYPTION_KEY_FILE` next to the existing env-var docs. Note:
   - What it's for (at-rest encryption of `isSecret=1` rows)
   - Auto-generation behavior in dev
   - Back-up guidance
   - Rotation is not yet supported (follow-up)

3. **`docker-compose.example.yml`** (and `docker-compose.local.yml` if it has the API service) — add a mounted Docker secret or bind-mounted file for `.encryption-key`, OR document the `SECRETS_ENCRYPTION_KEY_FILE` env var with an example. Prefer the file-based approach for production.

4. **`.env.example`** (or equivalent) — add a commented entry:
   ```bash
   # Base64-encoded 32-byte key for at-rest encryption of swarm_config secrets.
   # If not set, server writes to <data-dir>/.encryption-key on first boot.
   # BACK THIS UP — losing it means losing all encrypted secrets.
   # SECRETS_ENCRYPTION_KEY=
   # SECRETS_ENCRYPTION_KEY_FILE=/run/secrets/encryption-key
   ```

5. **`README.md`** (if it has a "Security" or "Configuration" section) — add a short paragraph linking to the CLAUDE.md docs. Otherwise skip and just update `CLAUDE.md`.

6. **`CONTRIBUTING.md`** — note that running the test suite requires no extra env vars (the fixture key is set by `src/tests/preload.ts`).

7. **`CHANGELOG.md`** (if one exists) — add entry for `1.67.0`:
   ```markdown
   ## 1.67.0 — 2026-04-14

   ### Added
   - Encrypted-at-rest storage for `swarm_config` `isSecret=1` rows using AES-256-GCM
   - New `SECRETS_ENCRYPTION_KEY` / `SECRETS_ENCRYPTION_KEY_FILE` env vars
   - Auto-generation of encryption key at `<data-dir>/.encryption-key` on first boot
   - Auto-migration of legacy plaintext secrets on upgrade

   ### Security
   - `swarm_config` API now rejects reserved keys `API_KEY` and `SECRETS_ENCRYPTION_KEY` (case-insensitive) at HTTP, MCP, and DB layers
   - Secrets are no longer stored as plaintext in `agent-swarm-db.sqlite`

   ### Operator notes
   - Upgrade is transparent; legacy plaintext secrets are auto-migrated on first boot after upgrade
   - Back up the `.encryption-key` file alongside the SQLite DB — losing either means losing all encrypted secrets
   - Key rotation is not yet supported (follow-up)
   ```
   If there's no `CHANGELOG.md`, put this in the PR description only.

8. **`BUSINESS_USE.md`** — if applicable, note the security flow change. (Probably not needed; this is internal storage, not a user-observable flow.)

### Success Criteria:

#### Automated Verification:
- [x] `package.json` version is `1.67.0`: `grep '"version": "1.67.0"' package.json`
- [x] `CLAUDE.md` mentions `SECRETS_ENCRYPTION_KEY`: `grep -q SECRETS_ENCRYPTION_KEY CLAUDE.md`
- [x] `.env.example` has the new entries: `grep -q SECRETS_ENCRYPTION_KEY .env.example` (if the file exists)
- [x] `docker-compose.example.yml` references the key: `grep -q encryption docker-compose.example.yml`
- [x] Lint still clean: `bun run lint:fix`
- [x] Type check still clean: `bun run tsc:check`
- [x] Full suite passes: `bun test`

#### Manual Verification:
- [ ] Read `CLAUDE.md` diff — confirm the new section is clear and covers: what the var does, auto-gen behavior, back-up guidance, rotation limitation
- [ ] Read `CHANGELOG.md` diff — confirm operator-facing notes are prominent
- [ ] Read `docker-compose.example.yml` diff — confirm the example is copy-pasteable

**Implementation Note**: Commit message: `chore(release): 1.67.0 — encrypted swarm_config secrets + reserved-key hardening`.

---

## Manual E2E

After all phases ship, run this end-to-end against a locally running server to prove the feature works in aggregate. Use a worktree or clean checkout to avoid polluting your dev DB.

### Setup

```bash
# Clean slate
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm .encryption-key

# First boot — no env var, no file → auto-generate
bun run start:http &
SERVER_PID=$!
sleep 2

# Verify the warning was logged
# Expected: "[secrets] Generated new encryption key at ./.encryption-key. BACK THIS FILE UP..."

# Verify the file was created with mode 0600
ls -la .encryption-key
# Expected: -rw------- (0600)
```

### Test A — New secret gets written as ciphertext

```bash
curl -s -X PUT \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"OPENAI_API_KEY","value":"sk-live-abc123","isSecret":true}' \
  http://localhost:3013/api/config

# Query the raw DB
sqlite3 agent-swarm-db.sqlite "SELECT key, value, encrypted, isSecret FROM swarm_config WHERE key = 'OPENAI_API_KEY'"
# Expected: key=OPENAI_API_KEY, value=<base64 ciphertext, not "sk-live-abc123">, encrypted=1, isSecret=1

# Read via API with includeSecrets
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/resolved?includeSecrets=true" | jq '.configs[] | select(.key == "OPENAI_API_KEY")'
# Expected: value === "sk-live-abc123" (decrypted)

# Read via API without includeSecrets
curl -s -H "Authorization: Bearer 123123" \
  http://localhost:3013/api/config/resolved | jq '.configs[] | select(.key == "OPENAI_API_KEY")'
# Expected: value === "********"
```

### Test B — Legacy plaintext secret is auto-migrated on boot

```bash
# Stop the server, directly inject a legacy plaintext row
kill $SERVER_PID
LEGACY_ID=$(uuidgen)
sqlite3 agent-swarm-db.sqlite "
  INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, encrypted, envPath, description, createdAt, lastUpdatedAt)
  VALUES ('$LEGACY_ID', 'global', NULL, 'LEGACY_SECRET', 'plain-text-value', 1, 0, NULL, NULL, '2026-04-14T00:00:00Z', '2026-04-14T00:00:00Z');
"

# Restart — should auto-encrypt
bun run start:http &
SERVER_PID=$!
sleep 2

# Verify the log line "[secrets] Auto-migrated 1 secret(s) to encrypted storage."

# Verify the row is now encrypted
sqlite3 agent-swarm-db.sqlite "SELECT value, encrypted FROM swarm_config WHERE key = 'LEGACY_SECRET'"
# Expected: value=<base64 ciphertext>, encrypted=1

# Verify we can still read it via API
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/resolved?includeSecrets=true" | jq '.configs[] | select(.key == "LEGACY_SECRET")'
# Expected: value === "plain-text-value"
```

### Test C — Reserved keys are rejected

```bash
# HTTP PUT
curl -s -X PUT \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"API_KEY","value":"evil","isSecret":true}' \
  http://localhost:3013/api/config
# Expected: HTTP 400, body contains "reserved and cannot be stored"

# Case variants
curl -s -X PUT \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"api_key","value":"evil","isSecret":true}' \
  http://localhost:3013/api/config
# Expected: HTTP 400

curl -s -X PUT \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"SECRETS_ENCRYPTION_KEY","value":"evil","isSecret":true}' \
  http://localhost:3013/api/config
# Expected: HTTP 400

# MCP set-config tool
# Use the MCP session handshake (see CLAUDE.md "MCP tool testing" section), then call set-config with key=API_KEY
# Expected: tool returns { success: false, message: "Key 'API_KEY' is reserved..." }
```

### Test D — Key file protection

```bash
# Try to read the key file as plaintext
cat .encryption-key
# Expected: base64 string (32 bytes decoded)

# Verify permissions block other users
ls -la .encryption-key
# Expected: -rw------- (owner only)

# Explicitly set SECRETS_ENCRYPTION_KEY in env, should take precedence over file
export SECRETS_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
kill $SERVER_PID
bun run start:http &
sleep 2

# Existing encrypted data should now FAIL to decrypt (wrong key)
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/resolved?includeSecrets=true"
# Expected: error response (GCM auth failure) — proves env var takes precedence

# Cleanup
kill $SERVER_PID
unset SECRETS_ENCRYPTION_KEY
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm .encryption-key
```

### Test E — Direct DB helper rejection

Run a one-off script to verify the guard at the DB layer:
```bash
bun run --no-install -e '
  import("./src/be/db").then(({ initDb, upsertSwarmConfig }) => {
    process.env.SECRETS_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    initDb("./e2e-guard-test.sqlite");
    try {
      upsertSwarmConfig({ scope: "global", key: "API_KEY", value: "x", isSecret: true });
      console.log("FAIL: did not throw");
      process.exit(1);
    } catch (e) {
      console.log("PASS: threw", e.message);
    }
  });
'
rm -f e2e-guard-test.sqlite*
```

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| User loses `.encryption-key` file | Medium | Critical — all secrets unrecoverable | Loud warning on first generation. Document prominently. Add README + CHANGELOG note. Consider Phase 6 (future): `cli rotate-encryption-key` + `cli backup-encryption-key` |
| User rotates key without migration | Low | Critical — existing secrets become junk | Loud GCM auth failure on first decrypt. No silent corruption. Document "don't rotate without the rotate command" |
| Migration hits a corrupted legacy row mid-loop | Low | High — partial state | Wrap in transaction; `process.exit(1)` on any error so the admin fixes it before retry |
| Test template doesn't pick up `encrypted` column | Medium | Breaks CI | Phase 4 updates `src/tests/preload.ts` to set fixture key; template rebuilds from migrations including `038` |
| `writeEnvFile` leaks ciphertext to disk | Medium | Medium — broken `.env` files | Encryption happens in SQL bind layer, not in `config` object. `rowToSwarmConfig` decrypts. Tested explicitly in Phase 4. |
| Telemetry or internal caller trips the reserved-key guard | Low | Medium — startup failure | Phase 1 manual verification confirms telemetry still works. If a new internal caller writes `API_KEY`, we want that to fail loudly anyway |
| `:memory:` tests can't find a key | High without mitigation | Breaks test suite | Preload sets fixture key explicitly; key-bootstrap has a special case for `:memory:` that requires the env var |

---

## Follow-ups (out of scope for this plan)

- `cli rotate-encryption-key` — decrypt with old, re-encrypt with new, in one atomic transaction
- `cli backup-encryption-key` — convenience wrapper to copy the key file with timestamp
- Optional: encrypt `agent_memory` entries with the same key (larger migration)
- Optional: integrate with KMS / Vault / cloud secret managers via a pluggable key-source interface
- Optional: add a health-check endpoint that verifies decryption works without exposing any values

---

## Review Errata

_Reviewed: 2026-04-15 by Claude (desplega:reviewing)_

### Applied

**Critical (auto-applied with authorization):**
- [x] Phase 4 Changes §1 — `resolveEncryptionKey` now called on BOTH the template fast-path and the main path in `initDb`. Prevents test breakage when `__resetEncryptionKeyForTests` is used and the next `initDb` hits the template fast-path.
- [x] Phase 4 Changes §4 — `autoEncryptLegacyPlaintextSecrets` now `throw`s instead of `process.exit(1)`. Surfaces as proper test-assertion failures instead of killing the test runner.

**Important (auto-applied):**
- [x] Phase 1 Success Criteria — removed vague "grep verifies guard is called" line that didn't map to a real command.
- [x] Phase 2 Changes — clarified base64 wording: "base64 string; must decode to exactly 32 bytes" (was ambiguous about whether the env var holds raw bytes or base64).
- [x] Phase 2 Changes §2 (Auto-generate) — added `flag: "wx"` to `writeFileSync` for TOCTOU protection, plus fallback to re-read on race loss.
- [x] Phase 2 Changes §2 (Malformed) — explicit error path when a key source returns non-32-byte content: fail loudly, do NOT fall through to auto-generation (which would silently overwrite a broken user key).
- [x] Phase 2 Changes — added `__resetEncryptionKeyForTests()` export to the module's public surface. Phase 4 referenced it without defining it.
- [x] Phase 3 Changes §5 — added note to grep for `SwarmConfig` type consumers and fix any object literals that need the new `encrypted` field.
- [x] Phase 3 Tests — explicit "use file-backed DB, not template fast-path" note so migration-level tests actually exercise the migration.
- [x] Phase 4 Changes §6 — rewrote the Zod schema note to remove Phase 3/Phase 4 forward-reference confusion.
- [x] Phase 4 Tricky bits — added decrypt-failure propagation spec: `rowToSwarmConfig` wraps the decrypt call and re-throws with config key + id context. HTTP surfaces a clear 500.
- [x] Phase 4 Tests — added `loadGlobalConfigsIntoEnv` round-trip test to prove env injection decrypts correctly on server boot.
- [x] Phase 4 Tests — updated wrong-key test to use `__resetEncryptionKeyForTests` + swap env var pattern.

**Minor (auto-applied):**
- [x] Manual E2E Test B — replaced hardcoded `'legacy-1'` id with `$(uuidgen)` to avoid potential collisions.

### Not applied (intentionally out of scope)

- Adding a "Quick Verification Reference" section per the planning template — the existing Manual E2E section covers this sufficiently and adding it would duplicate content.
- `deleteSwarmConfig` SELECT-then-check race condition — the race window is microsecond-scale and guarded by the API-layer check; additional locking adds complexity without meaningful protection.
- business-use instrumentation for the encryption feature — at-rest encryption is internal storage, not a user-observable flow, so no task/api event needed.

### Verdict

Plan is implementation-ready. All critical issues addressed. The 5-phase structure is sound, each phase has proper Automated + Manual Verification, the E2E section has concrete commands, and the risks table covers the realistic failure modes (key loss, rotation, corruption, template tests).

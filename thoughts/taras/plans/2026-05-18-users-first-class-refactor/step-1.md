---
id: step-1
name: Foundation — migration + src/be/users.ts + types + scrubber
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Foundation — migration + src/be/users.ts + types + scrubber

## Overview

The foundation that every other step in this plan depends on. Lands the unified migration `064_users_first_class.sql` (Q8 + Q15 + Q17.D + Q19 + Q20), introduces `src/be/users.ts` as the canonical API-server-side identity surface (Q10 + Q17.G), removes the four deprecated identity columns + `resolveUser` from `src/be/db.ts`, updates `src/types.ts` + `ui/src/api/types.ts`, rewires the seed script, adds the `aswt_*` rule to the secret scrubber, and ships exhaustive unit tests. After this step the DB and the helper surface exist — but **no caller has been rewired yet** (that's steps 2–8). The repo will not compile end-to-end at the close of this step alone (column reads in `src/slack/`, `src/github/`, etc. will reference the dropped columns); it compiles only once steps 2–8 land. The unit tests for `src/be/users.ts` pass standalone.

## Changes Required:

#### 1. Unified migration (the heart of the refactor)

**File**: `src/be/migrations/064_users_first_class.sql` (new)

**Changes**:

- DDL block (1) — `user_external_ids` table with PK `(kind, externalId)`, FK `userId REFERENCES users(id) ON DELETE CASCADE`, `idx_user_external_ids_userId` index.
- DDL block (2) — `ALTER TABLE users ADD COLUMN metadata TEXT;` (JSON).
- DDL block (3) — `ALTER TABLE users ADD COLUMN dailyBudgetUsd REAL;` (NULL = unlimited).
- DDL block (4) — `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended'));`
- DDL block (5) — `user_tokens` table: `id TEXT PK`, `userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `label TEXT`, `tokenHash TEXT NOT NULL UNIQUE`, **`tokenPreview TEXT NOT NULL`** (Q20 — last 4 chars of plaintext), `createdAt`, `lastUsedAt`, `revokedAt`. `idx_user_tokens_userId` index.
- DDL block (6) — `user_identity_events` table: `id TEXT PK`, `userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `eventType TEXT NOT NULL CHECK (eventType IN ('auto_merge', 'manual_merge', 'identity_added', 'identity_removed', 'email_added', 'email_removed', 'token_minted', 'token_revoked', 'budget_changed', 'status_changed'))` — Q19 includes `email_added`/`email_removed`. `actor TEXT NOT NULL`, `beforeJson TEXT`, `afterJson TEXT`, `createdAt`. `idx_user_identity_events_userId_createdAt` index (DESC on createdAt).
- Backfill block (7) — `INSERT INTO user_external_ids (userId, kind, externalId) SELECT id, 'slack', slackUserId FROM users WHERE slackUserId IS NOT NULL UNION ALL ... UNION ALL ... UNION ALL ...` — four UNION ALL subqueries for slack/linear/github/gitlab.
- DROP block (8) — `ALTER TABLE users DROP COLUMN slackUserId; DROP COLUMN linearUserId; DROP COLUMN githubUsername; DROP COLUMN gitlabUsername;` (four separate ALTER TABLE statements per SQLite syntax).
- Confirm SQLite auto-drops `idx_users_slack/linear/github/gitlab` indexes when their parent column drops — spot-check with `.indexes users` after migration.

#### 2. `src/be/users.ts` — pure DB functions

**File**: `src/be/users.ts` (new)

**Changes**: implement Q10 surface plus Q17.G `getUserIdentities`:

- `findUserById(id: string): UserRow | null` — single SELECT by id.
- `findUserByExternalId(kind: string, externalId: string): UserRow | null` — JOIN `user_external_ids` → `users`.
- `findUserByEmail(email: string): UserRow | null` — checks **both** `users.email` AND `json_each(emailAliases)` per Q12.
- `findOrCreateUserByEmail(email, hints, actor): { user: UserRow; created: boolean }` — Q4/Q5 auto-merge or auto-create. Emits `auto_merge` event when merging, `identity_added` when creating a fresh row with no identities yet.
- `linkIdentity(userId, kind, externalId, actor): void` — INSERT into `user_external_ids` + emit `identity_added` in same tx. PK collision throws (Q14 — replaces old UNIQUE-constraint behaviour).
- `unlinkIdentity(userId, kind, externalId, actor): void` — DELETE + emit `identity_removed`.
- `mintToken(userId, label, actor): { tokenId: string; plaintext: string }` — generate `aswt_<base62(20+ chars)>`, sha256, INSERT `user_tokens` with `tokenPreview = plaintext.slice(-4)`, emit `token_minted`. Return plaintext once. NOTE: the corresponding `POST /users/:id/mcp-tokens` endpoint is **deferred to the MCP plan**; this helper is callable from `src/be/users.ts` unit tests and ready for that future plan to wire up.
- `revokeToken(tokenId, actor): void` — UPDATE `revokedAt`, emit `token_revoked`.
- `resolveUserByToken(plaintext): UserRow | null` — sha256 lookup; on hit, async `lastUsedAt = now` update (fire-and-forget). Returns null if `revokedAt IS NOT NULL`.
- `recordIdentityEvent(userId, eventType, actor, before, after): void` — INSERT into `user_identity_events`. Used internally by the above; also exported for the manage-user MCP tool / HTTP endpoints that emit `email_added`/`email_removed`/`budget_changed`/`status_changed` directly.
- `getUserIdentities(userId): Array<{ kind: string; externalId: string }>` (Q17.G) — single SELECT for People-page response composition.
- `fingerprintApiKey(rawKey: string): string` (Q16) — returns `op:<sha256(rawKey).slice(0, 16)>`. Used by operator auth middleware in step-8 to produce the `actor` value for operator-driven events.
- `IdentityActor` TS type: `{ kind: 'system' | 'operator' | 'user'; id: string }` exported.
- File-level rule: **all mutating helpers (link/unlink/mint/revoke/findOrCreate) wrap the row mutation + event emission in a single `db.transaction(() => { ... })()`** — Q9 invariant: every identity mutation has a matching event row.
- Use `Bun.$` for any shell calls (none expected here), `bun:sqlite` directly via the shared `db` from `src/be/db.ts`. Boundary checker is silent on `src/be/` per research §4.

#### 3. `src/be/db.ts` cleanup

**File**: `src/be/db.ts`

**Changes**:

- Delete `resolveUser()` at lines 8770–8832. All 14 callers will be rewired in steps 2–8; intentional left-over compile errors in those files are the safety net for the same-PR-no-soak guarantee.
- Delete the four identity-column fields from `UserRow` (lines 8730–8745).
- Delete the four field mappings from `rowToUser()` (lines 8747–8764).
- Remove the four `slackUserId`/`linearUserId`/`githubUsername`/`gitlabUsername` parameters + INSERT columns from `createUser()` (lines 8843–8881).
- Remove the four `if (data.<col> !== undefined)` branches from `updateUser()` (lines 8883–8959).
- `deleteUser()` (lines 8961–8968) needs no code change — `ON DELETE CASCADE` on `user_external_ids.userId` and `user_tokens.userId` handles the rest. Sanity-check the cascade fired in the new test for step-1.

#### 4. `src/types.ts` Zod schemas + types

**File**: `src/types.ts`

**Changes**:

- Update `UserSchema` (lines 221–236): drop the four identity fields; add `metadata: z.record(z.unknown()).optional()`, `dailyBudgetUsd: z.number().nullable().optional()`, `status: z.enum(['invited', 'active', 'suspended']).default('active')`.
- Add new export `IdentityEventTypeSchema = z.enum([...10 event types per Q19...])` and `type IdentityEventType = z.infer<typeof IdentityEventTypeSchema>` — mirrored in lockstep with the SQL CHECK in migration 064. Same pattern as `AgentTaskSourceSchema`.
- Confirm `AgentTaskSourceSchema` (lines 56–70) — no change needed (research §1e + Q-research J).

#### 5. UI types

**File**: `ui/src/api/types.ts`

**Changes**:

- `User` interface (lines 161–164): drop four identity fields; add `identities?: Array<{ kind: string; externalId: string }>`, `dailyBudgetUsd?: number | null`, `status: 'invited' | 'active' | 'suspended'`, `metadata?: Record<string, unknown>`.
- `CreateUserInput` (lines 181–184): same drop + add `identities?: Array<{ kind: string; externalId: string }>`.
- Add `IdentityEventType` TS literal-union type matching `src/types.ts`.
- Add `IdentityEvent` interface: `{ id: string; userId: string; eventType: IdentityEventType; actor: string; beforeJson: string | null; afterJson: string | null; createdAt: number }`.
- Add `UserToken` interface (read shape): `{ id: string; userId: string; label: string | null; tokenPreview: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }`.
- **Do NOT touch** `AgentTask.slackUserId?: string` at `ui/src/api/types.ts:109` — that's the `agent_tasks` column, KEPT (research §1e).

#### 6. Seed script

**File**: `scripts/backfill-seed-users.sql`

**Changes**:

- Rewrite into two-stage form: stage 1 = `INSERT OR IGNORE INTO users (id, name, email, role) VALUES (...)` for Taras + Eze (no identity columns). Stage 2 = `INSERT OR IGNORE INTO user_external_ids (userId, kind, externalId) VALUES (...)` × 3 for Taras (slack + linear + github) and × 3 for Eze. Keep re-runnable.

#### 7. Secret-scrubber rule (lands here even though token endpoints defer)

**File**: `src/utils/secret-scrubber.ts`

**Changes**:

- Add a regex rule for `aswt_[A-Za-z0-9]{20,}` → `[REDACTED-MCP-TOKEN]` (or whatever the existing replacement convention is — match neighbouring rules' style). Lands here per Core Req #9: ensures the scrubber covers `aswt_*` plaintexts when the future MCP plan ships endpoints.
- Refresh the in-memory scrubber-rules cache key per `runbooks/secret-scrubbing.md` if the file has a static cache (check `src/utils/secret-scrubber.ts` for cache patterns).

#### 8. Unit tests for `src/be/users.ts`

**File**: `src/tests/user-identity.test.ts`

**Changes** (per research §1f):

- Rewrite the whole file against the new surface. Existing structure:
  - "Creates a user with all identity fields" → split into "creates with no identities" + "links identities one-by-one".
  - UNIQUE-constraint tests on `slackUserId`/`githubUsername` → rewrite against `user_external_ids` PK `(kind, externalId)`: `linkIdentity('slack', 'U_X')` succeeds; second call with same args throws.
  - "Cascade-delete clears requestedByUserId on tasks" → confirm + add assertion that `user_external_ids` rows are removed when the parent user is deleted.
  - `testUser` setup → `createUser` + 4× `linkIdentity`.
  - "Resolves by each identity kind" → rewrite as `findUserByExternalId(kind, externalId)` per kind.
  - "Negative cases" → rewrite for `findUserByExternalId('slack', 'U_NONEXIST')` returns `null`, same for email.
  - "Prioritizes platform ID over email" → DELETE this test. The new world has no waterfall; callers compose.
- Add new tests:
  - `findUserByEmail` checks BOTH primary `email` AND `emailAliases` (Q12 — easy to forget).
  - `findOrCreateUserByEmail` creates when no match; merges (returns existing) when match exists; emits the right event (`identity_added` for create, `auto_merge` for merge).
  - `linkIdentity` emits `identity_added` event in the same transaction.
  - `unlinkIdentity` emits `identity_removed`.
  - `mintToken` returns plaintext starting with `aswt_`, stores hash + 4-char `tokenPreview` (NOT plaintext), emits `token_minted`.
  - `revokeToken` sets `revokedAt`, emits `token_revoked`. Subsequent `resolveUserByToken(plaintext)` returns `null`.
  - `resolveUserByToken` updates `lastUsedAt`.
  - `fingerprintApiKey('some-key')` matches `/^op:[0-9a-f]{16}$/`.
  - Existing-DB migration: snapshot a pre-migration `users` row with `slackUserId='U_TEST'` → run migration → assert `user_external_ids` row exists with `(kind='slack', externalId='U_TEST', userId=<original>)` and the column is gone (`pragma_table_info('users')`).
- All tests should hit an in-memory `bun:sqlite` per `src/tests/` convention.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] `bun test src/tests/user-identity.test.ts` — all new + rewritten cases pass.
- [ ] `bun run tsc:check` — passes for the foundation files. (Will FAIL repo-wide because steps 2–8 still reference dropped helpers — that's expected; verify only `src/be/users.ts`, `src/be/db.ts`, `src/types.ts`, `src/tests/user-identity.test.ts`, `src/utils/secret-scrubber.ts`, `scripts/backfill-seed-users.sql`, and `ui/src/api/types.ts` typecheck cleanly in isolation by running `bun run tsc:check` and confirming all reported errors live in step-2–step-8 territory.)
- [ ] `bash scripts/check-db-boundary.sh` passes — boundary checker is silent on `src/be/users.ts` per research §4 (sanity check).
- [ ] `bash scripts/check-api-key-boundary.sh` passes — `fingerprintApiKey` uses `getApiKey()` ONLY if it reads the API key (in step-1 it just hashes the value passed in, so no direct env read; verify the boundary check is green regardless).
- [ ] Fresh-DB migration: `rm agent-swarm-db.sqlite && bun run start:http` — server boots, migration applies, `sqlite3 agent-swarm-db.sqlite '.schema users'` shows the four identity columns are **gone** and `metadata`/`dailyBudgetUsd`/`status` are present.
- [ ] Existing-DB migration: snapshot `agent-swarm-db.sqlite` (real one with existing rows) before run, restore that snapshot to a temp path, point the migration runner at the snapshot, verify backfill: `sqlite3 <snapshot> 'SELECT count(*) FROM user_external_ids;'` matches sum of pre-migration non-null identity counts.

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it. Browser-use, screenshot diff, CLI walkthrough, etc.)*

- [ ] CLI walkthrough: spin up a script that calls `createUser` → `linkIdentity('slack', 'U_QA1')` → `findUserByExternalId('slack', 'U_QA1')` returns the row → `unlinkIdentity('slack', 'U_QA1')` → `findUserByExternalId(...)` returns `null` → `SELECT * FROM user_identity_events WHERE userId = <id>` shows 2 rows (`identity_added`, `identity_removed`) with correct `actor` / `beforeJson` / `afterJson` shapes.
- [ ] CLI walkthrough: `findOrCreateUserByEmail('test@example.com', { name: 'Test' }, { kind: 'system', id: 'webhook:test' })` creates a row + emits `identity_added` event. Repeat call → returns existing row, `created: false`, no duplicate event.
- [ ] CLI walkthrough: `mintToken(userId, 'CI test', operatorActor)` → token starts with `aswt_`, `user_tokens` row has correct `tokenHash` (sha256 of plaintext) + `tokenPreview = plaintext.slice(-4)`, `user_identity_events` has matching `token_minted`. Then `revokeToken(tokenId, operatorActor)` → `revokedAt` set, `token_revoked` event present, `resolveUserByToken(plaintext)` returns `null`.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball the migration SQL — confirm DDL ordering is correct, backfill INSERT runs **before** DROP COLUMNs, CHECK constraints match the Zod enum exactly.
- [ ] Eyeball `src/be/users.ts` — confirm every mutating function is wrapped in `db.transaction()`.

**Implementation Note**: This step is a vertical slice — the migration applies cleanly + `src/be/users.ts` works in isolation, even though the rest of the repo will not typecheck until steps 2–8 land. After manual verification passes, commit with `[step-1] foundation: migration 064 + src/be/users.ts + types`. Steps 2–9 can then claim and parallelize.

---
id: step-8
name: HTTP API + operator fingerprint middleware
depends_on: [step-1]
status: ready
---

# step-8: HTTP API + operator fingerprint middleware

## Overview

Build the operator-facing HTTP surface for the People page and Unmapped tab. Add the operator-auth middleware that produces the `op:<sha256(rawKey)[:16]>` fingerprint (Q16) using `getApiKey()` from `src/utils/api-key.ts` (per CLAUDE.md API-key boundary rule). Replace the existing minimal `src/http/users.ts` (create/update body shapes already exist) with the full Core Req #6 surface — except `POST/DELETE /users/:id/mcp-tokens`, which are deferred to the MCP plan. Every endpoint goes through the `route()` factory and ends up auto-registered in OpenAPI; regenerate after the work.

## Changes Required:

#### 1. Operator-auth middleware + fingerprint actor

**File**: `src/http/operator-actor.ts` (new — or extend an existing auth helper if one exists; check `src/http/core.ts` or similar first)

**Changes**:

- Export `getOperatorActor(req): IdentityActor` that:
  1. Reads the `Authorization: Bearer <key>` header.
  2. Calls `getApiKey()` from `src/utils/api-key.ts` to fetch the configured swarm key.
  3. If the header key matches: returns `{ kind: 'operator', id: fingerprintApiKey(rawKey) }` where `fingerprintApiKey` was added in step-1.
  4. If no match: throws 401 (the existing API-key gate already enforces this — confirm during implementation).
- Confirm `scripts/check-api-key-boundary.sh` is happy after the change (the helper reads via `getApiKey`, not `process.env.API_KEY`).

#### 2. `GET /users` — list with identities + budget + token summary + recent events

**File**: `src/http/users.ts`

**Changes**: add new route via `route()` factory. Response shape:

```ts
{
  users: Array<{
    id, name, email, emailAliases, role, status, dailyBudgetUsd, metadata,
    identities: Array<{ kind, externalId }>,       // from getUserIdentities
    tokens: Array<{ id, label, tokenPreview, createdAt, lastUsedAt, revokedAt }>,  // from user_tokens
    recentEvents: Array<IdentityEvent>,             // last N events, default 5
  }>
}
```

- Compose the response in the handler by JOINing once per concern: `getAllUsers()`, then per-user `getUserIdentities(userId)`, then `SELECT * FROM user_tokens WHERE userId = ?`, then `SELECT * FROM user_identity_events WHERE userId = ? ORDER BY createdAt DESC LIMIT 5`.
- Acceptable performance for v1 (small N); add pagination only if needed.

#### 3. `POST /users` — create + optional initial linkages

**File**: `src/http/users.ts`

**Changes**:

- Update existing route's body Zod (lines 28–40): drop the four identity fields. Add: `identities?: Array<{ kind: string; externalId: string }>`, `dailyBudgetUsd?: number | null`, `status?: 'invited' | 'active' | 'suspended'`, `metadata?: Record<string, unknown>`.
- Handler:
  - `createUser({ name, email, role, status, dailyBudgetUsd, metadata })` — no identity fields.
  - For each `{kind, externalId}` in `identities ?? []`: `linkIdentity(user.id, kind, externalId, operatorActor)`.
  - If `dailyBudgetUsd` provided: `recordIdentityEvent(user.id, 'budget_changed', operatorActor, null, { dailyBudgetUsd })`.
  - Return `getUserById(user.id)` with identities/tokens/events composed.

#### 4. `PATCH /users/:id` — profile / budget / status / email-alias edit

**File**: `src/http/users.ts`

**Changes**:

- Update existing route body Zod (lines 56–69): drop four identity fields. Add `identities?` (diff-style — see step-7's `manage-user` shape); add `dailyBudgetUsd?: number | null`, `status?: ...`, `metadata?`, `emailAliases?: string[]`.
- Handler:
  - Snapshot `before = getUserById(:id)`.
  - `updateUser(:id, { name, email, role, status, dailyBudgetUsd, metadata, emailAliases })` — no identity fields.
  - If `dailyBudgetUsd` changed: emit `budget_changed`.
  - If `status` changed: emit `status_changed`.
  - If `emailAliases` changed: compute added/removed; emit `email_added` / `email_removed` per Q19.
  - If `identities` is a complete-list diff: same logic as `manage-user` update branch (step-7) — `linkIdentity` for additions, `unlinkIdentity` for removals.

#### 5. `POST /users/:id/identities` — add identity link

**File**: `src/http/users.ts`

**Changes**: new route. Body Zod: `{ kind: string; externalId: string }`. Handler: `linkIdentity(:id, kind, externalId, operatorActor)`. Returns updated `getUserIdentities(:id)`.

#### 6. `DELETE /users/:id/identities/:kind/:externalId` — remove identity link

**File**: `src/http/users.ts`

**Changes**: new route. Handler: `unlinkIdentity(:id, kind, externalId, operatorActor)`. Returns updated `getUserIdentities(:id)`.

#### 7. `GET /users/:id/events` — paginated event timeline

**File**: `src/http/users.ts`

**Changes**: new route. Query params: `limit` (default 50, max 200), `before` (event id cursor or createdAt ms). Returns `Array<IdentityEvent>` sorted DESC by `createdAt`.

#### 8. `GET /users/unmapped` — list unmapped identities

**File**: `src/http/users.ts` (or a new `src/http/users-unmapped.ts` if the file gets too long)

**Changes**: new route. Query params: `kind?` (filter), `limit` (default 100). Implementation:

- Per kind (or for each of slack/github/gitlab/linear if no filter): `listKv({ namespace: 'integration:unmapped:<kind>', prefix: '', limit })`.
- The kv entries come as pairs `<externalId>:meta` (json) + `<externalId>:count` (integer). Group them by `externalId` (strip the `:meta` / `:count` suffix from each key) and return a unified shape: `{ kind, externalId, lastSeenAt, count, sampleEventType, sampleContext }`.
- Sort by `count` DESC then `lastSeenAt` DESC for triage priority.

#### 9. `POST /users/unmapped/:kind/:externalId/resolve` — operator triage action

**File**: `src/http/users.ts`

**Changes**: new route. Body Zod (one of):

```ts
z.union([
  z.object({ userId: z.string() }),               // link to existing user
  z.object({ name: z.string(), email: z.string().email() }),  // create new user + link
]);
```

Handler:

- If `userId` provided: `linkIdentity(userId, kind, externalId, operatorActor)`.
- Else: `createUser({ name, email })` → `linkIdentity(user.id, kind, externalId, operatorActor)`.
- On success: `deleteKv('integration:unmapped:<kind>', '<externalId>:meta')` + `deleteKv('integration:unmapped:<kind>', '<externalId>:count')`.
- Returns the resolved user (via `getUserById` with identities composed).

#### 10. `POST /users/:id/merge` — operator merge tool

**File**: `src/http/users.ts`

**Changes**: new route. Body Zod: `{ sourceUserId: string }`. Handler:

- Snapshot `targetBefore = getUserById(:id)` and `sourceBefore = getUserById(sourceUserId)`.
- Move every identity from `sourceUserId` → `:id`: per `(kind, externalId)` in `getUserIdentities(sourceUserId)`: `unlinkIdentity(sourceUserId, ...)` + `linkIdentity(:id, ...)`.
- Move email-aliases: append `sourceBefore.email` + `sourceBefore.emailAliases` to `:id` 's `emailAliases` (de-duped). Emit `email_added` per added alias.
- Delete `sourceUserId` via `deleteUser(sourceUserId)` (CASCADE handles any remaining linkages).
- Emit a single `manual_merge` event on the target with `beforeJson = targetBefore`, `afterJson = getUserById(:id)`.
- Returns the merged user.

#### 11. OpenAPI regen

**Commands**: after wiring every route via `route()`:

```bash
# Add the new routes to scripts/generate-openapi.ts's import list (per CLAUDE.md route-factory rule).
bun run docs:openapi
```

**Files**: commit `openapi.json` + `docs-site/content/docs/api-reference/**`.

#### 12. Tests

**File**: `src/tests/http-users.test.ts` (existing if present; otherwise new)

**Changes**: per-endpoint integration tests using an in-memory `bun:sqlite` and a real `Bun.serve()` instance OR direct route-handler invocation, whichever the existing convention is:

- `GET /users` — returns identities + tokens + recentEvents composed correctly.
- `POST /users` with `identities` array — user created + links + events.
- `PATCH /users/:id` — budget / status / emailAliases diffs each emit the right event types.
- `POST /users/:id/identities` + `DELETE /users/:id/identities/:kind/:externalId` — round-trip.
- `GET /users/:id/events` — pagination + DESC ordering.
- `GET /users/unmapped` — kv grouping + count sorting.
- `POST /users/unmapped/:kind/:externalId/resolve` — both branches (`userId` and `{name, email}`); kv entries removed.
- `POST /users/:id/merge` — identities migrated, source user gone, `manual_merge` event present.
- Auth: every endpoint rejects requests with no `Authorization: Bearer ...` header (401) or with the wrong key.
- Actor: every event written under operator action has `actor = 'op:<16hex>'`.

### Success Criteria:

#### Automated Verification:

- [ ] `bun test src/tests/http-users.test.ts` — all cases pass.
- [ ] `bun run tsc:check` — passes for `src/http/**`.
- [ ] `bun run lint` passes on `src/http/**`.
- [ ] `bash scripts/check-api-key-boundary.sh` passes (operator middleware uses `getApiKey()`).
- [ ] `bun run docs:openapi` runs clean — `openapi.json` updated; commit it + `docs-site/.../api-reference/**`.
- [ ] `grep -n 'resolveUser\s*(' src/http/users.ts` returns 0 hits.

#### Automated QA:

- [ ] curl walkthrough against `bun run dev:http`:
  - `curl -H "Authorization: Bearer $AGENT_SWARM_API_KEY" https://api.swarm.localhost:1355/api/users` → returns the user list with identities/tokens/events composed.
  - `curl -X POST -d '{"name":"Tester","email":"tester@dev","identities":[{"kind":"slack","externalId":"U_QA1"}]}' ...` → user + identity link created.
  - `curl -X POST .../users/<id>/identities -d '{"kind":"github","externalId":"qa-tester"}'` → identity added; `GET /users/<id>/events` shows `identity_added`.
  - `curl -X DELETE .../users/<id>/identities/github/qa-tester` → identity removed; event timeline shows `identity_removed`.
  - `curl .../users/unmapped` → returns kv-backed entries (seed an unmapped row before via `incrKv`/`upsertKv` in a setup script).
  - `curl -X POST .../users/unmapped/slack/U_QA9/resolve -d '{"userId":"<existing>"}'` → identity linked, kv rows gone.
  - `curl -X POST .../users/<target>/merge -d '{"sourceUserId":"<source>"}'` → target gains source's identities, source deleted, `manual_merge` event present.

#### Manual Verification:

- [ ] Eyeball the regenerated `openapi.json` diff — new endpoints under `/api/users`, identity endpoints, unmapped endpoints, merge endpoint all present with correct shapes.

**Implementation Note**: After verification passes, commit with `[step-8] http: full /api/users surface + operator fingerprint middleware + openapi regen`. The regenerated `openapi.json` and `docs-site/.../api-reference/**` MUST be in the same commit (CI freshness check).

---
id: step-8
name: Invite API
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: Invite API

## Overview

An admin calls `POST /api/invites` with an email and a role (Requester by default). The swarm creates the user as `invited` with exactly that role and returns a one-time link, valid 7 days. The teammate's browser calls the public `POST /api/invites/exchange` with the code. The swarm marks the user `active` and returns a personal `aswt_` token. No email is sent. Risk: high (auth, migration). Label the PR `risk:high`.

Facts (invites research):
- `connector_codes` (migration `src/be/migrations/197_connector_codes.sql:8-23`) stores only a sha256 hash, single use, 10 minute TTL. `createConnectorCode` and `exchangeConnectorCode` live in `src/be/connector-codes.ts:15-80`. The exchange mints the token inside the same transaction. The heartbeat deletes expired codes 1 h after expiry.
- The public connector exchange route has a per-IP limiter (10/min), a code shape regex, a 1024-byte body cap and an identical 404 `code_invalid` for every bad code (`src/http/users.ts:421-449, 907-933`). Copy it.
- `aswt_` auth admits only `active` users (`src/http/auth.ts:55-60, 92-94`). The exchange must activate the user.
- A DB trigger gives every new user the `admin` role (`src/be/rbac-roles.ts:70-78`). Call `setUserRoles` (307-378) in the same transaction as `createUser`.
- `createUser` does not reject duplicate emails. Look the email up first (`findOrCreateUserByEmail` and the alias lookup in `src/be/users.ts:340-380`).
- Main's migration tail is `244_api_key_validation.sql`. Open PR #2219 holds 243, which sorts below the tail, so the conflict check forces it to renumber to 245 or above. Take the next ordinal above main's tail and above whatever #2219 ends up using: 246 on 2026-10-26. Check again on the day.

## Changes Required:

#### 1. Migration
**File**: `src/be/migrations/246_connector_code_kind.sql` (new; renumber if needed)
**Changes**: `ALTER TABLE connector_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'connector' CHECK (kind IN ('connector', 'invite'));`. Existing rows and the ChatGPT connector keep today's behavior. Classify the new TEXT column in `.text-columns.json` (`bun scripts/check-text-columns.ts`). Not a new table, so no audit-column entry.

#### 2. Code kinds
**File**: `src/be/connector-codes.ts` (keep DB code here or in `src/be/db/<domain>/`; the `db.ts` facade is frozen)
**Changes**:
- `createConnectorCode(userId, label, actor, now, opts?: { kind?: "connector" | "invite"; ttlMs?: number })`. Export `INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000`.
- `exchangeConnectorCode(code, opts?: { kind?: ... })` adds `AND kind = ?` to the atomic `UPDATE ... RETURNING`. Default `connector`, so the ChatGPT route cannot redeem an invite code and the reverse.
- For kind `invite`, inside the same transaction: `UPDATE users SET status = 'active' WHERE id = ? AND status = 'invited'`. When it changes 0 rows (the user was suspended or merged since), return the same null as an invalid code and mint nothing. Else record a `status_changed` identity event, then `mintToken(userId, label, actor, { source: "invite_exchange" })`.
- `deleteUnusedInviteCodes(userId)` for re-invites.
- All DB access through `getDbClient()` and one `transaction`.

#### 3. Routes
**File**: `src/http/users.ts` (next to the connector routes, 393-449 and 849-933)
**Changes**:
- `POST /api/invites`:
  - `route()` with `rbac: { permission: "user.role.manage" }`. In the handler, for user callers, also require grant-all, as `PUT /api/users/{id}/roles` does (`src/http/user-roles.ts:115-170`).
  - Body: `{ email: z.email(), name?: string, role: z.enum(["requester", "viewer", "admin"]).default("requester") }`.
  - Behavior: an email (or alias) that matches an `active` or `suspended` user returns 409 `user_exists`. An `invited` user gets the new role, `deleteUnusedInviteCodes` and a fresh code. Otherwise `createUser({ name: name ?? <email local part>, email, status: "invited" })`, then `setUserRoles(id, [role], actorUserId)` and `createConnectorCode(..., { kind: "invite", ttlMs: INVITE_CODE_TTL_MS })`, all in one transaction.
  - 201 response schema `{ user, inviteUrl, expiresAt, apiReachable: "public" | "local" }`.
  - `inviteUrl = ${resolveAppUrl() ?? <hosted default>}/join?swarm=<encodeURIComponent(resolveMcpBaseUrl())>&code=<code>` (`src/http/config-values.ts:36-60`). Use `swarm`, not `apiUrl`: the dashboard strips `apiUrl` and `apiKey` from every URL at load (`apps/ui/src/lib/connection-url-params.ts:7`).
  - `apiReachable` is `local` when the API URL is loopback or a private host, so the UI can warn that teammates cannot reach this swarm.
  - Never log the code or the URL.
- `POST /api/invites/exchange`:
  - `route()` with `auth: { apiKey: false }`, `rbac: { ungated: "the one-time invite code is the credential" }`, `maxBodyBytes: 1024`.
  - Copy the connector exchange handler: limiter (export a test reset, as `connectorExchangeRateLimiter.reset()` at `src/http/users.ts:681`), regex, identical 404.
  - 200 schema `{ token, userId }`.
- `bun run docs:openapi`. Set the count in `src/tests/docs-index-footprint.test.js` to the regenerated total (2 more operations).

#### 4. Docs
**File**: `docs-site/content/docs/(documentation)` page for People or users (find it with `grep -rln "mcp-tokens\|New user" docs-site/content`)
**Changes**: Describe invites: who can invite, roles, 7-day single-use links, the public URL requirement, and that re-inviting replaces the old link.

### Success Criteria:

#### Automated Verification:
- [x] Invite route tests: `bun run test:root -- src/tests/invites-http.test.ts` (new file; copy the harness and cases of `src/tests/user-token-routes.test.ts:213-510`). Cases:
  - create stores only the hash and mints no token;
  - the user is `invited` with the role `requester` and is NOT admin;
  - an `active` or `suspended` email gets 409;
  - an invite code for a user who was suspended before the exchange gets 404 and mints no token;
  - a re-invite replaces the code, and the old code then gets 404;
  - the exchange returns a token that works on `GET /api/whoami`;
  - the user is `active` with a `status_changed` event;
  - a second exchange gets 404;
  - an expired code gets 404;
  - a connector code on the invite route gets 404, and the reverse;
  - 10/min limiter, 413 on a big body;
  - a Requester caller of `POST /api/invites` gets 403;
  - a failed role set leaves no user.
- [x] Regressions: `bun run test:root -- src/tests/user-token-routes.test.ts src/tests/user-roles-http.test.ts src/tests/http-users.test.ts`
- [x] Migration: `bash scripts/check-migration-conflicts.sh && bun scripts/check-text-columns.ts`
- [x] Fresh DB boot (repeat with a DB file first created by a main checkout, to prove the migration applies once on an existing DB): `mkdir -p /tmp/afo-step-8 && rm -f /tmp/afo-step-8/db.sqlite* && (DATABASE_PATH=/tmp/afo-step-8/db.sqlite DESPLEGA_TELEMETRY_ENV=test PORT=3913 bun src/http.ts > /tmp/afo-step-8/api.log 2>&1 & echo $! > /tmp/afo-step-8/pid) && until curl -sf http://localhost:3913/health; do sleep 1; done && kill "$(cat /tmp/afo-step-8/pid)" && sqlite3 /tmp/afo-step-8/db.sqlite "SELECT name FROM pragma_table_info('connector_codes') WHERE name = 'kind'"` (prints `kind`)
- [x] Routes: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run docs:openapi && bun run test:root -- src/tests/docs-index-footprint.test.js`
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [x] Black-box contract: `scripts/e2e/scenarios/invites.ts` (new; copy `scripts/e2e/scenarios/config-roundtrip.ts`, pick a free `order`). It creates an invite, exchanges it, calls `GET /api/whoami` with the token, and checks that the second exchange is 404. Run: `bun run e2e --only invites`
- [x] curl walk on a booted API (temp DB, no `.env`): the whole flow, with the token kept in a shell variable and never echoed. `POST /api/tasks` with the Requester token returns 403 before step-6 and 201 after it. Record which one applies.
  - Result (2026-10-26, without step-6): 403 `admission: route has no permission verb (operator-only)`.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-8] invite API` after verification passes.

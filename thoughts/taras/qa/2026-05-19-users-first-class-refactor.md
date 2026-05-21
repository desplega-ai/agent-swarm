---
date: 2026-05-19
qa_engineer: Claude (automated, --autonomy=critical)
plan: thoughts/taras/plans/2026-05-18-users-first-class-refactor
branch: feat-human-first
verdict: PASS with 1 found bug (non-blocking) + manual UI QA still outstanding
---

# QA Report — Humans-as-first-class-users refactor

## TL;DR

Automated QA passed end-to-end (CI gates, migrations, HTTP API, MCP tools, event emission, merge flow). Found **one bug** in the unmapped-resolve endpoint that handles URL-encoded externalIds incorrectly. Manual UI QA on the People page + Unmapped tab is still required (see §3) — qa-use isn't used in this repo (per feedback memory).

## 1. Automated checks — PASS

All ran from `/Users/taras/worktrees/agent-swarm/2026-05-18-feat-human-first`.

| Check | Command | Result |
|---|---|---|
| Lint | `bun run lint` | ✅ 21 warnings (pre-existing, no errors) |
| Backend typecheck | `bun run tsc:check` | ✅ |
| DB boundary | `bash scripts/check-db-boundary.sh` | ✅ Worker/API boundary clean |
| API-key boundary | `bash scripts/check-api-key-boundary.sh` | ✅ |
| Unit tests | `bun test` | ✅ **4125 pass / 0 fail / 11774 expect()**, 20.6s |
| UI install | `pnpm install --frozen-lockfile` | ✅ |
| UI lint | `pnpm lint` (biome) | ✅ 242 files clean |
| UI typecheck | `pnpm exec tsc -b` | ✅ exit 0 |
| OpenAPI regen | `bun run docs:openapi` | ✅ no diff after regen (already committed) |
| pi-skills regen | `bun run build:pi-skills` | ✅ no diff after regen (already committed) |

### Cross-cutting grep verification (Global Verification §3 of the plan)

All return **zero hits** outside the canonical migration files:

```
grep users.slackUserId      src/ ui/ scripts/ plugin/ docs-site/ MCP.md  →  0
grep users.linearUserId     src/ ui/ scripts/ plugin/ docs-site/ MCP.md  →  0
grep users.githubUsername   src/ ui/ scripts/ plugin/ docs-site/ MCP.md  →  0
grep users.gitlabUsername   src/ ui/ scripts/ plugin/ docs-site/ MCP.md  →  0
grep 'resolveUser('         src/ ui/ scripts/ plugin/                    →  0
grep userEmailCache         src/                                         →  0
```

`resolveUser` is fully retired; the Slack in-memory cache is gone (now `src/slack/enrich.ts` with the kv-backed slack-email helper).

### Q21.A regression check — actor-extraction fix

```
grep 'event\.actor' src/linear/sync.ts  →  0 hits
```

The old `event.actor` reads (Linear sync.ts:379, :691 per plan) are gone. Replaced with reads from `agentSession.creator` (`created` action) and `agentActivity.user` (`prompted`). The Q21.C bot-self-link guard via persisted `appUserId` is in place (`src/linear/oauth.ts:40-91`, `src/linear/sync.ts:359-408`).

## 2. Live-server integration checks — PASS (+ 1 bug)

Spun up a fresh API server on port 3099 against `/tmp/qa-fresh.sqlite` (clean DB → all 64 migrations applied → seed). Verified:

### 2a. Migration 064 applied correctly

Took a snapshot of the live prod DB at `/Users/taras/Documents/code/agent-swarm/agent-swarm-db.sqlite` (the parent worktree's DB), ran migration 064 against it via `runMigrations()`:

- ✅ `[migrations] Applied: 064_users_first_class (7.9ms)`
- ✅ Dropped indexes: `idx_users_slack`, `idx_users_linear`, `idx_users_github`, `idx_users_gitlab` are gone. Only `idx_users_email` + `sqlite_autoindex_users_1` remain.
- ✅ Dropped columns: `slackUserId`, `linearUserId`, `githubUsername`, `gitlabUsername` no longer in the `users` table.
- ✅ New tables created: `user_external_ids`, `user_identity_events`, `user_tokens`.
- ✅ Backfill is trivially correct here because the snapshot had 0 `users` rows. **Caveat**: A non-empty real DB needs a manual re-check before deploy — the plan's existing-DB step expects `count(user_external_ids) == count(non-null identity columns pre-snapshot)`. Couldn't verify with non-empty data because the prod DB had no users yet.

### 2b. HTTP API smoke (all under `/api/users`)

| Endpoint | Result |
|---|---|
| `GET /api/users` (empty) | ✅ `{ users: [] }` |
| `POST /api/users` (Alice) | ✅ Returns hydrated user with `identities`, `tokens`, `recentEvents` |
| `GET /api/users/:id` | ✅ Hydrated view |
| `POST /api/users/:id/identities` (Slack) | ✅ Emits `identity_added`, actor = `operator:op:7f541e424c117e07` (fingerprint middleware confirmed) |
| `POST /api/users/:id/identities` (Linear) | ✅ Same |
| `POST /api/users/:id/identities` (duplicate) | ⚠️ 400 with raw SQLite error `UNIQUE constraint failed: user_external_ids.kind, user_external_ids.externalId`. Functionally correct (idempotent rejection), but the error message leaks SQL — see §4 nitpicks. |
| `DELETE /api/users/:id/identities/:kind/:externalId` | ✅ Emits `identity_removed` |
| `GET /api/users/:id/events` | ✅ Returns DESC-ordered events with full before/after JSON |
| `PATCH /api/users/:id` (name+budget+status) | ✅ Emits `budget_changed` + `status_changed` in same call |
| `POST /api/users/:id/merge` (Alice ← Bob) | ✅ Source identities migrated, source email moved to `emailAliases`, source row deleted (`GET bob → 404`), `manual_merge` event emitted with full snapshot in before/after |
| `GET /api/users/unmapped` | ✅ Reads kv entries; sorts by count DESC, lastSeenAt DESC; kind filter works |
| `POST /api/users/unmapped/:kind/:externalId/resolve` (create) | ⚠️ **BUG** — see §3 |
| `POST /api/users/unmapped/:kind/:externalId/resolve` (link existing) | ⚠️ **BUG** — see §3 |
| `POST /api/users/unmapped/:kind/:externalId/resolve` (bad userId) | ✅ 404 `Target user not found` |

### 2c. MCP tools

- ✅ Both `resolve-user` and `manage-user` registered.
- ✅ `resolve-user { kind: "slack", externalId: "U12345" }` → returns Alice.
- ✅ `resolve-user { email: "alice@example.com" }` → same Alice.
- ✅ Empty input rejected by Zod refine: `"Provide either (kind + externalId) or email"`.
- ✅ **Legacy shape rejected** (Q18 break-and-migrate): `{ slackUserId: "U12345" }` → `"Unrecognized key: \"slackUserId\""`. Honest runtime error confirms the worker `plugin/commands/` rewrite was the only call site of the old shape.
- ✅ `manage-user create/list` gated to lead with: `"Only the lead agent can manage user profiles."` — couldn't drive the lead branch from this QA harness (no lead-role agent registered), but the gate fires cleanly. Recommend a quick manual test from a real lead agent.

### 2d. Identity events table — full enum coverage observed

During the run I exercised: `identity_added`, `identity_removed`, `status_changed`, `budget_changed`, `email_added`, `manual_merge`. The remaining types in the enum (`auto_merge`, `token_minted`, `token_revoked`, `email_removed`) were not exercised this round — `auto_merge` needs a live webhook (Slack/Linear/AgentMail) with credentials; the token ones are deferred per the plan's "What we're NOT doing" list.

## 3. Bugs found

### BUG-1: `/api/users/unmapped/{kind}/{externalId}/resolve` doesn't URL-decode externalId — **non-blocking but real**

**Repro**:
```
# kv has key  integration:unmapped:github  →  "@alexdev:meta" (literal @)
POST /api/users/unmapped/github/%40alexdev/resolve {"name":"Alex","email":"a@example.com"}
```

**Expected**: identity row in `user_external_ids` has `externalId = "@alexdev"`; kv entries `@alexdev:meta` + `@alexdev:count` are deleted; subsequent `GET /api/users/unmapped` no longer lists this entry.

**Actual**:
- ❌ `user_external_ids` row gets `externalId = "%40alexdev"` (URL-encoded).
- ❌ `deleteKv(ns, "%40alexdev:meta")` no-ops because the real key is `"@alexdev:meta"`.
- ❌ `GET /api/users/unmapped` keeps returning the unresolved entry forever (until 30-day TTL).

**Same issue probably affects** `DELETE /api/users/:id/identities/:kind/:externalId` — any externalId containing `@`, `+`, `:`, `/`, etc. (relevant for AgentMail email addresses used as externalId, and possibly Linear/Slack usernames in some webhook payloads).

**Root cause**: `getPathSegments(url)` at `src/http/utils.ts:43`:
```ts
export function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);  // ← no decodeURIComponent
}
```

The `route()` factory at `src/http/route-def.ts:106-117` then maps `pathSegments[i]` straight into `rawParams` without decoding. Affects every endpoint that has a user-controlled string path param. The user-routes-specific call sites are `unmapped/{externalId}/resolve` (src/http/users.ts:411-432) and `identities/{kind}/{externalId}` delete (src/http/users.ts:476+).

**Suggested fix** (narrow): decode in the handler (`const externalId = decodeURIComponent(parsed.params.externalId)`), and feed the decoded value to both `linkIdentity` and the kv deletes.

**Suggested fix** (broad): decode in `getPathSegments` — risk: behavior change for other handlers that may have built up an assumption. Plan-wide audit needed. Probably not worth it given how shallow the narrow fix is.

**Severity**: medium-low. Affects only externalIds with URL-reserved chars. Of the current integrations, AgentMail (email-as-externalId) is the most-affected; GitHub usernames are alphanumeric+hyphen and Slack `U...` IDs are uppercase alphanumeric, so those auto-link flows are safe in practice today. But the operator-driven UI will hit this the moment someone tries to resolve an email-based unmapped entry.

## 4. Nitpicks (not bugs, decide if you want them)

1. **Duplicate-identity error leaks raw SQLite**: `400 UNIQUE constraint failed: user_external_ids.kind, user_external_ids.externalId`. Consider catching the SQLite constraint failure in `addIdentityRoute` and returning a friendlier 409: `"Identity (slack, U12345) is already linked to another user."`.
2. **`manual_merge` event snapshot is recursive-ish** — the merge event's `before`/`after` JSON contains the full `recentEvents` array of the target row, which itself contains prior events. Useful for audit but noisy if you ever render the timeline naively. Probably fine; just flagging.
3. **`user_metric_overrides` not created by migration 064** — that table is mentioned in some plan prose but not in the SQL. Confirm whether per-user metric overrides are intentionally out of scope for this PR (probably yes — token-mint UI is the explicit defer).

## 5. What's left for Taras to manually verify

**UI (must be manual — qa-use is not used in this repo per feedback memory):**

Open the dashboard (`bun run start:http` + UI dev server) and check:

- [ ] **People page list view** loads at `/people` — identity badges per row, budget badge ("Unlimited" or `$X.YY`), status pill (active/suspended/invited).
- [ ] **People detail page** `/people/:id` — edit name, add a Slack/GitHub/Linear identity via picker, remove an identity, set/clear `dailyBudgetUsd`, toggle status — all persist and show in the events timeline.
- [ ] **Operator merge flow** (merge-modal.tsx) — pick two rows, preview, confirm; target row gains source row's identities, `manual_merge` appears in timeline, source row is gone from the list.
- [ ] **Unmapped tab** — list shows kv-backed entries with kind filter chips; "Create user from this externalId" (resolve-create-dialog.tsx) and "Link to existing user" (link-to-existing-dialog.tsx) CTAs both:
  - work
  - clear the kv entry on success **only if BUG-1 is fixed** — otherwise the entry sticks around and the UI may look broken even though the user was created/linked correctly under a URL-encoded externalId. **Worth fixing BUG-1 before this manual QA pass.**
- [ ] No console errors on any page.

**Webhook end-to-end (needs live integrations):**

The plan's Global Verification §"Fresh-DB integration round-trip" lists these — I couldn't drive them from this QA harness because integrations were disabled:

- [ ] Slack DM via `#swarm-dev-2` (channel `C0AR967K0KZ`, bot `U0ALZGQCF96`) → user auto-linked via `enrichSlackUserEmail`, `auto_merge` or `identity_added` event in timeline, `requestedByUserId` on the resulting agent task.
- [ ] Linear `@devagentswarm` mention in dev workspace → `AgentSessionEvent.created` arrives at `/linear/webhook`, user auto-linked from `agentSession.creator`, `requestedByUserId` populated (this is the **Q21.A pre-existing bug fix** — verify it's actually fixed against real Linear payloads).
- [ ] Linear `prompted` follow-up → `agentActivity.user` extraction works, `requestedByUserId` populated again.
- [ ] Linear webhook where `creator.id === storedAppUserId` → **NO** `users` row created, **NO** unmapped entry (Q21.C bot-guard).
- [ ] AgentMail inbound → user auto-linked or unmapped entry created.
- [ ] GitHub webhook with unknown sender → `integration:unmapped:github` kv row created with `<login>:count = 1`, then `2` on second hit.
- [ ] Trigger the SAME identity again on any integration → no duplicate `users` row, no duplicate `user_external_ids` row, timeline reflects the second event.

**Existing-DB migration on non-empty data:**

The prod DB I sampled had 0 user rows, so the backfill assertion (`count(user_external_ids) == sum of non-null identity counts pre-snapshot`) was trivially true. If you have a non-empty cloud DB:

- [ ] Snapshot it, run migration 064, verify each pre-existing `users.<identityCol> IS NOT NULL` row produced a matching `user_external_ids` row, with zero data loss.

## 6. Files used / left behind

- `/tmp/qa-pre-migration.sqlite`, `/tmp/qa-post-migration.sqlite` — DB snapshots (migration verification)
- `/tmp/qa-fresh.sqlite*` — fresh-server DB
- `/tmp/run-migration-064.ts`, `/tmp/inject-unmapped.ts` — throwaway harness scripts
- `/tmp/qa-server.log`, `/tmp/qa-server.pid` — server PID/log

No source files were modified. Server was shut down at end of QA.

---
id: step-2
name: Slack webhook rewire + enrichSlackUserEmail
depends_on: [step-1]
status: ready
---

# step-2: Slack webhook rewire + enrichSlackUserEmail

## Overview

Rewire all three Slack webhook entry points (`handlers.ts`, `assistant.ts`, `actions.ts`) to use `src/be/users.ts`. Replace the in-process `userEmailCache: Map<string, string | null>` at `src/slack/handlers.ts:38` with a kv-backed `enrichSlackUserEmail(slackUserId): Promise<string | null>` helper (24h TTL, only successful results cached per Q17.E). On a resolve miss with no email recovery, record the identity in the kv-backed unmapped tracker (Q14 + Q17.D — two rows per externalId). Verified end-to-end against the dev Slack channel `#swarm-dev-2` (`C0AR967K0KZ`) with bot `@dev-swarm` (`U0ALZGQCF96`).

## Changes Required:

#### 1. Slack message handler — primary inbound

**File**: `src/slack/handlers.ts`

**Changes**:

- Line 38: delete the `userEmailCache: Map<string, string | null>` declaration.
- Lines 114–125: replace the inline `client.users.info(...)` cache lookup with the new `enrichSlackUserEmail(slackUserId)` helper (defined below in the same file or in a new `src/slack/enrich.ts` — author's choice).
- Line 395: replace `resolveUser({ slackUserId: msg.user })?.id` with the cascade:
  1. `findUserByExternalId('slack', msg.user)` — fast path.
  2. On null: `await enrichSlackUserEmail(msg.user)` → if email present, `findOrCreateUserByEmail(email, { name: profile.real_name }, { kind: 'system', id: 'webhook:slack' })` → `linkIdentity(user.id, 'slack', msg.user, { kind: 'system', id: 'webhook:slack' })`.
  3. On null email: record unmapped — `upsertKv('integration:unmapped:slack', '${msg.user}:meta', { lastSeenAt: now, sampleEventType: 'message', sampleContext: msg.text.slice(0, 100) }, 30 * 24 * 60 * 60 * 1000)` + `incrKv('integration:unmapped:slack', '${msg.user}:count', 1)`.
- Define new exported helper `enrichSlackUserEmail(slackUserId: string): Promise<string | null>`:
  - `getKv('integration:user-enrichment:slack', slackUserId)` first; if present, parse JSON `{ email?, name?, fetchedAt }` and return `email`.
  - On miss: `client.users.info({ user: slackUserId })` → on success with `profile.email`, `upsertKv('integration:user-enrichment:slack', slackUserId, { email, name: profile.real_name, fetchedAt: now }, 24 * 60 * 60 * 1000)`. Return email.
  - On API failure / no profile.email: **return null without caching** (Q17.E rule — caching null defeats retries on rate-limit recovery).

#### 2. Slack assistant handler — DM-in-thread variant

**File**: `src/slack/assistant.ts`

**Changes**:

- Line 80: same rewire as `handlers.ts:395`. The `userId ? resolveUser(...) : undefined` conditional → `userId ? (await resolveSlackUserId(userId)) : undefined` (where `resolveSlackUserId` is the local helper that does the three-step cascade defined in this file or imported from `src/slack/handlers.ts`).
- For sample context on unmapped: use the assistant prompt text instead of a message text. Truncate to 100 chars.

#### 3. Slack actions handler — button-click / modal-submit variant

**File**: `src/slack/actions.ts`

**Changes**:

- Line 70: same rewire — `findUserByExternalId('slack', body.user.id)` → enrichment → unmapped fallback.
- For sample context on unmapped: use the action's payload type as `sampleEventType` (e.g. `'block_actions'`, `'view_submission'`) and the action's primary value (button text or modal callback ID) truncated to 100 chars.

#### 4. Tests

**File**: `src/tests/slack-handlers.test.ts` (existing file if present; otherwise new under `src/tests/`)

**Changes**:

- Test: incoming Slack message from a NEW user with email-resolvable profile → `users` row created, `user_external_ids` row created with `(kind='slack', externalId=<U>, userId=<id>)`, `auto_merge` OR `identity_added` event emitted, task created with `requestedByUserId = <id>`.
- Test: SAME user again → no duplicate `users` / `user_external_ids`, fast-path through `findUserByExternalId`.
- Test: NEW user with profile that has no email → unmapped kv rows created (`<U>:meta` JSON + `<U>:count` = 1). Second message → count goes to 2. Meta upserted.
- Test: `enrichSlackUserEmail` cache-hit avoids the `client.users.info` call (mock `client.users.info` and assert call count = 0 on the second invocation).
- Test: `enrichSlackUserEmail` does NOT cache failures (null email response → second call still hits the API).

### Success Criteria:

#### Automated Verification:

- [ ] `bun test src/tests/slack-handlers.test.ts` — all new cases pass.
- [ ] `bun test src/tests/user-identity.test.ts` — still passes (step-1 invariants).
- [ ] `bun run tsc:check` — passes (assuming step-1 + this step both committed; if running in isolation, only Slack-related errors should remain).
- [ ] `bun run lint` passes on `src/slack/**`.
- [ ] `grep -n 'resolveUser\s*(' src/slack/` returns 0 hits.
- [ ] `grep -n 'userEmailCache' src/` returns 0 hits.

#### Automated QA:

- [ ] Live dev round-trip: with `bun run pm2-start`, send `@dev-swarm hi` in `#swarm-dev-2` from a user who has NO existing `users` row but whose Slack profile carries an email. Confirm: task created with `requestedByUserId` set, `users` row exists, `user_external_ids` row exists, `user_identity_events` row exists with `actor = 'system:webhook:slack'` (or equivalent per the `IdentityActor` shape — confirm against step-1's implementation choice).
- [ ] Live dev round-trip: same flow with a Slack profile that has NO email (a bot account or test fixture). Confirm: NO `users` row, kv row `integration:unmapped:slack` `<U>:count` = 1.
- [ ] Live dev round-trip: send a second message from the no-email user. Confirm: count = 2.
- [ ] kv-cache verification: after the first email-resolvable user lookup, `sqlite3 agent-swarm-db.sqlite "SELECT * FROM kv_entries WHERE namespace = 'integration:user-enrichment:slack';"` shows the cached JSON with `fetchedAt` timestamp and 24h `expires_at`.

#### Manual Verification:

- [ ] If the bot is the message sender (`msg.user === botUserId`), confirm we don't accidentally enroll the bot as a `users` row. (Slack handlers should already guard against the bot's own messages elsewhere — eyeball that the new cascade doesn't subvert that guard.)

**Implementation Note**: After verification passes, commit with `[step-2] slack: rewire to src/be/users.ts + kv-backed enrichSlackUserEmail`.

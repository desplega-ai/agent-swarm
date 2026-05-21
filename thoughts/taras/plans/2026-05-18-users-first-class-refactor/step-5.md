---
id: step-5
name: Linear webhook rewire + Q21.A actor fix + appUserId guard
depends_on: [step-1]
status: done
---

# step-5: Linear webhook rewire + Q21.A actor fix + appUserId guard

## Overview

The most consequential of the integration steps. **Fixes a pre-existing silent bug**: `src/linear/sync.ts:379, 691` reads `event.actor` but `AgentSessionEvent` payloads have no top-level `actor` field — `requestedByUserId` is **always undefined** on Linear-originated tasks today (Q21.A). The new actor extraction reads the correct nested paths (`event.agentSession.creator` on `created`; `event.agentActivity.user` on `prompted`), then runs the cascade per Q17.B: `findUserByExternalId('linear', id)` → on miss + email present, `findOrCreateUserByEmail(email, {name})` → `linkIdentity`. Also implements the **appUserId guard** (Q21.C): the swarm's own bot identity (`event.appUserId`) must NOT enroll as a `users` row — handler must short-circuit when the human equals the bot. The appUserId itself must be persisted alongside the integration config (NOT in `users`).

Per Q22.1, the Linear app is currently configured agent-session-events-only — only `created` + `prompted` actions arrive. There is no system-actor case under the current config (Q21.B). Forward-watch: if subscriptions widen to include `Issue` events, system-actor handling returns.

## Changes Required:

#### 1. AgentSessionEvent.created handler

**File**: `src/linear/sync.ts`

**Changes** (around lines 379–387 — locate the `event.actor` reads in the `created` branch):

- Delete the broken `event.actor` extraction.
- Add:
  ```ts
  const session = event.agentSession as Record<string, unknown> | undefined;
  const creator = session?.creator as Record<string, unknown> | undefined;
  const linearUserId = creator ? String(creator.id ?? "") : "";
  const email = creator ? String(creator.email ?? "") : "";
  const name = creator ? String(creator.name ?? "") : "";
  ```
- **appUserId guard**: read the stored `appUserId` from integration config (see Changes Required #3) and short-circuit if `linearUserId === storedAppUserId`. The swarm should not enroll itself — return early without writing unmapped, without creating users.
- Cascade:
  ```ts
  let userId = findUserByExternalId('linear', linearUserId)?.id;
  if (!userId && email) {
    const { user } = findOrCreateUserByEmail(email, { name }, { kind: 'system', id: 'webhook:linear' });
    linkIdentity(user.id, 'linear', linearUserId, { kind: 'system', id: 'webhook:linear' });
    userId = user.id;
  }
  if (!userId) {
    // Linear ID present but no email recovery path — record unmapped (Q14)
    upsertKv('integration:unmapped:linear', `${linearUserId}:meta`, {
      lastSeenAt: now,
      sampleEventType: 'AgentSessionEvent.created',
      sampleContext: (session?.comment as { body?: string } | undefined)?.body?.slice(0, 100) ?? null,
    }, 30 * 24 * 60 * 60 * 1000);
    incrKv('integration:unmapped:linear', `${linearUserId}:count`, 1);
  }
  ```
- Use `userId` for `requestedByUserId` on the created task (replacing the old `resolveUser({linearUserId, email, name})?.id`).
- Confirm the extraction happens in the **async branch** (post-200-return) per Q22.1 timing rule — Linear requires 5s response, 10s first activity.

#### 2. AgentSessionEvent.prompted handler

**File**: `src/linear/sync.ts` (around lines 691–699 — locate `event.actor` reads in the `prompted` branch)

**Changes**: same shape as `created`, but extract from `event.agentActivity.user`:

```ts
const activity = event.agentActivity as Record<string, unknown> | undefined;
const promptUser = activity?.user as Record<string, unknown> | undefined;
const linearUserId = promptUser ? String(promptUser.id ?? "") : "";
const email = promptUser ? String(promptUser.email ?? "") : "";
const name = promptUser ? String(promptUser.name ?? "") : "";
```

Same appUserId guard. Same cascade. `sampleContext` from `activity?.content?.body` (truncated to 100). `sampleEventType = 'AgentSessionEvent.prompted'`.

#### 3. Persist Linear `appUserId` in integration config (Q21.C)

**File**: pick the right home — research §1 implies one of (a) `tracker_integration_config` table (or its equivalent — find via `grep -RIn 'linear' src/integrations/ src/be/migrations/` to identify the existing Linear-config table), or (b) `kv_entries` namespace `integration:linear:bot-app-user-id`.

**Implementation choice (plan-default)**: use `kv_entries` namespace `integration:linear:bot-app-user-id`, key = (workspace ID or `default`), value type = `string`. Simpler than a column add, no migration churn beyond step-1. The webhook handler reads via `getKv('integration:linear:bot-app-user-id', workspaceId ?? 'default')` once per event (cached at module-init if observed hot).

**Changes**:

- During the existing Linear OAuth completion / install flow (locate via `grep -RIn 'linear' src/integrations/` or `src/linear/oauth.ts`), after the swarm's app-user identity is known (e.g. from the OAuth response or a GraphQL `viewer` query), persist it: `upsertKv('integration:linear:bot-app-user-id', workspaceId ?? 'default', appUserId, null)`. No TTL.
- During webhook dispatch, the handler reads `storedAppUserId = getKv('integration:linear:bot-app-user-id', workspaceId ?? 'default')?.value as string | null`. If null (not yet captured), skip the guard with a one-line log: `console.warn('[linear] appUserId not yet stored; bot-self-link guard disabled')` — handler proceeds but the guard is a no-op until the next OAuth refresh or admin-action captures it.
- **Plan-time decision pending**: confirm during implementation whether the swarm currently captures the `appUserId` during OAuth (probably not — it's a new requirement). If not, add a one-shot fetch in the OAuth completion handler.

#### 4. Unmapped-tracker bot guard

**File**: `src/linear/sync.ts` (and any shared unmapped-helper extracted across steps 2–5)

**Changes**: per Core Req #22, the unmapped-recording block above MUST already exclude the bot case — that's the early-return on `linearUserId === storedAppUserId`. Sanity-check this with a unit test (below).

#### 5. Tests

**File**: `src/tests/linear-sync.test.ts` (existing if present; otherwise new)

**Changes**:

- Test: `AgentSessionEvent.created` payload (use a real captured fixture under `src/tests/fixtures/linear/` — generate one via the dev pipeline if missing) with `agentSession.creator.email` present and an EXISTING `user_external_ids` row for that Linear ID → fast-path resolution, `requestedByUserId` populated, no new user.
- Test: same payload with an UNKNOWN Linear ID but recognizable email → cascade fires, `users` row + `user_external_ids` link both created, `auto_merge` + `identity_added` events emitted, `requestedByUserId` populated.
- Test: same payload with no email + unknown Linear ID → unmapped kv rows written, `requestedByUserId` undefined.
- Test: `AgentSessionEvent.prompted` payload parameterized the same way.
- Test: appUserId guard — payload where `agentSession.creator.id === storedAppUserId` → NO `users` row, NO unmapped entry, NO `requestedByUserId` (or treat as system-noise; confirm against the existing handler behaviour during implementation).
- Test (regression): a payload with the OLD `event.actor` shape (manually constructed) → handler does NOT enroll a user (proves the new code path is the only path).

#### 6. Forward-watch comment

**File**: `src/linear/sync.ts`

**Changes**: at the top of each rewired branch, add a 1–2 line comment per Q22 / Core Req #23:

```ts
// Linear app config is currently agent-session-events-only — only AgentSessionEvent.created/prompted arrive.
// If subscriptions widen to Issue/Comment events later, handle system-actor case (per Q21.B / Q22).
// Identity primitives in src/be/users.ts are event-type-agnostic; only the extraction shape changes.
```

### Success Criteria:

#### Automated Verification:

- [x] `bun test src/tests/linear-sync.test.ts` — all cases pass, including the appUserId guard test. (Ran as `bun test src/tests/linear-sync-identity.test.ts` — 9/9 pass.)
- [x] `bun run lint` passes on `src/linear/**`. (Biome clean on `src/linear/` + new test file; repo-wide lint failures are in sibling-step files.)
- [x] `grep -n 'resolveUser\s*(' src/linear/` returns 0 hits.
- [x] `grep -n 'event\.actor' src/linear/` returns 0 hits (the broken extraction is gone).
- [x] `grep -n 'linearUserId' src/linear/` returns 0 hits referring to the dropped `users.linearUserId` column (refs to the local `linearUserId` variable in the new code are expected and fine).

#### Automated QA:

- [ ] Dev-pipeline loop (per Q21 Insights): trigger a real `@devagentswarm hi` mention from a Linear dev workspace user. Tail `/tmp/linear-webhooks.jsonl` to capture the payload. Confirm: task created with `requestedByUserId` populated (this is the **first time** this works for Linear — confirms the Q21.A bug fix lands).
- [ ] Dev-pipeline loop: trigger a follow-up prompt to the same agent session. Confirm: task `requestedByUserId` populated; `user_identity_events` shows continuity (no duplicate identity links).
- [ ] Dev-pipeline loop: simulate a `creator.id === appUserId` payload (e.g. by spoofing the appUserId equality in a test fixture or by triggering an event the swarm itself emits). Confirm: NO `users` row, NO unmapped entry — the swarm doesn't hear itself.

#### Manual Verification:

- [ ] Visually compare a captured `AgentSessionEvent.created` payload (from `/tmp/linear-webhooks.jsonl`) against the extraction code — `event.agentSession.creator` is the correct path; `event.actor` does not exist in the payload.
- [ ] Confirm with Taras (or via the integration config UI in step-9) that the Linear `appUserId` is correctly captured during OAuth install and persisted in `kv_entries` namespace `integration:linear:bot-app-user-id`.

**Implementation Note**: This step ALSO fixes a pre-existing production bug — the commit message should call that out:

> `[step-5] linear: fix actor extraction (was reading event.actor; AgentSessionEvent puts human at agentSession.creator/agentActivity.user) + appUserId bot-self-link guard + new auto-link cascade`

After verification passes, commit.

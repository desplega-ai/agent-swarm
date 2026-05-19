---
id: step-4
name: GitLab webhook rewire
depends_on: [step-1]
status: ready
---

# step-4: GitLab webhook rewire

## Overview

Rewire all three GitLab webhook entry points to `findUserByExternalId('gitlab', user.username)`. If `user.email` is present inline on the webhook payload (rare — research §3), run the auto-link cascade (`findOrCreateUserByEmail` → `linkIdentity`). Otherwise record the unmapped entry. Like GitHub, the note (comment) handler at line 250 is currently a dead `_requestedByUserId` site — rewire it but keep the underscore.

## Changes Required:

#### 1. Merge-request handler

**File**: `src/gitlab/handlers.ts`

**Changes** (line 66, `merge_request` event):

- Replace `resolveUser({ gitlabUsername: user.username })?.id` with:
  1. `findUserByExternalId('gitlab', user.username)?.id` — fast path.
  2. On null + `user.email` present inline (check `src/gitlab/types.ts:14` — `user.email?: string`): `findOrCreateUserByEmail(user.email, { name: user.name }, { kind: 'system', id: 'webhook:gitlab' })` → `linkIdentity(<id>, 'gitlab', user.username, ...)`.
  3. On null + no email: `upsertKv('integration:unmapped:gitlab', '${user.username}:meta', { lastSeenAt: now, sampleEventType: 'merge_request', sampleContext: \`MR !${mr.iid}: ${mr.title}\`.slice(0, 100) }, 30 * 24 * 60 * 60 * 1000)` + `incrKv('integration:unmapped:gitlab', '${user.username}:count', 1)`.

#### 2. Issue handler

**File**: `src/gitlab/handlers.ts` (line 166, `issue` event)

**Changes**: same pattern. `sampleEventType = 'issue'`, sample context = `\`Issue #${issue.iid}: ${issue.title}\`.slice(0, 100)`.

#### 3. Note (comment) handler — currently dead path

**File**: `src/gitlab/handlers.ts` (line 250, `note` event)

**Changes**: same pattern. Keep underscore on `_requestedByUserId`. `sampleEventType = 'note'`, sample context = `note.note.slice(0, 100)`.

#### 4. Tests

**File**: `src/tests/gitlab-handlers.test.ts` (existing if present; otherwise new)

**Changes**:

- Test: MR event from a known GitLab user → `requestedByUserId` populated, no unmapped entry.
- Test: MR event from an unknown user WITH email inline → user auto-created via `findOrCreateUserByEmail`, `user_external_ids` row written, `requestedByUserId` populated, no unmapped entry.
- Test: MR event from an unknown user WITHOUT email inline → unmapped kv rows written, `requestedByUserId` undefined.
- Test: Repeat event same unknown user → count = 2.
- Test: Issue + note events parameterized.

### Success Criteria:

#### Automated Verification:

- [ ] `bun test src/tests/gitlab-handlers.test.ts` — all cases pass.
- [ ] `bun run lint` passes on `src/gitlab/**`.
- [ ] `grep -n 'resolveUser\s*(' src/gitlab/` returns 0 hits.
- [ ] `grep -n 'gitlabUsername' src/gitlab/` returns 0 hits.

#### Automated QA:

- [ ] Live dev round-trip via a GitLab dev project pointing at the dev API: create an MR from a user account NOT in `users` whose GitLab profile has email visible. Confirm: `users` row auto-created, `user_external_ids` row written, task `requestedByUserId` populated, no unmapped entry.
- [ ] Live dev round-trip: same flow with a user whose GitLab profile email is private. Confirm: NO `users` row, unmapped kv rows present.

#### Manual Verification:

- [ ] Spot-check that the inline-email branch only fires when `user.email` is a real non-empty string. Empty string / "" should fall through to unmapped (some GitLab installations send `email: ""` instead of omitting the field).

**Implementation Note**: After verification passes, commit with `[step-4] gitlab: rewire to src/be/users.ts + inline-email auto-link + unmapped tracking`.

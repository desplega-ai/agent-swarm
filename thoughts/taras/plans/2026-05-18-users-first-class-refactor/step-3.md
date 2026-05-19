---
id: step-3
name: GitHub webhook rewire
depends_on: [step-1]
status: ready
---

# step-3: GitHub webhook rewire

## Overview

Rewire all four GitHub webhook entry points to `findUserByExternalId('github', sender.login)` only — no email auto-link path because GitHub never exposes email via webhook or App-installation token in the common case (Q17.A). On a resolve miss, record the identity in the kv-backed unmapped tracker for operator triage on the People → Unmapped tab. Two of the four call-sites (`_requestedByUserId` at lines 752 and 860) are currently dead — leave the assignment in place for parity with the live sites but don't add new wiring.

## Changes Required:

#### 1. PR-event handler

**File**: `src/github/handlers.ts`

**Changes** (line 159, `pull_request` event):

- Replace `resolveUser({ githubUsername: sender.login })?.id` with `findUserByExternalId('github', sender.login)?.id`.
- On null: write unmapped — `upsertKv('integration:unmapped:github', '${sender.login}:meta', { lastSeenAt: now, sampleEventType: 'pull_request', sampleContext: \`PR #${pr.number}: ${pr.title}\`.slice(0, 100) }, 30 * 24 * 60 * 60 * 1000)` + `incrKv('integration:unmapped:github', '${sender.login}:count', 1)`.
- **No `enrichUserFromIntegration('github', ...)` helper is created** (Q17.A — would be empty-by-design).

#### 2. Issue-event handler

**File**: `src/github/handlers.ts` (same file, line 517 — `issues` event)

**Changes**: same rewire pattern as PR. Sample context = `\`Issue #${issue.number}: ${issue.title}\`.slice(0, 100)`. `sampleEventType = 'issues'`.

#### 3. Comment-event handler (currently dead path)

**File**: `src/github/handlers.ts` (line 752 — `issue_comment` event)

**Changes**: replace `resolveUser({ githubUsername: sender.login })` with `findUserByExternalId('github', sender.login)`. **Keep the underscore-prefixed `_requestedByUserId` assignment** — the value is intentionally unused per current code; rewiring it would expand scope beyond this PR. Still write the unmapped entry on miss (so the operator sees commenters who aren't mapped, even if the swarm isn't using the value yet). `sampleEventType = 'issue_comment'`, sample context = `comment.body.slice(0, 100)`.

#### 4. Review-event handler (currently dead path)

**File**: `src/github/handlers.ts` (line 860 — `pull_request_review` event)

**Changes**: same as comment handler. `sampleEventType = 'pull_request_review'`, sample context = `\`Review on PR #${pr.number}: ${review.state}\`.slice(0, 100)`.

#### 5. Tests

**File**: `src/tests/github-handlers.test.ts` (existing if present; otherwise new)

**Changes**:

- Test: PR event from a known GitHub user (existing `user_external_ids` row) → `requestedByUserId` populated, no unmapped entry.
- Test: PR event from an unknown GitHub user → `requestedByUserId` undefined, unmapped kv rows written (`<login>:meta`, `<login>:count = 1`).
- Test: Repeat PR event from same unknown user → count = 2.
- Test: Issue, comment, review events follow the same pattern (parameterize across event types).
- Test: confirm NO `enrichSlackUserEmail`-style helper is invoked for GitHub (assertion against module-level `client.users.info`-equivalents — should not exist).

### Success Criteria:

#### Automated Verification:

- [ ] `bun test src/tests/github-handlers.test.ts` — all cases pass.
- [ ] `bun run lint` passes on `src/github/**`.
- [ ] `grep -n 'resolveUser\s*(' src/github/` returns 0 hits.
- [ ] `grep -n 'githubUsername' src/github/` returns 0 hits (no leftover references to the dropped column).

#### Automated QA:

- [ ] Live dev round-trip (against a GitHub dev repo with a webhook hooked to the dev API): open a PR from a new account NOT in `users`. Confirm task created with `requestedByUserId = undefined` (no email auto-link possible) AND `sqlite3 agent-swarm-db.sqlite "SELECT * FROM kv_entries WHERE namespace = 'integration:unmapped:github';"` shows `<login>:meta` JSON + `<login>:count = 1`.
- [ ] Insert a `user_external_ids` row manually mapping `<login>` → an existing user. Open another PR from the same account. Confirm: task `requestedByUserId` populated, unmapped kv row entries NOT incremented (operator-linked identity skips the unmapped path).

#### Manual Verification:

- [ ] Spot-check `src/github/handlers.ts` lines 752 and 860 — the underscore-prefixed `_requestedByUserId` assignments still read as intentional dead code (not removed, just rewired to the new helper).

**Implementation Note**: GitHub is the simplest of the integration steps — no enrichment, no cascade. After verification passes, commit with `[step-3] github: rewire to findUserByExternalId + unmapped tracking`.

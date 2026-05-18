---
id: step-6
name: AgentMail webhook rewire
depends_on: [step-1]
status: done
---

# step-6: AgentMail webhook rewire

## Overview

AgentMail is the simplest webhook rewire — email IS the primary identifier (the whole event is an inbound email), so the cascade collapses to a single `findOrCreateUserByEmail` call per Q17.F. No unmapped path because there's never a "no email" miss case.

## Changes Required:

#### 1. AgentMail handler

**File**: `src/agentmail/handlers.ts`

**Changes** (line 164):

- Replace `resolveUser({ email: senderEmail })?.id` with:
  ```ts
  const { user, created } = findOrCreateUserByEmail(
    senderEmail,
    { name: senderName ?? undefined },
    { kind: 'system', id: 'webhook:agentmail' }
  );
  const requestedByUserId = user.id;
  ```
- `created === true` ⇒ a fresh `users` row exists and an `identity_added` event was emitted by `findOrCreateUserByEmail`. `created === false` ⇒ existing row was merged-by-email and an `auto_merge` event was emitted (in step-1's implementation). Either way, the auto-link path is honored.
- Confirm `senderEmail` is guarded (`if (!senderEmail) return null` or equivalent) before this call — the AgentMail event handler already conditions on email presence per research §1d.

#### 2. Tests

**File**: `src/tests/agentmail-handlers.test.ts` (existing if present; otherwise new)

**Changes**:

- Test: inbound email from an UNKNOWN sender → `users` row auto-created, `identity_added` event emitted, task `requestedByUserId` populated.
- Test: inbound email from a KNOWN sender (existing `users.email` match) → existing row returned, `auto_merge` event emitted, no duplicate row, task `requestedByUserId` populated.
- Test: inbound email from a sender whose email matches an EXISTING `users.emailAliases` entry (not primary `email`) → match resolves via the `json_each(emailAliases)` path in `findUserByEmail` (Q12), existing row returned, task `requestedByUserId` populated.
- Test: inbound email with no senderEmail at all (`senderEmail === ""` or null) → handler returns early without calling `findOrCreateUserByEmail`. (Verify this guard exists in the existing handler.)

### Success Criteria:

#### Automated Verification:

- [x] `bun test src/tests/agentmail-handlers.test.ts` — all cases pass.
- [x] `bun run lint` passes on `src/agentmail/**`.
- [x] `grep -n 'resolveUser\s*(' src/agentmail/` returns 0 hits.

#### Automated QA:

- [ ] Dev round-trip: send an inbound email through the AgentMail dev pipeline from an address not in `users`. Confirm: `users` row auto-created, task `requestedByUserId` populated.
- [ ] Dev round-trip: send a second email from the same address. Confirm: no duplicate user row, fast-path through `findUserByEmail`.

#### Manual Verification:

- [ ] Confirm the auto-create path doesn't get bot/notification-only emails (e.g. `noreply@…`) into the `users` table — these should ideally be filtered upstream of the resolve call. If the existing handler doesn't filter, leave a follow-up note (out of scope for this step).

**Implementation Note**: This is a 1–2 line code change plus tests. After verification passes, commit with `[step-6] agentmail: rewire to findOrCreateUserByEmail`.

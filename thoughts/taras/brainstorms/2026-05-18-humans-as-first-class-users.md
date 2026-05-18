---
date: 2026-05-18T00:00:00-00:00
author: Taras
topic: "Humans as first-class users: UI, auto-linking, per-user controls"
tags: [brainstorm, users, identity, ui, integrations, slack, github, linear, mcp]
status: in-progress
exploration_type: idea
last_updated: 2026-05-18
last_updated_by: Taras
related: [[2026-05-15-client-side-mcp]]
---

# Humans as first-class users: UI, auto-linking, per-user controls — Brainstorm

## Context

> **Related brainstorm — same UI surface:** The "People page" discussed here and the "Users page" in [[2026-05-15-client-side-mcp]] are **the same UI surface**. The MCP brainstorm has already specced the schema (`user_tokens`, `user_identity_events`, `users.dailyBudgetUsd`, `users.status`) and operator endpoints (`GET/POST/PATCH /users`, `POST /users/:id/mcp-tokens`, etc.) that this brainstorm needs as scaffolding. Goal: when the MCP plan lands, its migration is **zero new tables** (already there from this work), its DB helpers are **reused** (already there), and its operator UI is **additive** (token-mint dialog + token-list row) on an existing People page.

**Triggering feedback:** Someone reported that the bot can't connect "Daniel (dashboard)" to "fuvidani (GitHub)" or "daniel (Linear)" to a GitHub handle. The feedback is partially accurate.

**What exists today** (verified via codebase investigation):

- Migration `src/be/migrations/031_user_registry.sql` defines a canonical `users` table with optional + UNIQUE columns: `slackUserId`, `linearUserId`, `githubUsername`, `gitlabUsername`, `email`, `name`, `role`.
- `manage-user` MCP tool (`src/tools/manage-user.ts`) — lead-agent-only — creates/updates/deletes/lists users.
- `resolve-user` MCP tool (`src/tools/resolve-user.ts`) — looks up canonical user by any identifier.
- Webhook handlers (`src/github/handlers.ts`, `src/linear/sync.ts`, `src/slack/handlers.ts`) call `resolveUser({…})` to get `requestedByUserId` for created tasks.

**Gaps:**

1. **No UI** — `ui/src/` has no "People / Members / Identities" page. The only authoring path is the MCP tool, in practice used only by lead agents.
2. **No auto-linking** — if a Linear issue arrives from a Linear user that has no `users` row, `requestedByUserId` is silently `undefined`. No email-based merge, no name fuzzy-match, no "first seen" auto-create.
3. **No claim flow** — humans can't introduce themselves to the swarm or claim their identities.
4. **Per-user controls are scattered or absent** — e.g. Slack user rate limits (if/where they exist) aren't surfaced.
5. **"Users" today are mostly conceptual** — they exist as identity-mapping records, but humans are not really first-class actors in the swarm UX. The dashboard treats agents and tasks as the primary entities.

**Goals to explore:**

1. Dashboard UI for managing users + their integration identities
2. Automatic / heuristic identity linking (email-based merge, first-seen auto-create, claim flow)
3. Surface per-user controls already supported (Slack user limits, etc.)
4. Make humans first-class users of the swarm (not just agents / lead routing)

## Exploration

### Q1: Who's the primary actor and what can they do in the swarm?

**Answer:** Humans are there to **see and configure** the swarm. **Workers are always agents.** Humans don't get assigned work as if they were agents.

**Insights:**

- Closes off "humans as workers" — no need to design queueing, capacity, or task-execution UX for humans.
- The UI is fundamentally a **dashboard + configuration surface**, not a work queue.
- "First-class" here means: a human has a profile, identity mappings, controls, visibility into what the swarm does on their behalf — not that they execute tasks.
- Routing model stays: tasks created by humans (via Slack/Linear/GitHub) get `requestedByUserId` set, agents pick them up.

### Q2: What's the auth model?

**Answer:** Currently access is only via the global swarm API key.

**Insights:**

- This is the **current constraint**, not necessarily the future direction — but it sets the baseline.
- Implication: if we don't add new auth, the UI is **operator-only**. Anyone with the API key has full admin powers; everyone else has no access.
- Auto-linking must be the primary mechanism for getting identities right, because end users can't "claim" anything themselves without auth.
- Adding per-user auth (OAuth / magic-link) is a separate, larger initiative — should probably not block this UI.

### Q3: V1 scope — operator-only, or include end-user auth?

**Answer:** **Operator-only v1.**

**Insights:**

- Confirmed: no auth code in v1. The dashboard stays API-key-gated.
- Auto-linking becomes the **critical feature** — the operator's experience hinges on it being smart enough that they rarely manually wire identities.
- v1 deliverables collapse to: (a) People page (CRUD), (b) auto-linking heuristics, (c) per-user controls surfaced.

### Q4: Auto-merge by email — what should happen when Linear webhook with `email=daniel@acme.com` arrives and an existing row has same email but no `linearUserId`?

**Answer:** **Auto-merge by email.** Atomically set the linearUserId on the existing row. No human confirmation needed.

**Insights:**

- Email is being treated as a trusted identity primitive — strong opinion, simplifies the logic.
- This means we MUST fetch email aggressively from every integration (Slack `users.info`, Linear's actor email, GitHub commit email or `noreply` profile email, etc.).
- Implications for the data model: email is the de facto join key. Should we add a `user_emails` table for multi-email support? (Some people have work + personal emails.)
- Edge case: two integrations report different emails for what's actually the same person → still creates duplicate rows. Operator merge tool still needed.
- Risk: a user updates their email in one integration and we accidentally auto-merge them with someone else who picked up that email. Low likelihood but not zero.

### Q5: Should the system auto-create a `users` row for unknown identities?

**Answer:** **Auto-create only if email is present.** No email → no row. We should proactively fetch email from integration user-info APIs when the webhook payload doesn't include it.

**Insights:**

- Combined with Q4, this gives a deterministic auto-link pipeline:
  1. Webhook arrives → check by integration ID → if found, done.
  2. Check email in payload → if missing, call integration's user-info API to fetch.
  3. If email present → check for existing row with that email → merge if found, create if not.
  4. If email genuinely unavailable → no auto-create. `requestedByUserId` stays undefined for that task.
- Need to surface "unknown identities seen recently with no email" somewhere so the operator isn't blind to them.
- Each integration adapter (Slack, Linear, GitHub, GitLab) needs an `enrichUserFromIntegration(externalId): { email? }` helper. Cache aggressively — Slack rate limits matter.
- Storage hygiene: rows with no integration ID = no `users` row at all (they were never created), but agent-triggered events from unknown actors must still record SOMETHING for traceability — probably on the task itself (`vcsAuthor`, `slackUserId` raw fields) without creating a `users` row.

### Q6: Free-form metadata + custom integrations — what's the data-model shape?

**User raised:** could we have a TS-typed JSON metadata field, and also support custom integration fields more generally?

**Decision direction:** **Both normalized + JSON metadata.**

- New table `user_external_ids(user_id, kind, externalId, PRIMARY KEY (kind, externalId))` — the canonical identity-lookup primitive. Symmetric across first-party (slack/linear/github/gitlab) and custom (jira/anything) integrations.
- New `metadata` JSON column on `users` for free-form data (preferences, notes, internal HR codes, anything not used as a lookup key). Validated by Zod at the API boundary, stored as JSON text.
- Migration is forward-only: create `user_external_ids`, backfill from existing UNIQUE columns, keep old columns as a deprecated read-side cache for one release, drop in a follow-up.

**Honest framing correction:**

- The argument for normalizing isn't "scale" (this is one SQLite per swarm) — it's hot-path correctness (resolveUser is one indexed probe regardless of integration count) and API symmetry (new integrations = insert rows, not schema migrations).
- The existing four `*UserId`/`*Username` UNIQUE columns are already a prematurely-denormalized version of `user_external_ids`. Promoting them is the cleaner data model, not extra complexity.

### Q7: What kinds of per-user controls should the UI surface?

**Answer (initial pick):** **Rate / budget limits** and **Per-user preferences**. (More context coming from another brainstorm.)

**Insights so far:**

- Rate/budget limits = per-user enforcement primitive. Needs a place to store: max concurrent tasks, max tasks/day, max cost/period, plus current usage counters. Probably a separate `user_limits` table (or columns on `users`) so we don't conflate identity data with policy data.
- Per-user preferences = the JSON `metadata` column's first real customer. E.g., `metadata.notifications = { slack: "dm" | "channel-reply" }`, `metadata.defaultRepo = "..."`, `metadata.language = "en"`.
- Both feel orthogonal to identity itself — they're attached to users but operationally separable.
- Audit/history view was NOT picked but is probably implicit (the People-detail page would naturally include task history). Will revisit.
- Allow/deny lists were NOT picked. This implies trust is currently established at a different layer (maybe the integration level — only known orgs/workspaces, etc.) — worth confirming when context expands.

**Awaiting:** additional context from another brainstorm to refine.

### Q8: Should the People-page migration co-land the MCP-brainstorm schema in one migration?

**Context:** The MCP brainstorm ([[2026-05-15-client-side-mcp]] Core Requirement #1) specs a migration adding `users.dailyBudgetUsd`, `users.status`, `user_tokens`, `user_identity_events`. This brainstorm Q6 adds `user_external_ids` + `users.metadata`. Two brainstorms, one users-related migration coming up either way.

**Decision:** **Yes — one migration, all of it.**

```sql
-- src/be/migrations/NNN_users_first_class.sql (single file, forward-only)

-- (1) Normalized identity lookup (this brainstorm Q6)
CREATE TABLE user_external_ids (
  userId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- 'slack' | 'linear' | 'github' | 'gitlab' | 'jira' | any custom
  externalId  TEXT NOT NULL,
  createdAt   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (kind, externalId)
);
CREATE INDEX idx_user_external_ids_userId ON user_external_ids(userId);

-- (2) Free-form metadata (this brainstorm Q6)
ALTER TABLE users ADD COLUMN metadata TEXT;     -- JSON, Zod-validated at API boundary

-- (3) Budget cap (MCP brainstorm)
ALTER TABLE users ADD COLUMN dailyBudgetUsd REAL;  -- NULL = unlimited

-- (4) Lifecycle status (MCP brainstorm — lands in v1 to keep v1.5 small)
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('invited', 'active', 'suspended'));

-- (5) Multi-token-per-user MCP tokens (MCP brainstorm)
CREATE TABLE user_tokens (
  id           TEXT PRIMARY KEY,
  userId       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  tokenHash    TEXT NOT NULL UNIQUE,
  createdAt    INTEGER NOT NULL DEFAULT (unixepoch()),
  lastUsedAt   INTEGER,
  revokedAt    INTEGER
);
CREATE INDEX idx_user_tokens_userId ON user_tokens(userId);

-- (6) Identity-event audit trail (union of both brainstorms' needs)
CREATE TABLE user_identity_events (
  id           TEXT PRIMARY KEY,
  userId       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eventType    TEXT NOT NULL CHECK (eventType IN (
                 'auto_merge', 'manual_merge',
                 'identity_added', 'identity_removed',
                 'token_minted', 'token_revoked',
                 'budget_changed', 'status_changed'
               )),
  actor        TEXT NOT NULL,                   -- 'system' | operator-api-key fingerprint | users.id
  beforeJson   TEXT,                            -- full row snapshot before
  afterJson    TEXT,                            -- full row snapshot after
  createdAt    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_user_identity_events_userId_createdAt
  ON user_identity_events(userId, createdAt DESC);

-- (7) Backfill existing identity columns into user_external_ids
INSERT INTO user_external_ids (userId, kind, externalId)
  SELECT id, 'slack',  slackUserId     FROM users WHERE slackUserId    IS NOT NULL
  UNION ALL
  SELECT id, 'linear', linearUserId    FROM users WHERE linearUserId   IS NOT NULL
  UNION ALL
  SELECT id, 'github', githubUsername  FROM users WHERE githubUsername IS NOT NULL
  UNION ALL
  SELECT id, 'gitlab', gitlabUsername  FROM users WHERE gitlabUsername IS NOT NULL;

-- (8) Drop the deprecated identity columns (Q15 decided: same PR, no soak period).
--     All callers must be rewired to use user_external_ids in the same PR.
ALTER TABLE users DROP COLUMN slackUserId;
ALTER TABLE users DROP COLUMN linearUserId;
ALTER TABLE users DROP COLUMN githubUsername;
ALTER TABLE users DROP COLUMN gitlabUsername;
```

**Why one migration:**

- SQLite migrations are forward-only and tested fresh-DB + existing-DB (per CLAUDE.md). Two migrations doubles the test matrix for the same logical change.
- No version-skew window where the People page exists but the MCP scaffolding has to wait for migration N+1.
- `eventType` set is the **union** of both brainstorms (this brainstorm needs `auto_merge`/`identity_added`/`identity_removed` for webhook auto-link audit; MCP brainstorm needs `token_*`/`budget_changed`/`status_changed` — included here so the table is "done" the first time).
- Adds `status_changed` (not in MCP brainstorm's original list) because `users.status` is now writable and any change to it deserves an audit row.
- Migration filename should be something like `NNN_users_first_class.sql` — semantically captures both efforts under one rubric.

**Caveats:**

- **Q15 update:** the migration **does** drop the deprecated identity columns in the same file. Same-PR cleanup is more honest than a soak period (see Q15 for the full rationale). Every reader must be rewired in the same PR — exhaustive call-site inventory is a plan-time deliverable.
- `user_external_ids` PRIMARY KEY is `(kind, externalId)` — a single Linear user ID can only point to one canonical user, which matches today's UNIQUE constraint semantics. Merge conflicts (two rows claim the same externalId) are caught at write time.

### Q9: Should the auto-link path emit `user_identity_events` from day one?

**Decision:** **Yes, day one.** Every auto-merge, identity-add, and identity-remove triggered by a webhook writes a `user_identity_events` row in the same transaction.

**Why:**

- Q4 (auto-merge by email) intentionally skips human confirmation. That's a silent merge — and silent merges are exactly the kind of footgun where, six weeks later, someone asks "why is Daniel's GitHub now pointing at Sandra's row?" and there's no answer.
- The audit table from Q8 is cheap to write to. Skipping it on day one to "ship faster" is a false economy — the moment we need to debug a bad auto-link, we'd want this data and won't have it.
- Identity-events should be the **only** path that ever mutates `user_external_ids` or core identity columns. If you can't observe it in `user_identity_events`, it didn't happen — a strong invariant that prevents drift.

**Actor shape:**

| Trigger | `actor` value | Example |
|---|---|---|
| Webhook auto-link (no human in loop) | `'system'` | Linear webhook → email match → merge |
| Operator action via UI | `'op:<sha256(APIKey)[:12]>'` | Manual merge from People page, token mint, budget change |
| Self-service action (v1.5+, magic-link or MCP) | `<users.id>` | User mints their own additional MCP token |

- Prefixing operator fingerprints with `op:` keeps the value-space disambiguated from `users.id` (which has its own prefix scheme).
- Hashing the API key (truncated) — not storing plaintext — lets us tell "same operator did these N actions" without leaking the key. CLAUDE.md secret-scrubber rules still apply if it ever shows up in logs (it shouldn't).
- `'system'` is sufficient for auto-link provenance in v1. If/when we add multiple auto-link sources (e.g. a "merge suggestion" job vs immediate webhook merge), specialize to `'system:webhook'` / `'system:bg-job'`.

**Event payload shape:**

- `beforeJson` = full `users` row snapshot before the change (or `null` for `identity_added` on a fresh row).
- `afterJson` = full `users` row snapshot after (or `null` for `identity_removed`/cascade deletes).
- For `auto_merge`: `beforeJson` is the row state pre-link, `afterJson` is post-link. The fact that this was a merge vs a new-row-create is implicit in whether `beforeJson` had only one identity vs gained another.
- The "source of the new identity" (which integration's webhook triggered this) goes in the `actor` string or in an optional `contextJson` column — leaving out for now; YAGNI until a debug actually needs it. The `eventType` + diff is usually enough.

### Q10: Where does the v1 server-side logic live?

**Decision:** **`src/be/users.ts`** — pure DB functions. **No DB logic in HTTP handlers.**

**Reference:** CLAUDE.md "Architecture invariants" — *"The API server (`src/http.ts`, `src/server.ts`, `src/tools/`, `src/http/`) is the sole owner of the SQLite database."* So this file is API-server-side; workers call via HTTP, never import it directly. The boundary checker (`scripts/check-db-boundary.sh`) will enforce this.

**Surface (initial — keep small, expand as needed):**

```ts
// src/be/users.ts — pure DB functions, no HTTP

export function findUserById(id: string): UserRow | null;
export function findUserByExternalId(kind: string, externalId: string): UserRow | null;
export function findUserByEmail(email: string): UserRow | null;

// Auto-link primitive — used by webhook handlers + MCP middleware
export function findOrCreateUserByEmail(
  email: string,
  hints: { name?: string; metadata?: Record<string, unknown> },
  actor: IdentityActor
): { user: UserRow; created: boolean };

// Identity ops — always emit an event row in the same tx
export function linkIdentity(
  userId: string,
  kind: string,
  externalId: string,
  actor: IdentityActor
): void;
export function unlinkIdentity(
  userId: string,
  kind: string,
  externalId: string,
  actor: IdentityActor
): void;

// Token ops — return plaintext from mint, only hash persisted
export function mintToken(
  userId: string,
  label: string | null,
  actor: IdentityActor
): { tokenId: string; plaintext: string };
export function revokeToken(
  tokenId: string,
  actor: IdentityActor
): void;
export function resolveUserByToken(plaintext: string): UserRow | null; // for MCP middleware

// Audit — explicit when you don't fit the above primitives
export function recordIdentityEvent(
  userId: string,
  eventType: IdentityEventType,
  actor: IdentityActor,
  before: UserRow | null,
  after: UserRow | null
): void;

type IdentityActor = { kind: 'system' | 'operator' | 'user'; id: string };
```

**Callers:**

| Caller | Functions used |
|---|---|
| Webhook handlers (`src/github/handlers.ts`, `src/linear/sync.ts`, `src/slack/handlers.ts`) | `findUserByExternalId`, `findOrCreateUserByEmail`, `linkIdentity` |
| MCP middleware on `/mcp/user` (MCP brainstorm) | `resolveUserByToken` |
| Operator HTTP endpoints (`GET/POST/PATCH /users`, `POST/DELETE /users/:id/mcp-tokens`) | All of the above |
| Operator UI via HTTP — never imports this file | (indirect through endpoints) |

**Why this matters:**

- Without `src/be/users.ts`, the MCP brainstorm's middleware would either (a) duplicate token-resolution logic from a future endpoint, or (b) push DB logic into the HTTP handler. Both options age badly.
- Webhook auto-link in this brainstorm and operator token-mint in the MCP brainstorm share the same identity-event emission requirement (Q9). Centralizing in `src/be/users.ts` is what makes that consistent without copy-paste.
- Pure functions = unit-testable without spinning up HTTP. Tests can hit an in-memory `bun:sqlite` and call these directly.

### Q11: Should `dailyBudgetUsd` ship in the People page even though enforcement is the MCP brainstorm's concern?

**Decision:** **Yes — surface it in the People page now.**

**Argue-for (why ship it):**

- The column is in the migration (Q8). Once it exists in the DB, the edit field + "Unlimited" badge in the UI is **trivial incremental work** — a number input and a conditional badge. Maybe 30 lines of TSX.
- Operators get visibility into who has caps and who doesn't, even before enforcement lands. That visibility is itself useful — "huh, I never set a cap for Daniel" is a question that should be answerable today.
- The MCP brainstorm's enforcement wiring (Core Requirement #10) can land later without UI rework — it'll just start respecting a value the operator has already been setting.
- Avoids the "decorative-then-functional" awkwardness later, where the UI suddenly grows a field tied to behaviour that didn't exist before. Better to have it visible from day one.
- Setting the budget emits a `budget_changed` event (Q9). That's free audit value.

**Argue-against (why defer):**

- Operators might assume the cap is enforced when it isn't, leading to a "wait, why didn't this kill the task?" moment.
- Counter-mitigation: label the field "Daily budget cap (USD) — enforced once MCP user-tokens ship" or similar. Honest UI > hidden UI.

**Net:** ship it with the honest label. Cost is ~negligible; value is real (visibility + zero-rework when enforcement lands).

### Q12: Multi-email per user — keep JSON or normalize?

**Schema check:** `users.emailAliases TEXT DEFAULT '[]'` (JSON array) already exists in migration 031. This isn't green-field.

**Decision:** **Keep `emailAliases` as JSON.**

**Why:**

- Already works. No migration churn.
- Auto-merge SQL stays simple:
  ```sql
  SELECT * FROM users
   WHERE email = :candidate
      OR EXISTS (SELECT 1 FROM json_each(emailAliases) WHERE value = :candidate)
   LIMIT 1;
  ```
- Cost analysis: typically 1–3 emails per user. `json_each` over a 3-element array per webhook is microseconds. The hot-path argument that drove `user_external_ids` normalization (N integrations and growing) doesn't apply — emails don't have an analogous explosion.
- If we ever need per-alias metadata (verified flag, source-of-alias, primary toggle), normalize then. YAGNI today.

**Insights:**

- The MCP brainstorm already assumed `emailAliases` existed (line 22), so the auto-merge logic there is also unblocked.
- `findUserByEmail` in `src/be/users.ts` (Q10) must check both `email` and `emailAliases` — easy to forget. Worth a unit test that asserts both paths.
- Adding an email via the UI (alias) doesn't emit a dedicated event type in our current set. Could reuse `identity_added` (the diff is in `afterJson.emailAliases`) or add `email_added`/`email_removed` later. Defer.

### Q13: Where does the integration email-enrichment cache live?

**Decision:** **Reuse `kv_entries` (migration 061).** No new table.

**How:**

- Namespace: `integration:user-enrichment:<kind>` (e.g. `integration:user-enrichment:slack`, `…:linear`, `…:github`).
- Key: `<externalId>` (the integration's user ID — Slack user id, Linear user id, GitHub login, etc.).
- Value: JSON `{ email?, name?, fetchedAt }`. `value_type = 'json'`.
- TTL: `expires_at = now_ms + 24h`. Stale enrichment is fine — if a Slack user changes their email, we'll re-fetch within a day.
- Lazy-expire on read (kv's default behavior — no background sweep needed).

**Why this fits:**

- `kv_entries` already has the exact shape we need (namespaced, expiring, lazy-cleanup, indexed by PK). No new migration, no new helper.
- WITHOUT ROWID + composite PK = fast lookup. Cost per cache-hit is essentially free.
- Consistent with how other transient swarm state is stored (per the migration's docstring: "namespace mirrors `agent_tasks.contextKey`" — using `integration:*` as a namespace is the same pattern).
- Each integration adapter's enrichment helper becomes: `try kvGet → on miss, fetch from API → kvSet with 24h TTL`. Symmetric across integrations, no per-adapter cache plumbing.

**Insights:**

- The auto-link pipeline is now: `findUserByExternalId` → miss → kvGet enrichment → miss → integration API → kvSet → `findOrCreateUserByEmail`. Two-tier hit before the network call.
- This dovetails with rate-limit headers: Slack's 429 means "back off"; we should respect it AND NOT cache the failure. Only cache successful enrichments. Failures stay uncached so we don't lock in a "we couldn't get email" state.
- One subtle issue: the `kv_entries` access functions are API-server-side (DB invariant). Webhook handlers in `src/github/handlers.ts` etc. that call into enrichment helpers will go through `src/be/users.ts` and from there `src/be/kv.ts` (or wherever the kv helpers live). Worker code is not in the picture here — webhook handlers run on the API server.

### Q14: Where do "unmapped" webhook events surface for the operator?

**Decision:** **Dedicated `Unmapped` page/tab.** Sibling route to People — e.g. `/users/unmapped` or `/people/unmapped`.

**Why:**

- Keeps the People page focused on actual people. Unmapped events are operationally a different concern (triage queue) and benefit from their own list semantics (filters by integration, by recency, etc.).
- Lets us add filter chips (Slack / Linear / GitHub), sort by frequency ("this externalId appeared 14 times this week"), and a "create user from this externalId" CTA per row.
- Scales gracefully — if the list gets long, it has its own scroll/pagination without crowding the People page.

**What the data backing this page is:**

- Best source: a tail of webhook events that came in with an external identity but where `findOrCreateUserByEmail` returned no row (couldn't fetch email). We need to record these somewhere lightweight.
- Two options for storage:
  - **(a) Reuse `kv_entries`** with namespace `integration:unmapped:<kind>`, key = `<externalId>`, value = `{ lastSeenAt, count, sampleEventType, sampleContext }`. INCR-able. Auto-expires via TTL (e.g. 30 days).
  - **(b) New table** `unmapped_identity_events(id, kind, externalId, eventType, contextJson, seenAt)` with rolling retention. More structured but more weight.
- Pick **(a)** for v1 — fits the existing kv table, gives us "count + last seen + sample" which is what the UI needs. New table only if we discover (a) doesn't have enough data for triage.

**UI sketch:**

```
/users/unmapped
┌──────────────────────────────────────────────────────────────────┐
│ Unmapped identities  [Slack 12] [Linear 3] [GitHub 1]            │
├──────────────────────────────────────────────────────────────────┤
│ slack:U07ABCDE  · seen 14× · last 2h ago · "@bot please…"        │
│   [Create user from this Slack ID]  [Link to existing user…]     │
│ linear:user-xyz · seen 3×  · last 1d ago · assigned issue ENG-44 │
│   [Create user from this Linear ID] [Link to existing user…]     │
│ ...                                                              │
└──────────────────────────────────────────────────────────────────┘
```

**Insights:**

- "Link to existing user" flow needs a user picker (search by name/email) → confirm → call `linkIdentity` → row drops from Unmapped (entry cleared from kv on success).
- "Create user from this externalId" requires asking for an email (since auto-create required one). The form is essentially "create user with email X, link this external identity".
- Recording sample context (last message text from Slack, last issue title from Linear) makes the operator's "who is this?" guess easier. Truncate aggressively (e.g. 100 chars) to avoid storing user content in bulk.
- Privacy nit: sample context may contain user-typed text. We don't need full payloads; a stub is fine. Document the retention policy.
- The "count" metric helps prioritize — a Slack ID appearing 30 times this week is a real user we should onboard; one appearing once might be a bot or one-off.

### Q15: When do the deprecated identity UNIQUE columns get dropped?

**Decision:** **Same PR. Just rip them.**

**What this means for the migration:**

```sql
-- After the backfill INSERT into user_external_ids:
-- SQLite supports column drop natively as of 3.35 (well in range for bun:sqlite).

ALTER TABLE users DROP COLUMN slackUserId;
ALTER TABLE users DROP COLUMN linearUserId;
ALTER TABLE users DROP COLUMN githubUsername;
ALTER TABLE users DROP COLUMN gitlabUsername;
```

**What this means for the code change:**

- **Single PR rewires every reader** of those four columns. No "transition period" code. No dual-write.
- Caller inventory needs to be exhaustive before merge — anything missed = NULL/missing-column runtime error.
- Confirmed call-sites to rewire (preliminary, plan should expand):
  - `src/be/db.ts` — `resolveUser()` — definitely reads the four columns; replace with `findUserByExternalId(kind, externalId)` from `src/be/users.ts`.
  - `src/tools/resolve-user.ts` — MCP tool; presumably wraps the above.
  - `src/tools/manage-user.ts` — write paths; replace with `linkIdentity`/`unlinkIdentity`.
  - `src/github/handlers.ts`, `src/linear/sync.ts`, `src/slack/handlers.ts` — webhook handlers; replace inline column reads.
  - Tests under `src/tests/` — seed data and assertions.
- Indexes on the dropped columns (`idx_users_slackUserId`, etc. if any exist) are dropped automatically with the columns.

**Why "same PR" wins despite the bigger blast radius:**

- The alternative — "soak for one release" — creates a window where two sources of truth exist (`users.slackUserId` and `user_external_ids` rows for the same data). Writes must update both; reads must agree. That coordination has its own bug surface, and historically those windows last longer than planned.
- Single-PR cleanup forces an honest call-site inventory upfront. That inventory is needed eventually anyway — better to do it once than half-do it twice.
- `bun:sqlite` + small dataset = a single migration that DROPs columns and rewires readers is genuinely a few hundred lines, not thousands. The blast radius is bounded.

**Risk mitigation:**

- **Required** before merge: an exhaustive grep for the four column names across the whole repo (excluding the migration itself). Plan-time deliverable.
- **Required** before merge: a fresh-DB test that runs the migration + a representative round-trip (webhook arrives → user resolved → task created with correct `requestedByUserId`).
- **Required** before merge: an existing-DB test that takes a real-shaped pre-migration snapshot, runs the migration, and asserts every original identity now lives in `user_external_ids` with no data loss.
- Pre-push hook + CI already enforce the DB-boundary invariant (`scripts/check-db-boundary.sh`), so accidental worker-side imports of `src/be/users.ts` are caught.

**Insights:**

- This is the most aggressive part of the plan. It deserves the most careful research pass — exact call-site list. **Tips the recommendation toward `/desplega:research` before `/desplega:create-plan`.**
- After this PR, the schema is honest: identities are normalized, there's one source of truth, and any future integration is just an insert into `user_external_ids`. No future migration touches identity columns again.

### Q16: Operator-fingerprint length for audit `actor` field?

**Decision:** **16 hex chars.** Audit `actor` for operator-driven events is `op:<sha256(APIKey)[:16]>`.

**Why:**

- ~64 bits of entropy — no realistic collision risk even if API keys ever rotate or multiply.
- 16 chars is still scannable in audit logs ("oh, `op:a3f2b9e4c1d87a52` made all these changes last Tuesday").
- Cheap to canonicalize in `src/be/users.ts` — one helper: `function fingerprintApiKey(rawKey: string): string`.

**Implementation notes:**

- The operator-auth middleware that gates `/users`-prefixed endpoints already validates `Authorization: Bearer <swarm-API-key>`. Extending it to produce a fingerprint and stash it on the request context is ~5 lines.
- **API-key access invariant (per updated CLAUDE.md, 2026-05-18):** the swarm API key MUST be read via `getApiKey()` from `src/utils/api-key.ts` — never `process.env.API_KEY` / `process.env.AGENT_SWARM_API_KEY` directly. Precedence: `AGENT_SWARM_API_KEY` > `API_KEY`. Enforced by `scripts/check-api-key-boundary.sh` (CI). `fingerprintApiKey()` and the auth middleware must therefore call `getApiKey()`, not `process.env.*`.
- Per CLAUDE.md secret-scrubber rules: the **fingerprint** is safe to log (it's a one-way hash). The **raw API key** must never appear in logs / `session_logs` / jsonl emissions. The existing scrubber handles `Bearer …` patterns; confirm coverage extends to "stripped of `Bearer ` prefix" cases.
- `'system'` and `<users.id>` actors are unchanged from Q9; only the operator variant gets its length finalized here.

### Q17 (folded from 2026-05-18 research): findings that adjust prior decisions

Full research doc: [[2026-05-18-user-identity-refactor]] (in `thoughts/taras/research/`). The headline shifts to prior Qs:

**A. GitHub identities are operator-manual-link only (adjusts Q5).**

- Confirmed: GitHub webhooks never carry `sender.email`. `GET /users/{login}` returns email only if the user has set it public (rare). App-installation tokens can call that endpoint but the data isn't there in practice. Commit emails are usually `<id>+<login>@users.noreply.github.com` (privacy redirect) — useless for matching.
- **Adjustment:** Q5's "auto-create only if email is present" pipeline is unchanged in spirit, but for GitHub the practical answer is "no email is ever present → fall straight through to unmapped tracking." Operator triages on the Unmapped page (Q14).
- Plan-time: the `enrichUserFromIntegration('github', login)` helper is **not built** — it would be empty-by-design. Skip it; have the GitHub webhook handler call `findUserByExternalId('github', login)` and on miss record the unmapped entry directly.

**B. Linear name-only fallback is dropped (adjusts Q4/Q5).**

- The current `resolveUser` in `src/be/db.ts` walks `linearUserId → email → name`. The name-only path is a fuzzy-match heuristic and is incompatible with the Q4/Q5 "email is the trusted primitive" stance.
- **Adjustment:** the new Linear cascade is `findUserByExternalId('linear', actorLinearId)` → on miss + email present, `findOrCreateUserByEmail(actorEmail, {name})` → `linkIdentity`. No name-only fallback. ~5–10 lines explicit, replacing one `resolveUser({linearUserId, email, name})` call.
- Plan-time gap: research flags that Linear's *system-actor* webhook events (issue auto-transitions etc.) may have no `actor.id` and no `actor.email`. These currently fall through `resolveUser` silently. After the refactor, they'll become unmapped entries. Operator will see noise from "user: system" on the Unmapped page. **Decision needed at plan-time:** either (a) hard-skip Linear events where `actor.kind === 'system'` (or whatever the field is), or (b) accept the noise and let the operator dismiss those entries. Defer.

**C. kv_entries helpers live in `src/be/db.ts`, not a separate file (adjusts Q13).**

- All KV helpers (`getKv`, `upsertKv`, `incrKv`, `listKv`, `countKv`, `deleteKv`) are exports from `src/be/db.ts:9770-10060`. The brainstorm Q13 wording assumed a `src/be/kv.ts` — minor; the import path just changes.
- All primitives needed already exist. **No new kv primitive needed.** `incrKv` is atomic (transactional). `listKv` supports `prefix` filter with LIKE-escaping.

**D. Unmapped record must split into two kv rows (adjusts Q14).**

- `incrKv` requires `value_type='integer'`. A JSON blob with a `count` field cannot be INCR'd atomically.
- **Adjustment:** the unmapped record in `kv_entries` namespace `integration:unmapped:<kind>` becomes **two rows per externalId**:
  - Key `<externalId>:meta` — `value_type='json'`, value `{ lastSeenAt, sampleEventType, sampleContext }`. Upserted on each webhook.
  - Key `<externalId>:count` — `value_type='integer'`. `incrKv` per webhook.
- Both rows TTL'd at 30 days. UI joins by `externalId` via two `getKv` calls (or one `listKv` per externalId-prefix).
- Trade-off rejected: a single JSON row with read-modify-write is non-atomic; two simultaneous webhooks race and lose increments. Two-row design wins.

**E. Slack already has an in-memory email cache — replace it with kv (adjusts Q13).**

- `src/slack/handlers.ts:38` declares a process-local `userEmailCache: Map<string, string | null>` used at `:114-125`. It does the exact thing Q13 specs, just in-memory.
- **Adjustment:** the new `enrichSlackUserEmail(slackUserId)` helper replaces both — kv-backed for persistence across API-server restarts, same in-process semantics. Only successful results cached; nulls/failures not cached so retries on rate-limit recovery still work.

**F. AgentMail handler joined the caller inventory (one more rewire, not noted in prior Qs).**

- `src/agentmail/handlers.ts:164` calls `resolveUser({ email: senderEmail })`. After the refactor: `findOrCreateUserByEmail(senderEmail, ...)`. One-line change; auto-create per Q5 fits naturally.

**G. `src/be/users.ts` surface needs one more helper: `getUserIdentities(userId)`.**

- The People page (Q11) renders identity badges per row. Without an explicit join, the HTTP handler can't compose the response shape.
- **Adjustment:** add `getUserIdentities(userId): Array<{kind, externalId}>` to the Q10 surface. Called by the GET `/users` and GET `/users/:id` handlers when composing responses.

**H. Boundary checker confirmed silent on `src/be/users.ts` and all callers (confirms Q10).**

- `scripts/check-db-boundary.sh` allow-lists worker dirs only (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`, `plugin/opencode-plugins/`). Every prospective caller in this refactor is API-side. ✅

**I. Blast radius is small — ~30 file:line refs, not 150 (confirms Q15 feasibility).**

- The naive grep for the four column names returns 150+ hits, but >80% are for the unrelated `agent_tasks.slackUserId` / `inbox_messages.slackUserId` columns (different tables — **NOT** being dropped). The actual `users.<col>` references are concentrated in a tight set:
  - `src/be/db.ts` — helpers + `resolveUser`
  - `src/tools/{resolve-user,manage-user}.ts`
  - `src/http/users.ts`
  - 4 webhook handlers (`src/slack/handlers.ts`, `src/slack/assistant.ts`, `src/slack/actions.ts`, `src/github/handlers.ts`, `src/gitlab/handlers.ts`, `src/linear/sync.ts`, `src/agentmail/handlers.ts`)
  - `src/types.ts`, `ui/src/api/types.ts`
  - `src/tests/user-identity.test.ts`
  - `scripts/backfill-seed-users.sql`
  - Docs: `MCP.md`, `docs-site/.../mcp-tools.mdx`, `plugin/commands/user-management.md` (+ generated `pi-skills/user-management/SKILL.md`)
- Same-PR cleanup is comfortably tractable. Open Question on "is the blast radius too big?" — resolved.

**J. `AgentTaskSourceSchema` parity — no change needed.**

- Research confirmed the new migration does not add task-source values; the schema in `src/types.ts:56-70` is untouched.

### Q18: `resolve-user` MCP tool input shape — break and migrate

**Decision:** Option 2 — **new shape, drop `name`, mechanical worker migration in the same PR.**

```ts
// src/tools/resolve-user.ts
const InputSchema = z.object({
  kind: z.string().optional(),        // 'slack' | 'linear' | 'github' | 'gitlab' | 'jira' | any custom
  externalId: z.string().optional(),
  email: z.string().email().optional(),
}).refine(
  (v) => (v.kind && v.externalId) || v.email,
  { message: "Provide either (kind + externalId) or email" }
);
```

**Why:**

- One tool, symmetric schema. No MCP-surface bloat.
- `(kind, externalId)` is unambiguous; refine guarantees at least one identifier.
- `name` drops cleanly — research §2 confirmed no caller uses the name-only resolution path.
- Tool name stays `resolve-user` — keeps muscle memory and doc-link continuity.

**Plan-time deliverables this adds:**

- Grep for `resolve-user` invocations across `src/` AND `plugin/commands/`. Inventory who calls it. Replace `{slackUserId: X}` → `{kind: "slack", externalId: X}`, etc.
- Update `MCP.md`, `docs-site/.../mcp-tools.mdx` (resolve-user section), and `plugin/commands/user-management.md` to the new shape.
- Old field names (`slackUserId`, etc.) MUST NOT remain in the Zod — workers calling the old shape should error out at runtime, not silently degrade. This is the safer break-and-migrate semantics.



### Key Decisions

1. **Humans are first-class but observers, not workers** (Q1). The People page is dashboard + configuration. Agents remain the only thing that executes work.
2. **V1 is operator-only**, gated by the existing global API key (Q2, Q3). No end-user auth in this initiative — MCP brainstorm covers token-based per-user auth on top.
3. **Auto-merge by email is the default** (Q4). When an integration identity arrives with an email that matches an existing row, atomically merge. No human confirmation.
4. **Auto-create only when an email is available** (Q5). If email isn't in the webhook payload, fetch from the integration's user-info API; if still unavailable, no row is created.
5. **Schema is normalized for identity** (Q6) — `user_external_ids(kind, externalId)` is the canonical lookup primitive. `users.metadata` JSON column for free-form data.
6. **Per-user controls in v1:** rate / budget limits (`dailyBudgetUsd`) and preferences (under `users.metadata`) (Q7). Allow/deny lists and dedicated audit views deferred.
7. **One co-landed migration** (Q8) — `user_external_ids`, `users.metadata`, `users.dailyBudgetUsd`, `users.status`, `user_tokens`, `user_identity_events`. Single file, single test cycle. The MCP plan adds zero tables on top.
8. **Identity-event audit on day one** (Q9). Every auto-link/merge/identity-mutation writes a `user_identity_events` row in the same transaction. Actor model: `system` / `operator` / `user`.
9. **DB logic lives in `src/be/users.ts`** as pure functions (Q10). API server is sole DB owner per CLAUDE.md. Reused by webhook handlers, MCP middleware (future), operator HTTP endpoints, and tests.
10. **`dailyBudgetUsd` ships in the People page in v1** (Q11), with honest labeling that enforcement comes with the MCP token initiative.
11. **Multi-email stays as `users.emailAliases` JSON** (Q12). The column already exists in migration 031. Auto-merge SQL checks both `email` and `json_each(emailAliases)`. Normalization deferred until per-alias metadata is actually needed.
12. **Integration email-enrichment cache uses `kv_entries`** (Q13). Namespace `integration:user-enrichment:<kind>`, key = `<externalId>`, value = `{ email?, name?, fetchedAt }`, TTL 24h. No new table, no per-adapter cache plumbing.
13. **Dedicated `Unmapped` page** for triage of integration identities the auto-linker couldn't onboard (Q14). Backed by `kv_entries` namespace `integration:unmapped:<kind>` with last-seen + count + sample-context.
14. **Drop deprecated identity columns in the same migration** (Q15) — `slackUserId`, `linearUserId`, `githubUsername`, `gitlabUsername`. Single PR rewires every reader; no soak period; honest single source of truth from day one. Requires exhaustive call-site inventory before merge.
15. **Operator fingerprint = `op:<sha256(API_KEY)[:16]>`** for audit `actor` field (Q16). 16 hex chars (~64 bits). Fingerprint is safe to log; raw key never is.
16. **GitHub identities are operator-manual-link only** (Q17.A). No viable email path. Handler records unmapped on miss; no `enrichUserFromIntegration('github', …)` helper built.
17. **Linear name-only fallback dropped** (Q17.B). Auto-link via email only; no name fuzzy-match. Linear cascade is `findUserByExternalId('linear', id)` → `findOrCreateUserByEmail(email, {name})` → `linkIdentity`.
18. **Unmapped record = two kv rows per externalId** (Q17.D). `<externalId>:meta` JSON + `<externalId>:count` integer. Both 30-day TTL. Atomic INCR via existing `incrKv`.
19. **Slack in-memory cache is replaced by kv-backed enrichment** (Q17.E). Existing `userEmailCache` Map at `src/slack/handlers.ts:38` retired; new helper `enrichSlackUserEmail(slackUserId)` reads/writes `kv_entries` namespace `integration:user-enrichment:slack`.
20. **`getUserIdentities(userId)` added to the `src/be/users.ts` surface** (Q17.G). Required by GET `/users` / GET `/users/:id` for People-page response composition.

### Open Questions

- **Token UX copy** — MCP-brainstorm-side, but the People page will host the mint dialog. JSON snippet shapes for Claude Desktop / Cursor / etc. — plan-time concern.
- **`identity_added` overload for email aliases** (Q12) — Adding an email alias via the UI currently has no dedicated event type. Either reuse `identity_added` with the diff visible in `afterJson.emailAliases`, or add `email_added`/`email_removed`. Defer to plan-time / first-real-use.
- **Linear system-actor events** (Q17.B) — Linear webhooks for system-driven transitions may have no `actor.id` and no `actor.email`. After refactor they become unmapped noise. Plan-time decision: (a) hard-skip system-actor events, or (b) let operator dismiss. Verify against real Linear webhook payloads before merge.
- **`resolve-user` MCP tool input shape** (Q17.A / research §1b) — keep current input shape `{slackUserId, linearUserId, githubUsername, gitlabUsername, email, name}` as a compat shim (workers may have hard-coded it), or rev to `{kind, externalId, email, name}`. Compat shim is the safer call but adds dead-end naming. Defer to plan-time.

### Constraints Identified

- **CLAUDE.md DB ownership invariant** — `src/be/users.ts` is API-server-side. Workers call HTTP endpoints, never import this file. Enforced by `scripts/check-db-boundary.sh`.
- **Forward-only migrations** — `src/be/migrations/NNN_users_first_class.sql`. Tested against fresh DB and existing one. No `down` migration. Migration includes both schema additions AND the drop of deprecated identity columns (no soak period).
- **`route()` factory required** — any new HTTP endpoint (GET/POST/PATCH `/users`, token endpoints) goes through `src/http/route-def.ts`, then `bun run docs:openapi` regenerates the spec.
- **Secret scrubbing** — MCP token plaintext from `mintToken` MUST go through `scrubSecrets` before any log/`session_logs`/jsonl emission. Add `aswt_…` to the scrubber rules at the same time the migration lands.
- **Auto-link emission discipline** — only `src/be/users.ts` mutates identity tables/columns. All paths go through `linkIdentity`/`unlinkIdentity`/`recordIdentityEvent` so the audit trail can't drift.
- **Exhaustive call-site inventory before merge** — because deprecated columns are dropped in the same migration, every reader/writer of `users.slackUserId`/`linearUserId`/`githubUsername`/`gitlabUsername` must be rewired in the same PR. A missed call-site = runtime error.
- **AgentTaskSourceSchema parity** (per CLAUDE.md migration rules) — if any CHECK constraint changes existing schemas, ensure the matching Zod type in `src/types.ts` is updated.
- **API-key access invariant (added to CLAUDE.md 2026-05-18)** — `fingerprintApiKey()` and the operator-auth middleware MUST read the swarm API key via `getApiKey()` from `src/utils/api-key.ts` (precedence: `AGENT_SWARM_API_KEY` > `API_KEY`). Never `process.env.API_KEY` directly. Enforced by `scripts/check-api-key-boundary.sh` (CI).

### Core Requirements

1. **One migration `src/be/migrations/NNN_users_first_class.sql`** containing:
   - The six DDL blocks from Q8 (`user_external_ids`, `users.metadata`, `users.dailyBudgetUsd`, `users.status`, `user_tokens`, `user_identity_events`).
   - Backfill `INSERT INTO user_external_ids` from the existing four UNIQUE columns.
   - `ALTER TABLE users DROP COLUMN` for all four deprecated identity columns (Q15).
2. **`src/be/users.ts`** — pure DB functions per Q10, exported as the canonical identity API for the API server. Unit tests hit an in-memory `bun:sqlite`.
3. **Webhook auto-link refactor — all 7 handlers in same PR** (research §1d):
   - `src/slack/handlers.ts:395`, `src/slack/assistant.ts:80`, `src/slack/actions.ts:70` → `findUserByExternalId('slack', userId)` + `enrichSlackUserEmail` fallback → `findOrCreateUserByEmail` → `linkIdentity`.
   - `src/github/handlers.ts:159, 517, 752, 860` → `findUserByExternalId('github', login)` only; on miss, record unmapped. **No email path** (Q17.A).
   - `src/gitlab/handlers.ts:66, 166, 250` → `findUserByExternalId('gitlab', username)`; if `user.email` present inline, auto-link; else record unmapped.
   - `src/linear/sync.ts:383-387, 695-699` → cascade per Q17.B (explicit 5–10 lines per call-site).
   - `src/agentmail/handlers.ts:164` → `findOrCreateUserByEmail(senderEmail, ...)` (Q17.F).
   - All mutations go through `src/be/users.ts` so `user_identity_events` is emitted.
4. **Slack email-enrichment helper** — `enrichSlackUserEmail(slackUserId): Promise<string | null>`. Backed by `kv_entries` namespace `integration:user-enrichment:slack` with 24h TTL (Q13). Only successful results cached. **Retires** the in-memory `userEmailCache` Map at `src/slack/handlers.ts:38` (Q17.E). No `enrichUserFromIntegration` helper for github/gitlab/linear — Linear has email inline, gitlab is conditional, github has no email at all.
5. **Unmapped-identity tracking** — on every webhook resolve-miss with no email-recovery, write **two kv rows** (Q17.D):
   - `upsertKv('integration:unmapped:<kind>', '<externalId>:meta', { lastSeenAt, sampleEventType, sampleContext }, 30d)` — meta + last-seen + context (sampleContext ≤100 chars per privacy nit).
   - `incrKv('integration:unmapped:<kind>', '<externalId>:count', 1)` — atomic counter. TTL inherited at row creation; subsequent INCRs don't refresh TTL on the count row (acceptable, but flag at plan-time if observably wrong).
6. **Operator HTTP endpoints** (all via `route()`, all gated by global `API_KEY`):
   - `GET /users` — list with identity links, budget, token summary, recent events.
   - `POST /users` — create (name, email, optional budget, optional initial linkage). Emits `identity_added` / `budget_changed`.
   - `PATCH /users/:id` — profile / budget / status / identity edit. Emits relevant events.
   - `POST /users/:id/identities` — add identity link (kind + externalId). Calls `linkIdentity`.
   - `DELETE /users/:id/identities/:kind/:externalId` — remove. Calls `unlinkIdentity`.
   - `GET /users/:id/events` — paginated event timeline.
   - `GET /users/unmapped` — list of `integration:unmapped:<kind>` entries, with filter chips per integration and CTAs ("create user from this externalId" / "link to existing user").
   - `POST /users/unmapped/:kind/:externalId/resolve` — operator triage action; takes either `{ userId }` to link to existing or `{ name, email }` to create-and-link. Removes the kv entry on success.
   - (MCP-brainstorm endpoints: `POST/DELETE /users/:id/mcp-tokens` — schema lands in the same migration but the endpoint can ship with MCP if more convenient.)
7. **People page in `ui/`** — list view + per-user detail view + Unmapped tab.
   - List columns: name, email, identity badges (slack/linear/github/gitlab/custom), `dailyBudgetUsd` (or "Unlimited" badge), status.
   - Detail page: edit profile, manage identity links (add/remove kinds + externalIds), set/clear budget (with "enforcement comes with MCP" tooltip), set status, render `user_identity_events` timeline.
   - Operator merge tool: select two rows → preview → confirm → emit `manual_merge` event.
   - Unmapped tab: list backed by `GET /users/unmapped`; per-row CTAs to create-or-link via `POST /users/unmapped/:kind/:externalId/resolve`.
8. **Operator fingerprint helper** — `fingerprintApiKey(rawKey): string` in `src/be/users.ts` (or a sibling util), producing `op:<sha256(rawKey)[:16]>` (Q16). Used by the operator auth middleware to stash the actor value on the request context.
9. **`scrubSecrets` rule** for `aswt_*` MCP token plaintext (lands with the migration, even if MCP brainstorm ships the token endpoints).
10. **`AgentTaskSourceSchema` audit** (`src/types.ts`) — confirm no drift with the new CHECK constraints in this migration.
11. **OpenAPI regen** — `bun run docs:openapi` after every endpoint addition; commit the spec.
12. **Exhaustive call-site rewrite** — for the four deprecated identity columns, every read and write in `src/` and `src/tests/` must be replaced before merge (Q15). **Concrete list lives in the research doc's "Plan-time deliverables" §** ([[2026-05-18-user-identity-refactor]]) — the plan can import those checkboxes directly.
13. **`getUserIdentities(userId): Array<{kind, externalId}>`** in `src/be/users.ts` (Q17.G) — called by GET `/users` and GET `/users/:id` HTTP handlers when composing People-page response shape.
14. **Test fixture rewire** — `src/tests/user-identity.test.ts` is the primary test surface; research §1f enumerates every change. Adds: `findUserByEmail` covers both `email` and `emailAliases`, `linkIdentity` PK collision raises, `deleteUser` cascades to `user_external_ids`, webhook auto-link round-trip, existing-DB migration backfill assertion.
15. **Docs split** — `MCP.md` and `docs-site/.../mcp-tools.mdx` are hand-written (no `bun run docs:mcp` script found — research §1h "Honest gaps"); `plugin/pi-skills/user-management/SKILL.md` is regenerated via `bun run build:pi-skills` from `plugin/commands/user-management.md`. Plan must hand-edit the first two and regen the third.

## Next Steps

### Initial work that unblocks both brainstorms (cheapest first)

In rough dependency order — landing these unblocks the rest of both initiatives:

1. **The unified migration** (Core Requirement #1) — `src/be/migrations/NNN_users_first_class.sql`. Single PR. Tested against a fresh DB and an existing DB. Includes the backfill into `user_external_ids`.
2. **`src/be/users.ts`** (Core Requirement #2) — pure DB functions with unit tests. No HTTP changes yet, no webhook changes yet. This is the API surface everyone else will depend on.
3. **Webhook auto-link refactor** (Core Requirement #3) — switch `src/github/handlers.ts`, `src/linear/sync.ts`, `src/slack/handlers.ts` to use `src/be/users.ts`. This is where auto-merge by email and identity-event emission actually start happening. **Highest user-visible value of the three** because it fixes the original Daniel↔fuvidani footgun even before the UI exists.
4. **Stub People page in `ui/`** — read-only list of users with their identity badges. No editing yet. Confirms the schema + read endpoint work end-to-end. Operator can already audit existing state.

These four together would land the entire schema, give the auto-link improvement immediately, and prove the People-page shape with a low-risk read-only first cut. Everything else — the edit/mint/merge surfaces, the timeline view, the token endpoints — becomes additive.

### Recommended handoff

**Research is done** — see [[2026-05-18-user-identity-refactor]] in `thoughts/taras/research/`. The five-item research scope is complete and the findings have been folded back into Q17 + the Synthesis above.

**Recommendation: `/desplega:create-plan` now.** The picture is concrete:

- Migration shape: fully specified (Q8 + Q15 + Q17.D).
- `src/be/users.ts` surface: enumerated (Q10 + Q17.G), confirmed sufficient to replace all 14 `resolveUser` call-sites.
- Webhook rewires: per-handler file:line list with new code shape (research §1d, §2).
- Email-availability per integration: known (Q17.A — GitHub manual-only) and reflected in handler logic.
- kv design: confirmed all primitives exist; Q14 splits into two rows.
- Boundary checker: confirmed silent on `src/be/users.ts` (Q17.H).
- Blast radius: ~30 file:line refs, tractable for same-PR (Q17.I).

The research doc's "Plan-time deliverables" section contains a ready-to-import checkbox list the plan can pull from directly. Three real open questions remain (token UX copy, email-alias event type, Linear system-actor noise) — none block planning; each gets a sentence in the relevant plan phase.

Alternatives:

- **`/file-review` first** — if you want to leave inline comments on the brainstorm (decisions, Q17 adjustments, Open Questions) before planning, this is the moment.
- **Park** — if there's no immediate appetite to implement, fine to stop here. The two brainstorms + the research doc are durable context for a future pickup.

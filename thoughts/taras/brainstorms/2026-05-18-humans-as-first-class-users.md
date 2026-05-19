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

**Triggering feedback:** Someone reported that the bot can't connect "Alex (dashboard)" to "alexdev (GitHub)" or "alex (Linear)" to a GitHub handle. The feedback is partially accurate.

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

### Q4: Auto-merge by email — what should happen when Linear webhook with `email=alex@acme.com` arrives and an existing row has same email but no `linearUserId`?

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

- Q4 (auto-merge by email) intentionally skips human confirmation. That's a silent merge — and silent merges are exactly the kind of footgun where, six weeks later, someone asks "why is Alex's GitHub now pointing at Sandra's row?" and there's no answer.
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
- Operators get visibility into who has caps and who doesn't, even before enforcement lands. That visibility is itself useful — "huh, I never set a cap for Alex" is a question that should be answerable today.
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

### Q19: Email-alias add/remove event types — and TS-level type enforcement

**Decision (event types):** Add **`email_added` / `email_removed`** to the eventType set. Dedicated events for the dedicated semantic; keeps the per-user timeline cleanly readable ("added email X to user Y" rather than "identity diff in afterJson.emailAliases").

**Decision (enforcement layer):** **Both layers, in lockstep** — SQL CHECK in the migration AND a Zod enum / TS type in `src/types.ts`. Same pattern this codebase already applies to `AgentTaskSourceSchema` (per CLAUDE.md migration rules: "Keep `AgentTaskSourceSchema` in `src/types.ts` in sync with SQL CHECK constraints").

```ts
// src/types.ts — single source of truth at the API boundary
export const IdentityEventTypeSchema = z.enum([
  'auto_merge',
  'manual_merge',
  'identity_added',
  'identity_removed',
  'email_added',         // Q19
  'email_removed',       // Q19
  'token_minted',
  'token_revoked',
  'budget_changed',
  'status_changed',
]);
export type IdentityEventType = z.infer<typeof IdentityEventTypeSchema>;
```

```sql
-- src/be/migrations/NNN_users_first_class.sql — mirrored CHECK
CREATE TABLE user_identity_events (
  ...
  eventType TEXT NOT NULL CHECK (eventType IN (
    'auto_merge', 'manual_merge',
    'identity_added', 'identity_removed',
    'email_added', 'email_removed',     -- Q19
    'token_minted', 'token_revoked',
    'budget_changed', 'status_changed'
  )),
  ...
);
```

**Why both:**

- **SQL CHECK** — database-level guarantee. Protects against raw SQL, future tooling, anyone calling `db.run(...)` directly. Forward-only migration guarantees on-disk consistency.
- **Zod enum / TS type** — application-level enforcement. Compile-time errors when calling `recordIdentityEvent('typo_event_name', ...)`. Autocomplete in IDEs. Runtime validation at the API boundary (POST /users/:id/events shape, etc.).
- Drift between them is a documented risk (`AgentTaskSourceSchema` exists precisely to guard against this) — but the convention is to add to BOTH in the same PR, and the migration rule in CLAUDE.md catches PRs that don't.

**Defer to a future PR (not v1):** a **discriminated union** that mandates `beforeJson` / `afterJson` shapes per event type. E.g. `token_minted` always has `afterJson.tokenId` and never carries identity diffs. This is a stronger contract but overkill for v1 — start with the enum, escalate only if event-shape bugs appear.

**Insights:**

- The `recordIdentityEvent` signature in `src/be/users.ts` becomes typed:
  ```ts
  export function recordIdentityEvent(
    userId: string,
    eventType: IdentityEventType,   // Zod-derived literal union
    actor: IdentityActor,
    before: UserRow | null,
    after: UserRow | null
  ): void;
  ```
- Adding a new event type later means: append to the Zod enum, generate a new migration with an updated CHECK, ship the code that emits it. Three steps, all visible at PR review.
- The "Email add/remove via UI" path (operator typing into the People page) now emits a specific event. The `manage-user` MCP tool's email-alias edits should emit the same.

### Q20: Token-mint UX in the People page

**Decisions:**

**A. Pre-bundled MCP client snippets in the mint dialog:**

- **Claude Desktop** — JSON fragment for `claude_desktop_config.json` `mcpServers` entry. Includes the bearer-token header.
- **Claude Code (CLI)** — `claude mcp add` CLI snippet or JSON fragment for `~/.claude.json`. The primary harness this swarm targets.
- **Generic curl test** — `curl -H 'Authorization: Bearer aswt_…' <mcp-base-url>/mcp/user` for debugging and any client not pre-templated.

Cursor explicitly **not bundled** in v1. Users can adapt the Claude Desktop JSON; can add later if asked.

**B. Post-mint token-list display: GitHub-PAT-style "last 4 chars + label."**

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tokens                                                  [+ Mint new] │
├──────────────────────────────────────────────────────────────────────┤
│ aswt_…aX3f  ·  "MacBook (Claude Desktop)"  ·  used 4h ago  ·  Revoke │
│ aswt_…m7Tk  ·  "Cursor on laptop"          ·  used —       ·  Revoke │
│ aswt_…b2Qn  ·  "curl test"                 ·  used 2d ago  ·  Revoke │
└──────────────────────────────────────────────────────────────────────┘
```

- Last 4 chars come from the plaintext (NOT stored — derived from the kept-only-at-mint plaintext and stored in `user_tokens.tokenPreview TEXT NOT NULL` or similar). This requires a small migration tweak.
- Label is operator-set at mint time, free text (≤ 80 chars).
- `lastUsedAt` is updated fire-and-forget by the bearer-token middleware (per MCP brainstorm Q on Token format).
- Revoke is a single click; emits `token_revoked` audit event.

**C. Migration tweak required:**

- Add `user_tokens.tokenPreview TEXT NOT NULL` to the migration spec (stores the last-4 chars of the plaintext at mint time, e.g. `'aX3f'`). The full plaintext is never stored — only its hash and a 4-char suffix preview. The suffix preview alone has negligible attack value: 36^4 ≈ 1.7M permutations is brute-force-cheap against a known shape, but it's a SUFFIX not a prefix, so it can't be used to enumerate token namespaces.

**Insights:**

- "Last 4" matches GitHub PAT and most major secret-management UIs — operators already have the muscle memory.
- Label is the primary disambiguator; the last-4 preview is the assistive fallback when labels are missing or generic ("token" / "test").
- The mint dialog should also emit a `token_minted` event with the label captured in `afterJson` so the audit trail shows what was minted, not just that something was.

### Q21: Empirical Linear payload findings — Q19/Q2 resolves + a pre-existing bug surfaces

**Method:** Sampled real Linear webhook payloads against the dev API on 2026-05-18 (two events captured: `AgentSessionEvent.created` and `AgentSessionEvent.prompted` for issue DES-20).

**Finding A: The current Linear handler is silently broken.**

- `src/linear/sync.ts:379, 691` reads `event.actor` — but **`AgentSessionEvent` payloads have no top-level `actor` field**.
- Real payload shapes:
  - `action: "created"` → human prompter is at `event.agentSession.creator.{id, name, email, url}` and the trigger comment is at `event.agentSession.comment.{id, body, userId, issueId}`.
  - `action: "prompted"` → human prompter is at `event.agentActivity.user.{id, name, email, url}` and the prompt comment metadata at `event.agentActivity.{sourceCommentId, content.body}`.
- Consequence: `actorLinearId`, `actorEmail`, `actorName` are all empty strings today; `resolveUser({})` always returns `null`; `requestedByUserId` is **always `undefined`** on Linear-originated tasks.
- This is a **pre-existing bug**, not just a refactor concern. The new pipeline (using the correct nested paths) fixes it as a side effect.

**Refactor extraction logic — concrete code shape:**

```ts
// AgentSessionEvent.created
const session = event.agentSession as Record<string, unknown> | undefined;
const creator = session?.creator as Record<string, unknown> | undefined;
const linearUserId = creator ? String(creator.id ?? "") : "";
const email = creator ? String(creator.email ?? "") : "";
const name = creator ? String(creator.name ?? "") : "";

// AgentSessionEvent.prompted
const activity = event.agentActivity as Record<string, unknown> | undefined;
const promptUser = activity?.user as Record<string, unknown> | undefined;
const linearUserId = promptUser ? String(promptUser.id ?? "") : "";
const email = promptUser ? String(promptUser.email ?? "") : "";
const name = promptUser ? String(promptUser.name ?? "") : "";
```

Then the new cascade:

```ts
let userId = findUserByExternalId('linear', linearUserId)?.id;
if (!userId && email) {
  const { user } = findOrCreateUserByEmail(email, { name }, { kind: 'system', id: 'webhook:linear' });
  linkIdentity(user.id, 'linear', linearUserId, { kind: 'system', id: 'webhook:linear' });
  userId = user.id;
}
// fall through to unmapped record on miss
```

**Finding B: Q19 / Q2 (Linear system-actor noise) dissolves under current app config.**

- The Linear app is configured **agent-session-events-only**. The only event types delivered are `AgentSessionEvent.created` and `AgentSessionEvent.prompted`.
- Both event types are **triggered by a human** (the human writes `@devagentswarm hi there!` or sends a follow-up prompt). They always carry a populated `agentSession.creator` / `agentActivity.user` with `id` + `email` + `name`.
- System-driven Linear events (auto-archive, cycle rollover, SLA transitions) are **NOT** subscribed and never reach this webhook endpoint.
- **Result:** under the current configuration, there is no system-actor case to handle. The "Open Question" in the Synthesis can be closed.
- **Caveat (forward-looking):** if the Linear app config is ever widened to subscribe to issue/comment/cycle events, the system-actor case returns. The plan should note this in the Linear-rewire phase as a future-watch.

**Finding C (corrected per Taras 2026-05-18): The Linear `appUserId` represents the swarm itself, not a user.**

- `event.appUserId` (e.g. `48a91e15-…` for `devagentswarm`) is the Linear-side identity of the **swarm — operationally, the lead agent**, NOT a human user.
- This means the brainstorm's Q1 invariant holds even here: the `users` table is for HUMANS. Bots / agents are a separate concern.
- **Do NOT seed a `users` row for the app-user.** That would conflate humans (observers/configurators per Q1) with agents (workers per Q1) — exactly the boundary the brainstorm wants to keep clean.
- Where the `appUserId` belongs: associated with the **lead agent** somewhere — probably the existing agent registration / Linear integration config, NOT the `users` table. The plan needs to identify the right home (e.g. `tracker_integration_config` table, or a column on the lead agent's row, or `kv_entries` under `integration:linear:bot-app-user-id`).
- **What this means for webhook handlers:** when an inbound event's actor IS the bot itself (e.g. the bot's own comment triggers another event — feedback loop), the handler should detect `actor.id === appUserId` and **skip auto-link entirely** — no `users` row, no unmapped entry. It's the swarm hearing itself.

**Plan-time deliverables:**

- Store the Linear `appUserId` in a swarm-config location (NOT `users`). Probably alongside the OAuth tokens / integration metadata.
- Webhook handler logic: `if (creator.id === storedAppUserId) return /* skip — this is the swarm itself */;`
- Operator UI: surface "Linear app-user" as a swarm/integration property, not as a person.

**Knock-on effect:** the bot's `appUserId` should NOT trigger an unmapped entry. The Q14 unmapped-tracker logic must check `actor.id !== bot.appUserId` before recording.

**Finding D: Both AgentSessionEvent shapes also carry a comment reference.**

- `agentSession.comment.userId` (on `created`) and `agentActivity.sourceCommentId` (on `prompted`) reference the comment that triggered the agent session. The brainstorm doesn't currently use these for identity — and shouldn't, since the same identity is in `creator`/`user` — but it's worth noting that comment metadata is reliably attached. Could matter for future per-task conversation threading (MCP brainstorm v2 territory).

**Insights:**

- The new dev pipeline test loop is now: trigger Linear event → tail `/tmp/linear-webhooks.jsonl` → verify the extraction shape works against the real payload. Use this loop in plan Phase 3 (webhook rewires) to catch any other webhook event-type wrinkles before merge.

### Q22: Forward-watch — Linear lifecycle events we DON'T currently observe

**Surfaced by Taras 2026-05-18:** under the current `agent-session-events-only` Linear app config, the swarm receives `AgentSessionEvent.created` and `AgentSessionEvent.prompted` only. This means **many user actions on Linear that should plausibly affect swarm task state are invisible to us.**

**Specifically NOT observed today:**

| User action in Linear | What event Linear would send | What we'd want to do |
|---|---|---|
| Cancel / dismiss an agent session | Likely `AgentSessionEvent` with `action: "dismissed"` or `updated` (with `dismissedAt` set). Sample not captured this session. | Cancel the corresponding swarm task. Update `requestedByUserId` audit. |
| Unassign bot from an issue | `Issue` `update` event with assignee diff — NOT subscribed | Cancel / pause the running task. |
| Add a special label (e.g. `swarm:cancel`, `swarm:priority-high`) | `Issue.update` with label diff — NOT subscribed | Route label → task-action mapping. |
| Comment on issue without @-mentioning bot | NO `AgentSessionEvent`; only `Issue.comment.create` — NOT subscribed | Maybe contextually inject into task; maybe ignore. Depends on UX intent. |
| Issue closed / state transition | `Issue.update` with state diff — NOT subscribed | Possibly cancel or complete the swarm task. |
| Issue deleted | `Issue.remove` — currently routed in `webhook.ts:60-62` but only fires if subscribed | Hard-cancel the task. |

**Decision for this brainstorm:** **OUT OF SCOPE.** Reasoning:

- This brainstorm is about **identity mapping** (mapping Linear user IDs to canonical `users` rows). Widening the Linear event subscription is a different lever — it changes *what events we receive*, not *how we map identities once we have them*.
- If we widen subscriptions later, the identity-mapping primitives in `src/be/users.ts` (Q10) apply unchanged. New event-type handlers just call the same `findUserByExternalId` / `findOrCreateUserByEmail` / `linkIdentity` primitives.
- Solving lifecycle-routing here would dramatically expand the plan's scope (cancellation semantics, label→action mapping, conflict resolution when bot is unassigned mid-task) — each its own can of worms.

**Forward-watch deliverables (NOT part of this plan):**

- A **separate follow-up brainstorm** to cover: Linear app config widening + lifecycle event routing + label→task-action mapping. Tentatively `2026-XX-XX-linear-lifecycle-events.md` whenever this becomes a priority.
- Plan-time note in the Linear-rewire phase: "The new identity-mapping code is event-type-agnostic. When new event subscriptions are added in a future PR, the actor-extraction shape per event-type changes, but the `src/be/users.ts` calls do not."

**Honest gap acknowledgement:**

- A user who cancels a Linear agent session today probably expects the swarm task to stop. It doesn't. That's a real product bug — pre-existing, independent of this refactor. Worth filing as a Linear issue (meta-recursion) for the follow-up brainstorm to address.

### Q22.1: Linear agent-interaction docs review (2026-05-18)

**Source:** <https://linear.app/developers/agent-interaction>. Folded back here so the future lifecycle brainstorm doesn't have to re-research.

**Confirmed: `AgentSessionEvent` has only two actions, ever.**

> "There will be two types of actions in the `AgentSessionEvent` category, denoted by the action field of the payload:" — `created` (new session — user mention or issue delegation) and `prompted` (follow-up `prompt`-type activity from user).

No `dismissed`, `cancelled`, `completed`, `updated` actions exist. Our captured sample of 6 events (3× created, 3× prompted) matches this exhaustively.

**Confirmed: session lifecycle is agent→Linear, not Linear→agent.**

> "Agent sessions can have one of 6 states: `pending`, `active`, `error`, `awaitingInput`, `complete`, `stale`. … You don't need to manage agent session state manually. **Linear tracks session lifecycle automatically based on the last emitted activity.**"

State transitions are derived from the agent's emitted `AgentActivity` (5 types: `thought`, `elicitation`, `action`, `response`, `error` — plus user-generated `prompt`). **There is no inbound webhook signaling "user cancelled the session."** The closest signal is "session goes `stale`" — but that's a *derived* state visible in the next webhook payload's `agentSession.status`, not a separate event.

**Confirmed: subscribing to `Issue` events is a separate category.**

> "AgentSessionEvent webhooks only send events to your specific agent."

To learn about unassignment, labels, or status changes, the OAuth app must additionally subscribe to `Issue` events (a different webhook category entirely). This is what the future lifecycle brainstorm will need to evaluate.

**Confirmed: strict timing — bookmark for the follow-up brainstorm.**

> "You must return a response from your webhook receiver within 5 seconds."
> "If you receive a `created` event, you are expected to send an activity or update your external URL within 10 seconds to avoid the session being marked as unresponsive."

The existing handler returns 200 immediately and processes async (`processWebhookEvent(...)`.catch) — this satisfies the 5s rule. The 10s rule depends on how fast the lead agent picks up a Linear-originated task and emits its first activity. **Plan-relevant: the auto-link refactor in Phase 3 must NOT add synchronous overhead to the webhook response path** — the kv enrichment / `findOrCreateUserByEmail` / `linkIdentity` calls all happen in the async branch, not before the 200 return. Already the case in `webhook.ts:103` (`return { status: 200, body: { status: "accepted" } };` returns before `processWebhookEvent` awaits anything). Plan check: confirm the refactored extraction code stays in the async branch.

**Forward-watch payload for the lifecycle brainstorm:**

- To handle "user cancelled session" the swarm has two options:
  - (a) Subscribe to `Issue` events; when an issue is unassigned from the bot OR labeled `swarm:cancel`, derive cancellation intent. Pre-Linear-issue webhook category.
  - (b) Poll Linear GraphQL for `agentSession.status` on running tasks and react to `stale` / `complete` transitions. Heavier but lifecycle-agnostic.
  - (c) (Possibly future) Linear introduces inbound webhooks for session dismissal. Currently not in docs.



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
21. **`resolve-user` MCP tool ships with new shape `{kind?, externalId?, email?}`** + Zod refine (Q18). Mechanical worker-side migration in the same PR. `name` field dropped (no caller uses it). Old field names error out at runtime, not silently degrade.
22. **`email_added` / `email_removed` events added** (Q19) — distinct from `identity_added`/`identity_removed` for cleaner operator timelines. Enforced in BOTH SQL CHECK and `IdentityEventTypeSchema` Zod enum in `src/types.ts` — lockstep enforcement per CLAUDE.md migration rules.
23. **Token UX in People page** (Q20) — mint dialog bundles snippets for Claude Desktop, Claude Code (CLI), and a generic curl test. Cursor explicitly deferred. Post-mint list shows GitHub-PAT-style "last 4 chars + label + lastUsedAt + revoke." Adds `user_tokens.tokenPreview TEXT NOT NULL` (4-char suffix) to the migration.
24. **Linear `AgentSessionEvent` actor extraction is currently broken** (Q21.A) — `src/linear/sync.ts` reads `event.actor` which doesn't exist on `AgentSessionEvent` payloads. Refactor MUST switch to `event.agentSession.creator` (for `created`) and `event.agentActivity.user` (for `prompted`). Pre-existing bug; fixes as a side effect.
25. **Q19 / Q2 Linear system-actor noise dissolves under current app config** (Q21.B) — Linear is subscribed to **agent-session-events-only**; both event types are always human-prompted. No system-actor case in v1. Plan notes a forward-watch for if event subscriptions widen later.
26. **Linear `appUserId` is the swarm / lead agent, NOT a `users` row** (Q21.C corrected) — `event.appUserId` represents the bot identity Linear assigned the app at install time. Per Q1, the `users` table is for humans only; bot identity lives elsewhere (probably alongside OAuth tokens or in integration config). Webhook handlers MUST skip auto-link when `actor.id === appUserId` (it's the swarm hearing itself). The unmapped tracker MUST also exclude this case.

### Open Questions

(All resolved. The brainstorm is plan-ready.)

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
16. **`resolve-user` worker-caller grep + rewrite** (Q18) — same PR must inventory every `resolve-user` MCP-tool caller in `src/` and `plugin/commands/` and update from `{slackUserId: X}` / `{githubUsername: X}` / etc. to `{kind: "slack", externalId: X}`.
17. **`IdentityEventTypeSchema` Zod enum in `src/types.ts`** (Q19) — mirrored in lockstep with the SQL CHECK constraint on `user_identity_events.eventType`. Includes `email_added` / `email_removed`. Same migration-discipline as `AgentTaskSourceSchema`.
18. **`user_tokens.tokenPreview TEXT NOT NULL`** added to migration (Q20). Stores the last-4 chars of plaintext at mint time. Full plaintext never persisted.
19. **Token-mint dialog content** (Q20) — pre-bundled JSON / CLI snippets for Claude Desktop, Claude Code (CLI), and a generic curl test. UI sub-component should be data-driven so future clients (Cursor, etc.) can be added without rework.
20. **Linear actor-extraction fix** (Q21.A) — `src/linear/sync.ts` rewires `event.actor` reads to `event.agentSession.creator` (created) / `event.agentActivity.user` (prompted). This is **required**, not optional — without it the auto-link path never fires for Linear and `requestedByUserId` stays undefined as it does today.
21. **Store Linear `appUserId` in integration config, NOT `users`** (Q21.C corrected) — bot identity belongs with the OAuth-token / tracker-integration metadata (existing table TBD by plan) or in `kv_entries` under a namespace like `integration:linear:bot-app-user-id`. Webhook handlers MUST guard: `if (creator.id === storedAppUserId) return;` — the swarm should not auto-link itself.
22. **Unmapped-tracker bot guard** — Q14 unmapped-recording logic MUST exclude `actor.id === bot.appUserId`. The bot's own actions should never appear in the Unmapped triage queue.
23. **Plan Phase 3 dev-pipeline loop** (Q21 Insights) — Linear webhook rewire uses the live dev API + `/tmp/linear-webhooks.jsonl` capture loop to verify extraction shapes against real Linear payloads before merge. Pattern is reusable for Slack/GitLab/AgentMail verification too.

## Next Steps

### Initial work that unblocks both brainstorms (cheapest first)

In rough dependency order — landing these unblocks the rest of both initiatives:

1. **The unified migration** (Core Requirement #1) — `src/be/migrations/NNN_users_first_class.sql`. Single PR. Tested against a fresh DB and an existing DB. Includes the backfill into `user_external_ids`.
2. **`src/be/users.ts`** (Core Requirement #2) — pure DB functions with unit tests. No HTTP changes yet, no webhook changes yet. This is the API surface everyone else will depend on.
3. **Webhook auto-link refactor** (Core Requirement #3) — switch `src/github/handlers.ts`, `src/linear/sync.ts`, `src/slack/handlers.ts` to use `src/be/users.ts`. This is where auto-merge by email and identity-event emission actually start happening. **Highest user-visible value of the three** because it fixes the original Alex↔alexdev footgun even before the UI exists.
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

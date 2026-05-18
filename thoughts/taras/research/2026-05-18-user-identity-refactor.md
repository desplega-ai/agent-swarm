---
date: 2026-05-18T00:00:00-00:00
author: research-agent (for Taras)
topic: "User-identity refactor — call-site inventory & integration email matrix"
tags: [research, users, identity, integrations]
status: complete
related: [[2026-05-18-humans-as-first-class-users]], [[2026-05-15-client-side-mcp]]
---

# User-identity refactor — research

## TL;DR

1. **All call-sites of the four dropped columns live in a tight blast radius** — `src/be/db.ts` (the `users.*` helpers + `resolveUser`), the two MCP tools (`src/tools/resolve-user.ts`, `src/tools/manage-user.ts`), `src/http/users.ts`, and the four webhook handlers (`src/slack/`, `src/github/`, `src/gitlab/`, `src/linear/sync.ts`). UI types in `ui/src/api/types.ts`. Tests in `src/tests/user-identity.test.ts`. Docs in `MCP.md`, `docs-site/.../mcp-tools.mdx`, `plugin/commands/user-management.md`, `plugin/pi-skills/user-management/SKILL.md`, `openapi.json`. **No surprise readers** outside this set — the huge initial grep hit was almost entirely `agent_tasks.slackUserId` / `inbox_messages.slackUserId` (unrelated task-context column, KEPT).
2. **`resolveUser` has 8 callers across 4 integrations + 1 MCP tool + 1 test file.** Each caller's "single identifier in / single ID out" pattern maps cleanly onto the proposed `findUserByExternalId(kind, externalId)` + `findUserByEmail(email)` + `findOrCreateUserByEmail(email, hints, actor)` from brainstorm Q10. The Linear "multi-key + fallback to email + fallback to name" pattern is the awkward one — needs a small helper or sequential calls in the new world.
3. **Email-availability matrix:** Slack ✅ (already calls `users.info`, has cache scaffold); Linear ✅ (`actor.email` inline on webhook); GitLab ⚠️ (`user.email?` optional on webhook, GitLab API requires admin-token to reliably see email); GitHub ❌ (webhook sender has no email, `GET /users/{login}` returns the rarely-set public email only). **Conclusion: GitHub identities must be operator-manual-link in v1** — auto-link via email is impossible for the common case. Cache enrichment (kv) needed for Slack only; Linear pulls from webhook payload directly.
4. **`scripts/check-db-boundary.sh` is path-allow-listed against worker dirs only** (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`, `plugin/opencode-plugins/`). `src/be/users.ts` is API-side by location — boundary check is silent on it. Every prospective caller (webhook handlers, MCP middleware in `src/server.ts`, HTTP handlers in `src/http/`) is also API-side. No new check needed.
5. **kv has every primitive the plan needs already:** `getKv`, `upsertKv`, `deleteKv`, `incrKv` (atomic in tx, throws `KvTypeCollisionError` on type mismatch), `listKv` (with `prefix` filter — LIKE-escaped, paginated, lazy-filters expired), `countKv`. Lazy expire on read in `getKv`; `listKv` filters but doesn't delete (keeps cursors stable). **No kv helper needs to be added** — the unmapped-identity Q14 use case (INCR + namespace+prefix list) is fully covered. The one gotcha: `incrKv` stores as `value_type='integer'`, so the unmapped record can't be stored as JSON with a count field AND be INCR'd in-place. Plan must choose between (a) two kv rows per unmapped identity (one JSON `{lastSeenAt, sample}` + one integer `count`), or (b) one JSON row that gets read-modify-write upserted on every webhook (not atomic; race condition). Brainstorm Q14 implies (a) by listing `count` as a top-level field — see "Plan-time deliverables" for the exact resolution.

---

## 1. Exhaustive call-site inventory

**Scope filter — read carefully.** The four columns to drop are `users.slackUserId`, `users.linearUserId`, `users.githubUsername`, `users.gitlabUsername`. There is an **identically-named field** `agent_tasks.slackUserId` (and `inbox_messages.slackUserId`) — same string, different table, **NOT being dropped**. The naive grep returns ~150 hits, but >80% are for the task-context column. The inventory below has been filtered to ONLY include call-sites that touch the `users` table.

Verification: only `src/be/migrations/031_user_registry.sql` defines those four as columns on `users`. All other migrations declaring `slackUserId TEXT` (`001_initial.sql:87`, `001_initial.sql:206`, `004_workflow_source.sql:26`, `006_vcs_provider.sql:28`, `009_tracker_integration.sql:101`, `026_drop_epics.sql:26`, `043_jira_source.sql:27`, `056_drop_agent_tasks_source_check.sql:34`) declare it on `agent_tasks` or `inbox_messages` — UNTOUCHED by this refactor.

### 1a. DB helpers (the heart of the refactor)

| File:line | What it does | After refactor |
|---|---|---|
| `src/be/db.ts:8730-8745` | `UserRow` row type — declares `slackUserId/linearUserId/githubUsername/gitlabUsername` as `string \| null` columns on the `users` SELECT result. | Remove all four fields from `UserRow`. Add a separate `UserExternalIdRow` for the new table. |
| `src/be/db.ts:8747-8764` | `rowToUser()` — maps the four columns from `UserRow` into the `User` Zod-typed object. | Remove the four lines. The new `User` type (Q6) will not carry them at the row level; identities come from a parallel `findIdentitiesForUser(userId)` call. |
| `src/be/db.ts:8766-8832` | `resolveUser()` — the central read primitive. Four sequential `SELECT * FROM users WHERE <col> = ?` branches, then email + emailAliases + name fallback. | **Delete `resolveUser` entirely.** Replace with `findUserByExternalId(kind, externalId)` (single SELECT on `user_external_ids`), `findUserByEmail(email)` (handles `email` + `emailAliases`), and `findUserById(id)`. Callers compose. The name-fallback is an awkward heuristic — see §2 for caller analysis. |
| `src/be/db.ts:8834-8841` | `getUserById`, `getAllUsers` — no column refs but live alongside; the user-row-shape change affects them. | Update to use the new `User` type without identity columns; if callers need identities, expose a `getUserWithIdentities(id)` helper or have callers fetch identities separately. |
| `src/be/db.ts:8843-8881` | `createUser()` — INSERT writes 14 columns, four of which are the identity columns. | Remove the four parameters from `createUser`; identity creation is now a follow-up call to `linkIdentity` (which goes through `user_external_ids` + emits an `identity_added` event). Or: keep a single-call helper that wraps both inside a transaction. |
| `src/be/db.ts:8883-8959` | `updateUser()` — partial-update SET builder with four `if (data.<col> !== undefined)` branches. | Drop the four branches. Identity changes go through `linkIdentity` / `unlinkIdentity`. |
| `src/be/db.ts:8961-8968` | `deleteUser()` — no column refs, but `ON DELETE CASCADE` on the new `user_external_ids.userId` will auto-clean identities. | No code change; verify the cascade is in the migration's foreign key. |

### 1b. MCP tools

| File:line | What it does | After refactor |
|---|---|---|
| `src/tools/resolve-user.ts:14-21` | Input Zod schema declares `slackUserId/linearUserId/githubUsername/gitlabUsername/email/name`. | Either (a) keep the surface stable as a compat shim that maps to `findUserByExternalId(kind, externalId)` calls, or (b) expose a new shape: `{ kind?: string, externalId?: string, email?: string, name?: string }`. Brainstorm Q15 implies same-PR rewires — recommend (a) keep stable surface for one release, deprecate later. Workers may have hard-coded this shape. |
| `src/tools/resolve-user.ts:23` | Handler destructures the same four field names. | Map to sequential `findUserByExternalId('slack', slackUserId)` / `'linear'` / `'github'` / `'gitlab'` calls. |
| `src/tools/resolve-user.ts:35-42` | Calls `resolveUser({ slackUserId, ..., email, name })`. | Replace with sequential helper calls; first match wins. |
| `src/tools/manage-user.ts:27-30` | Input Zod schema declares the four identity fields. | Drop from input. Add explicit `identities?: Array<{ kind: string; externalId: string }>` field instead. (Alternatively: keep the input shape and have the tool emit `linkIdentity` calls under the hood — but the new model is symmetric across `jira`/custom, so the array shape is honest.) |
| `src/tools/manage-user.ts:78-104` (create branch) | Passes four identity fields to `createUser`. | Replace with: `createUser({ name, email, ... })` → for each entry in `identities`, `linkIdentity(user.id, kind, externalId, actor)`. |
| `src/tools/manage-user.ts:107-146` (update branch) | Passes four identity fields to `updateUser`. | Drop identity fields from `updateUser` call. If `identities` provided: compute diff → `linkIdentity` / `unlinkIdentity` per delta. |

### 1c. HTTP API surface

| File:line | What it does | After refactor |
|---|---|---|
| `src/http/users.ts:28-40` (create body Zod) | Declares four optional identity fields on `POST /api/users`. | Drop. Add `identities?: Array<{ kind: string; externalId: string }>`. |
| `src/http/users.ts:56-69` (update body Zod) | Same on `PUT /api/users/{id}`. | Same change. |
| `src/http/users.ts:101-103` | `createUser(parsed.body)` — passes the four identity fields through. | Pass only non-identity fields; loop `identities` → `linkIdentity`. |
| `src/http/users.ts:120-122` | `updateUser(parsed.params.id, parsed.body)` — same. | Same change. |

### 1d. Webhook handlers — readers of `resolveUser`

| File:line | What it does | After refactor |
|---|---|---|
| `src/slack/handlers.ts:395` | `resolveUser({ slackUserId: msg.user })?.id` → `requestedByUserId`. | Replace with: `findUserByExternalId('slack', msg.user)?.id ?? (await enrichAndLink('slack', msg.user))?.id`. The `enrichAndLink` path goes via the Slack `users.info` cache (already exists at `src/slack/handlers.ts:114-125`) → `findOrCreateUserByEmail` (Q5) → emit `identity_added`. |
| `src/slack/assistant.ts:80` | `resolveUser({ slackUserId: userId })?.id` (assistant message variant). | Same pattern as above. |
| `src/slack/actions.ts:70` | `resolveUser({ slackUserId: body.user.id })?.id` (button-click variant). | Same. |
| `src/github/handlers.ts:159` | `resolveUser({ githubUsername: sender.login })?.id` (pull_request handler). | Replace with `findUserByExternalId('github', sender.login)?.id`. **No email auto-link path** — GitHub has no inline email in webhook (§3). Operator-manual-link only. Falls through to "unmapped" record in kv if no match. |
| `src/github/handlers.ts:517` | Same, in the `issues` handler. | Same. |
| `src/github/handlers.ts:752` (`_requestedByUserId` — leading underscore = currently unused) | Same, in comment-event handler. | Same. The unused-variable rename is fine to keep — the result isn't wired through yet. |
| `src/github/handlers.ts:860` (`_requestedByUserId` — unused) | Same, in PR review handler. | Same. |
| `src/gitlab/handlers.ts:66` | `resolveUser({ gitlabUsername: user.username })?.id` (merge-request handler). | Replace with `findUserByExternalId('gitlab', user.username)?.id`. **Note:** `user.email` is optionally present on the webhook payload (`src/gitlab/types.ts:14`) — if present, enrichment can run inline (no kv cache needed). |
| `src/gitlab/handlers.ts:166` | Same, in issue handler. | Same. |
| `src/gitlab/handlers.ts:250` (`_requestedByUserId` — unused) | Same, in note (comment) handler. | Same. |
| `src/linear/sync.ts:383-387` | Multi-key call: `resolveUser({ linearUserId, email, name })`. The webhook payload has all three (`actor.id`, `actor.email`, `actor.name`) and `resolveUser` walks them in priority order. | Replace with: try `findUserByExternalId('linear', actorLinearId)` → if null, `findOrCreateUserByEmail(actorEmail, { name: actorName }, { kind: 'system', id: 'webhook:linear' })` (Q5 auto-create-on-email) → on success, `linkIdentity(user.id, 'linear', actorLinearId, ...)`. The name-only fallback is dropped — name fuzzy-match is a footgun and the brainstorm's auto-link model only auto-merges by email. |
| `src/linear/sync.ts:695-699` | Same multi-key shape (followup variant). | Same. |
| `src/agentmail/handlers.ts:164` | `resolveUser({ email: senderEmail })?.id`. | Replace with `findOrCreateUserByEmail(senderEmail, ...)?.user.id` — agentmail is naturally the email-only path; perfect fit for auto-create. |

### 1e. Type definitions

| File:line | What it does | After refactor |
|---|---|---|
| `src/types.ts:221-236` (`UserSchema`) | Zod schema declaring the four identity fields on `User`. | Drop four lines. The `User` type loses these — identities are surfaced via a separate `UserWithIdentities` shape (or `user.identities: Array<{kind, externalId}>` populated by the handler when the API response needs them). Brainstorm Q11 implies UI badges show all identities — so the API response shape used by the People page probably wants `identities` inline; that's a handler-level join, not a row-level column. |
| `ui/src/api/types.ts:161-164` (`User` interface) | TS-side mirror of `UserSchema` — four optional identity fields. | Drop four fields; add `identities?: Array<{ kind: string; externalId: string }>` or similar. |
| `ui/src/api/types.ts:181-184` (`CreateUserInput`) | Mirror of `POST /api/users` body shape. | Same drop + add `identities?:`. |
| `ui/src/api/types.ts:109` | `AgentTask.slackUserId?: string` — **NOT AFFECTED** (this is the `agent_tasks` column, kept). | No change. Flagged here to be explicit. |

### 1f. Tests

| File:line | What it does | After refactor |
|---|---|---|
| `src/tests/user-identity.test.ts:55-79` | `createUser` test — passes all four identity fields. | Either rewrite to call `createUser` (no identities) + `linkIdentity` calls, or keep an integration-style helper that mirrors the new `manage-user` flow. |
| `src/tests/user-identity.test.ts:81-89` | UNIQUE-constraint tests on `slackUserId` and `githubUsername`. | Rewrite against `user_external_ids` PRIMARY KEY `(kind, externalId)` — `linkIdentity('slack', 'U_UNIQUE')` succeeds; second call with same args throws. |
| `src/tests/user-identity.test.ts:152-163` | Cascade-delete test — `deleteUser` clears `requestedByUserId` on tasks. | Confirm FK `ON DELETE CASCADE` on `user_external_ids.userId` so identities are auto-removed; add an assertion that `user_external_ids` rows are gone after `deleteUser`. |
| `src/tests/user-identity.test.ts:172-180` (`testUser` setup) | Creates user with all four identity fields + email + alias. | Mirror the new shape: `createUser` + 4× `linkIdentity`. |
| `src/tests/user-identity.test.ts:183-204` | One test per identity kind — `resolveUser({ <kind>: ... })`. | Rewrite to use `findUserByExternalId(kind, externalId)`. Add coverage for `findUserByEmail` (primary + alias) and for the no-match case. |
| `src/tests/user-identity.test.ts:226-228` | Negative cases — `slackUserId: "U_NONEXISTENT"`, email, name. | Same translation. |
| `src/tests/user-identity.test.ts:231-245` | "Prioritizes platform ID over email" — depends on `resolveUser`'s waterfall. | If the new world has no waterfall (callers compose), this test is no longer meaningful — drop it. |

### 1g. Scripts

| File:line | What it does | After refactor |
|---|---|---|
| `scripts/backfill-seed-users.sql:6` | `INSERT OR IGNORE INTO users (..., slackUserId, linearUserId, githubUsername, gitlabUsername, ...)` for Taras. | Rewrite as two inserts: one into `users` (without identity columns), one with 3× `INSERT INTO user_external_ids (userId, kind, externalId)` for Taras's slack/linear/github IDs. Same for Eze. Both must be re-runnable (`INSERT OR IGNORE`). |
| `scripts/backfill-seed-users.sql:23` | Same for Eze. | Same. |

### 1h. Generated documentation (must regenerate, not hand-edit)

| File:line | What it does | After refactor |
|---|---|---|
| `MCP.md:223-226` | Doc table for `resolve-user` listing the four input fields. | Auto-regenerates from the tool's input schema — fix the Zod, run `bun run docs:business-use` (or whatever the auto-gen flow is) — verify by hand. **Caveat:** I see no `bun run docs:mcp` script; the file may be hand-written. Audit MCP.md ownership before assuming. |
| `MCP.md:244-247` | Same for `manage-user`. | Same. |
| `MCP.md:170` (`send-task.slackUserId`) | NOT AFFECTED — this is the `agent_tasks.slackUserId` parameter on `send-task`. Kept. | No change. |
| `docs-site/content/docs/(documentation)/reference/mcp-tools.mdx:766-769` (resolve-user) | Same content as MCP.md. **This file is HAND-WRITTEN** (not in `api-reference/` which is auto-generated). | Hand-edit. Update to reflect new shape. |
| `docs-site/content/docs/(documentation)/reference/mcp-tools.mdx:785-788` (manage-user) | Same. | Hand-edit. |
| `docs-site/content/docs/(documentation)/reference/mcp-tools.mdx:75` | `send-task.slackUserId` — NOT AFFECTED. | No change. |
| `docs-site/content/docs/(documentation)/guides/slack-integration.mdx:70, 78` | References `agent_tasks.slackUserId` — NOT AFFECTED. | No change. |
| `openapi.json:10083-10092` (POST /api/users body schema) | Auto-generated from `src/http/users.ts`. | Run `bun run docs:openapi` after editing the route. Will also regenerate `docs-site/content/docs/api-reference/**`. |
| `openapi.json:10168-10177` (PUT /api/users/{id} body schema) | Same. | Same. |
| `plugin/commands/user-management.md` (entire file, 20 hits) | Hand-written agent skill explaining how to use `resolve-user` / `manage-user`. | Rewrite the example payloads to the new shape. |
| `plugin/pi-skills/user-management/SKILL.md` (entire file, 20 hits) | Auto-generated from `plugin/commands/user-management.md` via `bun run build:pi-skills`. | Run `bun run build:pi-skills` after editing the source MD. |
| `CHANGELOG.md:483, 808` | Historical entries referencing `agent_tasks.slackUserId` parameter on send-task — NOT AFFECTED. | No change. |

### 1i. Non-code refs (NO CHANGE NEEDED — flagged for completeness)

The grep returns hits in `thoughts/` (planning docs, research, brainstorms) and in `src/be/migrations/` (`031_user_registry.sql` itself plus the various `agent_tasks` migrations). Migration files are immutable history per CLAUDE.md — **never modified**. Thoughts files are historical context — **leave them**.

Specifically: `src/be/migrations/031_user_registry.sql` already defines the columns that the new migration drops — that's the whole point and is the only safe migration reference.

---

## 2. `resolveUser()` call-graph

`resolveUser` is exported from `src/be/db.ts:8770`. Callers, by integration:

| Caller | `file:line` | Input shape | Output use | Null-handling |
|---|---|---|---|---|
| Slack message handler | `src/slack/handlers.ts:395` | `{ slackUserId: msg.user }` | `requestedByUserId` on Slack-created task | Graceful — `?.id` evaluates to `undefined`; task created with no `requestedByUserId` |
| Slack assistant handler | `src/slack/assistant.ts:80` | `{ slackUserId: userId }` (conditional — `userId ? resolveUser(...) : undefined`) | `requestedByUserId` on task or follow-up | Graceful — `undefined` allowed |
| Slack actions handler | `src/slack/actions.ts:70` | `{ slackUserId: body.user.id }` | `requestedByUserId` on follow-up task (modal submit) | Graceful |
| GitHub PR handler | `src/github/handlers.ts:159` | `{ githubUsername: sender.login }` | `requestedByUserId` on PR-created task | Graceful |
| GitHub Issue handler | `src/github/handlers.ts:517` | `{ githubUsername: sender.login }` | `requestedByUserId` on issue-created task | Graceful |
| GitHub Comment handler | `src/github/handlers.ts:752` | `{ githubUsername: sender.login }` | Currently unused (`_requestedByUserId`) — assigned but not threaded into a `createTaskExtended` call | Graceful (also dead) |
| GitHub Review handler | `src/github/handlers.ts:860` | `{ githubUsername: sender.login }` | Currently unused (`_requestedByUserId`) | Graceful (also dead) |
| GitLab MR handler | `src/gitlab/handlers.ts:66` | `{ gitlabUsername: user.username }` | `requestedByUserId` on MR-created task | Graceful |
| GitLab Issue handler | `src/gitlab/handlers.ts:166` | `{ gitlabUsername: user.username }` | `requestedByUserId` on issue-created task | Graceful |
| GitLab Note handler | `src/gitlab/handlers.ts:250` | `{ gitlabUsername: user.username }` | Currently unused (`_requestedByUserId`) | Graceful (also dead) |
| Linear sync — agent-session | `src/linear/sync.ts:383-387` | **`{ linearUserId: actorLinearId, email: actorEmail, name: actorName }`** (multi-key with priority) | `requestedByUserId` on Linear-created task | Graceful |
| Linear sync — issue followup | `src/linear/sync.ts:695-699` | **`{ linearUserId: ..., email: ..., name: ... }`** (multi-key) | `requestedByUserId` on followup task | Graceful |
| AgentMail handler | `src/agentmail/handlers.ts:164` | `{ email: senderEmail }` (conditional on email being present) | `requestedByUserId` on email-created task | Graceful |
| MCP `resolve-user` tool | `src/tools/resolve-user.ts:35-42` | Pass-through of arbitrary client-supplied combination | Tool response | Returns "No user found" message |
| Tests | `src/tests/user-identity.test.ts:184-228, 238` | Single-key + the priority-ordering test | Assertions | n/a |

### Pattern observations

- **11 of the 14 callers pass a single identifier.** A single `findUserByExternalId(kind, externalId)` call replaces them 1-for-1.
- **2 callers (Linear) pass three keys.** These are the only callers exercising `resolveUser`'s waterfall. The new model splits this into sequential calls + `findOrCreateUserByEmail` — the Linear webhook handler will need 5–10 lines of explicit cascade logic instead of one `resolveUser` call. That's an honest tradeoff: the caller now reads as a real auto-link pipeline.
- **1 caller (AgentMail) passes email.** Maps onto `findOrCreateUserByEmail` (with auto-create per Q5).
- **1 caller (MCP `resolve-user` tool)** is a pass-through and is the most ergonomic to keep stable as a compat shim.
- **No caller uses the `name` fallback in practice except the Linear sync.** Even there the name fallback is a vestigial heuristic — brainstorm Q4/Q5 explicitly say email is the trusted primitive. The plan can safely drop the name-only resolution path.
- **No caller does anything non-trivial with the returned `User` object beyond reading `.id`.** That's an important confirmation: the row-shape change (dropping the four columns from the returned `User`) doesn't ripple beyond the type files.

### Proposed `src/be/users.ts` surface — fit check

Brainstorm Q10 proposes:

```
findUserById, findUserByExternalId, findUserByEmail,
findOrCreateUserByEmail(email, hints, actor),
linkIdentity(userId, kind, externalId, actor),
unlinkIdentity(...),
mintToken(...), revokeToken(...), resolveUserByToken(...),
recordIdentityEvent(...)
```

For each caller above:

| Caller pattern | New code |
|---|---|
| Single-key Slack/GitHub/GitLab | `findUserByExternalId(kind, externalId)` |
| Slack — Q5 auto-link path | `findUserByExternalId('slack', userId)` → `findOrCreateUserByEmail(enrichedEmail, hints, actor)` → `linkIdentity(user.id, 'slack', userId, actor)` |
| GitHub — no email path available | `findUserByExternalId('github', sender.login)` only; on miss, record unmapped (kv) |
| Linear webhook | `findUserByExternalId('linear', actorLinearId)` → on miss + email present, `findOrCreateUserByEmail(actorEmail, {name: actorName}, actor)` → `linkIdentity` |
| AgentMail | `findOrCreateUserByEmail(senderEmail, hints, actor)` (auto-create per Q5) |
| MCP `resolve-user` tool | Compat shim: sequential `findUserByExternalId` per provided kind, then `findUserByEmail` |

**Verdict: surface is sufficient.** One missing primitive surfaces: the Linear cascade does **not** want `findOrCreateUserByEmail` to *create* a row when only a Linear ID + name are present (no email). It needs a "find but don't create" email path — which is `findUserByEmail`. The surface already includes that. ✅

**Minor add the plan should consider:** a `getUserIdentities(userId): Array<{kind, externalId}>` helper, since the People page UI (per Core Requirement #7) renders identity badges per row. Either expose it explicitly, or have `findUserById` JOIN and return identities inline; the brainstorm doesn't pin this down. Recommend: explicit separate helper, called by the HTTP handler when composing the People-page response.

---

## 3. Email-availability matrix per integration

| Integration | Webhook payload has email? | API fallback to email | Rate-limit notes | v1 verdict |
|---|---|---|---|---|
| **Slack** | ❌ Inbound `message` event payload contains `user` (Slack ID) only — no email field. | ✅ `client.users.info({ user: userId })` returns `result.user.profile.email`. **Already implemented** at `src/slack/handlers.ts:114-125`, gated on a `userEmailCache: Map<string, string \| null>` (in-memory, process-local). | Slack `users.info` is tier-4 (~100 req/min per workspace). Cache hit is essentially free. **Switch the in-memory cache to `kv_entries` namespace `integration:user-enrichment:slack` per brainstorm Q13** — gives persistence across API-server restarts. | **Can auto-link.** ✅ |
| **Linear** | ✅ `actor.email` is reliably present on webhook payloads (verified via current usage at `src/linear/sync.ts:382` — `String(actor.email ?? "")`). Linear's GraphQL `User` type also exposes `email`. | ✅ GraphQL fallback via `@linear/sdk` (`linearClient.user(id).email`) if ever needed. Current code only uses webhook payload. | Linear API rate limit is generous (~1500 complexity/hr per OAuth token). The `actor.email` lives inline; no separate fetch needed in the common case. | **Can auto-link.** ✅ Email-via-inline-payload — no kv cache needed for the common case. Cache only as an optimization if a future code path queries the GraphQL `User`. |
| **GitHub** | ❌ Webhook `sender` object has `login`, `id`, `type`, `avatar_url`, but **NO `email` field** (GitHub privacy posture — emails never appear in event payloads). | ⚠️ `GET /users/{username}` returns `email` ONLY if the user has set it to public — which is rare. App-installation tokens (`src/github/app.ts:189-238`) can call this endpoint. `GET /user` (auth'd user) is NOT applicable — we don't have a user OAuth token, only App installation tokens. Commit emails (`HEAD ~^{commit}.author.email`) often resolve to `<id>+<login>@users.noreply.github.com` (privacy-friendly redirect) — useless for matching. | App-installation tokens: 5000 req/hr. | **MANUAL-LINK ONLY.** GitHub identities cannot be auto-onboarded via email in the typical case. v1 path: `findUserByExternalId('github', sender.login)` → on miss, record `integration:unmapped:github` in kv. Operator triages on the Unmapped page. |
| **GitLab** | ⚠️ `user.email?` is an OPTIONAL field on `GitLabUser` (verified at `src/gitlab/types.ts:14`). In practice GitLab populates `email` on webhooks **only when** the project is configured to share commit-author-emails or when the user has set their profile email public. Most webhooks omit it. | ⚠️ `GET /api/v4/users?username=<u>` requires `GITLAB_TOKEN` and returns email **only** if the requesting token is admin OR the queried user has set email visibility public. With a regular project-scoped PAT, email is typically `null`. | GitLab API: 600 req/min for authenticated users on GitLab.com. | **Mostly manual.** v1 verdict: if `user.email` is present inline on the webhook (rare), auto-link path is fine. Otherwise: record unmapped, operator triages. No need for a kv-cache enrichment helper since the webhook either has the email or the API likely doesn't either. |
| **AgentMail** | ✅ The whole event IS an email — `senderEmail` extracted from `message.from_` at `src/agentmail/handlers.ts:163-164`. | n/a — email is the primary identifier. | n/a | **Can auto-link.** Already uses `resolveUser({email})` today; mapping to `findOrCreateUserByEmail` is a 1-line change. |

### Cross-reference with `enrichUserFromIntegration(kind, externalId)` (brainstorm Q5/Q13)

| Integration | Needs kv enrichment helper? | Path |
|---|---|---|
| Slack | ✅ Yes — wraps the existing in-memory `userEmailCache` map in `kv_entries` with TTL. | `try kvGet('integration:user-enrichment:slack', userId) → on miss, slackClient.users.info(...) → kvSet` (24h TTL per Q13) |
| Linear | ❌ Email is inline in webhook payload — no API call needed in the common case. | If a code path ever queries Linear's `User` GraphQL for the email (e.g. for a user not on the webhook), wrap it in kv then. |
| GitHub | ⚠️ Tempting but pointless — `GET /users/{login}` rarely returns email. Caching null/missing is not useful (defeats the "retries on rate-limit recovery" benefit from Q13). | Skip. Auto-link not viable for GitHub; cache adds complexity for no value. |
| GitLab | ⚠️ Same logic as GitHub — caching null is anti-value. If the webhook has email inline, use it; if not, unmapped. | Skip. |
| AgentMail | ❌ Email is the input. | No enrichment needed. |

**Conclusion:** the `enrichUserFromIntegration` helper Q5 implies is essentially **Slack-only** in v1. The plan should call it out: "Slack is the only integration that performs API-call email enrichment; Linear extracts inline; GitHub/GitLab don't auto-link by email."

---

## 4. `scripts/check-db-boundary.sh` behavior on `src/be/users.ts`

The script (`scripts/check-db-boundary.sh:18-46`) enforces:

```bash
WORKER_PATHS=(
  src/commands/
  src/hooks/
  src/providers/
  src/prompts/
  src/cli.tsx
  src/claude.ts
  plugin/opencode-plugins/
)
```

It greps these paths for `from\s+["\x27].*be/db` and `(import|from)\s+["\x27]bun:sqlite`.

**Yes/no per prospective caller:**

| Prospective caller of `src/be/users.ts` | Path | Boundary check applies? | Verdict |
|---|---|---|---|
| `src/be/users.ts` (the new file itself, importing `bun:sqlite`) | `src/be/` | ❌ Not in `WORKER_PATHS` | ✅ Free to import `bun:sqlite` |
| `src/github/handlers.ts` | `src/github/` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| `src/gitlab/handlers.ts` | `src/gitlab/` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| `src/slack/handlers.ts`, `src/slack/assistant.ts`, `src/slack/actions.ts` | `src/slack/` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| `src/linear/sync.ts` | `src/linear/` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| `src/agentmail/handlers.ts` | `src/agentmail/` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| `src/tools/resolve-user.ts`, `src/tools/manage-user.ts` | `src/tools/` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| `src/http/users.ts` (and any future MCP-user middleware in `src/http/` or `src/server.ts`) | `src/http/`, `src/server.ts` | ❌ Not in `WORKER_PATHS` | ✅ Free |
| Tests (`src/tests/`) | `src/tests/` | ❌ Not in `WORKER_PATHS` | ✅ Free |

**Conclusion:** the boundary check is **silent** on `src/be/users.ts` and all its prospective callers. No risk of accidentally tripping the check elsewhere.

**One quiet observation:** the check uses `grep -rn` against worker paths; adding `src/be/users.ts` is invisible to it. If the plan ever moves identity-related logic into a worker-side file by accident (e.g. a `src/prompts/identity.ts` that needs to read a user row), the pre-push hook would catch it. The current plan keeps everything API-side, so this is the green path.

---

## 5. `kv_entries` helper inventory

**File:** `src/be/db.ts:9770-10060` (all KV helpers live in `be/db.ts` — there is no separate `src/be/kv.ts` file, despite the brainstorm Q13 wording).

### Schema reference

`src/be/migrations/061_kv_store.sql:20-34`. PK `(namespace, key)` `WITHOUT ROWID`. `value_type` ∈ `{'json', 'string', 'integer'}`. `expires_at` is unix-ms.

### Helpers

| Helper | Signature | Behavior |
|---|---|---|
| `getKv(namespace, key)` | `(string, string) → KvEntry \| null` | Returns null if missing OR expired. **Lazy expire on read:** expired rows are `DELETE WHERE ... = ?`'d inline before returning null. (`src/be/db.ts:9852-9867`) |
| `upsertKv({ namespace, key, value, valueType, expiresAt? })` | named-args → `KvEntry` | INSERT ... ON CONFLICT DO UPDATE. Re-encoded per `valueType`. `expiresAt` is unix-ms or NULL. (`src/be/db.ts:9876-9900`) |
| `deleteKv(namespace, key)` | `(string, string) → boolean` | `true` if a row was removed, `false` otherwise. Doesn't distinguish "expired-but-not-swept" from "never existed". (`src/be/db.ts:9906-9911`) |
| `incrKv(namespace, key, by)` | `(string, string, number) → KvEntry` | **Atomic, in `db.transaction()`.** If row missing OR expired, inserts/replaces with `value=by, value_type='integer', expires_at=null`. **If existing row has non-`integer` value_type, throws `KvTypeCollisionError` (HTTP layer maps to 409).** `by` must be a JS-safe integer; overflow throws. (`src/be/db.ts:9928-9990`) |
| `listKv(namespace, { prefix?, limit, offset })` | named-args → `KvEntry[]` | `WHERE namespace = ? AND (expires_at IS NULL OR expires_at > now) AND key LIKE ? ESCAPE '\\'`. Caller-side capped at `limit ≤ 1000` per HTTP layer. **Does NOT delete expired rows** — keeps cursors stable. (`src/be/db.ts:10000-10032`) |
| `countKv(namespace, { prefix? })` | named-args → `number` | Same predicate as `listKv`. (`src/be/db.ts:10038-10060`) |

### TTL semantics — confirmed match for brainstorm needs

- ✅ Q13 enrichment cache: `upsertKv` with `expiresAt = Date.now() + 24*60*60*1000`. `getKv` lazy-expires. **No sweeper needed.**
- ✅ Q14 unmapped tracking: `upsertKv` with `expiresAt = Date.now() + 30*24*60*60*1000` (30 days). `listKv(namespace='integration:unmapped:<kind>', { prefix: '' })` enumerates for the UI.

### Missing primitives — none

- ✅ **`incrKv` exists** with atomic semantics. The brainstorm Q14 `count` field is supported.
- ✅ **`listKv` with prefix** exists for `GET /users/unmapped` enumeration.
- ✅ **TTL** is built into the schema, lazy-evicted on read.

### The one design wrinkle — unmapped record shape

Brainstorm Q14 proposes the unmapped record as a single JSON value: `{ lastSeenAt, count, sampleEventType, sampleContext }`. But `incrKv` requires `value_type='integer'`. You can't atomically INCR a sub-field of a JSON blob.

**Options (plan must pick one):**

1. **Two kv rows per unmapped identity.** Row A: `key='<externalId>:meta'`, `value_type='json'`, value `{lastSeenAt, sampleEventType, sampleContext}` — overwritten on each webhook. Row B: `key='<externalId>:count'`, `value_type='integer'` — `incrKv` per webhook. The UI joins by externalId. Slightly more rows, but each op is atomic.
2. **Single JSON row, read-modify-write upsert.** Get the row, parse, bump `count`, write. **Not atomic** — two concurrent webhooks for the same `externalId` would race and one increment is lost. Probably tolerable for an operator-triage UI where exact count isn't critical, but worth calling out as a known limitation.
3. **New kv operation `mergeJsonKv(namespace, key, mergeFn, expiresAt?)`.** Atomic read-modify-write inside `db.transaction()`. More general than INCR. **Adds a new primitive** — minor scope creep but a clean fit. The brainstorm leaves the door open by saying Q14 "needs INCR + listKv + TTL" but doesn't enforce a shape.

**Recommendation: option (1).** Symmetric with existing patterns, no new primitive needed, atomic per row. The UI's per-externalId join is trivial (single namespace, two keys per identity, prefix-filter or two `getKv` calls per row).

---

## Plan-time deliverables

The implementation plan MUST include checkboxes covering:

### Migration

- [ ] Create `src/be/migrations/NNN_users_first_class.sql` per Q8 (six DDL blocks + backfill + four DROP COLUMNs).
- [ ] Confirm `user_external_ids.userId REFERENCES users(id) ON DELETE CASCADE` so `deleteUser` continues to clean identities.
- [ ] Confirm migration runs fresh-DB AND on the current real `agent-swarm-db.sqlite` (CLAUDE.md migration rule).
- [ ] Verify dropped indexes (`idx_users_slack/linear/github/gitlab`) are auto-cleaned by SQLite when their parent column drops. Spot-check post-migration with `.indexes users`.

### `src/be/users.ts`

- [ ] Implement `findUserById`, `findUserByExternalId(kind, externalId)`, `findUserByEmail(email)` (checks primary `email` AND `emailAliases` per Q12).
- [ ] Implement `findOrCreateUserByEmail(email, hints, actor)` returning `{user, created}` — auto-merge per Q4.
- [ ] Implement `linkIdentity(userId, kind, externalId, actor)` — INSERT into `user_external_ids` + emit `identity_added` event in the same tx (Q9).
- [ ] Implement `unlinkIdentity(userId, kind, externalId, actor)` — DELETE + emit `identity_removed`.
- [ ] Implement `mintToken(userId, label, actor)` — generate `aswt_<base62>`, sha256, INSERT into `user_tokens`, emit `token_minted`. Return plaintext once.
- [ ] Implement `revokeToken(tokenId, actor)` — UPDATE `revokedAt`, emit `token_revoked`.
- [ ] Implement `resolveUserByToken(plaintext)` — sha256 lookup, async `lastUsedAt` update.
- [ ] Implement `recordIdentityEvent(userId, eventType, actor, before, after)` — INSERT into `user_identity_events`.
- [ ] Add `getUserIdentities(userId): Array<{kind, externalId}>` helper for People-page response composition.
- [ ] Add `fingerprintApiKey(rawKey): string` helper producing `op:<sha256(rawKey).slice(0,16)>` (Q16).
- [ ] Confirm `User` type in `src/types.ts` is updated (drop four identity fields, add `dailyBudgetUsd?: number`, `status: 'invited'|'active'|'suspended'`, `metadata?: Record<string, unknown>`).
- [ ] Confirm `AgentTaskSourceSchema` (`src/types.ts:56-70`) — **no change needed** (no new task-source values added by this migration).

### Caller rewires (all in same PR per Q15)

- [ ] **Delete** `resolveUser` from `src/be/db.ts:8770-8832`.
- [ ] **Delete** identity-field handling from `createUser` (`src/be/db.ts:8843-8881`) and `updateUser` (`src/be/db.ts:8883-8959`).
- [ ] **Delete** identity-field reads from `UserRow` (`src/be/db.ts:8730-8745`) and `rowToUser` (`src/be/db.ts:8747-8764`).
- [ ] Rewire `src/tools/resolve-user.ts` — keep input shape as a compat shim (recommend) OR replace with `{kind, externalId, email, name}` shape.
- [ ] Rewire `src/tools/manage-user.ts` — add `identities?: Array<{kind, externalId}>` field; loop `linkIdentity` calls.
- [ ] Rewire `src/http/users.ts` `POST /api/users` body Zod + `createUser` call.
- [ ] Rewire `src/http/users.ts` `PUT /api/users/{id}` body Zod + `updateUser` call.
- [ ] Rewire `src/slack/handlers.ts:395`, `src/slack/assistant.ts:80`, `src/slack/actions.ts:70` — `findUserByExternalId` + enrichment path (Q5).
- [ ] Rewire `src/github/handlers.ts:159, 517, 752, 860` — `findUserByExternalId('github', sender.login)`; record unmapped on miss (no email auto-link).
- [ ] Rewire `src/gitlab/handlers.ts:66, 166, 250` — `findUserByExternalId('gitlab', user.username)`; if `user.email` present inline, run auto-link; else record unmapped.
- [ ] Rewire `src/linear/sync.ts:383-387, 695-699` — cascade: `findUserByExternalId('linear', id)` → `findOrCreateUserByEmail(email, {name})` → `linkIdentity`.
- [ ] Rewire `src/agentmail/handlers.ts:164` — `findOrCreateUserByEmail(senderEmail, ...)`.

### Slack email-enrichment migration

- [ ] Replace the in-memory `userEmailCache` Map (`src/slack/handlers.ts:38`) with kv-backed access through a new helper `enrichSlackUserEmail(slackUserId): Promise<string | null>` that does `getKv('integration:user-enrichment:slack', slackUserId)` → on miss, `client.users.info(...)` → `upsertKv` with 24h TTL. Confirm: only successful results cached; failures/nulls not cached (Q13).

### Unmapped-identity tracking

- [ ] Pick the kv shape for unmapped records — recommend two rows per identity: `<externalId>:meta` (json) + `<externalId>:count` (integer). Document choice in code.
- [ ] On every webhook resolve-miss with no email-recovery: `upsertKv('integration:unmapped:<kind>', '<externalId>:meta', {lastSeenAt, sampleEventType, sampleContext}, 30 days)` + `incrKv(..., '<externalId>:count', 1)`.
- [ ] Cap `sampleContext` to ≤100 chars (privacy nit, per Q14 Insights).

### Tests

- [ ] Rewrite `src/tests/user-identity.test.ts` for new helper surface. Cover:
  - [ ] `findUserByExternalId` for each kind, plus negative case.
  - [ ] `findUserByEmail` checks both primary `email` AND `emailAliases` (the "easy to forget" case from Q12).
  - [ ] `linkIdentity` PK collision raises (replaces the old UNIQUE-constraint test).
  - [ ] `deleteUser` cascades to remove `user_external_ids` rows.
  - [ ] `findOrCreateUserByEmail` creates a row when no match; merges (returns existing) when there is.
- [ ] New test: webhook auto-link round-trip (Linear inbound with email → existing user gets `linkIdentity` + `identity_added` event).
- [ ] New test: existing-DB migration — pre-migration snapshot with seeded `users.slackUserId` etc. → run migration → assert `user_external_ids` rows backfilled correctly + the four old columns are gone.

### Scripts

- [ ] Rewrite `scripts/backfill-seed-users.sql` to insert into `users` (no identity columns) + 3× `INSERT OR IGNORE INTO user_external_ids` for Taras (slack, linear, github) and 3× for Eze. Keep re-runnable.

### UI

- [ ] Update `ui/src/api/types.ts`:
  - [ ] `User` interface: drop the four identity fields; add `identities?: Array<{kind, externalId}>` (or whatever the API exposes); add `dailyBudgetUsd?: number`, `status: ...`, `metadata?: Record<string, unknown>`.
  - [ ] `CreateUserInput`: same drop + add `identities`.
  - [ ] **Do not touch** `AgentTask.slackUserId` (`ui/src/api/types.ts:109`) — that's the kept task-context column.
- [ ] Build the People page per Q11 + Q14 (out of scope for the migration PR per brainstorm Next Steps; flag for follow-up).

### Docs

- [ ] Hand-edit `docs-site/content/docs/(documentation)/reference/mcp-tools.mdx:766-789` (the resolve-user / manage-user sections) to reflect new shape. **Do not touch** lines 75 and the `slack-integration.mdx` references (they're for `agent_tasks.slackUserId`, kept).
- [ ] Hand-edit `MCP.md:223-247` similarly (resolve-user / manage-user docs); leave line 170 alone (`send-task` parameter, kept).
- [ ] Rewrite `plugin/commands/user-management.md` (entire file). Update examples to use the new `identities: [{kind, externalId}, ...]` shape.
- [ ] Run `bun run build:pi-skills` to regenerate `plugin/pi-skills/user-management/SKILL.md`.
- [ ] Run `bun run docs:openapi` after changing `src/http/users.ts` to regenerate `openapi.json` + `docs-site/content/docs/api-reference/**`.

### Secret-scrubber (token plaintext)

- [ ] Add `aswt_[A-Za-z0-9]{20,}` rule to `src/utils/secret-scrubber.ts` (Core Requirement #11 from MCP brainstorm, lands with the migration even if endpoints land later).

### Pre-push / CI guardrails

- [ ] No change needed to `scripts/check-db-boundary.sh` — `src/be/users.ts` and all callers are API-side.
- [ ] After all rewires: re-grep for `users.slackUserId`, `users.linearUserId`, `users.githubUsername`, `users.gitlabUsername` and any of the four bare names that aren't in a `agent_tasks` / `inbox_messages` context. Target zero hits outside `src/be/migrations/031_user_registry.sql` and the new migration file + the seed script.

---

## Honest gaps in this research

- **MCP.md generation flow** is not explicitly clear from the repo — `MCP.md` may be hand-edited rather than generated. The plan should verify (look for a `bun run docs:mcp` script or similar; if absent, treat MCP.md as hand-written and edit accordingly).
- **`plugin/commands/user-management.md` → `plugin/pi-skills/user-management/SKILL.md`** generation is per the CLAUDE.md `bun run build:pi-skills` script. Confirmed in the project CLAUDE.md root file but not verified by running it.
- **Linear webhook payload `actor.email` reliability** is asserted based on the existing code's use (`src/linear/sync.ts:382` extracts it unconditionally) and is consistent with Linear's documented webhook schema. The plan should run a real Linear webhook through the dev pipeline before merge to confirm `actor.email` is populated for the agent-session and issue-followup events; if it's not, the auto-link path silently degrades to manual-only for Linear too.
- **GitHub email via App-installation token** — I assert this is functionally non-viable based on the privacy posture, but did not verify against a real GitHub user via the API. The plan should treat GitHub as manual-link-only and revisit only if a real test shows public emails are routinely available (don't expect them to be).
- **Linear sync `name`-only fallback** is dropped in the proposed rewrite. If any real Linear user's webhook event has neither `actor.id` nor `actor.email` populated (e.g. for system-actor events), the new code will silently miss them and record them as unmapped. Audit Linear's webhook documentation for the actor-shape on system events before merging.

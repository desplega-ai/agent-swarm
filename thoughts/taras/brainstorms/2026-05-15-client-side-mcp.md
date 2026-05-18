---
date: 2026-05-15T00:00:00Z
author: Taras
topic: "Client-side MCP for the swarm (end-user MCP, Slack-integration parity)"
tags: [brainstorm, mcp, users, identity, integrations]
status: in-progress
exploration_type: idea
last_updated: 2026-05-15
last_updated_by: Taras
---

# Client-side MCP for the swarm — Brainstorm

> **2026-05-18 update — schema lands via [[2026-05-18-humans-as-first-class-users]].** The People-page brainstorm now co-lands the migration this MCP plan needs: `user_external_ids`, `users.metadata`, `users.dailyBudgetUsd`, `users.status`, `user_tokens`, `user_identity_events` (with eventType union of both brainstorms' needs, plus `status_changed`). DB helpers go into `src/be/users.ts` (`mintToken`, `revokeToken`, `resolveUserByToken`, `recordIdentityEvent`, etc.) — also from that brainstorm. When this MCP plan lands, **its migration is zero new tables, its DB helpers are reused, and its operator UI is additive** (the token-mint dialog and token-list row attach to the People page). The same brainstorm also resolves Open Question #3 here (email-alias support → keep `users.emailAliases` JSON, no `user_emails` table). See [[2026-05-18-humans-as-first-class-users]] §Q8–Q16 for the schema/policy commitments, and the Synthesis section for Core Requirements that supersede #1 here.

## Context

Taras wants to expose a **client-side MCP server** that end-users of the swarm can connect to (from Claude Code, Cursor, Goose, etc.) — analogous to the MCP that the swarm owner uses today, but with end-user-appropriate scopes.

The mental model is: "what a user gets via the Slack integration today, but reachable from any MCP-aware client." That is — a regular user can ask the swarm to do work, check on their tasks, talk to their agents, search their channels, etc., without dropping into Slack.

Key existing primitives to ground on:

- **`users` table** (migration 031): canonical user profile keyed by id, with side identities `slackUserId`, `linearUserId`, `githubUsername`, `gitlabUsername`, `email`/`emailAliases`, plus `preferredChannel` and timezone. `agent_tasks.requestedByUserId` already links work back to a canonical user.
- **Owner/operator MCP** is the set of tools in `src/tools/` exposed via `src/server.ts` over the HTTP transport with `Authorization: Bearer ${API_KEY}` and `X-Agent-ID` headers. This includes things like `send-task`, `get-tasks`, `poll-task`, `post-message`, `slack-*`, memory tools, etc.
- **Slack integration** acts today as the de-facto user-facing surface: a user @-mentions the bot, gets routed by `slackUserId → users.id`, the bot creates tasks `requestedByUserId = users.id`, posts back into the thread. That's the UX shape we want to mirror for MCP-as-client.

Open questions worth iterating on (the meat of this brainstorm):

1. **Who is the user?** How does an MCP client prove "I am this `users.id`" — and how does that identity get bootstrapped (cf. existing `slackUserId` linking)?
2. **What's the surface area?** Which subset of today's tools does an end-user get, vs the owner/operator MCP? (Send task, check task, list my tasks, talk to my agent, search memory…)
3. **Multi-tenancy semantics** — when user A runs `get-tasks`, do they only see their own `requestedByUserId = A` tasks? Do they see the channels they're in?
4. **Token / auth model** — per-user token issued via OAuth-ish flow? Per-user API key in `users` table? Reuse existing `API_KEY` + `X-User-Id`?
5. **Discovery / onboarding** — how does a brand-new user get a connection URL and link their identity (slack, github, email)?
6. **Topology** — does this run as the same `src/http.ts` server with a different route prefix (e.g. `/mcp/user`), a separate Bun.serve, or as a per-user stdio shim that proxies to the HTTP API?

## Exploration

### Q: Auth model — how does an MCP client prove which `users.id` it is?

**Answer:** Mix of (1) per-user API token stored on `users` and (4) magic-link via email — "depends on support for that" suggests OAuth would have been the ideal but client support is uncertain, so the pragmatic blend is: ship token-in-config now, with magic-link-via-email as the supported way to mint/rotate that token (and to create a `users` row for someone who has no prior Slack/GitHub identity yet).

**Insights:**
- Implies a new column(s) on `users` — probably a hashed token (`mcpTokenHash`, never store plaintext) plus `mcpTokenIssuedAt` / `mcpTokenLastUsedAt`. Or a separate `user_tokens` table if we expect multiple concurrent tokens (one per device).
- Magic-link flow needs: `POST /mcp/connect {email}` → email-deliver link → `GET /mcp/connect/:nonce` → mint token → render in browser for copy-paste into MCP client config.
- For Slack-identified users, we can also let them ask the bot "give me an MCP token" without ever leaving Slack — but per the answer, that's a follow-up, not blocking the MVP.
- Email path is the inclusive default — users without Slack can still onboard, and we link `users.email`/`emailAliases` on first connect.
- Open: whether to add a column or table — comes down to "one active token per user" vs "N labelled tokens". Defer until we know.

### Q: What tool surface ships in v1?

**Answer:** Task ops scoped to me only — `send-task` (forced `requestedByUserId = me`), `get-tasks` filtered to mine, `poll-task`, `cancel-task`, `task-action` gated on ownership. Memory / channels / swarm-reads are out of scope for v1.

**Insights:**
- Tiny surface → small blast radius. The scoping invariant is uniform: "every tool either ignores user identity or filters by `requestedByUserId = me`". Easy to audit.
- `send-task` is the only mutator. That's also the only one with a real cost surface (spawning agents → compute spend). Worth thinking about per-user rate limits / budget caps from day one — but as guardrails, not a blocker.
- "Talk to my agents" was a tempting v1 addition (since it's the Slack-parity feel), but is correctly deferred — channel ACL membership is its own can of worms.
- Implies we need a uniform way to inject `requestedByUserId` into the tool's execution context based on bearer token. Probably a middleware that resolves `Bearer <mcpToken>` → `users.id` and stashes it on the request, then tools read it via a `ctx.userId` accessor.

### Q: How do we reconcile MCP-magic-link signups with the existing `users` row that the same human may already have via Slack?

**Answer:** Auto-merge by email match, best effort. On magic-link, look up `users.email` and `emailAliases`; attach the token to a matching row if found. For Slack-only rows without an email, fall back to a "is this you?" claim prompt showing the Slack handle.

**Insights:**
- Email becomes the canonical merge key. We should make sure `emailAliases` is checked alongside `email` (already supported by the schema).
- The "claim prompt" needs a landing page rendered after the magic-link click — list candidate Slack-only rows where some heuristic suggests the same person (e.g. Slack profile email if it was ever scraped, or just "no email-bearing rows exist; here's all Slack-only rows in your workspace — claim one or create new"). For a first version, "always create new unless email match" is fine; the claim flow is the v1.5 layer.
- We should record an `identityMergeLog` (or extend an existing audit log) — auto-merges that silently combine identity rows are exactly the kind of thing that bites later. At minimum: log "merged users.id=X (slackUserId=Y) with magic-link email=Z" with timestamp + nonce.
- Race condition to think about: two simultaneous magic-link claims on the same email. Need UNIQUE constraint on `email` (already present as partial unique index) and treat the second claim as an additional-device token mint on the existing row.
- Conflict case: what if email matches `users.A`, but the user later DMs the bot from Slack and Slack identity is already on `users.B`? Need a "merge two rows" operation — possibly manual-only.

### Q: Transport / distribution model?

**Answer:** Hosted HTTP/SSE only — extend `src/http.ts` with a `/mcp/user` route (or equivalent) alongside the existing owner MCP. Zero-install for users, scope stays inside this repo.

**Insights:**
- Lines up with the auth choice — the bearer token in the MCP connection URL is what drives `users.id` resolution.
- Implies we need to teach `src/http/route-def.ts` (or wherever the MCP routes get registered) about a second tool registry / second route prefix. We're not duplicating tool implementations — the same tool *functions* should be runnable under both the owner registry and the user registry, with different `ctx` (the user-scoped ctx forces `requestedByUserId = ctx.userId`).
- Clients that only do stdio (some self-hosters, older Goose, etc.) are intentionally out of scope for v1. If demand appears, a stdio shim that proxies to this endpoint is trivial to build later.
- Need to think about CORS / origin allow-listing — for hosted SaaS, the URL is public; for self-hosted, it's whatever the operator exposes. Reuse the existing `API_KEY` infra patterns where possible.
- One ergonomic decision: the connection URL should embed the token (`https://swarm.example.com/mcp/user?token=...`) or rely on a standard `Authorization` header — depends on what Claude Code / Cursor accept. Both can be supported; the header is preferred for security (URL params get logged).

### Q: Result-delivery semantics for `send-task`?

**Answer:** v1 = `send-task` returns immediately + manual `poll-task` (today's owner-MCP behavior). v2 plan = MCP notifications using Claude Code's notification format — reference: <https://code.claude.com/docs/en/channels-reference#notification-format>.

**Insights:**
- v1 is essentially "reuse the owner-MCP tool surface with user scoping". No new protocol work — just the auth/scope middleware and a route.
- v2 (notifications) closes the Slack-parity UX gap: agent finishes → push to MCP client → user sees it without having to ask. Need to study Claude Code's notification spec to know what payload shape they render usefully (title, body, action URL?).
- Polling is the safety net if notifications don't land — should always work as a backstop.
- Worth verifying that the existing `poll-task` long-poll behavior is tolerable from a hosted-server-cost perspective (held connections × N users); SSE notifications are cheaper than many held HTTP polls.

### Q: Guardrails for `send-task` (the only mutator)?

**Answer:** Reuse existing per-agent budget infra — wire `send-task` from user MCP so the resulting agent inherits a per-user budget cap (`users.dailyBudgetUsd` or similar) that the agent-side enforcement aborts on. Refer back to the existing 2026-04-28 brainstorm on per-agent daily cost budgets [[2026-04-28-per-agent-daily-cost-budget]].

**Insights:**
- Coheres with the smallest-possible-v1 ethos — no new enforcement code paths.
- Implies `users` gains a `dailyBudgetUsd` (or similar) column, with a sensible default. That default is the policy question: a too-low default is annoying, a too-high default is risky. Probably configure via an admin-set env or per-deploy default.
- Per-task hard ceiling (`maxTaskCostUsd`) is a useful secondary knob — prevents one runaway task from consuming the whole daily budget in a single agent run.
- The budget is enforced agent-side (so it works regardless of how the task was created — Slack, owner MCP, user MCP). That means we get this guardrail "for free" once the column is wired.

### Q: How does a new user get a token in v1?

**Answer:** Operator-mediated via the UI (`ui/`, port 5274) — the swarm operator authenticates with the global `API_KEY` and uses a **new Users page** to view, create, and manage users + mint MCP tokens. No public self-serve signup endpoint in v1.

**Insights:**
- This reframes the magic-link discussion: in v1 it's not the primary onboarding path; the operator mints the token directly in the dashboard. Magic-link via email becomes a v1.5+ concern, useful for self-rotation or operator-issued invite-by-email.
- New `ui/` page required — list `users` rows, show identity links (slack, github, etc.), buttons for "mint token", "revoke token", "edit budget". Token shown once on mint, then only hash is stored.
- The token-mint operation needs an authenticated API endpoint (uses the global `API_KEY` like everything else in the operator UI) — e.g. `POST /users/:id/mcp-tokens` returns the plaintext token once, persists only the hash.
- Implication for the `users` schema: separate `user_tokens` table is now strongly indicated. Multiple tokens (per-device labels), independent revoke, and a clean audit history are more important than a single column when the operator is doing this through a UI.
- Token table sketch: `user_tokens(id, userId, label, tokenHash, createdAt, lastUsedAt, revokedAt)` with index on `tokenHash`. Tools lookup is `SELECT userId FROM user_tokens WHERE tokenHash = ? AND revokedAt IS NULL`.
- Once the operator-UI flow ships and feels right, the same endpoint can power a self-serve `/connect` route in v1.5 with whatever gating policy (open / invite / domain) the deployment chooses.
- Also: the Users page is independently useful even without MCP — surfaces identity-link state, lets the operator do manual merges, audits `requestedByUserId` per task.

### Q: Owner-MCP overlap — one registry or two?

**Answer:** Two registries, shared tool implementations. Owner-MCP route stays as-is with `OwnerCtx`. User-MCP gets its own route + registry with `UserCtx`. Tool implementations are the same functions, parameterised by ctx shape.

**Insights:**
- Forces tools to be explicit about which ctx they accept — typescript can enforce that `send-task` from user-MCP receives a `UserCtx` that always has `userId`, so scoping is structural not behavioural.
- Two registries means the user-MCP registry exposes only the small v1 subset (`send-task`, `get-tasks`, `poll-task`, `cancel-task`, `task-action`) — operator tools (`db-query`, `manage-user`, `inject-learning`, etc.) are simply not registered there, no risk of accidental exposure.
- Implies a small refactor: tool definitions in `src/tools/*.ts` need to be split into "tool fn (ctx, args) -> result" and the registry mapping. The mapping is what differs per route.
- Keeps the owner-MCP backwards-compatible — `Authorization: Bearer ${API_KEY}` + `X-Agent-ID` is untouched. The new route uses `Authorization: Bearer <user-token>` and resolves `userId` from the token.

### Q: Connection URL shape — header or query-string?

**Answer:** Header-only, spec-correct. Clients send `Authorization: Bearer <token>` over HTTP; the URL is plain `https://swarm.example.com/mcp/user`.

**Insights:**
- Avoids the well-known foot-guns of tokens in URLs (proxy logs, browser history, referer leakage).
- Couples the v1 to "clients that support custom headers on MCP connections" — Claude Code and Cursor both do. If a popular client surfaces a URL-only UI, we revisit.
- The Users-page UI should display the token alongside a small ready-to-copy snippet in the right shape for the major MCP clients (e.g. `claude_desktop_config.json` fragment, Cursor MCP-server fragment). Reduces friction for the human.
- Server-side: middleware reads `Authorization: Bearer <prefix>_<rand>` → hash → lookup in `user_tokens` → resolve `userId`. Reject missing/malformed/unknown/revoked. Update `lastUsedAt` async (don't block the request).

### Q: Token format?

**Answer:** GitHub-PAT style — opaque random with a fixed prefix, sha256 stored. Token shape: `aswt_<base62(32 random bytes)>`. DB stores only `sha256(token)` in `user_tokens.tokenHash` with a UNIQUE index.

**Insights:**
- Prefix `aswt_` ("agent-swarm worker token") makes the token recognisable in logs / GitHub secret-scanning / accidental commits. Encode it as a literal `secret-scrubber` rule.
- 32 bytes of entropy is plenty; no need for argon2.
- Lookup: compute `sha256(presented)`, `SELECT userId, id, revokedAt FROM user_tokens WHERE tokenHash = ? LIMIT 1`. Reject if no row or `revokedAt` is set.
- Async `UPDATE ... SET lastUsedAt = now() WHERE id = ?` — fire-and-forget, don't block the request.
- For multi-token-per-user UX, `user_tokens.label` (free text) is shown next to `lastUsedAt` so the operator can tell devices apart.

### Q: `dailyBudgetUsd` default?

**Answer:** No default. `users.dailyBudgetUsd` is nullable; NULL = unlimited. Operator decides explicitly per-user from the Users page.

**Insights:**
- Cleanest schema; matches the "operator-mediated v1" stance — if the operator is creating users by hand, they can set a budget by hand.
- Users page should surface NULL clearly — e.g. an "unlimited" badge in red/warning colour, plus an inline "set cap" CTA. The visibility is the safety net.
- Agent-side budget enforcement: `if user.dailyBudgetUsd is null → no enforcement; else compare today's spend against cap`. Existing per-agent budget infra already handles the null case naturally if we wire it that way.
- Implication for hosted SaaS later: when self-serve opens (v1.5+), we'll likely flip the default to a non-null env-driven value. v1 doesn't need to solve that since signup is operator-only.

### Q: SSE / long-poll cost concerns?

**Answer:** Misframed in the original synthesis — `poll-task` is the **worker-side** long-poll ("give me a task to work on"), not an end-user "wait for my task to finish" call. End-user MCP doesn't include `poll-task` at all. Each user call is a quick request → quick response; long-poll cost concern dissolves.

**Insights:**
- v1 user-MCP tool surface is now: `send-task`, `get-tasks` (filtered), `get-task-details` (gated on ownership), `cancel-task`, `task-action`. Strike `poll-task` from the surface.
- "Is my task done?" UX = client calls `get-task-details` on demand. No held connections. Pure request/response.
- This *increases* the motivation for the v2 notifications path — without long-poll, the user has to actively ask, which is fine for Claude Code (it'll naturally call `get-task-details` when the agent wants to know) but is the gap from Slack-parity where the bot pushes back.
- Update Core Requirements + Key Decisions in the synthesis below to swap `poll-task` for `get-task-details`.

### Q: Identity-merge audit log?

**Answer:** New `user_identity_events` table — single source of truth for identity-related events on a user row. Schema: `(id, userId, eventType, actor, beforeJson, afterJson, createdAt)`, `eventType ∈ {auto_merge, manual_merge, identity_added, identity_removed, token_minted, token_revoked}`.

**Insights:**
- The Users page can render a per-user activity timeline directly from this table — useful for "when did this user last get a new token?" and "who linked this Slack ID?" questions.
- `actor` is either `'system'` (auto-merge), an operator's API-key fingerprint, or `users.id` (self-action) — gives provenance.
- `beforeJson` / `afterJson` are full row snapshots so we can reconstruct any state transition without joining other tables (cheap with SQLite text storage).
- Worth adding `eventType = 'budget_changed'` too while we're at it — same actor model, same use case.
- Index on `(userId, createdAt DESC)` for the timeline query.

### Q: Self-serve `/connect` route gating (v1.5+)?

**Answer:** All three modes ship together when v1.5 lands. `MCP_SIGNUP_MODE=open|invite|domain` (env). Operator picks per deploy.

**Insights:**
- `invite` mode is the natural extension of v1: operator pre-creates a `users` row with `status='invited'`, sends them a magic-link URL, link only works for emails on the allow-list (effectively just that row's email + aliases). Reuses v1 plumbing.
- `domain` mode reads `MCP_SIGNUP_DOMAINS` (comma-separated). On `POST /connect {email}`, check if `email` ends in any allowed domain; reject otherwise.
- `open` mode is the hosted SaaS posture; everyone with a valid email can mint. Pair tightly with a non-null `dailyBudgetUsd` default in this mode (the unlimited default from Q4 stops being safe).
- v1.5 should also surface `MCP_SIGNUP_MODE` in the Users page header so the operator can see at a glance which mode is active.
- Schema-wise: `users.status TEXT DEFAULT 'active'` with values `{invited, active, suspended}`. v1 doesn't strictly need this column yet, but adding it during v1 makes v1.5 a smaller delta.

### Q: Cross-user channel ACLs (v2+)?

**Answer:** Question dissolved — channels are de-facto deprecated / not used in the swarm today. "Talk to my agents" won't go through channel ACLs.

**Insights:**
- The Slack-parity "thread back the agent's reply" UX doesn't need channels — it needs something else. The natural alternative for v2+ is per-task conversation: the task itself is the thread, and `post-message` (if it returns) operates on a task id, not a channel id.
- `request-human-input` already exists as a tool and is the closest existing primitive for "agent asks user, user replies" — likely the right hook for a future "talk to my agents" flow over user-MCP.
- Out of scope for this brainstorm. Capture as a follow-up: "Define the v2+ conversation primitive for user-MCP now that channels are off the table."



### Key Decisions

- **Identity:** end-user is a `users` row. MCP tokens resolve to that row. Auto-merge with existing Slack-only rows by email match (best effort); claim-prompt for ambiguous Slack-only rows is v1.5.
- **Transport:** hosted HTTP/SSE only, added to existing `src/http.ts` (`/mcp/user` route). Stdio shim deferred.
- **Owner-MCP relationship:** two separate registries with shared tool implementations. Owner-MCP route untouched (`OwnerCtx`, global `API_KEY`); user-MCP gets its own route + registry (`UserCtx`, bearer user-token). Tool functions are reused; the registry mapping differs.
- **Connection URL:** header-only — `Authorization: Bearer <token>`. URL is plain. Tokens never travel in query-strings.
- **Token format:** GitHub-PAT style. Plaintext = `aswt_<base62(32 random bytes)>`. DB stores `sha256(token)` only, with UNIQUE index. Secret-scrubber gets the `aswt_` rule.
- **Tool surface (v1):** task ops scoped to the calling user — `send-task` (forces `requestedByUserId = ctx.userId`), `get-tasks` filtered to mine, `get-task-details` gated on ownership, `cancel-task`, `task-action`. Memory and channel/swarm reads explicitly out of scope. `poll-task` is **not** in the user-MCP surface (it's worker-side).
- **Result delivery (v1):** `send-task` returns immediately; client calls `get-task-details` on demand. No long-poll on the user MCP. v2 adds MCP notifications using the Claude Code notification format (<https://code.claude.com/docs/en/channels-reference#notification-format>).
- **Guardrails:** reuse the existing per-agent budget infra ([[2026-04-28-per-agent-daily-cost-budget]]). `users.dailyBudgetUsd` is nullable; NULL = unlimited. Operator sets per-user from the Users page. Optional per-task ceiling as a secondary knob.
- **Onboarding (v1):** operator-mediated via the dashboard. New "Users" page in `ui/` lets the operator (authed by global `API_KEY`) view/create users, manage identity links, mint/revoke MCP tokens, edit budget. No public self-serve signup yet.
- **Self-serve (v1.5+):** `MCP_SIGNUP_MODE=open|invite|domain` env, all three modes ship together. `users.status TEXT DEFAULT 'active'` (values `{invited, active, suspended}`) lands in v1 so the v1.5 delta is small.
- **Token storage:** separate `user_tokens` table (multi-token per user, labelled, independently revocable), not a single column on `users`. Plaintext token shown once on mint; only hash persisted. `lastUsedAt` updated fire-and-forget.
- **Audit log:** new `user_identity_events` table — single source of truth for `{auto_merge, manual_merge, identity_added, identity_removed, token_minted, token_revoked, budget_changed}` events. Renders the per-user timeline on the Users page.
- **Channels:** off the table — de-facto deprecated. "Talk to my agents" (v2+) will go through a per-task conversation primitive (likely `request-human-input` adjacent), not channel ACLs.

### Open Questions

All eight original open questions have been resolved in the iron-out round above. Remaining residual unknowns (not blocking v1):

- **Tool-fn refactor shape** — how exactly do existing `src/tools/*.ts` definitions split into `(ctx, args) → result` + registry binding? Probably a typed `defineTool({ name, schema, handler })` helper, but worth a research pass before committing.
- **`get-task-details` ownership-gating wording** — exact behaviour when a user calls it on someone else's task: 404 (don't leak existence) vs 403 (be explicit)? 404 is friendlier for security; lean that way unless there's a UX reason otherwise.
- **`request-human-input` reply path in v2+** — when "talk to my agents" enters the surface, does it route through `request-human-input` or a new conversation primitive? Triggered now that channels are off the table.
- **Token UX in the Users page** — copy-once-on-mint dialog should also offer JSON snippets for Claude Desktop / Cursor config. Worth designing once we're in plan-time.

### Constraints Identified

- **DB ownership invariant:** API server is the sole DB owner — new token mint / lookup logic lives in `src/be/db.ts` + new HTTP endpoints, not in worker code.
- **Migration discipline:** forward-only SQL in `src/be/migrations/NNN_*.sql`. New table needs to land in a single migration, tested against a fresh DB and an existing one.
- **`route()` factory:** any new HTTP endpoints (token mint, user listing) must use `src/http/route-def.ts`'s `route()`, then `bun run docs:openapi` to regenerate the spec.
- **Secret scrubbing:** plaintext MCP tokens MUST go through `scrubSecrets` before they touch any logs / `session_logs` / jsonl output. Add the token shape to the scrubber's regex set.
- **MCP tool registration:** the user-MCP tool registry should reuse existing tool implementations with a scoped `ctx`, not fork the implementations. One source of truth per tool.
- **`users` row creation:** when the operator creates a user from the UI, the same `INSERT` paths that Slack-bootstrap uses today should be invoked — don't create a second "user creation" code path.

### Core Requirements

1. **New migration** — one file, lands together:
   - `user_tokens(id PK, userId FK→users, label, tokenHash UNIQUE, createdAt, lastUsedAt, revokedAt)` + index on `tokenHash`.
   - `user_identity_events(id PK, userId FK→users, eventType, actor, beforeJson, afterJson, createdAt)` + index on `(userId, createdAt DESC)`. `eventType` ∈ `{auto_merge, manual_merge, identity_added, identity_removed, token_minted, token_revoked, budget_changed}`.
   - `users.dailyBudgetUsd REAL NULL` (NULL = unlimited).
   - `users.status TEXT NOT NULL DEFAULT 'active'` with CHECK in `{invited, active, suspended}` (lands v1 to make v1.5 small).
2. **New HTTP endpoints** (operator-auth via global `API_KEY`, all via `route()`):
   - `GET /users` — list users with identity links + budget + token summary + recent events.
   - `POST /users` — create a user (name, email, optional budget, optional initial Slack/GitHub linkage).
   - `PATCH /users/:id` — edit profile / budget / identity links / status. Emits `user_identity_events`.
   - `POST /users/:id/mcp-tokens` — mint a new token. Returns plaintext **once**; persists only sha256 hash. Emits `token_minted` event.
   - `DELETE /users/:id/mcp-tokens/:tokenId` — revoke. Emits `token_revoked` event.
   - `GET /users/:id/events` — paginated event timeline.
3. **New MCP route**: `/mcp/user` on the existing Bun.serve. Bearer-token middleware reads `Authorization: Bearer aswt_…`, hashes, looks up `user_tokens` where `revokedAt IS NULL`, stashes `userId` on request ctx, updates `lastUsedAt` async. Rejects unknown/revoked.
4. **Tool-fn refactor**: split `src/tools/*.ts` between a pure `(ctx, args) → result` handler and the registry-binding glue, so the same handler can be bound under the owner registry (with `OwnerCtx`) and the user registry (with `UserCtx`).
5. **Two registries**: owner-MCP unchanged. User-MCP registers exactly: `send-task`, `get-tasks`, `get-task-details`, `cancel-task`, `task-action`. Each handler reads `ctx.userId` for scoping (`send-task` writes `requestedByUserId = ctx.userId`; reads filter by it; mutators 403/404 on non-owned tasks).
6. **`UserCtx` type**: `{ userId: string; user: UserRow }` — resolved once by the middleware, passed through.
7. **Ownership-gating policy**: `get-task-details` / `cancel-task` / `task-action` return **404** (not 403) when the task exists but `requestedByUserId !== ctx.userId`, to avoid leaking existence.
8. **`ui/` Users page**: list / create / edit users; mint / revoke tokens; show identity links; edit budget; render per-user `user_identity_events` timeline; surface `MCP_SIGNUP_MODE` value (read-only header). Token plaintext shown in a copy-once dialog with ready-to-paste JSON snippets for major MCP clients.
9. **Auto-merge logic** on operator-create-from-email AND on future magic-link signup: look up `users.email` + `emailAliases` for a match; attach to the existing row if found; log `auto_merge` event with before/after JSON. Manual operator-driven merges (combine two existing rows) emit `manual_merge`.
10. **Budget enforcement wiring**: agent-side day-spend check resolves the requesting `users.id` via `agent_tasks.requestedByUserId`; if `users.dailyBudgetUsd IS NOT NULL` and today's cumulative spend ≥ cap, abort. NULL → unlimited.
11. **Secret scrubber update**: add `aswt_[A-Za-z0-9]{20,}` (or appropriate base62 length) to `src/utils/secret-scrubber.ts`. Confirm coverage via existing test pattern.
12. **OpenAPI regen**: after any HTTP additions, `bun run docs:openapi` + commit. `users.id`-shaped responses get a published schema.

## Next Steps

- **2026-05-15:** initial brainstorm captured the v1 shape; parked.
- **2026-05-15 (round 2):** ironed out all 8 open questions. v1 is now concretely spec'd in Core Requirements above.
- **Recommended handoff:** `/desplega:research` to ground the tool-fn refactor (Core Requirement #4) and the existing per-agent budget infra (Core Requirement #10) against the live codebase before planning. The migration + UI pieces are well-scoped already and could go straight to `/desplega:create-plan`.



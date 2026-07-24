---
date: 2026-07-23
author: taras
type: handoff
plan: thoughts/taras/plans/2026-07-21-connections-redesign
---

# Connections Redesign — v-implement Handoff (2026-07-23)

Resume with `/desplega:v-implement thoughts/taras/plans/2026-07-21-connections-redesign` in a fresh session. This doc captures state the plan files + git don't.

## Where we are

**Branch `connections-redesign`** (off `main` @ `09133e0a`). Steps 1–7 of 11 are DONE, reviewed, and merged. Autonomy = **Critical** (pause per wave), commits = **per-step**, executor policy per `delegate-work`.

Remaining: **step-8** (tracker fold), **step-9 + step-10** (UI), **step-11** (integration/docs). Per the DAG:
- step-8 depends on step-4 + step-5 → **READY NOW**
- step-9 depends on step-4 + step-6 → **READY NOW** (UI)
- step-10 depends on step-6 + step-7 → **READY NOW** (UI)
- step-11 depends on step-3 + step-8 + step-9 + step-10 → blocked until those land

Next wave can fan out step-8 (backend) + step-9 + step-10 (UI) in parallel.

## ⚠️ Test status — 6 REAL FAILURES to fix FIRST in the new session

First full `bun test` showed 9 fails; re-run showed **6 real fails** (the other 3 were the known cold-boot flakes — `events-http`, `page-proxy`, `memory-rater-e2e` — which pass in isolation; ignore those). Static checks all green (tsc, lint, both boundary checks, rbac-coverage 52 verbs, vendored drift, dep-graph 0 errors, Docker build OK). The 6 real failures, with diagnosis:

**Group A — my dead-verb cleanup left dangling test references (TRIVIAL, ~5 min, I caused these):**
When I removed the now-dead `config.credential-bindings.write` verb (commit `1f6df953`, correct — its last call site died with step-7's blob-store retirement), I updated `src/rbac/permissions.ts` + `legacy-policy.ts` but MISSED two tests that still reference it:
1. `(fail) lead-only verbs > config.credential-bindings.write: only lead allowed` — a legacy-policy test asserting the removed verb. **Fix: delete that test case** (likely in `src/tests/rbac-*.test.ts` or `src/tests/legacy-policy*.test.ts`).
2. `(fail) verb-group partition > test groups cover every registered verb exactly once` — a partition test with a hardcoded verb-group list that still names `config.credential-bindings.write`. **Fix: remove it from that group list** so the partition matches the (now smaller) registered-verb set. Grep: `grep -rn 'config.credential-bindings.write' src/tests/`.

**Group B — OAuth CAS + migration tests, need a real look (NOT yet triaged — could be merge regressions or tests needing updates for merged state):**
3. `(fail) ensureTokenOrThrow > carries the loaded tokenVersion through refresh when the refresh token is unchanged`
4. `(fail) ensureTokenOrThrow > does not rotate again when a concurrent caller already changed the token row`
5. `(fail) ensureTokenOrThrow > does not use a refreshed Jira access token when persistence loses the CAS race`
6. `(fail) migration 117 unified OAuth storage > carries legacy rows, lifts quirks, re-keys bindings, and encrypts idempotently`

Items 3–5 are the tokenVersion-CAS tests (file: likely `src/tests/ensure-token.test.ts` or `oauth-*`). These test the step-1-fix + step-5 CAS interaction. **Critically: these passed individually during step-5's merge verification** (the step-5 merge ran `ensureToken` + oauth-refresh suites green), so either (a) a later merge (step-6/step-7) regressed shared oauth code, or (b) they're order-dependent under full-suite `mock.module` leakage (see memory `bun-test-gotchas` — mock.module leaks process-wide, causing CI-only order effects). **Triage: run `bun test src/tests/<file>.test.ts` in isolation first.** If green in isolation → it's the known mock-leak order effect, lower priority. If red in isolation → real regression in the tokenVersion CAS path, must fix before wave 3 (this is the concurrency-correctness core of the OAuth refresh).
Item 6 is the migration-117 carry-over/encryption test — same triage; run in isolation. Migrations 120/121 landed after 117 so a fresh full-migration replay in the test may now behave differently.

**Do NOT proceed to wave 3 until all 6 are resolved (fixed or confirmed-flaky-in-isolation).** None block the architecture; they're test-integration debt from the merge + my cleanup.

## Executor policy decision (changed mid-run)

Codex background tasks were **externally killed twice** early on (environmental, not systematic). Taras chose **native Claude agents** for wave 2 — worked cleanly. **Default wave 3 to native agents** (Opus for UI steps 9/10; step-8 backend = Opus). If using Codex: **gotcha (memory `codex-worktree-trust`)** — `codex exec` code-mode host times out in worktrees not listed as `trusted` in `~/.codex/config.toml`; add `[projects."<abs-path>"]\ntrust_level="trusted"` before launch, remove after. Config was restored to original at handoff.

## Merge mechanics that worked

Each step ran in its own worktree/branch → committed on branch → reviewed (Sonnet routine, Opus for security/complex; the OAuth callback got a hostile-security Opus pass) → fix rounds → merged `--no-ff`. Merge order grouped files-in-common branches adjacent (step-4+step-6 both rewrite `POST /api/oauth-apps`; step-5+step-7 both rewrite the credential-broker). **Resolve conflicts semantically** — several were "both branches added different things at the same spot," not true overlaps.

The single most important merge fix: step-6's oauth-app handler called 2-arg `assertOAuthAppUrlsSafe` while writing preset-supplied `userinfoUrl`/`revocationUrl` — a naive merge would have re-opened the SSRF hole step-4 closed. Threaded the merged (hydrated ?? body) URLs into step-4's extended check at both HTTP + MCP-tool call sites.

## Known follow-ups / watch-items for remaining steps

1. **Step-8 (tracker fold)**: moves Linear/Jira onto the unified core. Provider-string wrappers (`ensureTokenOrThrow`, `forceRefreshTokenOrThrow`, `getOAuthTokens(provider)`) still exist as compat shims resolving provider→default-authorization; step-8 moves tracker callers to explicit `authorizationId`. step-5 left the provider-string `ensureTokenOrThrow`/`forceRefreshTokenOrThrow` swallowing `no_refresh_token` for legacy "not connected" semantics. **Jira cloudId post-processing was deferred from step-4 to step-8** — the `tracker` flow value is plumbed through pending/callback but cloudId resolution into `metadata` is not yet wired.
2. **Migration numbers used**: 117 (s1), 118 (s3), 119 (s2), 120 (s7), 121 (s5 keepalive flag — was NOT pre-assigned in root.md; step-5 added it). **Next free = 122.**
3. **Deferred security nit (step-4)**: `finalRedirect` is scheme-constrained (http/https) but has **no origin allowlist** — flagged in-code as follow-up.
4. **Pre-existing latent risk (from step-1 review)**: `src/oauth/wrapper.ts` + `mcp-wrapper.ts` embed raw token-endpoint error bodies into errors that may be logged/Slacked/returned. step-4 scrubbed the generic-callback path; wrapper-level raw bodies remain a provider-echo exfil risk — worth a dedicated pass, not in any current step.
5. **UI steps 9/10 convention** (memory `feedback_ui_tests_qa_use`): **no qa-use YAML / no UI unit-test infra in this repo — Taras manual-QAs the SPA.** Do drive the real UI with agent-browser (memory `feedback_browser_tooling`) for a screenshot pass per `delegate-work`. step-9 = OAuth apps & authorizations page; step-10 = single-flow connection creation (`AddConnectionDialog` OAuth branch backed by step-7's embedded-auth API).

## Manual QA items owed by Taras (accumulated, not blocking merge)

- **Step-4**: one real-provider OAuth dance (scratch Google app → two inboxes → two authorizations) — needs real creds + browser.
- Step-6 setupHints copy: reviewed + approved. Step-2 blessed set: approved.

## What each merged step delivered

- **step-1**: migration 117 unified OAuth schema (oauth_apps 1:N oauth_authorizations, encrypted, tokenVersion CAS, lockKey locks) + signature-preserving adapters + boot encryption backfill. Disconnect = revoke-in-place (rows survive for binding continuity).
- **step-2**: `vendored-openapi/` (real trimmed github/slack/jira specs + hand-authored gmail/linear façades) + blessed manifest merged into `/api/integrations-catalog` + offline drift check (CI) + migration 119 `vendored` source kind.
- **step-3**: spec `servers[]`/Swagger host extraction + `base_url_source` provenance (migration 118) + mismatch surfacing; refresh follows spec-derived, never clobbers user-set.
- **step-4**: static `/api/oauth/callback` + DB-backed PKCE pending (all flows) + N labeled authorizations/app + best-effort identity capture + `oauth-app.manage`/`oauth-authorization.manage` verbs. Hardened: SSRF-validates userinfo/revocation URLs (redirect:manual + egress re-check), HTML-escapes success page, consume-time TTL, scheme-constrained finalRedirect.
- **step-5**: refresh re-keyed to authorizationId (authz:<id> locks) + per-authorization sweep + persisted `refresh-failed` + typed OAuthRefreshError surfaced into scripts as `failedBindings` (patched fetch throws, no placeholder leak) + generalized keepalive (migration 121).
- **step-6**: `src/oauth/presets.ts` (google/slack/github/jira/linear/notion) + `presetId` hydration in POST /api/oauth-apps (explicit wins, source=curated-prefill) + `GET /api/oauth-presets`.
- **step-7**: migration 120 embedded connection auth (auth_type + managed bindings) — inline secret → encrypted `connection.<slug>.secret` swarm_config key, auto-derived managed binding, blob store retired + one-shot boot migration, orphan-secret cleanup on slug/auth-type change.

## Key commit shas (connections-redesign, off main 09133e0a)

Wave 1: s1 `f19dad47`+`0043bc6d`; s3 `91f267ce`+`a01f2fd5`; s2 `8fd9631b`+`d23d2990`; plan `03263339`.
Wave 2: s4 `def459ef`+`ef349a6c`+`eb7b2f58`; s6 `f70c24e5`+`b0a5e374`+`4336f116`; s5 `0750c24a`+`9f0cceda`+`af80a568`; s7 `3446eefa`+`bd7ea616`+`dd5bbb11`; rbac `1f6df953`; plan `a2fdefc2`.

## Environment

Disk filled to 100% twice mid-run (killed several agent runs). Fixed permanently: deleted `~/Library/Containers/com.docker.docker/Data/vms` (38.5GB legacy Docker Desktop VM; active runtime is OrbStack) + `~/Library/Caches/ms-playwright` (Taras-approved). ~49GB free. Worktrees cleaned; native/step-* branches deleted (merged); `git worktree list` shows only main + Taras's monorepo worktree. A snapshot of the pre-work local DB is at `/tmp/agent-swarm-db.pre-connections-redesign.sqlite`.

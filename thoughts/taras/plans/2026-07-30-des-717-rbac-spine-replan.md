---
date: 2026-07-30
author: Claude
planner: workflow des-717-rbac-spine-replan (5× Sonnet research → 2× Opus drafts → Opus judge synthesis), Fable 5 orchestrator
topic: "DES-717 — RBAC remaining spine: signed agent identity, originator propagation, asset-key ACLs"
tags: [rbac, des-445, des-717, security, identity, acl]
status: draft
autonomy: manual-review-per-phase
last_updated: 2026-07-30
last_updated_by: Claude
related_design: thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md
related_plan: thoughts/taras/plans/2026-07-08-des-445-rbac-increment5-mcp-admission-route-backlog.md
---

# DES-717 — RBAC Remaining Spine: fail-closed layers first, role in shadow early, signed identity before intersection

## Overview

Replan of the remaining DES-445 spine after increments 1+2 (#921), 3 (#935/#936), and 5 (#951) shipped. Prod runs `RBAC_ENABLED=true` but effectively no-op — every user holds the `grantsAll` admin role and no restrictive role has been exercised.

**Thesis (verified against HEAD):**

- `authorizeAssetKeyWrite` (`src/be/asset-key-auth.ts:21-44`) imports zero `src/rbac/` symbols, so DES-717's "grantsAll must NOT bypass personal-namespace checks" **already holds for writes**. The live gap is **reads**: `listAssetSummaries` (`src/be/db.ts:3470-3505`) has no identity predicate and `src/http/assets.ts:147-166` passes none.
- A narrow-grant user is already fail-closed by `handleCore` (`src/http/core.ts:344-364`) on all 128 `ROUTE_RBAC_BACKLOG` routes, and all 10 HTTP agent-principal construction sites sit behind an operator/user short-circuit — so **the first restrictive role does NOT depend on signed agent identity** and can ship early (in shadow) to produce the audit readout that answers the issue's opening question ("which of the 128 backlogged routes / 76 ungated tool files actually matter").
- The spine order is therefore: **(1)** fence the asset-key write invariant with CI + close the read side; **(2)** attach the first restrictive role in SHADOW alongside admin (UNION ⇒ provable no-op) to harvest the readout; **(3)** make `requestedByUserId` trustworthy before it becomes load-bearing; **(4)** mint signed agent identity in dual-accept; **(5)** enforce it + land the can()-hardening deferred out of #951; **(6)** wire originator-aware `can()` (call-site-supplied grant — `can()` never touches the DB), tighten `taskFsMutate`, then detach admin from the pilot.

Prod stays no-op through Phase 5: every change is either an always-on layer whose current behavior is characterization-pinned, or gated behind a flag/role no prod user holds.

## Current State Analysis

Key findings from the research pass (file:line verified):

**Agent identity is fully spoofable today.** `resolveHttpRequestAuth` (`src/http/auth.ts:13-32`) knows only two principal kinds — operator (shared key) and user (`aswt_`). There is no agent auth kind; `X-Agent-ID` is a caller-supplied string validated only for *existence* (`requireKnownAgent`, `src/http/mcp.ts:71-96`; `getAgentById` in `handleCore`). Agent registration mints no secret (`src/tools/join-swarm.ts:74-116`; no token column on `agents`). Workers get a predictable non-secret `AGENT_ID` env plus the *same shared operator API_KEY* as every container (`docker-entrypoint.sh:191,286-332,385-416`; `src/commands/e2b.ts:665-693`). Every agent-scoped rule in `src/rbac/legacy-policy.ts:26-73` (leadOnly, leadOrTaskCreator, leadOrResourceOwner, leadOrOwnNamespace) keys off this unauthenticated header.

**The sharpest raw-header promotion bug** is `src/http/kv.ts:296-307` (`buildAuthCtx`): derives `isLead` from the raw header with NO auth-kind check. (Note: the previously-suspected `ensureConfigAdmin` exploit is NOT real — `src/http/config.ts:85-86` short-circuits operator/user before building an agent principal; a shared-key holder is already operator-allowed there.)

**Originator attribution is self-assertable.** `requestedByUserId` already exists on `agent_tasks` and propagates parent→child (`src/be/db.ts:4370-4372`) — a reusable chain primitive. But: `send-task` accepts a caller-supplied UUID (`src/tools/send-task.ts:214,227-230`, format-checked only); workflow authors can hardcode any UUID (`src/workflows/executors/agent-task.ts:112`); and `TRUST_BODY_REQUESTED_BY_USER_ID` defaults ON in `src/http/tasks.ts:573-592` with an in-code comment admitting any caller can attribute a task to any user.

**`user_api_keys` does not exist.** Zero grep matches across code/migrations/docs — it was design-doc-only. The existing artifact is `user_tokens` (`src/be/migrations/067_users_first_class.sql:67-79`; sha256 tokenHash + revokedAt; helpers at `src/be/users.ts:432-529`). Also: `src/http/mcp-user.ts:16-29` duplicates bearer resolution outside `resolveHttpRequestAuth` (two-places risk).

**Asset-key auth** (`src/be/asset-key-auth.ts`) gates personal/* writes on `trustedUserId` derived from HTTP auth or ownership-validated source task — the one path that does NOT trust the raw header. Write side fail-closed regardless of flag; read side (GET /api/assets enumeration) unfiltered.

**Seeded requester role has a live latent bug**: `task.steer.own` is registered (`src/rbac/permissions.ts:52`) and admitted by `src/server-user.ts` for steer-task, but absent from `BUILTIN_ROLES` (`src/be/rbac-roles.ts:24-38`) — anyone actually on this role cannot steer their own task. And `task.fs.mutate`'s backing rule `taskFsMutate` (`src/rbac/legacy-policy.ts:119-131`) returns true for ANY user principal on ANY task.

Registry state: 54 verbs live, `ROUTE_RBAC_BACKLOG` = 128, `UNGATED_TOOL_FILES` = 76. Migrations on main top out at `122_steering_handled_note.sql` → this plan takes 123 and 124.

## Desired End State

- Asset-key personal-namespace write invariant CI-fenced (un-regressable); GET /api/assets read-filtered per principal.
- A real restrictive role (`rbac-role-requester`, repaired) exercised in prod: first in shadow alongside admin, finally enforced on a pilot user with admin detached.
- `requestedByUserId` trustworthy at every write path (helper-gated self-assertion).
- Per-agent signed tokens (`aswa_`, mirroring `user_tokens`) with dual-accept → enforce rollout via tri-state `AGENT_IDENTITY_MODE`; the ~10 raw-header consumer sites flipped to the verified value; #951's deferred can()-hardening landed.
- Originator-aware `can()`: optional call-site-supplied `originatorGrant` (agent ∩ originator, monotone-narrowing), rolled out to a small named set of call sites; `taskFsMutate` originator-scoped.

## What We're NOT Doing

- **Route-backlog burn-down** (128 routes) and the 76 ungated tool files — OUT, with exactly two carve-outs: `POST /api/scripts/run` (pinned operator-only in incr-5 *specifically because* of self-asserted X-Agent-ID — a genuine DES-717 dependency) and whichever handful the Phase-2 shadow readout proves the pilot role needs.
- **Role-management UI** — attach/detach is CLI only (`bun run src/cli.tsx rbac <verb>`, space not colon per structure-diagrams.md:130).
- **GA cleanup** — `trg_users_default_role` auto-attach removal, deny primitive (positive verb-set role ⇒ trigger condition unmet), per-token scopes (user-roles ∩ token-roles).
- **`user_api_keys` as a new table** — CUT. The reconciliation deliverable is `agent_tokens` mirroring `user_tokens`' shape behind ONE bearer resolver (incl. de-duping `src/http/mcp-user.ts:16-29`). See Open Decision 3.
- **Scoping the shared operator API_KEY out of workers** — OUT, named residual risk (signed agent identity does not remove it).
- **Asset-key as general ACL substrate** — `canReadMemory` and `leadOrOwnNamespace` stay independent primitives.
- **Flipping `TRUST_BODY_REQUESTED_BY_USER_ID` default** — surfaced in config catalog in Phase 3; flip is a follow-up PR gated on audit evidence.
- **Asset read-visibility beyond GET /api/assets** (MCP listings, entity detail routes) — Phase 1 covers enumeration only.
- **Merging can() with the role engine** — permanently out; two-layer model is settled (user-policy-admission-model.md:49-86).
- **Grant caching/TTL** — deferred per structure-diagrams.md:128.

### Non-negotiables

- `can()` stays pure/synchronous/DB-free (`src/rbac/can.ts:4-5`) — Phase 6 passes the grant IN.
- Per-user role compose is UNION (settled). The ONLY intersection introduced is agent ∩ originator.
- `src/be/asset-key-auth.ts` must never import from `src/rbac/` (Phase 1 CI assert).
- Missing/NULL originator = **no constraint, never deny** (cron/webhook/CLI tasks have NULL `requestedByUserId`).
- Migrations forward-only; workers never import `src/be/db`; `getApiKey()` for all key reads.

## Implementation Approach

Six phases, each independently mergeable, commit-per-phase, pause for manual review between phases. Fail-closed/always-on layers land first with characterization pins; enforcement flips are runtime config (`PUT /api/config`), not deploys.

### First restrictive role (decision summary — needs Taras sign-off, see Open Decisions)

| Aspect | Decision |
|---|---|
| Role | Reuse + repair seeded `rbac-role-requester` (`src/be/rbac-roles.ts:24-38`, grantsAll=0) — no new role |
| Verbs | `task.create.own`, `task.read.own`, `task.cancel.own`, `task.steer.own` (**ADD** — live seed bug), `task.action.own`, `favorite.write.own`; **REMOVE** `task.fs.mutate` until Phase 6 scopes its rule; **CUT** `script.search` (no observed need) |
| Who | ONE named pilot user, attached *alongside* admin (UNION ⇒ provable no-op) under `RBAC_SHADOW_MODE`; admin detached only in Phase 6 |
| Namespaces | WRITE `personal/<own>/**` (already unconditionally enforced), no `shared/**` write, READ shared + own personal via Phase-1 filter, no `kv task:agent:*`, everything else 403 by fail-closed default |
| Alternative (preserved) | Draft A's cohort: flip `trg_users_default_role` so integration-auto-minted users land on requester. Rejected as starter (rewrites out-of-scope GA trigger, narrows real users pre-evidence); viable Phase-7 follow-up |

## Quick Verification Reference

```bash
bun run tsc:check && bun run lint
bun run test:root -- src/tests/<file>.test.ts
bun run check:rbac-coverage
bash scripts/check-rbac-boundary.sh && bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh
RBAC_LIFECYCLE_E2E=1 bun run test:root -- src/tests/rbac-lifecycle-e2e.test.ts
bun run docs:openapi   # any route/description change → commit openapi.json + docs-site api-reference
rm -f agent-swarm-db.sqlite && bun run start:http   # fresh-DB migration check; ALSO re-run against an existing DB
```

---

## Phase 1: Asset-key ACL slice — fence the write invariant, close the read side

### Overview

Make the already-fail-closed personal-namespace write rule permanently un-regressable via CI, then add the missing read filter on GET /api/assets. No flag; the only behavior change is read-visibility for user-kind principals.

### Changes Required:

#### 1. Characterization tests FIRST — `src/tests/rbac-asset-key-acl.test.ts` (new)
`authorizeAssetKeyWrite('personal/<userA>/x', userB)` throws 403 with (a) `RBAC_ENABLED` unset, (b) `RBAC_ENABLED=true` + grantsAll admin caller, (c) operator-kind auth. The invariant holds today — these are the regression fence, not new behavior.

#### 2. CI boundary assert — `scripts/check-rbac-boundary.sh`
`src/be/asset-key-auth.ts` and `src/assets/key.ts` MUST NOT import from `src/rbac/` (`can`, `isRbacEnabled`, `getUserGrant`). ~5 lines. This is the concrete mechanism satisfying "must stay fail-closed regardless of flag".

#### 3. Read filter — `src/be/db.ts:3470-3505` (`listAssetSummaries`)
Add optional `visibleToUserId?: string | null`. Predicate: `(key LIKE 'shared/%' OR key IS NULL OR key LIKE 'personal/' || ? || '/%')`. **Refactor the `query += ' WHERE ...'` string-concat to a conditions array** — it assumes at most one WHERE and breaks when composed with the existing keyPrefix branch. NULL-key rows must survive.

#### 4. Route wiring — `src/http/assets.ts:147-166` (+ description at :34-51)
Resolve `visibleToUserId` from `getRequestAuth(req)`: user → `auth.userId`; operator → `null` (unfiltered, preserves dashboard/ops). Fix the route description (currently documents the opposite).

#### 5. New verb `asset.read.any` — `src/rbac/permissions.ts` + `src/rbac/legacy-policy.ts`
Lead-only-style rule; `can()` call in listAssetsRoute so a user WITH the verb gets the unfiltered list. Keeps the verb non-dead for coverage invariant #2.

#### 6. Docstring update — `src/assets/key.ts:107-115`
`canWriteAssetKey` says "v1 personal keys are labels, not a privacy or read-visibility guarantee" — partially reversed for the enumeration route only.

Do NOT touch `taskFsMutate` here — needs Phase 6's originator plumbing.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run test:root -- src/tests/rbac-asset-key-acl.test.ts`
- [ ] `bun run test:root -- src/tests/rbac-charact-http.test.ts src/tests/rbac-roles.test.ts`
- [ ] `bun run check:rbac-coverage` (verb count 54 → 55)
- [ ] `bash scripts/check-rbac-boundary.sh` (incl. new asset-key assert) && `bash scripts/check-db-boundary.sh`
- [ ] `bun run docs:openapi` → commit `openapi.json` + docs-site api-reference

#### Manual Verification:
- [ ] Manual E2E §Phase 1 block (below): cross-personal write 403 for user AND operator; read filter hides foreign personal/*, keeps NULL keys, composes with keyPrefix
- [ ] Verify apps/ui asset surfaces under an `aswt_` token before merge (dashboard proxy is operator-kind and unaffected)

**Risks:** routing the write check through can()/grantsAll would REGRESS fail-closed behavior — the CI assert makes that impossible, don't soften it.

**Implementation note:** pause for review; commit `feat(rbac): DES-717 phase 1 — asset-key ACL fence + read filter`.

---

## Phase 2: First restrictive role — define, seed-fix, attach in SHADOW (provable no-op)

### Overview

Get the audit readout that answers the issue's opening question without enforcement risk. Verified safe to ship BEFORE signed identity: handleCore fail-closes narrow users on every verb-less non-GET route, and all 10 HTTP agent-principal sites are OR'd behind an operator/user short-circuit, so no X-Agent-ID spoof escalates a narrowed user.

### Changes Required:

#### 1. Repair seeded `rbac-role-requester` — `src/be/rbac-roles.ts:24-38`
ADD `task.steer.own` (live seed bug); REMOVE `task.fs.mutate` (its rule confers cross-task asset-key authority today; returns in Phase 6 originator-scoped).

#### 2. Verify the seed reconciler's UPDATE path — `src/be/rbac-roles.ts:~242-253`
Must add/remove verbs on an *existing* role row, not just upsert on fresh DBs — else the change silently never lands in prod. Explicit test against an existing DB.

#### 3. `RBAC_SHADOW_MODE` flag + shadow audit marker
`decideAdmission`/`decideToolAdmission` (`src/rbac/admission.ts:17-71`) still return allow, but record the would-be decision. `permission_audit` needs a distinguishable marker — migration `123_permission_audit_shadow.sql` (nullable `shadow INTEGER`; number verified free, main tops at 122). A shadow deny must never read as a real deny. **Subtlety:** a shadow-attached user still has grantsAll via admin — the shadow branch must compute the grant for the NARROW role specifically, not the effective UNION. Register flag in `apps/ui/src/lib/configuration-catalog.ts` (Security, boolean) + `VALIDATED_KEYS` in `src/be/swarm-config-guard.ts` + configuration.mdx (same-PR rule).

#### 4. CLI — `src/cli.tsx`
`rbac attach <userEmailOrId> <roleName>` / `detach`, wrapping `attachRole`/`detachRole` (`src/be/rbac-roles.ts:202-220`).

#### 5. Pilot attach + readout
Attach requester to ONE named user who ALSO holds admin. Weekly readout: `SELECT decision, route, COUNT(*) FROM permission_audit WHERE shadow=1 GROUP BY 1,2 ORDER BY 3 DESC` — **the readout IS the deliverable**: it names the backlogged routes to un-backlog before Phase 6's flip.

Do NOT touch `trg_users_default_role` (GA cleanup, out of scope).

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run test:root -- src/tests/rbac-roles.test.ts src/tests/rbac-admission.test.ts src/tests/rbac-mcp-admission-e2e.test.ts src/tests/rbac-wire-e2e.test.ts`
- [ ] `RBAC_LIFECYCLE_E2E=1 bun run test:root -- src/tests/rbac-lifecycle-e2e.test.ts`
- [ ] `bun run src/cli.tsx rbac bootstrap` twice — idempotent, no drift; `bun run src/cli.tsx help` + `rbac --help`
- [ ] `bun run check:rbac-coverage`
- [ ] `rm -f agent-swarm-db.sqlite && bun run start:http` (fresh DB) AND restart against existing DB
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Manual Verification:
- [ ] Manual E2E §Phase 2 block: bootstrap idempotence, role verb-set (steer present, fs.mutate absent), shadow allows-but-records, readout query returns rows
- [ ] Shadow rows excluded from any existing permission_audit dashboards/queries (no fake deny spike)

**Implementation note:** pause for review; commit `feat(rbac): DES-717 phase 2 — requester role repair + shadow mode`.

---

## Phase 3: Kill self-asserted originator attribution before it becomes load-bearing

### Overview

Make `requestedByUserId` trustworthy at every write path so Phase 6's agent ∩ originator intersection cannot be escalated by naming another user's UUID. Behavior-preserving by default, flag-gated.

### Changes Required:

#### 1. Shared helper — `src/be/audit-user.ts` (alongside `resolveHttpAuditUserId`/`resolveTaskAuditUserId` at :28-72)
`resolveTrustedRequestedByUserId(input, ctx)`: (a) user-kind ctx → `ctx.userId`, input ignored; (b) input === callerTask.requestedByUserId → accept (self-propagation); (c) present-and-different → 403 unless `ORIGINATOR_TRUST_SELF_ASSERTED=true`; (d) absent → `callerTask?.requestedByUserId ?? undefined`.

#### 2. Apply at the three self-assertion paths
- `src/tools/send-task.ts:214,227-230` (+ schema description :127-133)
- `src/workflows/executors/agent-task.ts:112` (schema :16-33) — mismatching config value is **DROPPED with a warning**, not 403 (workflows must not hard-fail mid-DAG)
- `src/http/tasks.ts:573-592,791-817` — do NOT flip `TRUST_BODY_REQUESTED_BY_USER_ID` default in this PR (breaks single-tenant shared-key deployments); catalog it with a deprecation note

#### 3. Telemetry
Audit row on every rejected-or-dropped self-assertion so real usage is measurable before any default flip.

#### 4. MUST NOT apply to server-side trusted paths (negative tests)
Sub-task inheritance (`src/be/db.ts:4370-4372`), Slack auto-mint (`src/slack/enrich.ts:125-150`), webhook `findUserByExternalId` handlers, scheduler `createdBy` (`src/scheduler/scheduler.ts:55,64,84,147`) — these legitimately set/leave attribution.

Both flags → configuration catalog + `VALIDATED_KEYS` + configuration.mdx, same PR.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run test:root -- src/tests/rbac-originator-trust.test.ts src/tests/user-token-rest-auth.test.ts src/tests/rbac-wire-e2e.test.ts`
- [ ] `bun run test:root -- src/tests/task-cancellation.test.ts src/tests/steering-core.test.ts src/tests/workflow-http-v2.test.ts`
- [ ] `bun run check:rbac-coverage`
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Manual Verification:
- [ ] Manual E2E §Phase 3 block: user-authed body spoof ignored; MCP foreign-UUID spoof 403 under flag-off
- [ ] Cron/webhook/scheduled tasks still get correct (or NULL) attribution

**Risks:** over-applying the helper NULLs attribution for legitimate server-side paths; workflow drops are silent by design — telemetry row is the safeguard.

**Implementation note:** pause for review; commit `feat(rbac): DES-717 phase 3 — trusted originator attribution`.

---

## Phase 4: Signed agent identity — mint + dual-accept verify (no enforcement)

### Overview

Real per-agent credential (`aswa_`) and a verified `{kind:'agent'}` auth variant, accepted in parallel with today's bare X-Agent-ID. Zero client breakage; every request labelled verified/unverified and audited so the unsigned tail is measurable before Phase 5.

### Changes Required:

#### 1. Migration `src/be/migrations/124_agent_identity_tokens.sql` (new)
`agent_tokens`: id PK, agentId (no FK — token may pre-date the agents row), tokenHash TEXT NOT NULL UNIQUE (sha256), tokenPreview, label, createdAt, lastUsedAt, revokedAt + idx on agentId. Deliberately mirrors `user_tokens` (067:67-79) — **this mirroring IS the user_api_keys/user_tokens reconciliation** (see Open Decision 3).

#### 2. `src/be/agent-tokens.ts` (new), modeled on `src/be/users.ts:432-529`
`mintAgentToken(agentId, label)` → `aswa_<24-base62>` returned once, sha256 stored; `resolveAgentIdByToken`; `revokeAgentToken`. Server-side only.

#### 3. Auth resolver — `src/http/auth.ts:13-31` + `src/utils/request-auth-context.ts:5-24`
New `{ kind: 'agent'; agentId; verified: true }` variant + `aswa_` branch. Operator branch untouched. `isLead` is NOT a token claim — stays a live `getAgentById()` lookup (lead demotion takes effect immediately). **Also de-dup `src/http/mcp-user.ts:16-29`** (`resolveActiveUser` duplicates bearer resolution) onto the one resolver.

#### 4. Mint points
`join-swarm` returns a token in `toolOk` extras on registration; plus `POST /api/agents/{id}/token` via `route()` with `rbac: { permission: 'agent.token.mint' }` (new verb + lead/operator rule). Register handler in `src/http/all-routes.ts`; `bun run docs:openapi`.

#### 5. Dual-accept verify at exactly TWO boundaries
`handleCore` (`src/http/core.ts` ~326, before the `auth?.kind` branch) and `src/http/mcp.ts:71-96`. Valid `aswa_` bearer → agentId comes from the TOKEN; mismatching X-Agent-ID header → hard 401 (blocks "signed as A, act as B"). Absent → today's existence-only path with `agentIdentityVerified: false`.

#### 6. `src/tools/utils.ts:29-58` (`getRequestInfo`)
Must return the token-derived agentId (+ `verified: boolean`) so ~40 downstream tool sites inherit trust with zero edits. Fallback if the MCP SDK lacks a request side-channel: handleMcp rewrites `req.headers['x-agent-id']` to the verified value before the SDK sees it — decide in implementation.

#### 7. Secret scrubber — `src/utils/secret-scrubber.ts`
Learns the `aswa_` shape NOW, before any token can reach a log egress point.

#### 8. Optional distribution + flag
`AGENT_TOKEN` pass-through in `docker-entrypoint.sh` / `src/commands/e2b.ts:665-693` (API_KEY path stays default). Tri-state `AGENT_IDENTITY_MODE` = `off | shadow | enforce` (default `shadow`) — one knob, one rollback. Catalog + VALIDATED_KEYS + configuration.mdx.

### Success Criteria:

#### Automated Verification:
- [ ] `rm -f agent-swarm-db.sqlite && bun run start:http` (fresh DB) AND restart against existing DB
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run test:root -- src/tests/rbac-agent-identity.test.ts src/tests/rbac-wire-e2e.test.ts src/tests/user-token-rest-auth.test.ts`
- [ ] `bun run check:rbac-coverage` (new verb `agent.token.mint`)
- [ ] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bash scripts/check-rbac-boundary.sh`
- [ ] `bun run docs:openapi` → commit outputs

#### Manual Verification:
- [ ] Manual E2E §Phase 4/5 block: signed 200; signed-as-A-act-as-B 401 in every mode; bare header still 200 under shadow
- [ ] `aswa_` never appears in logs (scrubber grep)

**Risks:** ~150+ direct x-agent-id read sites remain outside the two boundaries — flipped in Phase 5 (kv.ts:296-307 first). join-swarm reachable with only the shared key caps token value at the shared key's strength (Open Decision 4).

**Implementation note:** pause for review; commit `feat(rbac): DES-717 phase 4 — signed agent identity, dual-accept`.

---

## Phase 5: Enforce signed identity + the can()-hardening deferred out of #951

### Overview

Flip `AGENT_IDENTITY_MODE` to enforce, roll tokens through container startup, flip raw-header consumers onto the verified value, land #951's deferred agent-principal gates.

### Changes Required:

#### 1. Boot-time token acquisition
`docker-entrypoint.sh:191,286-332,385-416` (curl snippets + generated MCP config header injection), `src/commands/e2b.ts:665-693`, `src/commands/setup.tsx:311,381`, `src/commands/runner.ts` (~2616), `docker-compose.local.yml:140,186,236`.

#### 2. Flip raw-header consumers, kv FIRST
`src/http/kv.ts:296-307,344` (the header→isLead promotion bug), then `src/http/tasks.ts:487`, `src/http/assets.ts:127`, `src/http/fs.ts:501`, `src/http/scripts.ts:431,759`, `src/http/script-connections.ts:675,708`, `src/http/script-connection-proxy.ts:72`, `src/http/config.ts:90`.

#### 3. can()-hardening carried from #951
Gate agent principals on skills / mcp-servers / scripts HTTP routes to match their MCP-tool twins, now that agentId is trustworthy.

#### 4. Un-backlog `POST /api/scripts/run`
Give it `rbac: { permission: 'script.run' }`; `ROUTE_RBAC_BACKLOG` 128 → 127. The one backlog entry that is a genuine DES-717 dependency.

#### 5. Hooks — `src/hooks/hook.ts:36,92-96,348,1138`
Branch on `AGENT_TOKEN` presence + server confirmation instead of mere header presence (hooks can't import src/be/db — verification status arrives via an HTTP response field).

#### 6. Back-compat drain
Enforce only after Phase-4 telemetry shows zero unverified agent-context requests; drain/re-provision long-lived E2B sandboxes and pre-Phase-4 worker images. Verify the `claude-managed` provider path (`docker-entrypoint.sh:51-81`, pre-created `MANAGED_AGENT_ID`) gets a token or is explicitly exempted. **Ship the server (mode default `shadow`) and the new worker image in the SAME release; flip via config afterwards.** Rollback = set mode back to `shadow` via `PUT /api/config`, no redeploy.

#### 7. Test matrix — extend `src/tests/rbac-wire-e2e.test.ts`
signed / unsigned / mismatched-header × mode shadow|enforce × kv.write.any, script-run, config-write paths.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run test:root -- src/tests/rbac-wire-e2e.test.ts`
- [ ] `RBAC_LIFECYCLE_E2E=1 bun run test:root -- src/tests/rbac-lifecycle-e2e.test.ts`
- [ ] `bun run test:root -- src/tests/rbac-charact-http.test.ts src/tests/rbac-charact-skills.test.ts src/tests/rbac-charact-misc-tools.test.ts src/tests/rbac-charact-slack.test.ts`
- [ ] `bun run test:root -- src/tests/kv-http.test.ts src/tests/kv-namespace-resolution.test.ts src/tests/runner-polling-api.test.ts`
- [ ] `bun run check:rbac-coverage && bash scripts/check-api-key-boundary.sh`
- [ ] `bun run docs:openapi`

#### Manual Verification:
- [ ] `bun run docker:build:worker:slim && bun run pm2-restart` (entrypoint changed → rebuild mandatory)
- [ ] `docker compose -f docker-compose.local.yml up --build` — lead+worker boot signed, join-swarm, claim a task under enforce
- [ ] Manual E2E: bare-header 401 under enforce; kv lead-promotion spoof now blocked

**Risks:** stale worker image vs enforcing server = total worker outage (same-release rule above). Shared operator key remains in workers — named residual risk constraining mint authority (Open Decision 4).

**Implementation note:** pause for review; commit `feat(rbac): DES-717 phase 5 — enforce signed identity + can()-hardening`.

---

## Phase 6: Originator-aware can(), taskFsMutate tightening, enforcement flip

### Overview

Connect can()/LEGACY_POLICY to the role engine without breaking can()'s pure-no-DB invariant; tighten the two known over-permissive rules now that identity and originator are trustworthy; detach admin from the pilot — the first real restrictive grant in prod.

### Changes Required:

#### 1. `RbacCheck` extension — `src/rbac/types.ts:10-44`, `src/rbac/can.ts:29-44`
Optional `originatorGrant?: EffectiveGrant` supplied by the CALL SITE. can() evaluates: LEGACY_POLICY rule passes AND (grant absent → no constraint; present → grantsAll || verbs.has(verb)). Monotone-narrowing only; the other ~40 of 46 call sites compile unchanged.

#### 2. `src/rbac/originator.ts` (new)
`buildOriginatorGrant(task | requestedByUserId | null)` → `getUserGrant` (`src/be/rbac-roles.ts:180-197`) or undefined. Add to `GATE_HELPER_SPECIFIERS` in `scripts/check-rbac-coverage.ts`.

#### 3. `getAgentGrant(agentId)`
Generalize the hardcoded `principalType='user'` WHERE — `principal_roles.principalType` already CHECKs `('user','agent')` (109:36-46), unused scaffolding. Audit every `getUserGrant` caller for the always-user assumption: `src/http/core.ts:345`, `src/http/config.ts:54-55`, `src/http/mcp-servers.ts:171-173`, `src/server-user.ts:72`. Do NOT let getAgentGrant drift into intersecting a user's own roles (UNION stays).

#### 4. Rollout to a SMALL named set only
`src/http/tasks.ts:461-492` (canSteerTask), `src/tools/task-tool-ctx.ts:27-51` (assertOwnsTask), `src/tools/cancel-task.ts:79`, `src/tools/steer-task.ts:77`, `src/http/kv.ts:344`, `src/http/fs.ts` canMutateTask. Everything else keeps today's semantics.

#### 5. Tighten `taskFsMutate` — `src/rbac/legacy-policy.ts:119-131`
User branch requires `resource.requestedByUserId === principal.userId` OR new `task.fs.mutate.any` verb. Behavior-changing only for narrow-grant users → prod stays no-op until the flip. Re-add `task.fs.mutate` to requester now that it's scoped; optionally new `asset.shared.write` verb enforced at authorizeAssetKeyWrite's CALLERS (`src/http/assets.ts:175,214`, `src/http/tasks.ts:612`) — never inside asset-key-auth.ts (Phase-1 CI assert forbids it).

#### 6. Un-backlog the shadow-readout routes
The specific handful Phase 2 proved the pilot needs. Bulk burn-down stays OUT.

#### 7. Enforcement flip
`RBAC_SHADOW_MODE` off, then `bun run src/cli.tsx rbac detach <pilot> admin`. **Write the re-attach command down BEFORE the detach.** Require a clean readout for a full week first.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run test:root -- src/tests/rbac-engine.test.ts src/tests/rbac-originator-intersect.test.ts`
- [ ] `bun run test:root -- src/tests/rbac-admission.test.ts src/tests/rbac-mcp-admission-e2e.test.ts src/tests/rbac-roles.test.ts`
- [ ] `bun run test:root -- src/tests/rbac-charact-http.test.ts src/tests/rbac-charact-skills.test.ts`
- [ ] `bun run test:root -- src/tests/rbac-wire-e2e.test.ts src/tests/asset-key-api.test.ts src/tests/asset-key-mcp.test.ts`
- [ ] `bun run check:rbac-coverage && bash scripts/check-rbac-boundary.sh`
- [ ] `bun run src/cli.tsx rbac bootstrap` — idempotent after role-set change

#### Manual Verification:
- [ ] Manual E2E §Phase 6 block: cross-user key-move 403; NULL-originator task still steerable; post-detach requester matrix (create-own 201, config-write 403, script-run 403)
- [ ] Runbooks + docs-site document the role's verb set as an API contract

**Risks:** missing originatorGrant must be "no constraint", never deny (explicit test — cron/Jira/CLI leave it NULL, `src/types.ts:560`). Detach is the point of no return for the pilot.

**Implementation note:** pause for review; commit `feat(rbac): DES-717 phase 6 — originator-aware can() + enforcement flip`.

---

## Manual E2E

Run top-to-bottom against a local backend. Repeat the migration-bearing phases against BOTH a fresh and a pre-existing DB.

```bash
# ---- Setup ----
rm -f agent-swarm-db.sqlite && RBAC_ENABLED=true bun run start:http   # separate terminal; applies 123/124
export API=http://localhost:3013; export KEY=123123
export UA=$(curl -s -X POST $API/api/users -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"email":"a@example.com","name":"A"}' | jq -r .id)
export UB=$(curl -s -X POST $API/api/users -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"email":"b@example.com","name":"B"}' | jq -r .id)
export TA=$(curl -s -X POST $API/api/users/$UA/tokens -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"label":"a"}' | jq -r .token)
export TB=$(curl -s -X POST $API/api/users/$UB/tokens -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"label":"b"}' | jq -r .token)

# ---- Phase 1: asset-key write fail-closed (must hold for EVERY principal kind) ----
curl -s -o /dev/null -w 'own-personal %{http_code}\n' -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d "{\"task\":\"x\",\"key\":\"personal/$UA/proj\"}"   # expect 200/201
curl -s -o /dev/null -w 'cross-personal-user %{http_code}\n' -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d "{\"task\":\"x\",\"key\":\"personal/$UB/proj\"}"   # expect 403 EVEN THOUGH A holds grantsAll admin
curl -s -o /dev/null -w 'cross-personal-operator %{http_code}\n' -X POST $API/api/tasks -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"task\":\"x\",\"key\":\"personal/$UB/proj\"}"   # expect 403 — operator key must NOT bypass

# ---- Phase 1: asset read filtering ----
curl -s "$API/api/assets?limit=100" -H "Authorization: Bearer $TB" | jq "[.assets[].key] | map(select(startswith(\"personal/$UA/\")))"   # expect []
curl -s "$API/api/assets?limit=100" -H "Authorization: Bearer $TB" | jq '[.assets[] | select(.key==null)] | length'   # NULL-key rows must survive the filter
curl -s "$API/api/assets?limit=100&keyPrefix=personal" -H "Authorization: Bearer $TB" | jq '.count'   # keyPrefix + visibility compose (the two-WHERE refactor)
curl -s "$API/api/assets?limit=100" -H "Authorization: Bearer $KEY" | jq '.count'   # operator unfiltered, expect > 0

# ---- Phase 2: first role in shadow ----
bun run src/cli.tsx rbac bootstrap && bun run src/cli.tsx rbac bootstrap   # twice: assert idempotent
bun run src/cli.tsx rbac roles | grep -A8 requester   # confirm task.steer.own present, task.fs.mutate absent
bun run src/cli.tsx rbac attach b@example.com requester   # B now holds admin ∪ requester = admin (UNION)
curl -s -X PUT $API/api/config -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"key":"RBAC_SHADOW_MODE","value":"true","scope":"global"}'
curl -s -o /dev/null -w 'shadow-allows %{http_code}\n' -X PUT $API/api/config -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"key":"X","value":"1"}'   # expect 200 (shadow never blocks) but a shadow-DENY row lands
sqlite3 agent-swarm-db.sqlite 'SELECT shadow, decision, route, COUNT(*) FROM permission_audit GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20;'   # THE READOUT

# ---- Phase 3: originator self-assertion ----
curl -s -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d "{\"task\":\"spoof\",\"requestedByUserId\":\"$UB\"}" | jq -r .requestedByUserId   # expect $UA — body id ignored for user-authed callers
# with ORIGINATOR_TRUST_SELF_ASSERTED=false, re-run the send-task MCP spoof (agent session passing a foreign UUID) → expect 403

# ---- Phase 4/5: signed agent identity ----
export AID=$(uuidgen)   # MUST be a real UUID — slug agent IDs break MCP output schemas mid-write
export ATOK=$(curl -s -X POST $API/api/agents/$AID/token -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"label":"worker-1"}' | jq -r .token)
curl -s -o /dev/null -w 'signed %{http_code}\n' $API/me -H "Authorization: Bearer $ATOK"   # 200, agentId derived from the token not the header
curl -s -o /dev/null -w 'signed-as-A-act-as-B %{http_code}\n' $API/me -H "Authorization: Bearer $ATOK" -H 'X-Agent-ID: some-other-agent'   # expect 401 in every mode
curl -s -o /dev/null -w 'bare-header %{http_code}\n' $API/me -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AID"   # 200 under mode=shadow, 401 under mode=enforce
export LEAD=$(curl -s $API/api/agents -H "Authorization: Bearer $KEY" | jq -r '.agents[] | select(.isLead) | .id' | head -1)
curl -s -o /dev/null -w 'kv-lead-promotion %{http_code}\n' -X PUT "$API/api/kv/task:agent:$LEAD/somekey" -H "Authorization: Bearer $TB" -H "X-Agent-ID: $LEAD" -H 'Content-Type: application/json' -d '{"value":"x"}'   # the REAL header-promotion bug (src/http/kv.ts:296-307): allowed before Phase 5, 401/403 after
curl -s -X PUT $API/api/config -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"key":"AGENT_IDENTITY_MODE","value":"enforce","scope":"global"}'   # runtime flip, no restart; rollback = set back to shadow
bun run docker:build:worker:slim && docker compose -f docker-compose.local.yml up --build   # lead+worker boot signed, join-swarm, claim a task under enforce
grep -o 'aswa_[A-Za-z0-9]*' /workspace/logs/*.jsonl 2>/dev/null; echo "exit=$? (expect no matches — scrubber covers aswa_)"

# ---- Phase 6: originator-aware can() + taskFsMutate ----
export T1=$(curl -s -X POST $API/api/tasks -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"task":"A owns this"}' | jq -r .id)
curl -s -o /dev/null -w 'cross-user-key-move %{http_code}\n' -X PATCH $API/api/assets/task/$T1/key -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"key":"shared/hijacked"}'   # 200 BEFORE Phase 6 (the taskFsMutate gap), 403 AFTER
export T2=$(curl -s -X POST $API/api/tasks -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"task":"no originator"}' | jq -r .id)   # requestedByUserId NULL
curl -s -o /dev/null -w 'null-originator %{http_code}\n' -X POST $API/api/tasks/$T2/steer -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"message":"hi"}'   # MUST still work — NULL originator = no constraint, never deny

# ---- Phase 6: enforcement flip ----
curl -s -X PUT $API/api/config -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"key":"RBAC_SHADOW_MODE","value":"false","scope":"global"}'
bun run src/cli.tsx rbac detach b@example.com admin   # re-attach command, written down FIRST: bun run src/cli.tsx rbac attach b@example.com admin
curl -s -o /dev/null -w 'create-own %{http_code}\n' -X POST $API/api/tasks -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"task":"requester creates own"}'   # expect 201
curl -s -o /dev/null -w 'config-write %{http_code}\n' -X PUT $API/api/config -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"key":"X","value":"1"}'   # expect 403 (config.write.any not granted)
curl -s -o /dev/null -w 'script-run %{http_code}\n' -X POST $API/api/scripts/run -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d '{"code":"export default async()=>1"}'   # expect 403 (script.run not granted)

# ---- Full round trip ----
# swarm-local-e2e skill: lead+worker docker round trip with AGENT_IDENTITY_MODE=shadow then enforce, pilot user on requester only
```

## Open Decisions (need Taras before implementation)

1. **First role** — approve repaired `rbac-role-requester` = {task.create.own, task.read.own, task.cancel.own, task.steer.own, task.action.own, favorite.write.own}, one named pilot alongside admin under shadow? RECOMMEND YES (`task.steer.own` is a verified live seed bug; `task.fs.mutate` withheld until Phase 6; `script.search` unjustified). Alternative (Draft A cohort: flip `trg_users_default_role` for integration-auto-minted users) preserved as a Phase-7 follow-up. **Which prod user is the pilot?**
2. **Sequencing** — ship the restrictive role at Phase 2 (shadow-only, BEFORE signed identity)? RECOMMEND YES — verified no X-Agent-ID spoof escalates a narrowed user, and the readout answers the issue's own opening question four phases earlier.
3. **user_api_keys interpretation** — the "reconciliation" resolves to `agent_tokens` mirroring `user_tokens` behind ONE bearer resolver (operator key / `aswt_` / `aswa_`); a per-user-API-key table is per-token scopes, already deferred. RECOMMEND YES (verified: no `user_api_keys` table exists). If you meant something else, Phase 4's schema changes.
4. **Mint authority** — who may call `POST /api/agents/{id}/token`? Load-bearing: workers keep the shared operator key, so operator-mint means a compromised worker can mint any agent's token. RECOMMEND operator-only + join-swarm returning a token once per registration, residual risk documented (real fix = scoping the operator key out of workers, separate initiative). Alternatives: lead-only, or per-spawn bootstrap secret.
5. **Caller-chosen agent IDs in join-swarm** — force `crypto.randomUUID()`? RECOMMEND NO for this initiative: breaks the predictable `${prefix}-${sandboxID}` convention; signed tokens already make the id unforgeable at request time. Track separately.

## Appendix

- Workflow run: `wf_433b34b1-f39` (5 Sonnet research agents, 2 Opus drafts, 1 Opus judge; artifacts in `/tmp/des717-*.json` this session).
- Binding prior decisions honored: per-user UNION (user-policy-admission-model.md:123-125); per-token INTERSECTION deferred (:153-162); deny primitive deferred (:131-143); two-layer model settled (:49-86); CLI space-not-colon (structure-diagrams.md:130); audit only for non-grantsAll grants (structure-diagrams.md:132); grant caching deferred (:128).
- Stale Appendix B corrected: "agent ∩ originator ∩ trigger" intersection framing superseded — only agent ∩ originator is introduced.
- Corrections to research made by the judge: `ensureConfigAdmin` "guess the lead id" exploit is NOT real (operator/user short-circuit at config.ts:85-86); the real header-promotion bug is kv.ts:296-307.
- References: DES-717, DES-445; PRs #921 #935 #936 #951; `runbooks/local-development.md`, `LOCAL_TESTING.md`.

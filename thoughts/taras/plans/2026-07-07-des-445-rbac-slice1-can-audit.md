---
date: 2026-07-07T00:00:00Z
author: Claude
planner: Claude
topic: "DES-445 RBAC — Slice 1: central can() + audit log (increments 1+2)"
tags: [plan, rbac, auth, security, des-445]
status: completed
last_updated: 2026-07-07
last_updated_by: Claude (orchestrator — whole-slice E2E passed)
related_brainstorm: thoughts/taras/brainstorms/2026-05-15-rbac-for-swarm.md
related_research: thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md
---

# DES-445 RBAC — Slice 1: central `can()` + audit log (increments 1+2) Implementation Plan

## Overview

Introduce the central `can()` authorization chokepoint as a **behavior-preserving refactor** (increment 1) and hang the async audit log off it (increment 2). No `RBAC_ENABLED` flag, no role tables yet — disabled-mode `can()` IS the built-in legacy policy reproducing today's exact rules. Closes the `src/http/scripts.ts` ungated-gap as part of the migration.

- **Motivation**: DES-445 — RBAC for the agent-swarm. First shippable slice of the 6-increment strategy; pure risk-reduction that makes everything after it additive.
- **Related**:
  - Brainstorm (12 settled decisions + incremental strategy): `thoughts/taras/brainstorms/2026-05-15-rbac-for-swarm.md`
  - Research (codebase-as-is map, git `9015e5be`): `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md`
  - Increments 3–6 outline: see Appendix.
- **PR shape** (Taras, 2026-07-07): **PR A** = increment 1 (Phases 1–5), **PR B** = increment 2 (Phase 6). Commit per phase after verification passes (`[phase N] <description>`).

## Current State Analysis

Full map: `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md` (git `9015e5be`); anchors re-verified at HEAD 2026-07-07. What matters for this slice:

- **No central authz helper exists.** 34 enforced authorization sites are all inline `if (!agent?.isLead)` — no `requireLead`/`can()` anywhere. Full enumerated table in research §3 (re-verified; see drift note below). MCP denials are **soft** (`{success: false}` / `isError` in the tool result); HTTP denials are real `403`. Three file-local pseudo-helpers still inline the check: the KV namespace guard duplicated across `src/tools/kv/kv-set.ts` / `kv-delete.ts` / `kv-incr.ts`, `authorizeWrite` (`src/http/kv.ts:313`), and `canMutateTask` (`src/http/fs.ts:432`).
- **Drift since the research pin**: raw `isLead` hits in `src/tools/` + `src/http/` are now 59 across 40 files. Files referencing `isLead` that are NOT in the research's 34-site table: `src/tools/slack-reply.ts`, `src/tools/join-swarm.ts`, `src/tools/send-task.ts`, `src/tools/memory-search.ts`, `src/tools/memory-get.ts`, `src/http/memory.ts`, `src/http/agents.ts`, `src/http/poll.ts`. Some are non-authz (registration, routing) and some are excluded memory soft-scoping — Phase 1 classifies every one.
- **Ownership gate already centralized once:** `assertOwnsTask` (`src/tools/task-tool-ctx.ts:27`, comment: "RBAC chokepoint") denies `get-task-details` / `cancel-task` / `task-action` when `task.requestedByUserId !== ctx.userId`. `ToolCtx` is a discriminated union `ownerCtx | userCtx` (`task-tool-ctx.ts:5-18`).
- **Live ungated gap:** `src/http/scripts.ts:97,146` document a `403 "Global write/delete requires lead agent"` in OpenAPI, but the handlers (upsert branch `:407-434`, delete branch `:709-715`) only call `requireAgent` (existence) — global script write/delete is currently **ungated**. `src/tests/scripts-http.test.ts:319-345` currently *characterizes the permissive behavior* (non-lead CAN write/delete global scripts). This slice closes the gap and flips those tests.
- **Enforcement-by-construction is viable on both surfaces** (context for later increments, not changed in this slice): one HTTP listener, `handleCore` (`src/http/core.ts:197`, auth block `~:240-256`) gates everything; 114/114 MCP tools go through `createToolRegistrar` (`src/tools/utils.ts:139`); `ToolConfig` (`src/tools/utils.ts:111`) has no auth field yet.
- **Identity substrate:** `HttpRequestAuth` (`src/utils/request-auth-context.ts`) distinguishes `operator` (shared key) vs `user` (`aswt_` token). `X-Agent-ID` is self-asserted/unauthenticated — hardened in increment 4, NOT here. `agent_tasks.requestedByUserId` is already load-bearing for authz (ownership, user-scoped listing, budget admission).
- **No audit table exists.** business-use telemetry is flow-level and complementary; audit is verb-level (one row per `can()` call) and must not be merged with it. There is **no in-memory-buffer→flush writer precedent** in `src/be/` (writes are synchronous `getDb().run(...)`) — the audit writer introduces that pattern. There IS a periodic-cleanup precedent to copy: `startMemoryGc`/`stopMemoryGc` (`src/http/memory.ts:963-1010`), wired at boot (`src/http/index.ts:594`) and shutdown (`:417`).
- **Test substrate** (from pattern recon): tool-gate tests exist in three shapes — direct handler + `ownerCtx`/`userCtx` (`src/tests/task-tools-ownership.test.ts`), real `McpServer` + `_registeredTools` extraction with identity faked via `extra.requestInfo.headers["x-agent-id"]` (`src/tests/update-profile-auth.test.ts:26-49`, the dominant pattern), and a `MockMcpServer` class (`src/tests/swarm-config-reserved-keys.test.ts:53-75`). HTTP gates are tested by wrapping `handleCore` + the family handler in a real `node:http` server (`src/tests/kv-http.test.ts:39-52`) or by faking `req`/`res` (`src/tests/scripts-http.test.ts:95-140`). Tests import `initDb`/`createAgent`/`createTaskExtended`/`createUser` straight from `src/be/db` (allowed — `src/tests/` is not on the DB-boundary list). **Only ~9 of the 34 gates have denial coverage today**; ~25 have none (list in Phase 1).

## Desired End State

After this slice (increments 1+2 of the 6-increment strategy):

1. A `src/rbac/` module exists: typed permission registry, pure `can()` engine, principal/resource/decision types, pluggable audit sink.
2. Every hard authorization gate — the 34 research-§3 sites, any hard gates added since the pin (Phase-1 sweep), `assertOwnsTask`, the kv/fs guards, and the two `scripts.ts` handlers — routes its allow/deny decision through `can()`. **Zero behavior change** except `scripts.ts` now enforcing its documented 403.
3. `can()` runs the **built-in legacy policy** — a hardcoded rule table reproducing today's exact rules. No `RBAC_ENABLED` flag, no role tables (those are increment 3).
4. Characterization tests prove parity: every migrated gate has deny (and where practical allow) cases asserting the same outcome — same soft-failure shape and message for MCP, same HTTP status/body for HTTP — passing both before and after the refactor.
5. A `permission_audit` table + async batched writer records one row per `can()` call (allow AND deny), **always-on** with a `RBAC_AUDIT_DISABLED=true` kill-switch *(Taras, 2026-07-07: supersedes brainstorm Decision #11's "disabled mode = no audit writes" for this increment)*. Retention cleanup task prunes old rows.
6. Verifiable: full suite green (`bun test`), targeted characterization suite green, audit rows observable via sqlite query after exercising a gated tool (Manual E2E below).

## What We're NOT Doing

- **No `RBAC_ENABLED` flag, no `roles`/`permissions`/`principal_roles` tables, no seeded roles, no first-enable wizard** — increment 3.
- **No `user_api_keys`, no signed agent-context token** — increment 4. `X-Agent-ID` stays self-asserted in this slice; the legacy policy is exactly as spoofable as today's inline checks (no regression, no improvement).
- **No `permissions:[]` field on `route()` or `ToolConfig`, no prompt-time tool filtering** — increment 5.
- **No resource ACLs** (`channel_members`/`repo_access`/`agent_access`) — increment 6.
- **No memory RBAC** — separate parallel track (own deps: Picateclas `7dd1c73d`, `workflow_runs.requestedByUserId`; requires removing the `isLead` memory bypass at `src/be/memory/graph-expansion.ts:53`). The memory read-visibility `isLead` sites (soft scoping — `memory-search.ts`, `memory-get.ts`, `graph-expansion.ts`, `links-store.ts`, `sqlite-store.ts`, `src/http/memory.ts`) are **explicitly excluded** from the gate migration.
- **No audit read API or UI** — write-only in this slice; audit-viewer + `audit.read.own`/`audit.read.any` gating follow increment 3.
- **No intersection/principal-stack semantics in the engine yet** — the legacy policy needs only (principal, verb, resource-ownership) rules; the stack-intersection engine arrives with the role engine in increment 3 behind the same `can()` signature.
- **No caching in `can()`** — correctness > performance (Taras, 2026-07-06); every call evaluates directly. Perf is measured (audit timing is cheap to add later), never traded for correctness.

## Implementation Approach

- **Characterization tests FIRST** (Phases 1–2): capture today's behavior at every migration site while the inline checks still exist; the suite must pass before AND after the refactor. This is the parity proof, not an afterthought.
- **Inventory before tests**: the codebase drifted since the research pin — Phase 1 starts with a classification sweep of every `isLead` reference (hard gate / soft scoping / non-authz) producing the definitive migration checklist (appendix table updated in place).
- **`can()` disabled-mode = built-in legacy policy**, not allow-all — a data-driven rule table in `src/rbac/legacy-policy.ts` encoding the exact rules from research §3 (lead-only, lead-OR-creator, owner-OR-lead, own-namespace-OR-lead, authenticated-principal, requester-owns-task).
- **`can()` is pure** — no DB imports; callers pass the rows they already fetched (agent, task, resource metadata). Keeps `src/rbac/` importable anywhere without touching the DB boundary; the audit sink is injected at server boot.
- **`can()` returns a decision object** (`{ allow: true } | { allow: false, reason, missing }`); call sites keep their existing denial *presentation* (MCP soft `{success:false}`/`isError` with today's exact message strings, HTTP 403 with today's body). The engine centralizes the decision, not the response shape.
- **Migrate in reviewable batches**: inventory + MCP characterization (Phase 1) → HTTP characterization (Phase 2) → engine (Phase 3) → MCP tool sites (Phase 4) → HTTP sites + scripts.ts gap closure (Phase 5) → audit (Phase 6).
- **Audit is fire-and-forget**: in-memory buffer, interval flush, flush on shutdown; never blocks or fails the request path; `RBAC_AUDIT_DISABLED=true` kill-switch. Retention copies the `startMemoryGc` pattern. Rows are structured fields only (ids, verb, decision, reason code) — no raw payloads, so no `scrubSecrets` egress concern.

## Quick Verification Reference

Verbatim from LOCAL_TESTING.md / CLAUDE.md:

```bash
bun test                              # all unit tests
bun test src/tests/<file>.test.ts     # one file
bun run tsc:check                     # type check
bun run lint                          # CI runs `lint` (read-only), not lint:fix
bash scripts/check-db-boundary.sh     # DB ownership boundary
bash scripts/check-rbac-boundary.sh   # no inline isLead authz (exists from Phase 5)
bun run check:dep-graph               # dep-graph check
# Fresh-DB migration check (Phase 6):
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http
```

---

## Phase 1: Site inventory + MCP characterization tests

### Overview

Deliverables: (a) the definitive, HEAD-verified migration checklist (every `isLead` reference in `src/tools/` + `src/http/` classified as HARD GATE / SOFT SCOPING / NON-AUTHZ — appendix table of this plan updated in place), and (b) `src/tests/rbac-charact-tools*.test.ts` — deny-path (and where practical allow-path) characterization tests for every HARD-GATE MCP tool site that lacks coverage. All tests pass against **current** code.

### Changes Required:

#### 1. Inventory sweep
**Files**: none (plan appendix + test-file structure are the output)
**Changes**: `grep -rn "isLead" src/tools src/http --include='*.ts'`, classify all ~59 hits. Known classification seeds: research §3's 34 sites = HARD; `memory-search.ts`/`memory-get.ts`/`http/memory.ts` = SOFT (excluded, memory track); `slack-reply.ts:128` = NON-AUTHZ (verified 2026-07-07: cosmetic `icon_emoji` pick only); `join-swarm.ts:83-140` = NON-AUTHZ as a gate (registration-time lead assignment — escalation-adjacent, flagged to increment 4 in derail notes); `poll.ts` = likely NON-AUTHZ routing (verify); `send-task.ts:365`/`http/agents.ts` = classify. Update the appendix table with the result; every HARD gate gets a checklist row used by Phases 4–5.

#### 2. Characterization tests — MCP tool gates
**Files**: `src/tests/rbac-charact-skills.test.ts` (skills + mcp-servers gates), `src/tests/rbac-charact-slack.test.ts` (slack-post/read/start-thread/upload, delete-channel, register-kapso-number), `src/tests/rbac-charact-misc-tools.test.ts` (manage-user, update-profile, cancel-task lead-or-creator, inject-learning, context-history/diff, memory-delete, credential-bindings, script-connections, set-config, kv-set/delete/incr)
**Changes**: Model on `src/tests/update-profile-auth.test.ts:26-49` (real `McpServer` + `_registeredTools` handler extraction; identity via `extra.requestInfo.headers["x-agent-id"]`; lead + worker agents created with `createAgent({ id, name, isLead, status: "idle" })`; per-file `TEST_DB_PATH` + `removeDbFiles` convention). For each uncovered gate (recon list — skill-install/install-remote/uninstall/create/delete, all five mcp-servers gates, script-connections deny path, credential-bindings, context-diff/history, delete-channel, register-kapso-number, slack-post/start-thread/read/upload, memory-delete, kv-incr/kv-delete, cancel-task non-lead-non-creator):
  - **Deny case**: call as worker → assert exact current soft-failure shape + message substring (e.g. `/lead/`), and DB-not-mutated where cheap.
  - **Allow case**: call as lead → where the happy path has external side effects (Slack/Kapso), assert only that the result is NOT the authz denial (downstream failure is acceptable); for pure-DB tools assert success.
  - Skip gates already covered (kv-set, update-profile, manage-user, set-config, skill-update/promote, assertOwnsTask family) — existing tests are the characterization there; do not duplicate.

### Success Criteria:

#### Automated Verification:
- [x] New characterization tests pass against unmodified code: `bun test src/tests/rbac-charact-skills.test.ts && bun test src/tests/rbac-charact-slack.test.ts && bun test src/tests/rbac-charact-misc-tools.test.ts`
- [x] Full suite still green: `bun test`
- [x] Types + lint: `bun run tsc:check && bun run lint`

#### Automated QA:
- [x] Agent cross-checks the appendix inventory table against a fresh `grep -rn "isLead" src/tools src/http --include='*.ts'` — every hit row appears in the table with a classification; every HARD row has a test (new or pre-existing, referenced by file)

#### Manual Verification:
- [ ] Taras skims the classification table — especially the verdicts on `slack-reply.ts`, `send-task.ts`, `http/agents.ts`, `join-swarm.ts`, `http/poll.ts`

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 1] rbac: site inventory + MCP gate characterization tests` after verification passes.

---

## Phase 2: HTTP characterization tests

### Overview

Deliverable: deny/allow characterization coverage for the HTTP-surface gates — `src/http/fs.ts` lead/owner case (missing today), any `http/agents.ts` hard gates found in Phase 1, and confirmation the existing kv-http coverage counts as characterization. `scripts.ts` permissive tests are left as-is (flipped in Phase 5, since that behavior intentionally changes).

### Changes Required:

#### 1. fs gate tests
**File**: `src/tests/fs-routes.test.ts` (extend) or `src/tests/rbac-charact-http.test.ts` (new)
**Changes**: Model on `src/tests/kv-http.test.ts:39-52` (real `node:http` server wrapping `handleCore` + family handler; `authedFetch` with `Authorization: Bearer` + optional `X-Agent-ID`). Add cases for `canMutateTask` (`src/http/fs.ts:432-444`): operator allowed, authenticated user allowed, lead agent allowed, owner agent allowed, non-owner worker denied (403) — matching today's exact behavior.

#### 2. Other HTTP gates from Phase-1 inventory
**File**: `src/tests/rbac-charact-http.test.ts`
**Changes**: For each `http/agents.ts` (or other) hit classified HARD in Phase 1, add deny+allow cases in the same pattern. If classified NON-AUTHZ, record in the appendix and skip.

### Success Criteria:

#### Automated Verification:
- [x] New/extended tests pass against unmodified code: `bun test src/tests/fs-routes.test.ts && bun test src/tests/rbac-charact-http.test.ts`
- [x] Full suite: `bun test`
- [x] Types + lint: `bun run tsc:check && bun run lint`

#### Automated QA:
- [x] Agent confirms every HARD-classified HTTP site in the appendix table now maps to a test file:line (kv → `kv-http.test.ts:269-311` existing; fs → `rbac-charact-http.test.ts` new; agents → no HARD gates found in Phase 1, bucket empty)

#### Manual Verification:
- [ ] None

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 2] rbac: HTTP gate characterization tests`.

---

## Phase 3: `src/rbac/` module — permission registry + `can()` + legacy policy

### Overview

Deliverable: a greenfield `src/rbac/` module (registry, types, legacy policy table, `can()` engine, audit-sink seam) fully unit-tested. Nothing calls it yet — zero behavior change.

### Changes Required:

#### 1. Types
**File**: `src/rbac/types.ts`
**Changes**:
```ts
export type RbacPrincipal =
  | { kind: "agent"; agentId: string; isLead: boolean }
  | { kind: "user"; userId: string }
  | { kind: "operator" };           // shared swarm key

export type RbacResource =                       // only what the legacy rules need
  | { kind: "task"; taskId: string; requestedByUserId?: string | null; creatorAgentId?: string | null; agentId?: string | null }  // agentId = assignee (fs "owner" = assignee OR creator)
  | { kind: "agent"; agentId: string }           // target-agent resources (profile, context, skills-for-agent)
  | { kind: "kv-namespace"; namespace: string }
  | { kind: "owned"; ownerAgentId?: string | null; scope?: string }   // skills, mcp-servers, memory entries, scripts
  | { kind: "none" };

export type RbacDecision =
  | { allow: true }
  | { allow: false; reason: string; missing: PermissionVerb };

export type RbacCheck = { principal: RbacPrincipal; verb: PermissionVerb; resource?: RbacResource; source: "mcp" | "http" };
```

#### 2. Permission registry
**File**: `src/rbac/permissions.ts`
**Changes**: Typed registry — `export const PERMISSIONS = { "user.manage": { description: ... }, ... } as const satisfies Record<string, { description: string; namespace: string }>` + `export type PermissionVerb = keyof typeof PERMISSIONS`. Follow the `src/types.ts` z.enum convention for a derived `PermissionVerbSchema` if a Zod schema is needed downstream (it will be, for the audit row + increment 3). Draft verb set (finalized here, `.own`/`.any` convention per brainstorm): `user.manage`, `agent.profile.update.any`, `agent.context.read.any`, `task.cancel.any`, `task.read.own`, `task.cancel.own`, `task.action.own`, `task.fs.mutate`, `memory.learning.inject`, `memory.delete.any`, `channel.delete`, `integration.kapso.manage`, `integration.slack.post`, `integration.slack.read`, `integration.slack.thread.start`, `integration.slack.upload`, `credential-binding.manage`, `script-connection.manage`, `config.credential-bindings.write`, `skill.create.swarm`, `skill.install.any`, `skill.install.global`, `skill.uninstall.any`, `skill.update.any`, `skill.promote.swarm`, `skill.delete.any`, `mcp-server.create.swarm`, `mcp-server.install.any`, `mcp-server.uninstall.any`, `mcp-server.delete.any`, `mcp-server.update.any`, `kv.write.any`, `script.global.write`, `script.global.delete` (+ any verbs the Phase-1 inventory adds, e.g. slack-reply).

#### 3. Legacy policy
**File**: `src/rbac/legacy-policy.ts`
**Changes**: Data-driven rule table `Record<PermissionVerb, LegacyRule>` where `LegacyRule` is one of: `lead-only`, `lead-or-task-creator`, `lead-or-resource-owner`, `lead-or-own-namespace`, `any-authenticated`, `requester-owns-task`, plus two composites verified against HEAD: `memory.delete.any` (owner OR (lead AND scope=swarm)) and `task.fs.mutate` (operator OR user OR lead OR task-assignee OR task-creator — `src/http/fs.ts:432-444`). Each rule is a small pure function `(principal, resource) => boolean` mapped from research §3's Rule column. Explicit exhaustiveness: every `PermissionVerb` MUST have a rule (compile-time `satisfies`). **Scope boundary (verified 2026-07-07):** the kv `task:page:*` rule (`src/http/kv.ts:318-327` — page writes require the page-proxy `X-Page-Id` request header) is a request-shape structural guard, NOT a principal permission; it stays inline at its call sites and does NOT get a verb. Only the `task:agent:<other>` own-OR-lead rule (`kv.write.any`) goes through `can()`.

#### 4. Engine + sink seam
**File**: `src/rbac/can.ts`, `src/rbac/index.ts`
**Changes**: `can(check: RbacCheck): RbacDecision` — pure, no DB, no caching: look up legacy rule for verb, evaluate, build decision with `reason` naming the failed rule (e.g. `"requires lead agent"`, `"not the task requester"`). `setAuditSink(fn: (check, decision) => void) / clearAuditSink()` — module-level seam, invoked (sync, try/catch-swallowed) on every `can()` call when set; Phase 6 wires the real writer, until then it stays unset. `src/rbac/index.ts` re-exports the public surface.

#### 5. Engine unit tests
**File**: `src/tests/rbac-engine.test.ts`
**Changes**: Table-driven: every verb × {lead agent, worker agent, owner-worker, task-creator-worker, user-requester, foreign user, operator} → expected decision, mirroring research §3 exactly. Sink tests: sink receives (check, decision) for allow AND deny; a throwing sink never breaks `can()`; unset sink is a no-op.

### Success Criteria:

#### Automated Verification:
- [x] Engine tests pass: `bun test src/tests/rbac-engine.test.ts`
- [x] Full suite: `bun test`
- [x] Types + lint: `bun run tsc:check && bun run lint`
- [x] Boundary clean (src/rbac imports no DB): `bash scripts/check-db-boundary.sh && bun run check:dep-graph`

#### Automated QA:
- [x] Agent verifies rule-table exhaustiveness: every verb in `permissions.ts` has a `legacy-policy.ts` rule and at least one allow + one deny engine test asserting it (36 verbs = 36 policy keys = 36 registry entries; programmatic sweep over 7 principals × 5 resource fixtures confirms every verb reaches both allow and deny; every verb string appears in `rbac-engine.test.ts`)

#### Manual Verification:
- [ ] Taras reviews the verb naming + registry descriptions (they become an API contract in increment 3)

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 3] rbac: permission registry + can() engine with legacy policy`.

---

## Phase 4: Migrate MCP tool gates to `can()`

### Overview

Deliverable: every HARD-gate MCP tool site (research §3 items 1–32 + Phase-1 additions) and `assertOwnsTask` delegate their decision to `can()`; all inline `if (!agent?.isLead)` authz conditionals in those tools are gone. Characterization suites pass unchanged.

### Changes Required:

#### 1. Tool sites (≈31 sites across ~25 files)
**Files**: per the appendix checklist — `src/tools/manage-user.ts`, `update-profile.ts`, `cancel-task.ts`, `inject-learning.ts`, `delete-channel.ts`, `context-history.ts`, `context-diff.ts`, `memory-delete.ts`, `register-kapso-number.ts`, `credential-bindings/tool.ts`, `script-connections/tool.ts`, `swarm-config/set-config.ts`, `slack-post.ts`, `slack-read.ts`, `slack-start-thread.ts`, `slack-upload-file.ts` (+ `slack-reply.ts` if HARD), `skills/skill-create.ts`, `skill-install.ts`, `skill-install-remote.ts`, `skill-uninstall.ts`, `skill-update.ts`, `skill-delete.ts`, `mcp-servers/mcp-server-create.ts`, `mcp-server-install.ts`, `mcp-server-uninstall.ts`, `mcp-server-delete.ts`, `mcp-server-update.ts`, `kv/kv-set.ts`, `kv-delete.ts`, `kv-incr.ts`
**Changes**: Replace each inline check with: build `RbacPrincipal` from the already-fetched caller agent, build the minimal `RbacResource`, call `can({principal, verb, resource, source: "mcp"})`, and on `!decision.allow` return the **exact same soft-failure payload as today** (message strings unchanged — characterization tests enforce this). The duplicated KV namespace guard collapses into one `kv.write.any` check for the `task:agent:` rule; any `task:page:` structural checks in the kv tools stay inline (see Phase 3 scope boundary). **Missing-caller conflation:** today's `if (!agent?.isLead)` treats an unresolvable caller agent the same as a non-lead — call sites must preserve that exact mapping (unknown agent → same denial payload), not introduce a new "agent not found" branch. No handler gains or loses any non-authz logic.

#### 2. Ownership chokepoint
**File**: `src/tools/task-tool-ctx.ts`
**Changes**: `assertOwnsTask` keeps its signature and its `CallToolResult | null` contract but delegates the decision to `can({principal: {kind:"user"|"operator"...}, verb: "task.read.own" | ..., resource: {kind:"task", ...}})`. Verb is passed by the three callers (`get-task-details`, `cancel-task`, `task-action`) or defaulted; denial text stays "this task is not yours" + `code: "forbidden"`.

### Success Criteria:

#### Automated Verification:
- [x] Characterization suites pass UNCHANGED (no test edits in this phase): `bun test src/tests/rbac-charact-skills.test.ts src/tests/rbac-charact-slack.test.ts src/tests/rbac-charact-misc-tools.test.ts src/tests/task-tools-ownership.test.ts src/tests/kv-tool.test.ts src/tests/update-profile-auth.test.ts src/tests/mcp-tools-user.test.ts src/tests/skill-update-scope.test.ts src/tests/swarm-config-reserved-keys.test.ts` (135 pass / 0 fail)
- [x] Full suite: `bun test` (5893 pass / 0 fail)
- [x] Types + lint: `bun run tsc:check && bun run lint`
- [x] No stray inline gates left in migrated files: `grep -n "isLead" <each migrated file>` returns only non-authz hits recorded in the appendix (all remaining hits are principal-construction feeding `can()` — see Appendix A note)

#### Automated QA:
- [x] MCP-over-HTTP spot check (server on :3013, LOCAL_TESTING.md §"MCP tool testing over HTTP" handshake): seed a lead + a worker agent, run the initialize → initialized → tools/call sequence with each agent's UUID as `X-Agent-ID`, call `skill-create` (swarm scope) — worker gets today's soft denial, lead succeeds (verified 2026-07-07 against a scratch `DATABASE_PATH` DB: worker → `"Only lead agents can create swarm-scope skills directly."` success:false; lead → skill created)

#### Manual Verification:
- [ ] None (parity is machine-checked)

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 4] rbac: migrate MCP tool gates to can()`.

---

## Phase 5: Migrate HTTP gates + close the scripts.ts gap + CI boundary check

### Overview

Deliverable: `src/http/kv.ts`, `src/http/fs.ts` (+ any Phase-1 HTTP additions) decide via `can()`; `src/http/scripts.ts` global write/delete now enforce the 403 their OpenAPI has promised all along; a CI static check locks the migration in (no inline `isLead` authz can sneak back). This completes increment 1 → **PR A**.

### Changes Required:

#### 1. KV + FS HTTP gates
**Files**: `src/http/kv.ts` (`authorizeWrite`, `:313-329`), `src/http/fs.ts` (`canMutateTask`, `:432-444`)
**Changes**: Both helpers keep their signatures/return shapes. `authorizeWrite` delegates ONLY its `task:agent:<other>` own-OR-lead branch to `can()` (`kv.write.any`); the `task:page:*` page-proxy branch (`kv.ts:318-327`) stays as-is — it is a request-shape guard, not a principal permission (characterization at `kv-http.test.ts:303-311` pins it). `canMutateTask` delegates to `can()` with `task.fs.mutate` (composite: operator/user/lead/assignee/creator). 403 bodies unchanged, `source: "http"`.

#### 2. scripts.ts gap closure (intentional behavior change)
**File**: `src/http/scripts.ts` (upsert branch `:407-434`, delete branch `:709-715`)
**Changes**: For **global-scope** upsert/delete only: resolve the caller agent (as `requireAgent` already does), call `can({verb: "script.global.write" | "script.global.delete", ...})`, return `403` with the already-documented message on deny. Agent-scope script ops unchanged. No `route()` metadata changes → no `bun run docs:openapi` needed (the 403 was already documented); if any route description IS touched, regenerate and commit `openapi.json`.

#### 3. Flip the permissive scripts tests
**File**: `src/tests/scripts-http.test.ts:319-345`
**Changes**: Rewrite the "non-lead CAN upsert/delete global scripts" cases to assert `403` + add lead-allow cases. This is the only intentional characterization change in the slice — called out in the PR description.

#### 4. CI static check: enforce `can()` usage (Taras, file-review 2026-07-07)
**Files**: `scripts/check-rbac-boundary.sh` (new), `.github/workflows/merge-gate.yml`, `runbooks/ci.md`
**Changes**: Modeled on `scripts/check-db-boundary.sh` (grep + allowlist, fail on violation): flag any `isLead` occurrence in `src/tools/` + `src/http/` that is NOT in the allowlist. The allowlist is exactly the Phase-1 inventory's SOFT + NON-AUTHZ hits (memory soft-scoping, `join-swarm.ts` registration, `slack-reply.ts` cosmetic, routing sites) — so every migrated gate stays migrated and any NEW inline `isLead` authz check fails CI with a pointer to `src/rbac/can()`. Wire into the merge-gate workflow next to the existing boundary checks and document in `runbooks/ci.md` (same-PR rule). Note the limits honestly in the script header: this enforces "no inline `isLead` authz", not "every new tool calls `can()`" — full enforcement-by-construction (a required `permissions` field on `ToolConfig`/`route()`) is increment 5.

### Success Criteria:

#### Automated Verification:
- [x] HTTP characterization passes unchanged (kv/fs): `bun test src/tests/kv-http.test.ts src/tests/fs-routes.test.ts src/tests/rbac-charact-http.test.ts`
- [x] Flipped scripts tests pass: `bun test src/tests/scripts-http.test.ts`
- [x] New boundary check passes at HEAD: `bash scripts/check-rbac-boundary.sh`
- [x] Boundary check actually fails on violation: temporarily add `if (!agent?.isLead) return;` to a migrated tool → `bash scripts/check-rbac-boundary.sh` exits non-zero → revert
- [x] Full suite: `bun test`
- [x] Types + lint + boundary: `bun run tsc:check && bun run lint && bash scripts/check-db-boundary.sh && bun run check:dep-graph`

#### Automated QA:
- [x] Live check against a fresh server (`rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http`): `curl -s -X POST http://localhost:3013/api/scripts -H "Authorization: Bearer 123123" -H "X-Agent-ID: <worker-uuid>" -H "Content-Type: application/json" -d '{"name":"t","code":"export {}","scope":"global"}'` → `403`; same call with `<lead-uuid>` → success (exact path/body per the route def; agents seeded via `createAgent` or registration curl from LOCAL_TESTING.md smoke test)

#### Manual Verification:
- [ ] Taras signs off on the scripts.ts behavior change (any known callers relying on ungated global script writes?)

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 5] rbac: migrate HTTP gates + enforce global-script lead requirement`. **Open PR A** (increment 1).

---

## Phase 6: Audit log — table, batched writer, retention (increment 2 / PR B)

### Overview

Deliverable: `permission_audit` table + always-on async batched writer hung off `can()`'s sink seam + retention GC, with `RBAC_AUDIT_DISABLED=true` kill-switch. One row per `can()` call, allow and deny.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/108_rbac_permission_audit.sql` (use next free NNN at implementation time)
**Changes**: `--` why-header + idempotent DDL per house style (`105_user_favorites.sql` as reference): `permission_audit(id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, principalType TEXT NOT NULL CHECK (principalType IN ('agent','user','operator')), principalId TEXT, originatorUserId TEXT, verb TEXT NOT NULL, resourceType TEXT, resourceId TEXT, decision TEXT NOT NULL CHECK (decision IN ('allow','deny')), reason TEXT, source TEXT NOT NULL CHECK (source IN ('mcp','http')))` + indexes on `ts`, `(decision, ts)`, `(principalId, ts)`. Keep any enum additions in sync with `src/types.ts` schemas per the migrations rule.

#### 2. Batched writer + retention
**File**: `src/be/rbac-audit.ts` (new)
**Changes**: In-memory array buffer; flush via `setInterval` (e.g. 2s or 200 rows, whichever first) inside a single prepared-statement transaction; `flushAuditBuffer()` exported and called on shutdown; every path try/caught — a failed flush logs a warning (through the standard logger; rows are structured ids/verbs only, no secret-bearing payloads) and drops, never throws into the request path. `RBAC_AUDIT_DISABLED === "true"` → sink no-ops entirely. Retention: `startAuditGc`/`stopAuditGc` copying `startMemoryGc` (`src/http/memory.ts:963-1010`) — daily tick deleting `ts < now - RBAC_AUDIT_RETENTION_DAYS (default 30)`.

#### 3. Wiring
**File**: `src/http/index.ts`
**Changes**: At boot (next to `startMemoryGc()` at `:594`): `setAuditSink(enqueueAuditRow)` + `startAuditGc()`. On shutdown (next to `stopMemoryGc()` at `:417`): `stopAuditGc()` + final `flushAuditBuffer()` + `clearAuditSink()`. **Also check `src/stdio.ts`**: if the stdio MCP transport registers the same tools in a standalone process that owns the DB, wire the sink there too; if it doesn't (worker-side, no DB), document explicitly that stdio-transport calls produce no audit rows (sink unset → `can()` still decides correctly).

#### 4. Tests
**File**: `src/tests/rbac-audit.test.ts`
**Changes**: buffer + flush persists rows (allow AND deny, correct columns incl. `source`); kill-switch env writes nothing; throwing DB during flush doesn't propagate; retention purge deletes only rows older than cutoff; shutdown flush drains the buffer; a migrated gate exercised end-to-end (call a gated handler → flush → row exists with expected verb/decision). Env save/restore per `scripts-http.test.ts:55-82` convention. Every test that starts the flush interval or GC MUST stop it in `afterAll`/`afterEach` — bun test leaks module state process-wide across files (see `runbooks`/bun-test gotchas), so dangling timers poison unrelated suites.

### Success Criteria:

#### Automated Verification:
- [x] Audit tests pass: `bun test src/tests/rbac-audit.test.ts`
- [x] Full suite: `bun test`
- [x] Types + lint + boundaries: `bun run tsc:check && bun run lint && bash scripts/check-db-boundary.sh && bash scripts/check-rbac-boundary.sh && bun run check:dep-graph`
- [x] Fresh-DB migration applies: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http` boots clean (then Ctrl-C) — verified against a scratch `DATABASE_PATH`, 106 migrations incl. 108 applied clean
- [x] Existing-DB migration applies: restart `bun run start:http` against a pre-existing DB copy — runner applies 108 forward-only without error (second boot applied 0 migrations, no errors)

#### Automated QA:
- [x] With the server running, exercise a gated MCP tool as a worker (handshake per LOCAL_TESTING.md §"MCP tool testing over HTTP"), then `sqlite3 agent-swarm-db.sqlite "SELECT verb, decision, principalType, source FROM permission_audit ORDER BY ts DESC LIMIT 5;"` shows the deny row — got `memory.learning.inject|deny|agent|mcp|requires lead agent`
- [x] Restart server with `RBAC_AUDIT_DISABLED=true`, repeat the tool call, confirm row count unchanged — count stayed 1

#### Manual Verification:
- [ ] Taras spot-checks audit row `reason` strings for debuggability (the brainstorm's key UX win — "which permission was missing, at which layer")

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 6] rbac: permission_audit table + async batched writer + retention`. **Open PR B** (increment 2).

---

## Manual E2E (whole slice, against a real local backend)

```bash
# 0. Fresh server
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 1. Seed a lead and a worker (UUIDs required)
export LEAD_ID=$(uuidgen) WORKER_ID=$(uuidgen)
# register via the LOCAL_TESTING.md smoke-test registration curls, or:
bun -e 'import {initDb, createAgent} from "./src/be/db"; initDb("./agent-swarm-db.sqlite");
createAgent({id: process.env.LEAD_ID, name: "e2e-lead", isLead: true,  status: "idle", maxTasks: 1});
createAgent({id: process.env.WORKER_ID, name: "e2e-worker", isLead: false, status: "idle", maxTasks: 1});'

# 2. MCP handshake as WORKER (LOCAL_TESTING.md §"MCP tool testing over HTTP", :89-125)
curl -sN -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" -H "X-Agent-ID: $WORKER_ID" \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl","version":"1"},"capabilities":{}}}' -D -
# grab mcp-session-id, send notifications/initialized, then:
curl -sN -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" -H "X-Agent-ID: $WORKER_ID" -H "mcp-session-id: <sid>" \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skill-create","arguments":{"name":"e2e","scope":"swarm","content":"x"}}}'
# EXPECT: today's exact soft denial (lead required). Repeat handshake with $LEAD_ID → success.

# 3. scripts.ts gap is closed
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3013/api/scripts \
  -H "Authorization: Bearer 123123" -H "X-Agent-ID: $WORKER_ID" -H "Content-Type: application/json" \
  -d '{"name":"e2e-script","code":"export {}","scope":"global"}'
# EXPECT: 403 (was 2xx before this slice). Same call with $LEAD_ID → 2xx.

# 4. Audit rows landed
sqlite3 agent-swarm-db.sqlite \
  "SELECT ts, principalType, verb, decision, reason, source FROM permission_audit ORDER BY ts DESC LIMIT 10;"
# EXPECT: deny rows for steps 2/3 (worker) and allow rows (lead), with readable reasons.

# 5. Kill-switch
kill %1; RBAC_AUDIT_DISABLED=true bun run start:http &
# repeat step 3 as worker; then:
sqlite3 agent-swarm-db.sqlite "SELECT count(*) FROM permission_audit;"   # unchanged count
kill %1
```

(Exact request bodies for `/api/scripts` and `skill-create` args to be taken from the route/tool schemas at implementation time; placeholders above.)

---

## Appendix

### A. Gate inventory (updated in Phase 1)

Definitive classification of `grep -rn "isLead" src/tools src/http --include='*.ts'` at HEAD 2026-07-07 (Phase-1 sweep): **61 raw hits across 42 files** → **36 HARD-gate sites** (34 research-§3 + 2 post-pin: `slack-delete.ts`, `slack-update.ts` from PR #918), **10 SOFT-scoping hits** (memory read-visibility, excluded — memory RBAC track), **12 NON-AUTHZ hits**, **4 helper-plumbing hits** (folded into their gate row).

#### HARD gates (migrate through `can()`)

Rules verified against HEAD source. "Test" = characterization coverage (new = added in Phase 1). "P4 ✓" = migrated to `can()` in Phase 4 (2026-07-07); `assertOwnsTask` (`src/tools/task-tool-ctx.ts`) also delegates to `can()` with verbs `task.read.own` / `task.cancel.own` / `task.action.own` passed by its three callers.

**Post-P4 `isLead` hits in migrated files (non-authz, allowlist for the Phase-5 CI check):** every remaining `isLead` occurrence in the migrated tool files is principal construction feeding `can()` (`isLead: agent?.isLead ?? false` or `isLead: agent.isLead` inside an `RbacPrincipal` literal) — no inline authz conditional remains. The three kv tools now share `src/tools/kv/kv-write-auth.ts` (new file), which holds the single `kv.write.any` `can()` check plus the inline `task:page:*` request-shape guard.

| # | Site | Rule (today) | Verb (Phase-3 draft) | Phase | Characterization test |
|---|---|---|---|---|---|
| 1 | `src/tools/manage-user.ts:89` | lead-only | `user.manage` | P4 ✓ | `mcp-tools-user.test.ts:311` (pre-existing) |
| 2 | `src/tools/update-profile.ts:175` | lead-only (other-agent target) | `agent.profile.update.any` | P4 ✓ | `update-profile-auth.test.ts` (pre-existing) |
| 3 | `src/tools/cancel-task.ts:74` | lead OR task-creator | `task.cancel.any` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new — first denial coverage) |
| 4 | `src/tools/inject-learning.ts:48` | lead-only | `memory.learning.inject` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new — real handler test, supersedes the re-implemented predicate in `self-improvement.test.ts:371-379`) |
| 5 | `src/tools/delete-channel.ts:48` | lead-only | `channel.delete` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 6 | `src/tools/context-history.ts:83` | lead-only (other-agent) | `agent.context.read.any` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new) |
| 7 | `src/tools/context-diff.ts:95` | lead-only (other-agent) | `agent.context.read.any` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new) |
| 8 | `src/tools/memory-delete.ts:54,56` | owner OR (lead AND scope=swarm) | `memory.delete.any` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new — incl. lead+agent-scope deny edge) |
| 9 | `src/tools/register-kapso-number.ts:71` | lead-only | `integration.kapso.manage` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 10 | `src/tools/register-kapso-number.ts:174` | lead-only | `integration.kapso.manage` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 11 | `src/tools/credential-bindings/tool.ts:60` | lead-only | `credential-binding.manage` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new) |
| 12 | `src/tools/script-connections/tool.ts:63` | lead-only | `script-connection.manage` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new) |
| 13 | `src/tools/swarm-config/set-config.ts:100` | lead-only (`SCRIPT_CREDENTIAL_BINDINGS` key) | `config.credential-bindings.write` | P4 ✓ | `swarm-config-reserved-keys.test.ts:268` (pre-existing) |
| 14 | `src/tools/slack-post.ts:51` | lead-only | `integration.slack.post` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 15 | `src/tools/slack-read.ts:146` | lead-only (direct-channel branch only; inbox/task branches are ownership checks on other fields) | `integration.slack.read` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 16 | `src/tools/slack-start-thread.ts:46` | lead-only | `integration.slack.thread.start` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 17 | `src/tools/slack-upload-file.ts:219` | lead-only (direct-channel branch) | `integration.slack.upload` | P4 ✓ | `rbac-charact-slack.test.ts` (new) |
| 18 | `src/tools/slack-delete.ts:47` | lead-only — **post-pin (PR #918)** | `integration.slack.delete` (add to registry) | P4 ✓ | `slack-delete.test.ts:91` (pre-existing) |
| 19 | `src/tools/slack-update.ts:50` | lead-only — **post-pin (PR #918)** | `integration.slack.update` (add to registry) | P4 ✓ | `slack-update.test.ts:94` (pre-existing) |
| 20 | `src/tools/skills/skill-create.ts:47` | lead-only (swarm scope) | `skill.create.swarm` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 21 | `src/tools/skills/skill-install.ts:40` | lead-only (cross-agent) | `skill.install.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 22 | `src/tools/skills/skill-install-remote.ts:46` | lead-only | `skill.install.global` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 23 | `src/tools/skills/skill-uninstall.ts:35` | lead-only (cross-agent) | `skill.uninstall.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 24 | `src/tools/skills/skill-update.ts:70` | owner OR lead | `skill.update.any` | P4 ✓ | `skill-update-scope.test.ts` (pre-existing) |
| 25 | `src/tools/skills/skill-update.ts:116` | lead-only (promote to swarm) | `skill.promote.swarm` | P4 ✓ | `skill-update-scope.test.ts:100` (pre-existing) |
| 26 | `src/tools/skills/skill-delete.ts:46` | owner OR lead | `skill.delete.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 27 | `src/tools/mcp-servers/mcp-server-create.ts:88` | lead-only (swarm/global scope) | `mcp-server.create.swarm` | P4 ✓ | `rbac-charact-skills.test.ts` (new — both scopes) |
| 28 | `src/tools/mcp-servers/mcp-server-install.ts:41` | lead-only (cross-agent) | `mcp-server.install.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 29 | `src/tools/mcp-servers/mcp-server-uninstall.ts:36` | lead-only (cross-agent) | `mcp-server.uninstall.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 30 | `src/tools/mcp-servers/mcp-server-delete.ts:43` | owner OR lead | `mcp-server.delete.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 31 | `src/tools/mcp-servers/mcp-server-update.ts:62` | owner OR lead | `mcp-server.update.any` | P4 ✓ | `rbac-charact-skills.test.ts` (new) |
| 32 | `src/tools/kv/kv-set.ts:22` | own `task:agent:` namespace OR lead (page branch stays inline) | `kv.write.any` | P4 ✓ | `kv-tool.test.ts:178,188` (pre-existing) |
| 33 | `src/tools/kv/kv-delete.ts:17` | own `task:agent:` namespace OR lead | `kv.write.any` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new) |
| 34 | `src/tools/kv/kv-incr.ts:17` | own `task:agent:` namespace OR lead | `kv.write.any` | P4 ✓ | `rbac-charact-misc-tools.test.ts` (new) |
| 35 | `src/http/kv.ts:329` (`authorizeWrite`; plumbing hits `:288,294,297,299`) | own `task:agent:` namespace OR lead → 403; `task:page:*` branch (`:318-327`) is a request-shape guard, stays inline | `kv.write.any` | P5 ✓ | `kv-http.test.ts:269-311` (pre-existing) |
| 36 | `src/http/fs.ts:442` (`canMutateTask`) | operator OR user OR lead OR assignee OR creator → 403; **ordered**: operator/user short-circuit BEFORE agent identity (operator bearer + non-owner `X-Agent-ID` is allowed), and the lead/assignee/creator/deny branches only bind when the request-auth context is unset — unreachable via `handleCore` today (Phase-2 finding) | `task.fs.mutate` | P5 ✓ | `rbac-charact-http.test.ts` (new — full decision table: pipeline operator/user cases + auth-context-unset agent branches) |

Plus the **documented-but-unenforced** `src/http/scripts.ts` global write/delete gap (no `isLead` hit — that's the bug): verbs `script.global.write` / `script.global.delete`, **closed in P5 ✓** (2026-07-07), tests flipped in `scripts-http.test.ts` (403 deny + lead-allow + agent-scope-unchanged cases).

**Post-P5 CI enforcement:** `scripts/check-rbac-boundary.sh` (wired into merge-gate next to the DB/api-key boundary checks) flags any `isLead` in `src/tools/` + `src/http/` that is neither a property-key/shorthand-property usage (principal construction, zod schema, memory pins) nor in the file allowlist: `memory-search.ts` (SOFT), `slack-reply.ts` / `join-swarm.ts` / `send-task.ts` / `poll.ts` (NON-AUTHZ), `kv.ts` (buildAuthCtx plumbing feeding `can()`).

#### SOFT scoping (excluded — memory RBAC parallel track)

| Site | What it does |
|---|---|
| `src/tools/memory-search.ts:81,93,100,168` | lead widens memory read-visibility (recall scope) |
| `src/tools/memory-get.ts:138` | same — read-visibility flag into store |
| `src/http/memory.ts:506,513` | recall routes pin `isLead: false` (worker-visibility view) |
| `src/http/memory.ts:590,638` | admin/list routes pin `isLead: true` (lead-visibility view) |

#### NON-AUTHZ (no migration; allowlisted in the Phase-5 CI check)

| Site | Verdict |
|---|---|
| `src/tools/slack-reply.ts:129` | Cosmetic — picks `:crown:` vs `:robot_face:` icon_emoji (verified 2026-07-07) |
| `src/tools/join-swarm.ts:83,95,134,140` | Registration-time lead assignment (first-lead-wins) + join-message text. Not a caller-permission gate; it IS the lead-escalation surface increment 4 must cover (derail note) |
| `src/tools/send-task.ts:365` | Target-shape validation — rejects assigning tasks TO the lead ("wtf?" guard). Constraint on the target, not the caller |
| `src/http/poll.ts:321` | Lead-vs-worker trigger routing branch (lead triggers vs worker auto-claim) |
| `src/http/poll.ts:454` | Lead-only channel-activity monitor trigger (env-gated `LEAD_MONITOR_CHANNELS` routing, not authz) |
| `src/http/agents.ts:47,317,344` | Registration payload schema field, `createAgent` isLead pass-through, telemetry attribute. Registration surface — self-asserted, increment-4 hardening scope |

#### Coverage summary

36 HARD sites: 9 covered by pre-existing tests (rows 1, 2, 13, 18, 19, 24, 25, 32, 35), 26 covered by the new Phase-1 suites (`rbac-charact-skills.test.ts` — 10 gates incl. both mcp-server-create scopes, `rbac-charact-slack.test.ts` — 7 gates, `rbac-charact-misc-tools.test.ts` — 9 gates), 1 covered in Phase 2 (row 36, HTTP fs → `rbac-charact-http.test.ts`). Both HARD HTTP sites now map to tests: row 35 → `kv-http.test.ts:269-311` (pre-existing), row 36 → `rbac-charact-http.test.ts` (Phase 2). `http/agents.ts` contributed no HARD sites (all three hits NON-AUTHZ, see table below), so the "other HTTP gates" bucket is empty.

### B. Increments 3–6 outline (higher altitude — separate plans)

- **Increment 3 — Role engine (opt-in).** Migrations: `roles`, `permissions`, `role_permissions`, `principal_roles` (+ seed data reproducing the legacy policy). `RBAC_ENABLED` flag read at the top of `can()`: OFF → legacy table (this slice's path), ON → role lookup with principal-stack intersection (`agent ∩ originator ∩ trigger-source`, missing layers = no constraint). Multi-role UNION semantics; `rbac.default_unattributed_role` (default admin) for NULL-originator chains; `bun run src/cli.tsx rbac:bootstrap` idempotent backfill; first-enable wizard + roles-first dashboard pages follow. Acceptance: enabling with seeded defaults is a behavioral no-op (characterization suite green with flag ON).
- **Increment 4 — Identity hardening.** `user_api_keys` table (hashed, prefix, revoke/expire) + bearer introspection in `resolveHttpRequestAuth`; signed agent-context token (issued at registration, carries `agent_id` + `originator_user_id` per task, minted on lead→worker handoff) replacing self-asserted `X-Agent-ID` at `handleCore`/`mcp.ts`. **Hard prerequisite for trusting any role-based AGENT scoping** (increments 5–6 agent paths); user-RBAC on 1–3 doesn't wait (aswt_ already authenticated). CLI: `rbac:issue-key`.
- **Increment 5 — Broader enforcement surfaces.** `permissions:[]` on `route()` (`src/http/route-def.ts`) enforced in `handleCore`; `permissions` field on `ToolConfig` enforced in `createToolRegistrar`; prompt-time tool filtering in `buildBasePrompt` (`src/prompts/base-prompt.ts:98-112,165,171,262-281`) so agents never see forbidden tools. Flag-gated; defense-in-depth over the per-site `can()` calls, which remain the security boundary.
- **Increment 6 — Resource ACLs.** `channel_members`/`repo_access`/`agent_access` with resource-local roles; `can()` consults ACL first, falls back to global roles; creator-becomes-owner defaults + audit-logged backfill on enable. Depends on increment 4 for trusted agent scoping.
- **Memory RBAC (parallel track, separate plan).** Reference design: agent-fs `research/2026-06-01-rbac-memory-options.md` (Option B, 3-col ownership, swarm/team/org scopes). Deps: Picateclas `7dd1c73d`, `workflow_runs.requestedByUserId`. Must remove the `isLead` memory bypass (`graph-expansion.ts:53`, `sqlite-store.ts:792-821`) — the SOFT-classified sites from Phase 1's inventory are its work-list.

### C. Derail notes (out of scope, don't lose)

- `self-improvement.test.ts:371-379` re-implements the inject-learning lead predicate instead of invoking the handler — Phase 1 adds a real characterization test; consider deleting the duplicated predicate assertion later.
- `users.role` free-form column + UI `UserRole`/`minRole` are inert scaffolding (research §7) — increment 3 decides reuse-vs-replace; nothing in this slice touches them.
- No batched-writer precedent existed; if the audit buffer pattern proves useful, `session_logs` writes could adopt it (perf, non-gating).
- `cancel-task` non-lead-non-creator denial had zero coverage before this slice — worth calling out in PR A as a coverage win.
- Audit `originatorUserId` is populated only where call sites already know the task's `requestedByUserId`; systematic originator threading through every `can()` call is increment-3 work.
- `join-swarm.ts:83-95` assigns lead status at registration time based on self-asserted input (first-lead-wins) — not a gate to migrate, but it is the lead-escalation surface that increment 4's signed agent identity must cover alongside `X-Agent-ID`.

### D. References

- Research: `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md`
- Brainstorm: `thoughts/taras/brainstorms/2026-05-15-rbac-for-swarm.md`
- Testing recipes: `LOCAL_TESTING.md` (§Unit tests, §MCP tool testing over HTTP, §Minimal smoke-test)
- Retention pattern: `src/http/memory.ts:963-1010` (`startMemoryGc`)
- Linear: DES-445

## Review Errata

_Reviewed: 2026-07-07 by Claude (gap-analysis pass, auto-apply mode; kv/fs/join-swarm/slack-reply claims verified against HEAD source)_

### Applied
- [x] **kv `task:page:*` rule mis-modeled** — `authorizeWrite` (`src/http/kv.ts:313-333`) has a third, non-principal rule: page-namespace writes require the page-proxy `X-Page-Id` header regardless of lead status. Collapsing all kv authz into one `kv.write.any` verb would have wrongly routed a request-shape guard through the principal engine. Fixed: Phase 3 scope boundary + Phase 4/5 now route only the `task:agent:<other>` own-OR-lead branch through `can()`; the page-proxy branch stays inline. — auto-applied
- [x] **fs "owner" definition incomplete** — `canMutateTask` (`src/http/fs.ts:432-444`) grants to operator OR user OR lead OR **assignee (`task.agentId`)** OR creator. The task resource type lacked `agentId`; the legacy-rule list lacked this second composite. Fixed in Phase 3 types + legacy-policy description and Phase 5 wording. — auto-applied
- [x] **`slack-reply.ts` misclassified as likely hard gate** — verified: `isLead` at `:128` only picks `:crown:` vs `:robot_face:` icon. Reclassified NON-AUTHZ in Phase 1 seeds; removed from characterization scope and verb examples. — auto-applied
- [x] **Missing-caller conflation risk** — today's `if (!agent?.isLead)` treats an unresolvable caller agent identically to a non-lead; Phase 4 now requires call sites to preserve that exact mapping instead of introducing an "agent not found" branch. — auto-applied
- [x] **stdio transport audit blind spot** — if `src/stdio.ts` serves the same tools standalone, the audit sink (wired only in `src/http/index.ts`) would be unset there. Phase 6 now requires wiring it or documenting the gap explicitly. — auto-applied
- [x] **bun-test timer leakage** — Phase 6 tests must stop flush/GC intervals in teardown (bun test leaks module state process-wide across files). — auto-applied
- [x] Minor: `join-swarm.ts` lead self-assignment surface recorded in derail notes (increment-4 concern); Phase-1 QA grep cleaned up (`grep -v __tests__` was a no-op); Manual E2E now exports `LEAD_ID`/`WORKER_ID` for the `bun -e` seeding snippet; `planner:` frontmatter field added. — auto-applied

### Remaining
- None — no Critical findings. The plan is faithful to the five locked-in constraints (legacy-policy disabled mode, scripts.ts gap in increment 1, memory track excluded, identity hardening sequenced at increment 4, no caching in `can()`).

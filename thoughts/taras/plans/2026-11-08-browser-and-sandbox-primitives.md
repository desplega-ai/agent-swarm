---
status: in-progress
autonomy: critical
---

# Browser and Sandbox Primitives Implementation Plan

Status: Phase 1 implemented, verified, and manually accepted on `t3/sandbox-browser-primitives`. Phase 2 is paused and has not started. Taras accepted the plan on 2026-11-08 after file-review closed without saved comments.
Each phase requires automated verification, automatic standards/spec review, and Taras's manual checkpoint before a commit. Continue on the existing branch; commit once per approved phase.

## Overview

Add browser sessions and sandbox previews that agents can create and humans can inspect.
Use the existing research and brainstorm as the scope authority.

- Research: `thoughts/taras/research/2026-11-08-browser-and-sandbox-primitives.md`
- Brainstorm: `thoughts/taras/brainstorms/2026-11-07-browser-and-sandbox-primitives.md`

## Current State Analysis

Baseline: `3d215051d5ce71488012fc0e2fe0123434e8ad1a`, checked on 2026-11-08.

- `src/runtime-providers/types.ts:80` owns worker runtimes. Preview resources need a separate interface.
- `src/scripts-runtime/ctx.ts:20` exposes connections, files, shell, and swarm tools. It has no sandbox or browser namespace.
- `src/runtime-providers/e2b.ts:150` reads status without resuming the sandbox. Preserve this distinction in the new adapter.
- `package.json:248` and `apps/evals/package.json:20` pin E2B 2.26.0. The research recommends one coordinated SDK update.
- The research verified process survival with shell-detached starts or explicit pause plus `timeoutMs: 0`.
- The research observed that an open background command could prevent automatic pause. It did not isolate the cause.
- Browser Use sessions stop permanently. A profile preserves cookies and storage for a later session, but not open tabs.
- The existing Swarm Apps design governs catalog-based mini-apps. These previews remain separate resources and do not change its invariants.

- `src/be/audit-user.ts:28` validates task ownership before resolving its requester. Resource authorization must require an explicit task when several tasks run concurrently.
- `src/http/core.ts:574` checks `X-Source-Task-Id` against the token agent. Script credentials currently lose that task binding.
- `src/be/scripts/run-credential.ts:62` mints an agent credential, while `src/be/users.ts:692` leaves its task binding empty.
- `src/scripts-runtime/loader.ts:196` scrubs script results. Returning a secret CDP URL through ordinary script output conflicts with that guarantee.
- `src/be/db.ts:2563` inherits selected task fields. It does not inherit resource IDs, tags, or attachments.
- `src/github/handlers.ts:869` creates PR comment tasks without a parent. Resource feedback needs an explicit parent selection.
- `src/be/budget-admission.ts:72` checks daily global, agent, and user budgets. Its spend queries currently read session costs only.
- `src/be/db.ts:5259` supplies Usage summaries. Resource costs need a distinct dimension without changing token counts.
- The checkout migration tail is 297. The inspected local `origin/main` reference ends at 302. Refresh both before choosing migration ordinals.

## Desired End State

An agent creates a separate sandbox, synchronizes code, starts a server, and publishes its public preview URL.
The sandbox survives task completion. Human feedback creates a related task that updates the same sandbox.
Browser sessions preserve login state through named profiles and expose a human live view.
The API owns resource state, lifecycle, caps, costs, and authorization.
Provider adapters perform infrastructure operations without importing database modules.

## What We're NOT Doing

Private preview proxy, extra providers, local-browser replacement, browser action APIs, and a takeover state machine remain outside v1.
Private preview requests fail before provider allocation. Public E2B URLs do not expire or revoke independently of the sandbox.
Signed guest browser links and independent link revocation remain deferred.
Human browser access starts through an authenticated dashboard page.
Do not change worker runtime ownership or execute setup commands inside the API process.

## Implementation Approach

### Confirmed decisions

- Keep one comprehensive plan, with a separate verification checkpoint for each phase.
- Public E2B previews are the v1 default. Reject `private` before creating provider resources.
- The swarm controls pause and resume. Disable E2B traffic-triggered resume.
- Resume must pass authorization, live-resource caps, and budget admission.
- A saved public provider URL does not resume a paused sandbox. Its dashboard page provides Resume.
- Commit each implementation phase only after Taras confirms its manual verification.
- Use a connection-only browser CLI bridge. After connection, agents use native `agent-browser` commands.
- Open human browser live views through the authenticated dashboard. Do not post provider control URLs into tasks or channels.

### Shared data and contracts

Use `resources` for both kinds and `browser_profiles` for persistent browser identity.
Keep the resource ID stable across browser reopen operations. Increment a generation when the provider creates a replacement session.
Provider session IDs and connection credentials stay outside public list responses.

Use separate `resource_links`, `sandbox_templates`, `resource_operations`, and `resource_costs` tables.
Each table has the required audit columns. Use forward-only migrations and the async database client.
`resource_operations` makes long setup work observable after the script call returns.
It also records uncertain operations after API restarts, instead of silently repeating commands.

Resource fields include kind, provider, state, generation, template snapshot, creator agent, requester, source task, root task, activity, expiry, and last error.
Keep provider handles and secret configuration encrypted. Store scrubbed errors only.
Use typed links for tasks, GitHub PRs, Slack threads, and workflow runs.
Derive requester and task-tree ownership from trusted server data, never arbitrary links supplied by a caller.

The shared adapter contract includes create, status, pause, resume, destroy, list-owned, and traits.
Traits describe supported operations and lifetime limits. Unsupported operations return a typed error.
The sandbox interface adds exec, files, and preview URLs. The browser interface adds profile management and connection discovery.
Browser Use advertises no pause support. Closing a browser preserves its profile but loses tabs and process state.
Opening a stopped browser creates a new provider session under the same resource ID.

The provider interfaces are explicitly requested. Keep them narrow, with a lazy factory and no generic plugin framework.
Do not share lifecycle interfaces with worker runtime providers. Reuse only DB-free E2B connection helpers.

### Lifecycle, identity, and cost rules

Use these resource states: `provisioning`, `running`, `pausing`, `paused`, `stopping`, `stopped`, `resuming`, `destroying`, `destroyed`, and `error`.
Keep operation status separate: `pending`, `running`, `succeeded`, `failed`, or `uncertain`.
An error does not prove remote termination. Preserve the live reservation until reconciliation confirms the provider state.
Sandbox pause leads to `paused`. Browser close leads to `stopped`. Destruction is terminal for either resource kind.
Open on an already running browser returns its current generation. Open on a stopped browser reserves capacity before replacement.

Serialize mutations per resource with database leases and generation checks.
Reserve capacity in a short transaction before a provider call. Never hold a transaction across network calls.
Count provisioning, running, resuming, and unresolved stop failures against live caps.
Release capacity only after the provider confirms a stopped, paused, or destroyed state.
Use resource and generation metadata to reconcile uncertain creates and discover owned orphans.
Never blindly retry a create after a network timeout or rerun arbitrary exec after an API restart.

Use the brainstorm defaults: three live resources per task tree, twenty per swarm, and thirty minutes of idle time.
Destroy resources after seven days without authenticated activity. Also enforce provider limits for each continuous runtime.
Public preview traffic is invisible to the API. Only authenticated operations and dashboard heartbeat calls renew activity.
Status polling and reaper reads do not renew activity or resume resources.
Native browser CLI activity also bypasses the API. A connection obtains a bounded lease, renewed through an explicit browser open or touch call.
Renewal never promises to exceed the active Browser Use session's timeout.
At that timeout, reconnect to a new generation with the same profile. Open tabs do not survive.
The dashboard must explain this limit beside the public preview link.

Bind resource requests to a verified source task, creator agent, and canonical requester.
Do not infer one current task when an agent has several tasks.
Resource creation requires a source task in v1. Operators select an authorized task in the dashboard or create one through the existing composer.
Taskless runs receive an actionable error. They cannot access user-owned profiles.
A new feedback author never inherits another user's profile access from the original task.
Allow one active provider session per profile to prevent concurrent profile writes.

Record cost intervals by resource, generation, billable dimension, agent, requester, and source task.
Use idempotent checkpoints and split intervals at the existing budget-day boundary.
Count resource cost in all three budget spend queries, including admission for later agent tasks.
Include accrued running cost before resource creation, resume, and lease renewal.
Refuse new running leases when the budget is exhausted. Pause or stop existing resources when their admitted lease ends.
Use finite provider timeouts as a backstop when the API is unavailable.
Keep estimated charges distinct from provider-reported charges. Never add both for the same interval.
Provider billing latency prevents a guaranteed financial hard ceiling. Caps and finite leases bound the exposure.

## Quick Verification Reference

Run commands from the repository root. Test command forms come from `LOCAL_TESTING.md`.
New test paths and scenario names below are deliverables, not files that already exist.
All paths under `src/resource-providers/` and `src/be/resources/` are new deliverables.
The resource, sandbox, and browser HTTP handlers are also new deliverables.

```bash
bun run check:local
bun run lint
bun run lint:slop
bun run tsc:check:tsc
bun run test:root -- --parallel=4
bun run e2e --strict
bun run e2e:ui
bun run check:bun-version
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bash scripts/check-async-db-seam.sh
bash scripts/check-test-spawn-sync.sh
bash scripts/check-audit-columns.sh
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bun run check:dep-graph
```

Run affected checks during each phase. Run the complete required gate before opening the implementation PR.
Use free ports and valid UUIDs in tests. Use `runChild()` for subprocess tests.
Keep provider calls mocked in normal CI. Run the provider acceptance checks separately with explicit credentials.

### HTTP and script conventions

New endpoints use `route()`, explicit RBAC, typed success schemas, and the shared error envelope.
Import every new handler in `src/http/all-routes.ts` and register its runtime handler.
Every route operation and MCP tool needs a black-box scenario or a reasoned coverage exclusion.
Use `getDbClient()` and `afterCommit()` for all runtime storage and post-commit work.
Use `getApiKey()` for worker authentication. Provider keys remain API-side.

Long create, setup, refresh, and exec operations return `{ resourceId, operationId, status }` immediately.
Bound script-side waits below the thirty-second script limit. Let later calls inspect operation progress.
Retry an idempotent request with its original key. Return the existing operation instead of repeating provider effects.

### Sandbox configuration and transfer

Resolve app configuration in this order: DB template, `.agent-swarm/sandbox.json`, then explicit call overrides.
Operator limits remain ceilings after the merge. Repo files cannot change provider credentials or widen secret access.
Persist the resolved template version and configuration for reproducible refreshes.
Define setup command, start command, working directory, declared ports, and a readiness probe.
Store secret references in configuration. Encrypt caller-supplied secret values and avoid returning them in detail responses.

Public repositories use credential-free git. Private GitHub repositories use a separate installation-token mint with one repository and read-only contents permission.
Do not reuse the existing broadly scoped installation-token cache.
Use a temporary credential helper for git. Remove it before executing repository setup commands.
Do not embed tokens in clone URLs, persistent git configuration, logs, or task descriptions.
Other private Git hosts fail with an upload alternative until they have a scoped credential mechanism.

Use the invoking agent's agent-fs drive for upload, as proposed in the brainstorm.
Accept an explicit file manifest under that drive, never an arbitrary external URL or worker-local path.
Validate relative paths, traversal, symlinks, entry count, and byte limits before writing.
Support bounded `writeFiles` for small generated files without agent-fs.
Do not create an archive extraction service or a general worker upload CLI.

Start servers shell-detached, with stdin closed and stdout/stderr redirected to bounded sandbox logs.
Track a process group so refresh can stop descendants before restarting.
Readiness probes must check application content over repeated requests. A single provider response is insufficient.
Configure the actual preview hostname for dev servers with host checks.
Use a custom E2B template with a supported runtime. Do not assume the base template supports current Vite.

## Phase Outline

| Phase | Concrete result | Depends on |
| --- | --- | --- |
| 1 | Shared resource contracts, storage, and authorization | None |
| 2 | Lifecycle reconciliation, caps, and resource costs | 1 |
| 3 | E2B adapter with verified pause and resume | 2 |
| 4 | Sandbox templates, git sync, upload, and server refresh | 3 |
| 5 | Browser Use adapter and persistent profiles | 2 |
| 6 | Script namespaces, browser connection CLI, and seeded skill | 4, 5 |
| 7 | Resource feedback and task-tree continuity | 6 |
| 8 | Resource dashboard, settings, and Usage | 7 |
| 9 | Provider acceptance, complete contract coverage, and operator documentation | 8 |

Implement sequentially in this order. The dependencies also identify which earlier changes a phase relies on.
This plan requires several implementation sessions. Preserve phase status and evidence in this document between sessions.
Each phase ends with a manual checkpoint and a commit after Taras confirms verification.

## Phase 1: Resource contracts, storage, and authorization

### Implementation progress

Implemented and verified. Taras explicitly accepted the names and permission matrix on 2026-11-08 and authorized `[phase 1] add resource contracts and storage`; Phase 2 remains paused. The file-review invocation timed out without saved comments; acceptance came through the subsequent explicit checkpoint, not from the timeout. Two independent standards/spec review rounds found no Critical issues. All Important findings are addressed, including the final localized fixes verified by the parent session:

- Requester/viewer read grants and nonempty real-server REST/MCP tests cover actual admission, bound credentials, shared-key worker headers, and operator metadata reads.
- Encrypted snapshots are separate from explicitly registered secrets; public identities and ordinary commands survive registry reloads.
- Retained metadata reads use stored canonical requester attribution. Operators can read every resource's sanitized metadata, including private browsers and deleted-task history, as approved by Taras. Selecting someone else's task does not authorize operator use of their private profile.
- Listings select public columns, filter and paginate in SQL, and audit once. Agent recursion starts at the authorized root only; a query-plan regression verifies the indexed root lookup.
- Migration tests discover real migration files and compare fresh/upgrade schemas without copied main fixtures.
- Atomic create-request reservations and operation retry conflict checks survive DB reopen. Creation no longer accepts a provider handle before allocating the resource ID; test fixtures inject valid handles after reservation. Production generation-checked handle installation belongs to Phase 2.
- Canonical Slack requester attribution, explicit boolean link conversion, operation error schema, and provider DB-boundary checks are covered. The authorization audit field is named `contextAuthorized`, not the misleading `verifiedTaskTree`.

Final parent verification (2026-11-08): 148 tests passed across the four resource suites and `rbac-engine` (25 resource tests); TypeScript, changed-file Biome, DB/API-key/async boundaries, floating-promise and promise-sink checks, migration/audit/RBAC/response coverage, OpenAPI generation, `git diff --check`, and `bun run e2e --only resources-read` passed. Earlier repair verification also passed 362 regression tests across 11 suites. No live provider allocation was run. Full PR gates remain due before a PR.

Migration `306_resources.sql` was selected after refreshing main (tail 302) and inspecting open PR reservations 303–305. Manual acceptance is complete. Generated script declarations were reproducible; `bash scripts/check-script-types-freshness.sh` passed against the staged phase changes before commit. OpenAPI's missing final newline matches the existing generator.

Minor review dispositions for later phases:

- Preserve fresh authorization rechecks for now; consolidate duplicate ancestry resolution when wiring lifecycle entry points (Phase 2), without caching stale assignment/requester decisions.
- Normalize stored-secret registration labels at write and reload before lifecycle cleanup integration (Phase 2). Stored registrations are currently append-only; no resource unregistration exists.
- User control/feedback read parity and role grants ship with their routes: profile management in Phase 5, feedback in Phase 7, dashboard controls in Phase 8. Phase 1 exposes reads only; requester/viewer roles gain no resource writes here.
- Completed tasks remain valid explicit ownership context; no active-status requirement was specified. Private profiles still require the selected task's canonical requester.
- Decide provider-specific external-ID secrecy before Phase 3: public E2B hostnames must not be redacted as private browser handles. Cost overlap/replacement and boot-history bounds belong to Phase 2.

### Overview

Create the shared resource model and its API-owned repository.
Provide a fake adapter and authorization tests before any live provisioning exists.

### Changes Required:

1. **New contracts:** `src/resource-providers/types.ts`, `src/resource-providers/index.ts`, and shared schemas in `src/types.ts`.
   Use discriminated sandbox and browser contracts with provider traits.
   Keep public resource records separate from encrypted provider handles and connection credentials.
2. **New storage:** `src/be/resources/db.ts` and forward-only SQL under `src/be/migrations/`.
   Add the six tables described above, indexes for links and reaping, and unique operation idempotency keys.
   Add `sourceTaskId` provenance to `session_tokens` without reusing its worker-token `taskId` discriminator.
   Add generation, lease owner, lease expiry, and operation state fields for conditional updates.
   Preserve resource and cost history after remote destruction.
3. **New authorization:** `src/be/resources/access.ts`, plus `src/rbac/types.ts`, `permissions.ts`, and `legacy-policy.ts`.
   Define `resource.read`, `resource.create`, `resource.use`, `resource.destroy`, `resource.feedback`, and template/profile management verbs.
   Operators manage templates and swarm profiles. Users manage their own profiles.
   Agents use resources linked to their verified task tree, subject to profile ownership.
   User-profile use requires the current task's requester to match the profile owner, including follow-ups.
4. **New read routes:** `src/http/resources.ts`, handler registration, and `src/tools/resource-list.ts`.
   Implement filtered list and detail reads. Add `resource-list` to the SDK map and read-tool classification.
   Use `toolOk`, `toolErr`, and loose output schemas. Exclude browser provider IDs, CDP URLs, and secret configuration.
   Register mock E2E scenarios in `scripts/e2e/coverage-manifest.json` as each surface appears.

### Verification

Start with `bun run test:root -- src/tests/resources-db.test.ts`. Run the remaining phase checks listed below.

Choose migration ordinals after refreshing `main` and inspecting open migration PRs.
Test both an empty database and a database initialized through the previous migration tail.
New tests: `resources-db.test.ts`, `resources-access.test.ts`, and `resources-http.test.ts` under `src/tests/`.

### Success Criteria:

#### Automated Verification:

- [x] `bun run test:root -- src/tests/resources-db.test.ts`
- [x] `bun run test:root -- src/tests/resources-access.test.ts`
- [x] `bun run test:root -- src/tests/resources-http.test.ts`
- [x] `bash scripts/check-migration-conflicts.sh`
- [x] `bash scripts/check-audit-columns.sh`
- [x] `bun run docs:openapi`
- [x] `bun run check:rbac-coverage`
- [x] `bun run check:openapi-response-coverage`

#### Automated QA:

- [x] A fake resource appears through authenticated REST and MCP list calls.
- [x] Forged task, requester, profile owner, and resource-link inputs cannot expand access.
- [x] Detail responses and audit records omit connection credentials and encrypted provider handles.
- [x] Upgrade and fresh-database fixtures produce equivalent schemas without modifying prior migrations.

#### Manual Verification:

- [x] Taras accepts the resource names and permission matrix before live providers become available.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 1] add resource contracts and storage`.

## Phase 2: Lifecycle, capacity, and resource costs

### Overview

Create a restart-safe resource reconciler and cost accounting against the fake adapter.
Creation and resume reserve capacity before the provider starts billable work.

### Changes Required:

1. **New lifecycle service:** `src/be/resources/service.ts`, `operations.ts`, and `reconciler.ts`.
   Implement create, pause, resume, stop, destroy, bounded operation polling, and explicit touch.
   Record pending work before execution. Claim work through conditional database updates with expiring leases.
   Reconcile owned provider metadata after uncertain create results. Prevent stale generations from replacing current handles.
   Mark interrupted arbitrary exec or setup as uncertain. Require a deliberate retry instead of automatic replay.
2. **Capacity and reaper:** `src/be/resources/admission.ts` and `src/http/index.ts` start/stop wiring.
   Enforce task-tree and swarm caps atomically across concurrent API calls.
   Apply idle pause for E2B, idle stop for browsers, inactivity expiry, and bounded provider leases.
   Stop new work during shutdown. Keep unresolved remote resources visible and eligible for cleanup retries.
   Discover only orphans bearing this swarm's ownership metadata.
3. **Cost accounting:** `src/be/resources/costs.ts`, `src/be/budget-admission.ts`, and daily spend queries in `src/be/db.ts`.
   Accrue billable intervals once per checkpoint, including after API restarts.
   Snapshot rates and attribution before tasks finish. Do not depend on an active task to attribute later cost.
   Update Usage summary schemas with resource cost and total cost fields while preserving session-only fields.
   Keep credential-level token totals unchanged. Report resource charges separately because provider keys are a different dimension.
4. **Configuration:** `apps/ui/src/lib/configuration-catalog.ts`, `src/be/swarm-config-guard.ts`, and the configuration docs page.
   Add validated defaults for caps, idle time, inactivity expiry, lease duration, and preview access mode.
   Accept `public` or `private` as configuration values. Mark `private` unsupported and reject provisioning while it is selected.
   Keep API keys in encrypted secret configuration, outside the ordinary configuration catalog.
   Record each provider's rate and billing dimensions in adapter configuration, with an effective date.

### Verification

Start with `bun run test:root -- src/tests/resources-lifecycle.test.ts`. Run the remaining phase checks listed below.

Use a fake clock and fake provider failures for deterministic concurrency and reconciliation tests.
Prove that denied creation, denied resume, and rejected private mode cause zero provider calls.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run test:root -- src/tests/resources-lifecycle.test.ts`
- [ ] `bun run test:root -- src/tests/resources-costs.test.ts`
- [ ] `bun run test:root -- src/tests/budget-admission.test.ts`
- [ ] `bun run test:root -- src/tests/budget-user-scope.test.ts`
- [ ] `bun run test:root -- src/tests/budget-claim-gate.test.ts`
- [ ] `bun scripts/check-floating-promises.ts`
- [ ] `bun scripts/check-promise-sinks.ts`
- [ ] `bash scripts/check-async-db-seam.sh`

#### Automated QA:

- [ ] Simultaneous create and resume requests cannot exceed either live cap.
- [ ] Restart between provider creation and DB completion produces one owned resource, not two.
- [ ] Pause, destroy, and refresh races cannot restore an older provider generation.
- [ ] A failed remote stop retains its cap reservation until the provider confirms termination.
- [ ] Costs survive task completion and split correctly across budget days without duplicate charges.
- [ ] Budget exhaustion prevents new leases and stops or pauses resources at the admitted lease boundary.

#### Manual Verification:

- [ ] Taras accepts the defaults and the visible distinction between estimated and provider-reported costs.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 2] enforce resource lifecycle and budgets`.

## Phase 3: E2B provider adapter

### Overview

Implement the E2B sandbox adapter and update the shared SDK dependency.
Prove process survival with explicit pause and resume before adding repository setup.

### Changes Required:

1. **Dependency update:** `package.json`, `apps/evals/package.json`, and `bun.lock`.
   Pin both E2B dependencies to the same compatible version, at least 2.63.0, which the research spike exercised.
   Check current package compatibility during implementation and record the selected version.
   Preserve worker-runtime behavior for `betaPause`, `connect`, `getInfo`, timeout renewal, and eval sandbox helpers.
2. **New adapter:** `src/resource-providers/e2b.ts` and factory registration.
   Reuse `e2bSdkConnectionOptions` from `src/e2b/dispatch.ts`.
   Set public traffic explicitly. Disable provider auto-resume and reject private mode before allocation.
   Read state through `getInfo`, never `connect`. Only explicit resume may call `connect`.
   Implement exec, file writes, configured-port URLs, pause, resume, destroy, and owned-resource listing.
3. **Provider contract fixtures:** new tests under `src/tests/resource-providers-*` and reusable assertions by resource kind.
   Use fixed trusted provider hosts or validated operator host overrides.
   Bound calls, retries, response sizes, and errors. Scrub credentials at every log and persistence boundary.

### Verification

Start with `bun run test:root -- src/tests/resource-providers-e2b.test.ts`. Run the remaining phase checks listed below.

Use a live scratch sandbox for a finite provider check after mock tests pass.
Verify a stable process marker and several content responses after resume, not only a status code.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run test:root -- src/tests/resource-providers-e2b.test.ts`
- [ ] `bun run test:root -- src/tests/runtime-providers-e2b.test.ts`
- [ ] `bun run test:root -- src/tests/runtime-providers-e2b-transport.test.ts`
- [ ] `bun run test:root -- src/tests/e2b-dispatch.test.ts`
- [ ] `bun run check:local`

#### Automated QA:

- [ ] A shell-detached server survives beyond the SDK's default command timeout.
- [ ] Explicit pause preserves files and process state. Ordinary URL traffic does not resume it.
- [ ] Explicit resume restores the marker and repeated application responses.
- [ ] Destroy removes the remote sandbox. Read-only status calls never start it again.
- [ ] The existing worker-runtime smoke path still provisions, pauses, resumes, and terminates correctly.

#### Manual Verification:

- [ ] Taras accepts the public-link behavior while the sandbox is paused.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 3] add E2B preview adapter`.

## Phase 4: Sandbox setup, synchronization, and refresh

### Overview

Agents can create a running preview from git or uploaded files, inspect logs, and refresh the same sandbox.
Templates and repo configuration produce a stored, bounded setup operation.

### Changes Required:

1. **Templates and config:** `src/be/resources/templates.ts`, `sandbox-config.ts`, and template routes in `src/http/resources.ts`.
   Define `.agent-swarm/sandbox.json` with a schema version, setup/start commands, working directory, ports, readiness, and env references.
   Resolve its file at the selected git revision before running setup.
   Apply the configuration precedence and immutable operator ceilings described above.
   Install no automatic default template that relies on the old base runtime.
2. **Git and uploads:** `src/be/resources/sandbox-sync.ts`, `src/github/app.ts`, and sandbox operation routes.
   Clone public repositories and mint narrowly scoped GitHub App credentials for private repositories.
   Validate registered repository identity and installation access before minting.
   Resolve only authorized secret references. Support global and own-agent scopes with an operator-controlled allowlist for sandbox delivery.
   Do not invent requesting-user secrets because the current secrets store has no user scope.
   Add agent-fs file-manifest transfer and small bounded file writes without extracting archives.
3. **Server operations:** `src/be/resources/sandbox-process.ts` and `src/http/sandboxes.ts`.
   Add create, refresh, exec, logs, file transfer, and preview-link operations.
   Serialize refreshes. Reject conflicting unsaved sandbox changes unless the caller explicitly requests replacement.
   Stop the tracked process group, synchronize the requested revision, run setup, restart, and verify readiness.
   Keep the resource available for diagnostics when setup fails. Report the failing stage with scrubbed logs.
4. **Contract scenarios:** add mock sandbox scenarios in `scripts/e2e/scenarios/` and coverage entries.
   Test missing credentials, unknown templates, denied secrets, invalid paths, oversized uploads, failed setup, and retry idempotency.
   Add a small preview fixture with deterministic body content and a WebSocket endpoint for acceptance checks.

### Verification

Start with `bun run test:root -- src/tests/sandbox-config.test.ts`. Run the remaining phase checks listed below.

No setup command runs in the API process. No long-lived git token enters the sandbox.
New tests below cover configuration, synchronization, and process lifecycle independently.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run test:root -- src/tests/sandbox-config.test.ts`
- [ ] `bun run test:root -- src/tests/sandbox-sync.test.ts`
- [ ] `bun run test:root -- src/tests/sandbox-process.test.ts`
- [ ] `bun run test:root -- src/tests/secret-scrubber.test.ts`
- [ ] `bun run docs:openapi`
- [ ] `bun run e2e --only resources-sandbox`

#### Automated QA:

- [ ] Public git and agent-fs uploads both produce a working preview through the real API.
- [ ] An approved private GitHub repository clones with a read-only token limited to that repository.
- [ ] Git configuration, setup env, operation logs, and task output contain no git credential after cloning.
- [ ] Refresh changes the application marker without changing the resource ID.
- [ ] HTTP and WebSocket traffic work on the configured public port host.
- [ ] Template ceilings survive repo and call overrides. Failed readiness never produces a ready state.

#### Manual Verification:

- [ ] Taras accepts the template fields and a real create, inspect, and refresh workflow.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 4] add sandbox setup and refresh`.

## Phase 5: Browser Use sessions and profiles

### Overview

Implement persistent profiles and bounded cloud browser sessions.
An authenticated API caller can open, close, and reopen a resource without exposing provider account keys.

### Changes Required:

1. **New adapter:** `src/resource-providers/browser-use.ts` and factory registration.
   Use the v4 HTTP API with native fetch, without adding an SDK dependency.
   Implement sessions, status, stop, owned-session listing, profile CRUD, and connection discovery.
   Mark pause unsupported. Reopen creates a fresh session with the same profile.
   Bound session timeout to the resource lease and provider maximum. Reconcile timeout stops by polling.
2. **Profiles and browser service:** `src/be/resources/browser-profiles.ts` and `browsers.ts`.
   Enforce user/swarm ownership on every session operation and connection read.
   Serialize profile use and wait for the previous session to stop before opening another.
   Keep profile rows after session destruction. Reject profile deletion during an active session with a clear conflict.
   Store each new provider handle under a new resource generation and reconcile its cost independently.
3. **Routes and secret handling:** `src/http/browsers.ts`, `src/utils/secret-scrubber.ts`, and its fixtures.
   Add typed profile CRUD, open, close, connection, and live-view endpoints.
   Deliver raw connection URLs only through authenticated, no-store responses to authorized consumers.
   Never include these URLs in list/detail responses, script results, task output, logs, analytics, or audit payloads.
   Register dynamic secrets and structural rules for Browser Use CDP hostnames and live-view tokens.
   Increment the scrubber version and update the scrub gate fixtures.

### Verification

Start with `bun run test:root -- src/tests/browser-profiles.test.ts`. Run the remaining phase checks listed below.

Preserve the distinction between remote browser stop and client disconnect.
Mock provider errors including insufficient credit, rate limits, missing profiles, and permanent session stop.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run test:root -- src/tests/resource-providers-browser-use.test.ts`
- [ ] `bun run test:root -- src/tests/browser-profiles.test.ts`
- [ ] `bun run test:root -- src/tests/secret-scrubber.test.ts`
- [ ] `bun run test:root -- src/tests/secret-scrub-gate.test.ts`
- [ ] `bun run docs:openapi`
- [ ] `bun run e2e --only resources-browser`

#### Automated QA:

- [ ] Explicit close and provider timeout both preserve a test cookie in a later session.
- [ ] Reopen changes the provider generation and invalidates old connection URLs.
- [ ] Concurrent opens cannot use the same profile in two active provider sessions.
- [ ] Another requester cannot obtain the profile's CDP URL or live view, including through a feedback task.
- [ ] An authenticated endpoint delivers a usable URL while stored output and logs contain only redacted values.

#### Manual Verification:

- [ ] Taras confirms interactive control through a live view using a test profile.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 5] add Browser Use sessions and profiles`.

## Phase 6: Script namespaces and connection-only CLI

### Overview

Agents receive `ctx.sandboxes` and `ctx.browsers`, plus one discovery tool.
A small CLI command connects the existing native browser client once per session.

### Changes Required:

1. **Trusted invocation context:** `src/be/scripts/run-credential.ts`, `src/be/users.ts`, and script invocation entry points.
   Resolve the source task from validated request context before minting the per-run credential.
   Bind that task to the credential and preserve it through nested script calls.
   Extend `src/utils/request-auth-context.ts` and token lookup to return the stored provenance.
   Resource routes trust this server-side binding over caller-editable task descriptors or headers.
   Preserve script-run token semantics and verify that existing route admission still accepts them.
   Add the non-secret task descriptor to `RunScriptInput`, `SwarmConfigPayload`, and outgoing API headers.
   Update `src/http/scripts.ts`, `src/be/scripts/run-saved.ts`, workflow and scheduler callers, and `src/http/x.ts` deliberately.
   Taskless runs fail closed for user profiles. Do not convert sentinel agent IDs into operator authorization for resource creation.
2. **New namespaces:** `src/scripts-runtime/sandboxes.ts`, `browsers.ts`, `ctx.ts`, and both executors.
   Wire native `eval-harness.ts` and QuickJS shape, prelude, and `dispatchCall` with `swarmHostCalls.run(true, ...)`.
   Use authenticated HTTP, never database imports.
   Provide sandbox create/get/list/refresh/exec/logs/writeFiles/uploadFromFs/preview/pause/resume/touch/destroy/operation methods.
   Provide browser create/get/list/open/touch/close/destroy and profile create/list/delete methods.
   Browser open returns resource ID, state, generation, lease expiry, and dashboard URL. It returns no CDP secret.
3. **New connection CLI:** `src/commands/browser.ts` and `src/cli.tsx`.
   Add `browser connect <resource-id> --session <name>`.
   Read auth with `getApiKey()`, preserve verified source-task context, and request a connection for the resource's current generation.
   Invoke `agent-browser --session <name> connect <cdp-url>` internally without shell interpolation or command echo.
   Set `AGENT_BROWSER_SESSION` for this child process. Use a resource-specific name to avoid another agent's session.
   Scrub child stdout/stderr. Return the native session name and lease expiry only.
   Do not wrap browser actions, start another browser, or implement another CDP library.
   Subsequent commands remain native: `AGENT_BROWSER_SESSION=<name> agent-browser snapshot`, `click`, `fill`, and `close`.
4. **Types, skill, and fixtures:** `src/be/scripts/typecheck.ts`, type contributors where necessary, and `templates/skills/resource-previews/` (new).
   Generate both ambient declarations with `bun run build:script-types`.
   Seed the new skill through `src/be/seed-skills/index.ts` with static imports.
   Include short loops for creation, bounded polling, refresh, connection, renewal, human input, and teardown.
   Explain that native CLI commands do not extend the resource lease and local client close does not stop the provider session.

### Verification

Start with `bun run test:root -- src/tests/scripts-resources.test.ts`. Run the remaining phase checks listed below.

The `scripts-resources.test.ts` test file must parameterize every namespace case over native and QuickJS execution.
Its single test command runs both executors, with no manual environment switch.
Test exact task attribution with two concurrent tasks for one agent and different requesting users.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run test:root -- src/tests/scripts-resources.test.ts`
- [ ] `bun run test:root -- src/tests/scripts-typecheck.test.ts`
- [ ] `bun run test:root -- src/tests/browser-cli.test.ts`
- [ ] `bun run test:root -- src/tests/sdk-allowlist.test.ts`
- [ ] `bun run build:script-types`
- [ ] `bash scripts/check-script-types-freshness.sh`
- [ ] `bun run build:skill-md`
- [ ] `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`
- [ ] `bun run src/cli.tsx help`
- [ ] `bun run src/cli.tsx browser --help`
- [ ] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

#### Automated QA:

- [ ] Both executors run a create, poll, refresh, and destroy loop through the real API with fake providers.
- [ ] Calls retain the correct task and requester through nested scripts without accepting forged ownership fields.
- [ ] The connection CLI attaches a named client, then unwrapped native CLI commands control the cloud browser.
- [ ] Captured stdout, stderr, task output, and persisted script results contain no CDP or live-view credential.
- [ ] Expired or replaced provider sessions report reconnect instructions without silently creating another billed session.

#### Manual Verification:

- [ ] Taras accepts the one-time connection command and native CLI workflow.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 6] expose resource scripts and browser connect`.

## Phase 7: Feedback and task continuity

### Overview

Dashboard, Slack, and GitHub feedback can identify a resource and create a task in its original tree.
The next agent sees the resource and can continue its work without keeping the original worker occupied.

### Changes Required:

1. **Resource context:** `src/be/resources/task-context.ts` and task creation/read integration.
   Resolve authorized resource links from the source task, root task, verified PR identity, or Slack thread.
   Keep existing origin `contextKey` values. Do not replace Slack or GitHub routing with a resource-only context family.
   Link the new task to the selected resource explicitly. Avoid a generic task metadata column.
   Ambiguous PR/thread matches expose candidate resources rather than choosing an unrelated task silently.
2. **Feedback creation:** resource feedback route plus `src/github/handlers.ts` and `src/slack/handlers.ts`.
   For a unique authorized resource, create a follow-up under the latest relevant task in its tree.
   Attribute the requester to the new feedback author. Do not blindly inherit the original requester.
   Preserve current mention gates and active-task steering. Include the resource reference in steering context.
   For completed tasks, create a new follow-up without requiring the old worker to remain online.
   Deduplicate provider deliveries and dashboard feedback with stable event/idempotency keys.
3. **Agent context and publication:** a registered prompt template under `src/prompts/`, plus the seeded resource skill.
   Include resource ID, current state, useful ports, public preview URL, and dashboard URL.
   Require an authorized reattach before editing. Never include browser control URLs or provider handles.
   Agents publish links through existing origin-channel tools and `gh` for GitHub comments.
   Do not add automatic server-side PR posting when the existing task path already lets the agent publish.
4. **PR-close cleanup:** authenticated GitHub event handling and resource reconciliation.
   Default to destruction when the resource's primary linked PR closes or merges.
   Keep one primary cleanup PR per resource in v1. Other links are informational.
   Record cleanup intent durably. Repeated or out-of-order events cannot revive a destroyed resource.

### Verification

Start with `bun run test:root -- src/tests/resources-feedback.test.ts`. Run the remaining phase checks listed below.

Test completed-task feedback separately from active-task steering.
Use mock webhook payloads in CI. Reserve live Slack/GitHub messages for the designated test channel and scratch PR.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run test:root -- src/tests/resources-feedback.test.ts`
- [ ] `bun run test:root -- src/tests/chained-task-follow-up.test.ts`
- [ ] `bun run test:root -- src/tests/follow-up-config-inheritance.test.ts`
- [ ] `bun run test:root -- src/tests/github-handlers.test.ts`
- [ ] `bun run test:root -- src/tests/context-key.test.ts`
- [ ] `bun run e2e --only resources-feedback`

#### Automated QA:

- [ ] Dashboard feedback after task completion creates a child in the same root tree with the resource attached.
- [ ] Slack and GitHub feedback retain source routing and identify the same resource.
- [ ] A different feedback author cannot reuse the original author's private browser profile.
- [ ] Duplicate feedback events create one task. Ambiguous resources are shown for selection.
- [ ] PR close queues destruction once and removes the remote resource after provider confirmation.

#### Manual Verification:

- [ ] Taras accepts a real feedback task that changes an existing preview and posts the updated result.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 7] connect resource feedback to task trees`.

## Phase 8: Dashboard, configuration, and Usage

### Overview

Provide one Resources page with kind filters and a detail view for previews, browsers, lifecycle controls, and feedback.
Add template/profile management and show resource cost beside session cost.

### Changes Required:

1. **List and details:** new `apps/ui/src/pages/resources/` pages, router/sidebar entries, and typed API hooks.
   Use `DESIGN.md` and existing table, detail, form, and status components.
   Show state, source task, primary PR, activity, lease/expiry, and cost.
   Show public sandbox URLs with the public-access label and the pause/resume limitation.
   Provide operation progress, scrubbed logs, bounded pagination, and stable selection across refreshes.
2. **Controls and feedback:** create/refresh/pause/resume/close/destroy actions and a feedback composer.
   Disable unsupported actions through provider traits. Preserve unsent feedback during polling.
   Polling must not resume a resource. Only explicit action or an active viewer heartbeat extends a lease.
   Render an authenticated Browser Use live view with no-referrer policy and a new-tab fallback.
   Fetch its URL only on deliberate open. Keep it out of localStorage, URLs, analytics, and shared page state.
   Do not label the provider view read-only because its controls are not a server-enforced restriction.
3. **Settings and Usage:** template/profile management, provider credential setup, and resource cost breakdown.
   Keep secrets write-only and use the existing encrypted configuration paths.
   User profiles show their owner. Swarm profiles clearly indicate shared use.
   Show separate session and resource totals, estimated cost labels, and existing budget settings.
   Do not attribute resource charges to model tokens or credential-level token usage.
4. **UI coverage and evidence:** new `packages/ui-e2e/specs/resources.spec.ts` and appropriate seeded fixtures.
   Cover empty states, denied actions, operation failures, reconnect, pending feedback, and mobile layouts.
   Capture before/after screenshots and a recording of create, inspect, feedback, and refresh.
   Use the browser tools required by the active harness. For repository CLI verification, use a named `agent-browser` session.

### Verification

Start with `bun run e2e:ui -- specs/resources.spec.ts`. Run the remaining phase checks listed below.

Check desktop and mobile viewports, keyboard interaction, and disabled-state explanations.
Test an actual provider iframe. Header inspection alone does not establish that interactive embedding works.

### Success Criteria:

#### Automated Verification:

- [ ] `bun run e2e:ui -- specs/resources.spec.ts`
- [ ] `bun run e2e:ui:tsc`
- [ ] `bun run lint`
- [ ] `bun run tsc:check:tsc`

#### Automated QA:

- [ ] Desktop and 390px layouts have no horizontal overflow or blocked lifecycle controls.
- [ ] Feedback drafts survive background status refreshes and failed submissions.
- [ ] The live view accepts clicks and typing, or the UI presents a working new-tab fallback.
- [ ] Opening a list or inactive detail page does not renew a resource lease.
- [ ] Usage totals match persisted resource intervals and session charges without duplicate amounts.
- [ ] The PR contains screenshots and a recording under `## Before / after`.

#### Manual Verification:

- [ ] Taras accepts the preview feedback flow, browser view, and cost presentation.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 8] add resource dashboard and usage`.

## Phase 9: Acceptance, documentation, and release readiness

### Overview

Complete the full human-feedback loop against real providers and document operator setup.
Provide repeatable acceptance commands and evidence without leaving paid test resources running.

### Changes Required:

1. **Acceptance runner:** new `scripts/resources-smoke.ts` using the real API and selected live providers.
   Add a `--help` interface, bounded waits, resource ownership labels, and cleanup in `finally`.
   Support `--keep` for interactive review. The cleanup command removes only resources and profiles created by that smoke run.
   Never delete a caller-supplied profile during cleanup.
   Expose `sandbox`, `browser`, `feedback`, and `cleanup` subcommands.
   Emit `smokeRunId`, resource IDs, operation states, application markers, cost summaries, and redacted failures.
   Run this helper on the API host with its configured provider credentials for the final ownership enumeration.
   All lifecycle actions use the HTTP API. Final verification calls each adapter's `listOwned` and profile-list methods directly.
   Filter by swarm owner and smoke-run metadata. Never delete resources from another run.
   Never print provider credentials or connection URLs.
2. **Operator docs:** new `runbooks/resources.md` with an index entry and a project-instructions pointer.
   Document credentials, templates, supported runtimes, git setup, public exposure, lifecycle limits, costs, and teardown.
   Include the adapter checklist and its contract tests. State that adding a provider can require schema, config, and UI registration too.
   Add dashboard documentation and regenerate the docs index if pages or frontmatter change.
   Use `bun run build:docs-index` for that change.
   If seeded bundled files change, run `bun run build:seed-skill-files`.
   Keep seeded skill files, generated declarations, and OpenAPI synchronized.
3. **Complete validation:** run required local gates and the Manual E2E procedure below.
   Test real provider timeout, close/reopen, private git clone, and process survival.
   Record unsupported or failed checks explicitly. Do not count mocked provider tests as live evidence.
   Update this plan's status with phase commits, evidence, and remaining limitations.

### Verification

Start with `bun run e2e --strict`. Run the remaining phase checks listed below.

The final gate uses the exact commands from Quick Verification Reference and the trigger-specific drift checks.
No product implementation or provider acceptance test runs during this planning session.

### Success Criteria:

#### Automated Verification:

- [ ] All commands in Quick Verification Reference pass on the final implementation.
- [ ] `bun run e2e --strict` reports coverage for every new route operation and the discovery tool.
- [ ] `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`
- [ ] `bash scripts/check-script-types-freshness.sh`
- [ ] `bun scripts/resources-smoke.ts --help`
- [ ] Triggered OpenAPI, docs-index, and seeded-file generation leaves no unexplained drift.

#### Automated QA:

- [ ] Real sandbox creation, pause, resume, refresh, and destruction pass through the API.
- [ ] A real profile retains a cookie after explicit stop and timeout stop.
- [ ] A connected native CLI controls the provider browser without exposing its CDP URL in output.
- [ ] Human feedback produces a child task that updates the original preview.
- [ ] Provider enumeration confirms no owned test resources remain after cleanup.
- [ ] Stop test servers and browser sessions, remove test outputs, and report `df -h /` before and after cleanup.

#### Manual Verification:

- [ ] Taras confirms the complete preview and feedback loop and accepts the documented v1 limits.

**Implementation Note:** Stop for manual confirmation, then commit `[phase 9] verify and document resource primitives`.

## Appendix

Commit preference: Taras confirmed one commit after each phase passes verification and manual review.
Use `[phase N] <brief description>` for implementation commits. Do not implement during planning.

### Accepted design decisions

- Public previews intentionally replace the brainstorm's signed private links for v1.
- Browser connection uses a one-time CLI bridge because ordinary script results redact secrets.
- Provider URLs cannot bypass swarm resume admission. This requires explicit resume from the dashboard or scripts.
- Activity means API-visible use. Public traffic and native browser actions do not renew leases automatically.
- The upload path uses agent-fs and small file writes, without an archive service or another upload CLI.
- Private git starts with GitHub App credentials. Other private hosts require upload until scoped credentials exist.
- Resource creation requires an authorized source task. User-profile use always requires trusted requester identity.
- Resource costs use the existing budget-day semantics. UI timestamps follow the viewer's configured timezone.

### References

- Research: `thoughts/taras/research/2026-11-08-browser-and-sandbox-primitives.md`
- Brainstorm: `thoughts/taras/brainstorms/2026-11-07-browser-and-sandbox-primitives.md`
- Adjacent design: `thoughts/taras/design-docs/swarm-apps.md`
- Verification: `LOCAL_TESTING.md`, `runbooks/testing.md`, `runbooks/ci.md`
- Provider patterns: `src/runtime-providers/types.ts`, `src/runtime-providers/e2b.ts`, `runbooks/runtime-providers.md`
- Security: `runbooks/secret-scrubbing.md`, `src/be/audit-user.ts`, `src/http/core.ts`
- Skills: `runbooks/skills.md`

## Manual E2E

Run this after Phase 9 against a disposable local API and test provider accounts.
The smoke commands below are planned deliverables from Phase 9. They do not exist at planning time.
Use preconfigured provider keys without printing them. Select a registered test repository and template.
Use `AGENT_SWARM_API_KEY` with the CLI. Keep provider account keys on the API server.

The acceptance runner must implement this interface:

| Command | Required arguments | Behavior |
| --- | --- | --- |
| `sandbox` | `--api`, `--task`, `--template`, `--repo`, `--ref` | Create, check readiness, exec, transfer a fixture, pause, resume, refresh, and check cost |
| `browser` | `--api`, `--task`, `--profile` | Check test-cookie persistence, stop/reopen, timeout, and ownership, then retain a running generation when requested |
| `feedback` | `--api`, `--task`, `--resource`, `--message` | Submit feedback, verify the created task's parent and requester, and return its ID |
| `cleanup` | `--api`, `--run` | Destroy run-owned resources, remove profiles created by that run, and verify provider absence |

`sandbox` and `browser` accept optional `--keep`. Every command emits its `smokeRunId` for later cleanup.
The sandbox fixture writes a file through the bounded upload API before refresh.
The browser fixture uses a disposable profile. A supplied test profile remains caller-owned and is never deleted by the runner.
Both commands record failures and attempt cleanup unless `--keep` was explicitly requested.
The runner reads authentication from the environment, never a command-line token argument.

1. Start the API and UI in managed terminal sessions. These command forms come from `LOCAL_TESTING.md`.
   Use a disposable database and the port configuration from `runbooks/local-development.md`.

   ```bash
   df -h /
   DESPLEGA_TELEMETRY_ENV=test bun run start:http
   ```

   In a second terminal:

   ```bash
   cd apps/ui && bun run dev
   ```

2. Run the sandbox acceptance runner through the local API.
   Pass an existing test task with a UUID and a repository ref that is safe to execute.

   ```bash
   bun scripts/resources-smoke.ts sandbox \
     --api http://localhost:3013 \
     --task <task-uuid> \
     --template <sandbox-template-name> \
     --repo <registered-repo-id> \
     --ref <branch-or-commit> \
     --keep
   ```

   The runner verifies create, setup, repeated readiness, exec, upload, pause, explicit resume, refresh, and cost.
   Without `--keep`, it also destroys the sandbox. This run retains it for feedback in step 4.
   Repeat with an approved private GitHub test repository to check the scoped clone path.
   Assert that public requests cannot resume the paused sandbox and that setup leaves no git token behind.

3. Run browser acceptance, then the native CLI path with a kept test resource.

   ```bash
   bun scripts/resources-smoke.ts browser \
     --api http://localhost:3013 \
     --task <task-uuid> \
     --profile <test-profile-id> \
     --keep
   bun run src/cli.tsx browser connect <resource-id> --session resources-e2e
   AGENT_BROWSER_SESSION=resources-e2e agent-browser open https://example.com
   AGENT_BROWSER_SESSION=resources-e2e agent-browser snapshot
   AGENT_BROWSER_SESSION=resources-e2e agent-browser get title
   AGENT_BROWSER_SESSION=resources-e2e agent-browser close
   ```

   The runner verifies cookie persistence, profile ownership, timeout stop, explicit stop, and generation changes.
   Client close only disconnects. Use the cleanup command below to stop the provider session.
   Open the resource in the dashboard and confirm interactive live view with the test profile.

4. Exercise human feedback after the original task completes.

   ```bash
   bun scripts/resources-smoke.ts feedback \
     --api http://localhost:3013 \
     --task <completed-task-uuid> \
     --resource <sandbox-resource-id> \
     --message "Change the preview heading to Review accepted"
   ```

   Inspect the returned follow-up task. Confirm its root task, requester, resource links, and registered prompt context.
   Let a test worker execute it. Verify the changed heading at the same resource's preview URL.
   Repeat through dashboard feedback and an authorized test GitHub PR mention.
   For Slack, use only the documented dev channel and bot from `runbooks/testing.md`.
   Close the scratch PR and confirm provider destruction for its primary linked resource.

5. Capture UI evidence with the active harness browser tools.
   The repository CLI equivalents below use the command forms from `LOCAL_TESTING.md` with an isolated session.

   ```bash
   AGENT_BROWSER_SESSION=resources-ui agent-browser skills get core
   AGENT_BROWSER_SESSION=resources-ui agent-browser open http://localhost:5274/resources
   AGENT_BROWSER_SESSION=resources-ui agent-browser doctor
   AGENT_BROWSER_SESSION=resources-ui agent-browser record start /tmp/resources-ui.mp4 --cursor
   AGENT_BROWSER_SESSION=resources-ui agent-browser snapshot
   # Use current snapshot references to create feedback, inspect progress, and refresh.
   AGENT_BROWSER_SESSION=resources-ui agent-browser record stop
   AGENT_BROWSER_SESSION=resources-ui agent-browser screenshot /tmp/resources-ui.png
   AGENT_BROWSER_SESSION=resources-ui agent-browser close
   ```

   Check desktop and 390px widths, then upload evidence using the repository's PR media workflow.
   Keep browser control URLs and authenticated profile content out of public evidence.

6. Destroy every kept provider resource and delete test profiles before stopping the API.

   ```bash
   bun scripts/resources-smoke.ts cleanup \
     --api http://localhost:3013 \
     --run <smoke-run-id>
   df -h /
   ```

   Verify absence by enumerating this smoke run's provider metadata, not only by reading local DB status.
   Stop the API, UI, and browser sessions started for this run.
   Remove this run's temporary database, logs, and uploaded local evidence copies. Keep shared caches and `node_modules`.

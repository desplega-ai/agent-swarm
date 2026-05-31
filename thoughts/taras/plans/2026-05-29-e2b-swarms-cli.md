---
date: 2026-05-29T00:00:00Z
topic: "E2B Dispatch CLI — Lead Stacks, Swarm Grouping, Lifecycle Control"
status: completed-v1
autonomy: autopilot
last_updated: 2026-05-30T00:00:00Z
last_updated_by: implementing (v1 = Phases 1-5; v2 = Phases 6-7 deferred)
---

# E2B Dispatch CLI — Lead Stacks, Swarm Grouping, Lifecycle Control: Implementation Plan

## Overview

Extend the E2B dispatch CLI so an operator can launch a complete, long-lived swarm (API + lead + N workers) in one command, see/extend its lifetime, group and inspect it by name, and stream its logs — closing the gaps found while deploying a lead-only swarm by hand.

- **Motivation**: Manual lead-only deploy surfaced four gaps: (1) sandboxes silently hard-kill at TTL with no visibility or extend; (2) `start-stack` can only make a homogeneous worker fleet (no lead, shared env across roles); (3) no way to group/inspect a swarm and get its API URL + key + dashboard link; (4) the entrypoint's output never reaches E2B's native logs.
- **Related**: `src/commands/e2b.ts`, `src/e2b/dispatch.ts`, `src/e2b/env.ts`, `src/tests/e2b-dispatch.test.ts`, `runbooks/e2b-dispatch.md`, `ui/src/hooks/use-config.ts`, draft design `/tmp/2026-05-29-1922-e2b-swarms-cli-plan.md`.

## Current State Analysis

- **TTL is set once, kill-on-timeout, no extend.** `createSandbox` sends `timeout` (seconds) in the raw `POST /sandboxes` body (`src/e2b/dispatch.ts:194`), sourced from `--timeout-sec` default **3600** (`src/commands/e2b.ts:350`). E2B's default lifecycle is `kill` → the VM is destroyed at elapse. No extend/heartbeat exists anywhere; `endAt` is on `E2BSandboxInfo` (`src/e2b/dispatch.ts:15`) but never read. The SDK is reached only for connect-and-run (`startDetachedProcess`, `src/e2b/dispatch.ts:225`) and template builds — `Sandbox.setTimeout(ms)` is available but unused.
- **`start-stack` = API + N homogeneous workers, no lead.** `loadRuntimeEnv` branches on E2B `SwarmRole` (`"api"|"worker"`) and reads a single global `--agent-role` (`src/commands/e2b.ts:250`); `startStackCommand` loops `startRole(flags, cwd, "worker", api.url)` with no per-worker override (`src/commands/e2b.ts:601`). `--env-file`/`--secret` are shared across all roles (cross-contamination). A lead is still E2B `SwarmRole === "worker"` (same template/entrypoint/wait); `metadata.role` only ever records `api`/`worker`, never `lead`.
- **No grouping.** `parseMetadata` stamps `{app, role, launcher}` (`src/commands/e2b.ts:300`); there is no shared swarm id. `listSandboxes` (`src/e2b/dispatch.ts:218`) returns metadata for grouping but nothing consumes it that way. `sandboxPortUrl` reconstructs the public URL (`src/e2b/dispatch.ts:151`); the swarm API key resolves via `resolveSwarmApiKey` precedence explicit `--api-key` > `AGENT_SWARM_API_KEY` > `API_KEY` > `getApiKey()` (`src/e2b/env.ts:157`).
- **Entrypoint output is invisible to native logs.** `buildDetachedShell` runs `nohup ${command} >/tmp/agent-swarm-e2b-<role>.log 2>&1 </dev/null &` (`src/e2b/dispatch.ts:101`), so the long-running entrypoint is a detached grandchild writing to a file; envd only ever streams the ~2s wrapper. `e2b sandbox logs` / dashboard / `commands.connect` never see it.
- **Dashboard deep-link.** SPA reads **camelCase** `apiUrl`/`apiKey`/`email`/`name` and strips them after load (`ui/src/hooks/use-config.ts:66-110`); base URL `https://app.agent-swarm.dev` via `getAppUrl()` (`src/utils/constants.ts`). **Latent bug:** onboarding builders emit snake_case `api_url`/`api_key` (`src/commands/onboard/steps/post-dashboard.tsx`, `src/commands/onboard.tsx`) → silently ignored.
- **Persona templates are env-driven.** A worker/lead adopts a persona via `TEMPLATE_ID` (+ `TEMPLATE_REGISTRY_URL`, default `https://templates.agent-swarm.dev`); `runner.ts` fetches `${registry}/api/templates/${id}` (`src/commands/runner.ts:3373-3393`) and applies `agentDefaults` + md files. The registry exposes `GET /api/templates` → `{templates:[{name, displayName, agentDefaults:{role}, ...}]}` (11 templates; `role` is `worker` or `lead`).
- **Tests:** `src/tests/e2b-dispatch.test.ts` (≈15 tests) covers `resolveSwarmApiKey`, `redactObjectWithEnv`, `loadRuntimeEnv`-adjacent helpers, `waitForAgentRegistration`. No CI workflow consumes `start-*` commands (only `build-template`/`publish-template` in `.github/workflows/docker-and-deploy.yml`).

## Desired End State

- `e2b start-stack` provisions **API + 1 lead + N workers** by default (interactive wizard in a TTY; `--yes` one-shot in CI), with role-scoped env that never cross-contaminates.
- Every sandbox in a launch is tagged `metadata.swarm=<slug>` + `metadata.swarmRole`; `e2b swarms list|info|kill|add` groups by it and surfaces API URL, key (source-reported, `--reveal-key`-gated), dashboard deep-link, roles, TTL-remaining, and health.
- Lifetime is visible (`expires in …`), extendable (`e2b extend` / `swarms extend`), and re-synced across a stack; `e2b kill --all` sweeps everything launched by the dispatcher.
- Entrypoint output is captured by envd and reachable (`e2b swarms logs`, dashboard).
- **v2:** persona-template selection per role; manual `pause`/`resume` + opt-in `--on-timeout pause`.

## What We're NOT Doing

- No persistent laptop-bound heartbeat loop (extend is one-shot / on-demand).
- No defaulting to E2B persistence/auto-pause (public beta, data-loss bug #884) — opt-in only, v2.
- No UI changes to the dashboard's connection model (the flat multi-connection list already suffices; deep-link stages a connection).
- No new E2B SwarmRole for "lead" (a lead remains `SwarmRole=worker` + `AGENT_ROLE=lead`).
- No raising the default TTL (stays 3600s; extend is the lever).

## Implementation Approach

- **v1 = Phases 1–5** (auto-stop/extend/kill-all → per-role env → lead stack + wizard → swarms command → native logs). **v2 = Phases 6–7** (persona templates, pause/auto-pause). Recommended as two PRs.
- Keep create on the raw HTTP path; reach for the SDK (`Sandbox.connect`) only for `setTimeout`/`pause`/`resume`/background-run, mirroring `startDetachedProcess`.
- Backward-compat: `start-api`/`start-worker` behavior unchanged; shared `--env-file`/`--secret` still apply to all roles; scoped flags layer on top.
- Treat anything that embeds the swarm API key (deep-link) as secret: hidden by default, `--reveal-key` to emit.

## Quick Verification Reference

- Type check: `bun run tsc:check`
- Unit tests: `bun test src/tests/e2b-dispatch.test.ts`
- Lint (read-only, mirrors CI): `bun run lint`
- Boundaries: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`
- CLI smoke: `bun run src/cli.tsx e2b <subcommand> --help` and `… --dry-run`

---

## Phase 1: Auto-stop visibility, `extend`, re-sync, `kill --all`

### Overview

`e2b` surfaces each sandbox's expiry, can extend a live sandbox's TTL, re-syncs a stack to one wall-clock end, and can tear down all dispatcher-launched sandboxes. Deliverable: `ttlRemaining`/`setSandboxTimeout` in `dispatch.ts`, an `e2b extend` subcommand, `kill --all`, and `expires:` lines on every start.

### Changes Required:

#### 1. Lifetime helpers
**File**: `src/e2b/dispatch.ts`
**Changes**: Add `ttlRemaining(sandbox): {expiresAt?, secondsLeft?}` from `endAt`. **Pre-flight check:** confirm the `POST /sandboxes` response populates `endAt`; if not, have `createSandbox` compute `expiresAt = now + timeoutSec*1000` as a client-side fallback on the returned object. Add `setSandboxTimeout({sandboxId, apiKey, apiBase, e2bEnv, timeoutMs})` via `Sandbox.connect(...).setTimeout(ms)`; read back actual `endAt` (E2B clamps to tier max); catch connect-on-dead → "not found / already expired" (redacted).

#### 2. CLI surface
**File**: `src/commands/e2b.ts`
**Changes**: Print `${role} expires: <endAt> (in Hh Mm)` in `printHumanStart`. Add `e2b extend <sandbox-id...> --timeout-sec <s>` (routes next to `kill`). Extend `kill` with `--all` → filter `listSandboxes` by `metadata.launcher === "agent-swarm-e2b"` and kill (TTY confirmation guard for multi-sandbox). After a stack is fully up, one `setSandboxTimeout(timeoutSec)` re-sync pass over API+lead+workers. Dry-run short-circuits `setSandboxTimeout`. Update `printE2BHelp`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Unit tests pass (add a `ttlRemaining` test for populated/absent `endAt`): `bun test src/tests/e2b-dispatch.test.ts`
- [x] Help lists the new commands: `bun run src/cli.tsx e2b extend --help` and `bun run src/cli.tsx e2b kill --help`
- [x] Dry-run does not touch E2B: `bun run src/cli.tsx e2b extend dry --timeout-sec 60 --dry-run`

#### Automated QA:
- [ ] Agent starts a short-TTL API sandbox, runs `e2b extend <id> --timeout-sec 3600`, and confirms `endAt` moved out (via `e2b list --json`).
- [ ] Agent runs `e2b kill --all` and confirms 0 `agent-swarm` sandboxes remain.

#### Manual Verification:
- [ ] Confirm the printed `expires in …` reads correctly against the E2B dashboard's sandbox end time.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, commit after verification passes.

---

## Phase 2: Per-instance launch spec + namespaced env

### Overview

`startRole`/`loadRuntimeEnv` accept an explicit `AGENT_ROLE` + a role-scoped env layer, so lead/worker/api env never cross-contaminates. Deliverable: a `LaunchSpec` type, namespaced `--{api,lead,worker}-env-file`/`-secret` flags with shared-flag fallback, and tests proving isolation.

### Changes Required:

#### 1. Launch spec + env scoping
**File**: `src/commands/e2b.ts`
**Changes**: Introduce `LaunchSpec { swarmRole: "api"|"worker"; agentRole?: "worker"|"lead"; envScope: "api"|"lead"|"worker" }`, threaded through `startRole`. `loadRuntimeEnv` gains an env-scope param; precedence (highest wins): forward-keys (`process.env`) < shared `--env-file` < scoped `--{scope}-env-file` < shared `--secret` < scoped `--{scope}-secret` < forced `API_KEY`/`AGENT_SWARM_API_KEY`. `AGENT_ROLE` from `spec.agentRole`, else fall back to `--agent-role` (keeps `start-worker` identical). `start-api`/`start-worker` pass the equivalent spec and stay byte-identical.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] New isolation tests pass: `--worker-secret FOO=x` appears in worker runtime but **not** lead/API; shared `--secret BAR=y` appears in all three; existing tests stay green — `bun test src/tests/e2b-dispatch.test.ts`
- [x] API-key boundary intact: `bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [ ] Agent runs `start-worker --dry-run --agent-role lead --lead-secret K=v` and confirms (via dry-run output / a debug print) the spec resolves `AGENT_ROLE=lead` and `K=v` only in that role's env. <!-- Covered via unit tests: dry-run JSON intentionally does NOT surface resolved env (it carries secrets), so per the plan's guidance the proof lives in src/tests/e2b-dispatch.test.ts ("AGENT_ROLE comes from the spec…", fallback test, and "--lead-secret lands only in the lead scope") rather than via noisy debug prints. The literal command runs cleanly (exit 0). -->

#### Manual Verification:
- [ ] None (fully covered by automated checks).

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 3: `start-stack` → API + lead + N workers, + Ink wizard + one-shot

### Overview

`start-stack` provisions API + 1 lead + N workers, interactive in a TTY and headless under `--yes`/non-TTY. Deliverable: reworked `startStackCommand`, a new `e2b-stack-wizard.tsx`, and the one-shot flag surface.

### Changes Required:

#### 1. Stack topology
**File**: `src/commands/e2b.ts`
**Changes**: `startStackCommand` → (1) API, (2) 1 lead `{agentRole:"lead", envScope:"lead"}` (default `AGENT_ID=e2b-lead-<sandboxID>`), (3) N workers `{agentRole:"worker", envScope:"worker"}`. Lead added to `started[]` cleanup. JSON shape → `{api, lead, workers:[...]}`. `--no-lead` retains legacy topology. `--agent-role` ignored for the split (warn → point to `--no-lead`/`start-worker`). **Pre-flight check:** confirm `/docker-entrypoint.sh` registers a `lead` under `/api/agents/<id>` the same way a worker does (so `waitForAgentRegistration` resolves); if not, adjust the lead wait.

#### 2. Interactive wizard + flags
**File**: `src/commands/e2b-stack-wizard.tsx` (new), `src/commands/e2b.ts`, `src/cli.tsx`
**Changes**: Ink wizard (consistent with `onboard*.tsx`): first step create-new vs add-to-existing swarm (lists groups); then swarm name→slug, #workers, provider, TTL (expiry preview), env-file(s), integrations on/off (→ `*_DISABLE`). Each prompt skipped if its flag is set; after collecting, **echo the equivalent `--yes` command**. TTY detection (`process.stdin.isTTY && process.stdout.isTTY`); `--yes`/`--non-interactive` and non-TTY and `--dry-run` force headless. New flags: `--yes`, `--no-lead`, `--swarm <slug>`, `--lead-agent-id`, `--integrations <csv>`/`--no-<integration>`. Update help in `printE2BHelp` + `src/cli.tsx`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Dry-run shows API + lead + N workers: `bun run src/cli.tsx e2b start-stack --dry-run --yes --workers 2 --swarm test` (JSON has `api`, `lead`, 2 `workers`)
- [x] Help lists new flags: `bun run src/cli.tsx e2b start-stack --help`
- [x] Non-TTY never prompts (piped): `echo | bun run src/cli.tsx e2b start-stack --dry-run --swarm test` exits without hanging
- [x] Unit tests pass: `bun test src/tests/e2b-dispatch.test.ts`

#### Automated QA:
- [ ] Agent runs `start-stack --yes --swarm qa --workers 1 --timeout-sec 1800 --json` against real E2B, then queries `${apiUrl}/api/agents` and confirms exactly one `isLead:true` agent + one worker registered, API `/health` 200.

#### Manual Verification:
- [ ] Run `bun run src/cli.tsx e2b start-stack` in a real TTY; confirm the wizard prompts, then prints a runnable `--yes` command equivalent.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 4: Swarm grouping + `e2b swarms` command + dashboard deep-link

### Overview

Every launch is tagged with a shared swarm slug; `e2b swarms list|info|kill|add` operates by slug and emits a working dashboard deep-link. Deliverable: reserved metadata keys, the `swarms` command family, and camelCase deep-link generation (plus fixing the onboarding snake_case bug while in this code).

### Changes Required:

#### 1. Metadata tagging
**File**: `src/commands/e2b.ts`, `src/e2b/dispatch.ts`
**Changes**: `parseMetadata` stamps reserved `swarm=<slug>`, `swarmRole=api|lead|worker`, `apiPort` (API), `agentId` (lead/worker) on every sandbox of a launch (documented alongside `app`/`role`/`launcher`); slug from `--swarm`/wizard/generated, shared across the stack and echoed at start.

#### 2. `swarms` command family
**File**: `src/commands/e2b.ts`
**Changes**: `e2b swarms list|info <slug>|kill <slug>|add <slug>` (routed in switch), grouping `listSandboxes` by `metadata.swarm`. **info:** API URL via `sandboxPortUrl` preferring the sandbox's own `domain` (custom-domain correctness), `apiPort` from metadata (fallback 3013); lead+workers by `swarmRole`+`agentId`; TTL-remaining via `ttlRemaining`; single-shot unauthenticated `GET /health`; API key re-resolved locally via `resolveSwarmApiKey` with **source** reported and masked. **kill:** by slug (API last) or `--all`; TTY confirm. **add:** look up the swarm's API + key, launch worker(s)/lead tagged with the slug, `MCP_BASE_URL` at the existing API, TTL re-synced to the group's `endAt`; with no slug in a TTY, offer a picker. Detect 401 on authed probes → warn "resolved key may not match launch key". Ungrouped sandboxes → `(ungrouped)` bucket in `list`.

#### 3. Dashboard deep-link (+ onboarding bug fix)
**File**: `src/commands/e2b.ts`, `src/commands/onboard/steps/post-dashboard.tsx`, `src/commands/onboard.tsx`
**Changes**: Build via `getAppUrl()` + **camelCase** `?apiUrl=&apiKey=&name=<slug>`. Key hidden by default (`apiKey=<hidden — pass --reveal-key>`); full key-bearing URL only under `--reveal-key`, printed raw (NOT via `redactWithEnv`) with a secret warning. Fix the two onboarding builders to camelCase + add a unit test.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Metadata carried (dry-run prints fake sandbox metadata): `bun run src/cli.tsx e2b start-stack --dry-run --yes --swarm demo` shows `swarm`/`swarmRole`
- [x] Deep-link unit test passes (camelCase params; onboarding builders now camelCase): `bun test src/tests/e2b-dispatch.test.ts`
- [x] Help lists swarms subcommands: `bun run src/cli.tsx e2b swarms --help`

#### Automated QA:
- [ ] Agent starts a real swarm `--swarm qa-grp`, runs `swarms list` (group present), `swarms info qa-grp` (correct API URL, key source, lead+worker, health 200, TTL), `swarms info qa-grp --reveal-key` (deep-link contains the resolved key), then `swarms add qa-grp --workers 1` (worker count grows), then `swarms kill qa-grp` (0 remain).

#### Manual Verification:
- [ ] Open the `--reveal-key` deep-link on `https://app.agent-swarm.dev`; confirm it auto-connects (camelCase) and the swarm's lead/workers appear.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 5: Native sandbox log capture

### Overview

The entrypoint becomes an envd-tracked process so its output reaches E2B's native logs and is reconnectable. Deliverable: background-run launch (replacing the nohup-to-file detach) + an `e2b swarms logs` command.

### Changes Required:

#### 1. envd-tracked launch
**File**: `src/e2b/dispatch.ts`
**Changes**: Replace `buildDetachedShell`'s `nohup … >file …` with the SDK background primitive — `sandbox.commands.run('sh -lc "<entrypoint> 2>&1 | tee <logPath>"', { background: true, user, cwd, envs })` — so envd owns/streams the entrypoint (survives client disconnect) **and** a file copy is preserved for full-history retrieval. Handle returns the PID immediately (replaces the `sleep 2; kill -0` liveness hack with an early `exitCode`/handle poll). **Pre-flight checks:** does envd replay historical stdout on `commands.connect(pid)` after disconnect (keep the tee-to-file if not); what does `e2b sandbox logs <id>` surface (system vs process).

#### 2. logs command
**File**: `src/commands/e2b.ts`
**Changes**: `e2b swarms logs <slug> [--role api|lead|worker] [--follow]` — stream via `commands.connect(pid)` (live) or `commands.run("cat/tail <logPath>")` (history). Update help + `runbooks/e2b-dispatch.md`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Unit tests pass: `bun test src/tests/e2b-dispatch.test.ts`
- [x] Help lists the logs command: `bun run src/cli.tsx e2b swarms logs --help`

#### Automated QA:
- [ ] Agent starts a real swarm, then `e2b swarms logs <slug> --role api` shows entrypoint output (API boot lines), and `e2b sandbox logs <api-id>` (native CLI) is no longer empty.

#### Manual Verification:
- [ ] Open the API sandbox in the E2B dashboard; confirm the entrypoint logs are visible in the process/log view.

**Implementation Note**: End of v1. Pause for manual confirmation; this is a natural PR boundary.

---

## Phase 6: Persona templates (v2)

### Overview

Workers and the lead can adopt an agent persona from the templates registry. Deliverable: `--lead-template-id`/`--worker-template-id` flags + wizard picker that set `TEMPLATE_ID` per instance.

### Changes Required:

#### 1. Per-instance TEMPLATE_ID
**File**: `src/commands/e2b.ts`, `src/e2b/env.ts`
**Changes**: Add `TEMPLATE_ID`/`TEMPLATE_REGISTRY_URL` to `DEFAULT_E2B_FORWARD_KEYS` and route them per-role via the Phase 2 env scope. New flags `--lead-template-id` / `--worker-template-id` (repeatable for per-worker personas; one applied to all otherwise). **Naming caveat:** `--worker-template` is already the E2B *image* template flag — persona flag MUST be `--worker-template-id` (call out in help). Validate ids against `GET ${registry}/api/templates` before launch.

#### 2. Wizard picker
**File**: `src/commands/e2b-stack-wizard.tsx`
**Changes**: Fetch the registry, present a picker filtered by `agentDefaults.role` (workers pick `role:"worker"`; lead defaults to a `role:"lead"` template, override allowed).

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Test: `--worker-template-id coder` sets `TEMPLATE_ID=coder` only on workers — `bun test src/tests/e2b-dispatch.test.ts`
- [ ] Help shows the disambiguated flags: `bun run src/cli.tsx e2b start-stack --help`

#### Automated QA:
- [ ] Agent runs `start-stack --yes --swarm qa-tpl --workers 1 --worker-template-id coder --lead-template-id <lead-role-template> --dry-run` and confirms the resolved per-role `TEMPLATE_ID` values.

#### Manual Verification:
- [ ] In a real swarm, confirm a worker's session reflects the selected persona (e.g. coder CLAUDE.md applied) via `swarms logs`/dashboard.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 7: Pause/resume + opt-in auto-pause (v2)

### Overview

Operators can pause/resume sandboxes and swarms to stop compute billing while preserving state, and opt a launch into pause-on-timeout. Deliverable: `pause`/`resume` commands + `--on-timeout pause` lifecycle.

### Changes Required:

#### 1. Pause/resume
**File**: `src/e2b/dispatch.ts`, `src/commands/e2b.ts`
**Changes**: Add `pauseSandbox`/`resumeSandbox` (SDK `Sandbox.connect(id).pause()` / `Sandbox.resume(id)`). Commands `e2b pause|resume <sandbox-id...>` and `e2b swarms pause|resume <slug>`. Ordering: pause workers→lead→**API last**; resume **API first**→lead→workers. Warn about beta caveat (#884 FS-loss on 2nd+ resume).

#### 2. Auto-pause lifecycle
**File**: `src/e2b/dispatch.ts`, `src/commands/e2b.ts`
**Changes**: **Resolve first:** verify the raw `POST /sandboxes` body accepts `lifecycle:{on_timeout, auto_resume}`; if not, route the API-sandbox create through `Sandbox.create()`. Add `--on-timeout pause|kill` (default `kill`) + `--auto-resume` → `CreateSandboxOptions.onTimeout`/`autoResume` → conditional `lifecycle`. Document the beta caveat. Update `runbooks/e2b-dispatch.md`.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Unit tests pass: `bun test src/tests/e2b-dispatch.test.ts`
- [ ] Help lists pause/resume + `--on-timeout`: `bun run src/cli.tsx e2b pause --help`, `bun run src/cli.tsx e2b swarms --help`, `bun run src/cli.tsx e2b start-stack --help`
- [ ] Lint + boundaries: `bun run lint && bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [ ] Agent starts a swarm, `swarms pause <slug>` (sandboxes report paused, API `/health` unreachable), `swarms resume <slug>` (API back to 200, agents still registered).

#### Manual Verification:
- [ ] Confirm in the E2B dashboard/billing that a paused swarm stops accruing compute and resumes with state intact.

**Implementation Note**: End of v2. Pause for manual confirmation.

---

## Appendix

- **Follow-up plans**: v1 = Phases 1–5 (recommend one PR); v2 = Phases 6–7 (persona templates, pause/auto-pause) as a second PR. If v1 is still too large for one session, split at the Phase 3/4 boundary (stack+wizard, then swarms command + logs).
- **Derail notes**:
  - The onboarding deep-link snake_case bug (`post-dashboard.tsx`, `onboard.tsx`) is live and independent — folded into Phase 4, but can ship as a standalone fix sooner.
  - `printE2BHelp` is already incomplete vs current flags (omits `--agent-role`, `--workers`, `--provider`, etc.); treat as a full rewrite, not an append, while touching it.
  - Verify-don't-assume items are embedded as pre-flight checks: `endAt` in create response (Phase 1), lead registration via entrypoint (Phase 3), envd historical-log replay + `e2b sandbox logs` scope (Phase 5), raw-HTTP `lifecycle` acceptance (Phase 7).
- **References**:
  - Draft + design/critique: `/tmp/2026-05-29-1922-e2b-swarms-cli-plan.md`
  - Runbook: `runbooks/e2b-dispatch.md`
  - E2B docs: `https://e2b.dev/docs/sandbox/persistence`, `https://e2b.dev/docs/commands/background`

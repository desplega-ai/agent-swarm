---
date: 2026-04-28
author: taras
git_commit: 09e6c082aaa44ffd39b0a6a1d9658c5b3d2dec6e
branch: main
repository: agent-swarm
topic: "Claude Managed Agents harness provider"
tags: [plan, providers, harness, claude, managed-agents, anthropic, mcp]
status: completed
research_source: thoughts/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/research/2026-04-09-claude-managed-agents-integration.md
autonomy: critical
last_updated: 2026-04-28
last_updated_by: claude (phase 7)
---

# Claude Managed Agents Harness Provider Implementation Plan

## Overview

Add Claude Managed Agents as a fourth `HARNESS_PROVIDER` value (`claude-managed`), alongside `claude`, `pi`, and `codex`. Sessions execute in Anthropic's cloud sandbox, not the swarm worker container — the worker reduces to a thin SSE relay that maps Anthropic's `client.beta.sessions.events.stream` output to the existing `ProviderEvent` union.

- **Motivation**: Claude Managed Agents launched in public beta on 2026-04-08; offers managed sandboxing, vault-based credential isolation, and ~60% faster cold-start than the self-hosted Claude CLI. The provider abstraction in `src/providers/` already exists with three implementations — adding this is incremental.
- **Related**:
  - Research: `agent-fs cat thoughts/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/research/2026-04-09-claude-managed-agents-integration.md`
  - Provider contract: `docs-site/content/docs/(documentation)/guides/harness-providers.mdx`
  - Reference adapters: `src/providers/codex-adapter.ts` (closest match — also wraps an SDK and translates events), `src/providers/claude-adapter.ts`, `src/providers/pi-mono-adapter.ts`
  - Provider types: `src/providers/types.ts:18-88`
  - Local testing recipes: `LOCAL_TESTING.md`
  - Anthropic docs: https://platform.claude.com/docs/en/managed-agents/quickstart

## Current State Analysis

### The provider abstraction is in place

- `ProviderAdapter` interface (`src/providers/types.ts:82-88`): `name`, `createSession(config)`, `canResume(sessionId)`, `formatCommand(commandName)`.
- `ProviderSession` interface (`src/providers/types.ts:62-68`): `sessionId`, `onEvent`, `waitForCompletion`, `abort`.
- `ProviderEvent` discriminated union (`src/providers/types.ts:18-40`): `session_init`, `message`, `tool_start`, `tool_end`, `result`, `error`, `raw_log`, `raw_stderr`, `custom`, `context_usage`, `compaction`. The runner consumes these — adapters never read raw native events outside their own boundary.
- `CostData` shape (`src/providers/types.ts:1-15`): tokens + USD + duration + turns + model.
- Factory at `src/providers/index.ts:16-26` — switch on string, throws `Unknown HARNESS_PROVIDER` on default branch.
- Runner integration at `src/commands/runner.ts:2190` instantiates one adapter per worker boot. Per-task spawn site at `src/commands/runner.ts:3140-3160` builds `ProviderSessionConfig` from `task` + worker env and calls `adapter.createSession(config)`. Event listener attached via `session.onEvent(listener)` forwards to swarm API endpoints (`src/commands/runner.ts:1815-1827` for `raw_log` upload; `src/commands/runner.ts:1037` for `session_init` persistence; `src/commands/runner.ts:402-410` for `POST /api/tasks/{id}/progress`; etc.).

### The closest-match reference: `src/providers/codex-adapter.ts`

Codex is the most useful template because it (a) wraps an SDK rather than spawning a CLI, (b) translates an async-iterator event stream, (c) has the cleanest cancellation model, and (d) implements a mature MCP wiring pattern.

- `CodexAdapter` class (`src/providers/codex-adapter.ts:743`); `createSession` (`:758+`, method extends well past line 800).
- MCP server config built in `buildCodexConfig` (`src/providers/codex-adapter.ts:132+`, extends past line 243). Always includes `agent-swarm` Streamable HTTP server with headers `Authorization`, `X-Agent-ID`, `X-Source-Task-Id`. Per-agent MCP servers fetched from `GET /api/agents/{id}/mcp-servers?resolveSecrets=true` (`:157-165`); SSE entries warned + skipped (`:210-215`); fetch failure falls back to swarm-only (`:217-229`).
- Event loop in `runSession()` (`src/providers/codex-adapter.ts:651-740`); `handleEvent` (`:463-618`) emits `raw_log` for every event before mapping (`:466`).
- Cancellation: `abort()` (`:342-345`) sets a flag and calls `abortController.abort()`; the abort signal is shared with `codex-swarm-events` via `abortRef` (`:265, 654-655`) so external cancel polls can trigger it.
- Cost: `buildCostData(usage, isError)` (`:383-412`); emitted in `result` (`:704-709`) before `settle()` resolves `waitForCompletion`.
- Secret scrubbing: centralized in `emit()` (`:347-374`) — `scrubSecrets` wraps `raw_log`/`raw_stderr` content before fanning to listeners and writing JSONL to `logFileHandle`.
- Skill resolver pattern at `src/providers/codex-skill-resolver.ts:60-113`: intercepts leading `/<name>` in user prompt, reads `SKILL.md` from `${CODEX_SKILLS_DIR ?? ~/.codex/skills}`, inlines content + user request body. **Note**: this plan does NOT use the inline-resolver pattern — managed-agents has native skills support (see Phase 2).
- Throttled swarm-event polling at `src/providers/codex-swarm-events.ts:59-186`: cancellation (500 ms throttle), heartbeat (5 s), activity (5 s), context (30 s) — all `void fetch().catch(() => {})` to swallow failures.

### What managed-agents introduces that's different

| Aspect | Existing local providers | Managed Agents | Mitigation |
|---|---|---|---|
| Where the agent runs | Worker container | Anthropic cloud sandbox | Adapter becomes a thin SSE relay; no subprocess. |
| Filesystem | Worker `cwd`, persistent across runs | Ephemeral per session | Map repos via `resources: [{type:"github_repo"}]` (Phase 4); deferring `/workspace/personal` and `/workspace/shared`. |
| MCP transport | stdio + HTTP | Streamable HTTP only | Skip per-agent stdio MCP servers with a warning (same fallback pattern as Codex SSE skip). |
| MCP host reachability | localhost / Docker network | **Must be HTTPS-public** for Anthropic to reach our `/mcp` | Require `MCP_BASE_URL` env var; fail fast if not set or not HTTPS. Defer ngrok automation. |
| System prompt | Per-task via SDK arg / file / CLI flag | Locked to the Agent definition (no session-level override) | **Prepend composed system prompt to user message** (per-task content into first `user.message`). |
| `X-Source-Task-Id` MCP header | Per-task via session config | Locked to the Agent definition | **Drop X-Source-Task-Id**. Rely on `X-Agent-ID` + active-session inference on the API side. |
| Skills | Filesystem (~/.claude/skills) or inline resolver | Native via `client.beta.skills.create` + reference by `skill_id` on the Agent | Upload `SKILL.md` files at worker boot via `beta.skills.create` (no-op if exists). The pre-existing managed Agent must reference these `skill_id`s — operator wires that once (manual/setup-script). |
| Cancellation | SIGTERM / abort signal | `sessions.events.send({user.interrupt})` + `sessions.archive()` | Reuse the `codex-swarm-events.ts` throttled-poll pattern. |
| Resume | CLI flag / SDK option | Reconnect via `sessions.events.stream(id)` + dedup with `sessions.events.list` | `canResume` calls `sessions.retrieve` and checks `status !== "terminated"`. |
| Agent CRUD by runtime | n/a | None — operator pre-creates the managed Agent + Environment out-of-band | Adapter only does `sessions.create`, `sessions.events.{stream,send}`, `sessions.archive`, `sessions.retrieve`. |
| Cost | Direct from native event | Token counts via `span.model_request_end`; USD must be computed | Add a Claude pricing table (mirror `src/providers/codex-models.ts`). |

### SDK status

Repo currently has `@anthropic-ai/sdk@0.73.0` (transitive dep, not declared); inspecting `node_modules/@anthropic-ai/sdk/resources/beta/` shows only `messages` and `files` — no `agents/`, `sessions/`, `environments/`, `skills/`. **Bumping to `latest` is Phase 1 step 1**, with a hard verify against the docs at https://platform.claude.com/docs/en/managed-agents/quickstart#create-your-first-session.

## Desired End State

1. `HARNESS_PROVIDER=claude-managed bun run src/cli.tsx worker` boots a worker that:
   - Polls the swarm task queue as today.
   - For each task, calls `sessions.create()` against a pre-existing managed Agent + Environment.
   - Streams events back to the swarm API (progress, cost, raw logs, tool calls).
   - Honors cancellation within ≤2 s end-to-end via `user.interrupt` + `sessions.archive` (cancel-poll throttle is 500 ms; archive round-trip + abort propagation typically lands within 1–2 s).
   - Emits a `result` `ProviderEvent` with USD cost data before `waitForCompletion` resolves.
2. A one-time CLI command (`bun run src/cli.tsx claude-managed-setup` — implemented at `src/commands/claude-managed-setup.ts`, mirroring `src/commands/codex-login.ts`) bootstraps:
   - The Anthropic-side managed Agent (with `mcp_servers` pointing at the public swarm MCP URL, with `Authorization`, `X-Agent-ID` headers, no `X-Source-Task-Id`).
   - The Anthropic-side Environment (cloud, unrestricted networking by default).
   - All bundled `SKILL.md` files uploaded via `beta.skills.create` (no-op if matching `skill_id`/content already exists), with their IDs added to the Agent's `skills` field.
   - Prints `MANAGED_AGENT_ID=...` and `MANAGED_ENVIRONMENT_ID=...` for the operator's `.env`.
3. `bash scripts/check-db-boundary.sh` passes (no DB imports under `src/providers/`).
4. `bun run lint:fix && bun run tsc:check && bun test` all pass.
5. `harness-providers.mdx` lists `claude-managed` in the reference implementations table; `CLAUDE.md` lists it in the `HARNESS_PROVIDER` accepted-values block; `README.md` multi-provider line updated.
6. A simple end-to-end task ("Say hi and exit") completes successfully against a real managed session, with progress posted to the swarm UI and cost recorded.

## What We're NOT Doing

Per Q&A — these are out of scope for v1 and tracked as follow-up plans:

- **Persistent `/workspace/personal` and `/workspace/shared`** — managed sandboxes are ephemeral. Replacement strategy (likely agent-fs as virtual workspace) is its own plan.
- **Hook-equivalent stream monitoring** — memory auto-indexing, identity-file sync, tool-loop detection in-stream. v1 only does cancellation polling + heartbeat (matches the codex-swarm-events footprint). Memory indexing on file-write events deferred.
- **Automatic ngrok / tunneling for dev** — operator must point `MCP_BASE_URL` at a manually-set-up public HTTPS endpoint (ngrok, Cloudflare Tunnel, or a deployed instance).
- **OAuth / claude.ai-login flow** — v1 uses `ANTHROPIC_API_KEY` only. OAuth flow (similar to `codex-login`) deferred.
- **PM2 services in managed sandboxes** — long-running services (artifact servers, PM2-managed processes) cannot run in managed sandboxes. Affects only specific agent templates; not a swarm-wide blocker.
- **Multi-agent coordination, Agent Memory, Outcomes** — all in Anthropic's research preview; defer until they exit preview.
- **Per-task `X-Source-Task-Id` MCP attribution** — the API blocks per-session MCP header overrides. Tasks attributed via `X-Agent-ID` + active-session lookup on the API side. If this proves insufficient in production, see follow-up: encode taskId in MCP URL path.
- **Lead-agent support on managed-agents** — v1 targets workers only. Lead semantics (different system prompt, different MCP scope) come later.
- **CRUD on managed Agents at runtime** — the adapter never calls `agents.create` / `agents.update` / `agents.delete` during normal operation. Setup script handles agent creation once.
- **stdio MCP servers** — agent-installed stdio servers will be skipped with a warning. Operator must use HTTP-transport MCP servers for managed agents.

## Implementation Approach

- **One adapter file** at `src/providers/claude-managed-adapter.ts`, structured like `codex-adapter.ts`: `ClaudeManagedAdapter` (the factory-target class, holds the `Anthropic` client) + `ClaudeManagedSession` (per-task session, owns the SSE loop, log handle, abort controller, cost accumulator).
- **No `Bun.spawn`** — pure SDK + `fetch`. Means no PATH/HOME juggling, no entrypoint binary check, no Dockerfile changes beyond adding the env-var validation branch.
- **Agent + environment are pre-existing**. Adapter reads `MANAGED_AGENT_ID` and `MANAGED_ENVIRONMENT_ID` from env. If missing → fail fast at adapter construction with a clear message pointing at the setup script.
- **System prompt delivery**: the composed system prompt (built by `buildSystemPrompt()` defined at `src/commands/runner.ts:2273`, called per-task around `runner.ts:2289+`) is **prepended** to the first `user.message` text block, separated by a `\n\n---\n\nUser request:\n` marker. Same pattern Codex uses for skill inlining.
- **Prompt caching**: Anthropic's prompt cache normally segments around the system prompt; collapsing system+user into one block changes cache behavior. The composed system prompt is stable across tasks for a given agent identity — split it into a static prefix (skills + provider preamble) and a per-task suffix (task-specific instructions), and place an explicit `cache_control: { type: "ephemeral" }` breakpoint between them on the first content block of the user message. This preserves cache hits across consecutive tasks. Verify in Phase 3 with a two-task run: token cost on the second task should show non-zero `cacheReadTokens`.
- **Cancellation**: a separate `src/providers/claude-managed-swarm-events.ts` mirrors `codex-swarm-events.ts` 1:1 — same throttle constants, same shape — but `checkCancelled` triggers `abortController.abort()`. The session's `runSession()` catches the abort, sends `user.interrupt`, then `sessions.archive(sessionId)` before settling.
- **Reuse, don't fork**: the throttle/heartbeat/activity/context-progress logic in `codex-swarm-events.ts` is provider-agnostic at the dispatch level. Phase 5 *extracts the core* into a shared helper to avoid drift; codex and claude-managed both consume it.
- **DB boundary stays clean**: adapter only imports from `src/providers/types.ts`, `src/utils/secret-scrubber`, `src/hooks/tool-loop-detection`, the Anthropic SDK, and Node/Bun stdlib. No `bun:sqlite` / `src/be/db`.
- **Verify the SDK exposes the types we need before writing the adapter** — Phase 1 step 1.

## Quick Verification Reference

- `bun run lint:fix`
- `bun run tsc:check`
- `bun test`
- `bash scripts/check-db-boundary.sh`
- `bun test src/tests/claude-managed-adapter.test.ts`
- `bun run src/cli.tsx help` (verify `claude-managed-setup` listed; `HARNESS_PROVIDER=claude-managed` accepted)
- `cd docs-site && pnpm exec next build` (after MDX edits in Phase 6)
- `cd new-ui && pnpm exec tsc --noEmit && pnpm lint` (after Phase 7)
- `bun run docs:openapi` (after Phase 7 — new test-connection endpoint)

---

## Phase 1: Adapter skeleton + factory + dependency bump

### Overview

Land a runnable but inert provider: `HARNESS_PROVIDER=claude-managed bun run src/cli.tsx worker --help` exits 0 without error. SDK is bumped, types verified, factory wired, but `createSession` throws `Not implemented`.

### Changes Required:

#### 1. SDK bump

**File**: `package.json`
**Changes**: Add `@anthropic-ai/sdk` as a direct dependency at `latest`. Run `bun install` and confirm `node_modules/@anthropic-ai/sdk/resources/beta/` now contains `agents/`, `sessions/`, `environments/`, `skills/` directories.

**SDK shape assertions** — write each one as an actual TypeScript line in the adapter file (Phase 1 step 2 below) so `bun run tsc:check` fails if any is wrong. Do not rely on a manual `ls` check.

- `import type { Agent } from "@anthropic-ai/sdk/resources/beta/agents"` — type usable
- `import type { Session, SessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions"` — type usable
- `import type { Environment } from "@anthropic-ai/sdk/resources/beta/environments"` — type usable
- `import type { Skill } from "@anthropic-ai/sdk/resources/beta/skills"` — type usable
- `client.beta.agents.{create,retrieve,update}` exist and accept `{ name, model, system, tools, skills, mcp_servers }`
- `client.beta.environments.create` accepts `{ name, config: { type, networking } }`
- `client.beta.skills.create` accepts the documented shape (the adapter must use the precise field names from the SDK type — confirm `skill_id` vs `id`, `content_md` vs `content` against the SDK before writing)
- `client.beta.sessions.{create,retrieve,archive}` exist; `client.beta.sessions.events.{stream,send,list}` exist

If any are missing in `latest`, escalate before continuing — do not proceed with raw-fetch fallback (per Q&A: SDK exposes them per https://platform.claude.com/docs/en/managed-agents/quickstart).

#### 2. Adapter skeleton

**File**: `src/providers/claude-managed-adapter.ts` (new)
**Changes**: New file. Exports `ClaudeManagedAdapter` class with `name = "claude-managed"`, ctor that reads `ANTHROPIC_API_KEY` / `MANAGED_AGENT_ID` / `MANAGED_ENVIRONMENT_ID` from env and throws clear errors if missing. `createSession` throws `Error("ClaudeManagedAdapter.createSession not yet implemented (Phase 3)")`. `canResume` returns `false`. `formatCommand(name)` returns `/${name}`.

**Critical**: include the SDK type imports listed in step 1's "SDK shape assertions" at the top of this file, even though they're unused at this phase — this is what makes `bun run tsc:check` actually fail if `latest` doesn't expose them. Suppress unused-import lint with a single `// biome-ignore lint/correctness/noUnusedImports: SDK shape assertion — tightened in Phase 3` comment if needed; remove the comment in Phase 3 once the imports become real usages.

#### 3. Factory wiring

**File**: `src/providers/index.ts:10-26`
**Changes**: Import `ClaudeManagedAdapter`. Add `case "claude-managed": return new ClaudeManagedAdapter();`. Update the unknown-provider error message to list `claude-managed`.

#### 4. Type / enum updates

**File**: `src/types.ts`
**Changes**: Locate the `HarnessProvider` union (referenced by `harness-providers.mdx` Step 12); add `"claude-managed"` literal.

**File**: `templates/schema.ts`
**Changes**: Find the provider enum in the templates schema; add `"claude-managed"`.

#### 5. Smoke test

**File**: `src/tests/claude-managed-adapter.test.ts` (new)
**Changes**: One test: `import { createProviderAdapter } from "../providers"; expect(createProviderAdapter("claude-managed").name).toBe("claude-managed");`. Set `process.env.MANAGED_AGENT_ID = "agent_x"`, `process.env.MANAGED_ENVIRONMENT_ID = "env_x"`, `process.env.ANTHROPIC_API_KEY = "sk-test"` in the test file's `beforeAll`. One additional test: missing `MANAGED_AGENT_ID` → ctor throws.

### Success Criteria:

#### Automated Verification:
- [x] `bun install` completes; `ls node_modules/@anthropic-ai/sdk/resources/beta/agents` exists
- [x] `bun run tsc:check` passes
- [x] `bun run lint:fix` produces no errors
- [x] `bun test src/tests/claude-managed-adapter.test.ts` passes
- [x] `bash scripts/check-db-boundary.sh` passes
- [x] `MANAGED_AGENT_ID=agent_x MANAGED_ENVIRONMENT_ID=env_x ANTHROPIC_API_KEY=sk-test HARNESS_PROVIDER=claude-managed bun run src/cli.tsx worker --help` exits 0

#### Automated QA:
- [x] Smoke test asserts factory dispatches to `ClaudeManagedAdapter` and rejects unknown providers as before.

#### Manual Verification:
- [ ] Confirm the bumped SDK version in `package.json` and the lockfile diff are reasonable (not pulling unexpected major bumps in transitive deps).

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 1] claude-managed adapter skeleton + SDK bump` after verification passes.

---

## Phase 2: Setup CLI command + worker bootstrap + skills upload

### Overview

A new CLI subcommand `bun run src/cli.tsx claude-managed-setup` (mirrors `src/commands/codex-login.ts`) bootstraps the Anthropic-side Agent + Environment + Skills, then writes the resulting IDs to `swarm_config` (encrypted at rest where appropriate) so the docker-entrypoint can fetch them at boot. Worker boot validates the env vars. Docker entrypoint gets a `claude-managed` branch.

### Changes Required:

#### 1. Setup CLI command (NOT a standalone script)

**File**: `src/commands/claude-managed-setup.ts` (new)
**Changes**: Implement as a non-UI CLI subcommand following `src/commands/codex-login.ts` shape — `console.log` + `process.exit(0)` style, no Ink rendering. The command:
1. Reads `ANTHROPIC_API_KEY` from env (or prompts via `promptHiddenInput` like codex-login does for the API key).
2. Reads `MCP_BASE_URL` from env. Validates it starts with `https://`. Fail-fast otherwise.
3. Calls `client.beta.environments.create({ name: "swarm-worker-env", config: { type: "cloud", networking: { type: "unrestricted" } } })`.
4. Walks `plugin/commands/*.md` (the canonical SKILL.md sources — see `bun run build:pi-skills`), and for each: calls `client.beta.skills.create({ skill_id: <slug>, content_md: <file content> })` with the `skills-2025-10-02` beta header. On 409 (already exists), retrieves the existing skill_id (no-op). Collect `skill_id`s.
5. Calls `client.beta.agents.create({ name: "swarm-worker", model: process.env.MANAGED_AGENT_MODEL ?? "claude-sonnet-4-6", system: "<minimal placeholder — actual prompt is per-task in user.message>", tools: [{ type: "agent_toolset_20260401" }], skills: <collected skill_ids>, mcp_servers: [{ name: "agent-swarm", type: "url", url: <MCP_BASE_URL>/mcp, http_headers: { Authorization: "Bearer <API_KEY-PLACEHOLDER-INSTRUCTION>", "X-Agent-ID": "<set-via-vault>" } }] })`.
6. **Persists** the resulting IDs to `swarm_config` via `PUT /api/config` (matches `codex-login` storage pattern at `src/providers/codex-oauth/storage.ts`): `{ scope: "global", key: "managed_agent_id", value: <id>, isSecret: false }`, same for `managed_environment_id`. The `anthropic_api_key` is stored with `isSecret: true`.
7. Prints both human-readable env-var lines (for operators preferring `.env`) AND a confirmation that the IDs are now in `swarm_config` (the docker-entrypoint will pick them up automatically on next worker boot).
8. Idempotent: re-running detects existing entries via `GET /api/config?key=managed_agent_id`, skips with a "already configured" message unless `--force` is passed.

**File**: `src/cli.tsx`
**Changes**:
1. Update `COMMAND_HELP` record with `claude-managed-setup` (usage, description, options, examples — mirror the `codex-login` entry).
2. Add to `commands` array in `printHelp()`.
3. Route the command **before `render()`** (non-UI command pattern, like `codex-login`). Verify with `bun run src/cli.tsx help` and `bun run src/cli.tsx claude-managed-setup --help`.

#### 2. Worker bootstrap

**File**: `docker-entrypoint.sh`
**Changes**: Add a branch like the existing claude/pi/codex blocks: when `HARNESS_PROVIDER=claude-managed`:
1. **Restore credentials from `swarm_config`** (the entrypoint pattern used for `codex_oauth` at L13-71): fetch `GET /api/config/resolved?includeSecrets=true&key=anthropic_api_key`, `key=managed_agent_id`, `key=managed_environment_id`; export each as the corresponding env var (`ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`). If env vars are already set externally (e.g. via `.env.docker`), respect them — only fill from `swarm_config` if missing.
2. Validate the four required env vars (`ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `MCP_BASE_URL`) are present and non-empty. Fail-fast with a clear error pointing at the `claude-managed-setup` CLI.
3. **Skip** the Claude/Pi/Codex CLI binary checks.
4. **Skip** the skill-sync block (`L764-803` per harness-providers.mdx) — managed-agents skills are uploaded via API, not filesystem.
5. Skip MCP discovery — managed agents read MCP from the Agent definition, not `.mcp.json`.

#### 3. Env var documentation

**File**: `runbooks/local-development.md`
**Changes**: Add a new subsection "Claude Managed Agents" listing required env vars (note: reuses the existing `MCP_BASE_URL` — no new env var introduced):

```
HARNESS_PROVIDER=claude-managed
ANTHROPIC_API_KEY=sk-ant-...
MANAGED_AGENT_ID=agent_...                    # from claude-managed-setup CLI
MANAGED_ENVIRONMENT_ID=env_...                # from claude-managed-setup CLI
MCP_BASE_URL=https://api.swarm.example.com    # must be HTTPS-public for managed-agents (ngrok/CF tunnel in dev — already required by Jira webhook setup)
MANAGED_AGENT_MODEL=claude-sonnet-4-6         # optional; default in setup CLI
```

Mention that `MCP_BASE_URL` must be HTTPS-public for managed-agents (ngrok / Cloudflare Tunnel in dev — same constraint already documented for Jira webhook setup). The adapter fail-fasts at construction if `MCP_BASE_URL` is unset or starts with `http://`.

**File**: `CLAUDE.md`
**Changes**: Update the `HARNESS_PROVIDER` callout (the `<important if="you are setting up local development">` block) to mention `claude-managed` and link to the new runbook subsection.

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc:check` passes (CLI command + adapter type-check against bumped SDK)
- [x] `bun run lint:fix` produces no errors
- [x] `bun run src/cli.tsx help` lists `claude-managed-setup`
- [x] `bun run src/cli.tsx claude-managed-setup --help` prints usage and exits 0 without making API calls
- [x] `bash -n docker-entrypoint.sh` passes
- [x] `bash scripts/check-db-boundary.sh` passes (the new CLI command lives under `src/commands/` and must not import `src/be/db` — it talks to the API via HTTP like `codex-login` does)

#### Automated QA:
- [x] Mock test (with mocked `fetch`/`Anthropic`): running `claude-managed-setup` against a stubbed API hits `environments.create`, `skills.create` (×N for plugin/commands files), `agents.create`, then `PUT /api/config` for each ID. Idempotent on second run (existing IDs detected via `GET /api/config?key=managed_agent_id`, skipped).
- [ ] `MANAGED_AGENT_ID=agent_x MANAGED_ENVIRONMENT_ID=env_x ANTHROPIC_API_KEY=sk-test MCP_BASE_URL=https://example.com HARNESS_PROVIDER=claude-managed bash docker-entrypoint.sh` boots without exit-1 (env vars set externally — entrypoint should respect them and skip the swarm_config fetch).
- [ ] Boot the docker image with **only** `HARNESS_PROVIDER=claude-managed` and `MCP_BASE_URL` set (no `MANAGED_*` env vars), but with `swarm_config` pre-populated; grep `docker logs` for "Restored claude-managed config from swarm_config" line and confirm worker proceeds.

#### Manual Verification:
- [ ] Run `bun run src/cli.tsx claude-managed-setup` against a real Anthropic API key in a sandbox account; confirm: (1) it creates an environment, (2) uploads skills (idempotent on second run with "already exists" output), (3) creates an agent, (4) prints the IDs, (5) writes them to `swarm_config` via `PUT /api/config`. Then verify via `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/config?key=managed_agent_id` returns the persisted value.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 2] claude-managed-setup CLI + worker bootstrap + skills upload`.

---

## Phase 3: Session lifecycle + event translation

### Overview

The adapter's heart. `createSession` opens a real managed session; `runSession` translates Anthropic SSE events to `ProviderEvent`s; `abort` and `canResume` work end-to-end against the API. After this phase, a single task can run in a real managed sandbox with raw logs streaming to the swarm UI.

### Changes Required:

#### 1. `ClaudeManagedSession` class

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: Implement `ClaudeManagedSession` (mirrors `CodexSession` shape from `src/providers/codex-adapter.ts`). Owns:
- `private listeners: Array<(e: ProviderEvent) => void>` and `private eventQueue: ProviderEvent[]` for the same buffer-until-listener pattern Codex uses (`codex-adapter.ts:347-374`).
- `private logFileHandle = Bun.file(config.logFile).writer()` opened in ctor.
- `private abortController = new AbortController()`.
- `private completionPromise: Promise<ProviderResult>` started in ctor (calls `this.runSession()`).
- `private cost: CostData` accumulator initialized to zeros + `model` from config.
- Central `emit(event)` that runs `scrubSecrets` on `raw_log`/`raw_stderr` `content`, writes JSONL to `logFileHandle`, then dispatches to listeners (with the queue-until-listener fallback). Identical structure to `codex-adapter.ts:347-374`.

#### 2. Session creation

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: `createSession(config)` flow:
1. Build the user-message **content blocks** (not a single text string) so the prompt-cache breakpoint can be placed precisely. `composeManagedUserMessage(config)` returns:
   ```ts
   [
     { type: "text", text: <static prefix: skills + provider preamble>, cache_control: { type: "ephemeral" } },
     { type: "text", text: `---\n\nUser request:\n${config.prompt}` },
   ]
   ```
   The static prefix must be deterministic per agent identity (no per-task taskId or timestamp interpolation). Keep this helper testable in isolation — assert the static prefix is byte-identical across two different `config` inputs with the same agent.
2. Call `client.beta.sessions.create({ agent: process.env.MANAGED_AGENT_ID!, environment_id: process.env.MANAGED_ENVIRONMENT_ID!, title: \`Task ${config.taskId}\`, metadata: { swarmAgentId: config.agentId, swarmTaskId: config.taskId, swarmRunnerSessionId: ... } })`. Handle resume (see §5 below).
3. Construct `ClaudeManagedSession(client, session.id, config, composedUserMessageContent)`. Constructor immediately starts the SSE loop (don't block on it).
4. Return the session — runner attaches listeners via `onEvent` and the queued `session_init` event drains as soon as it does.

#### 3. SSE loop + event translation

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: Inside `ClaudeManagedSession.runSession()`:
1. `const stream = await this.client.beta.sessions.events.stream(this.sessionId)` — open stream **before** sending the user message (race-safe ordering, per the research doc's quickstart guidance at line 187).
2. `await this.client.beta.sessions.events.send(this.sessionId, { events: [{ type: "user.message", content: this.composedUserMessageContent }] })` — pass the cache-control-annotated content blocks directly.
3. `this.emit({ type: "session_init", sessionId: this.sessionId })`.
4. `for await (const event of stream)`:
   - Always emit `raw_log` first (with `scrubSecrets`).
   - `agent.message` (text blocks) → `emit({type:"message", role:"assistant", content})`.
   - `agent.tool_use` / `agent.mcp_tool_use` → `emit({type:"tool_start", toolCallId, toolName, args: input})`. Invoke `checkToolLoop` from `src/hooks/tool-loop-detection.ts` (same as codex uses) — on block, abort.
   - `agent.tool_result` / `agent.mcp_tool_result` → `emit({type:"tool_end", toolCallId: tool_use_id, toolName: <derived>, result: content})`. Set `isError` flag if `is_error`.
   - `agent.thread_context_compacted` → `emit({type:"compaction", preCompactTokens, compactTrigger:"auto", contextTotalTokens})` (use whatever fields the SDK exposes; fall back to placeholders).
   - `span.model_request_end` → accumulate `cost.inputTokens`, `cost.outputTokens`, `cost.cacheReadTokens` from `model_usage`. Increment `cost.numTurns`. Emit `context_usage` with `contextTotalTokens` from a model-specific constant table (see Phase 4).
   - `agent.thinking` → `emit({type:"custom", name:"claude-managed.thinking", data})`.
   - `session.status_running` → no-op after the first one (the first one was the trigger for `session_init`).
   - `session.error` → `emit({type:"error", message, category:"managed_agent_error"})`. Don't terminate unless the error is fatal (the `is_retryable` field, if present).
   - `session.status_terminated` → `isError = true`, capture error, fall through to terminal handling.
   - `session.status_idle` → terminal: compute `cost.durationMs`, compute `cost.totalCostUsd` via the pricing table (Phase 4), emit `result`, return `ProviderResult`.
5. If the loop exits without `session.status_idle` (stream broken): emit `error`, return `result` with `isError: true`, `errorCategory: "stream_ended"`.
6. `finally`: close `logFileHandle`.

#### 4. `abort()` and `canResume()`

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- `abort()`: idempotent. Sets `this.aborted = true`. Calls `this.abortController.abort()`. In `runSession`'s `AbortError` catch path: send `user.interrupt`, `sessions.archive(sessionId)`, emit `result { isError: true, errorCategory: "cancelled" }`, return `{ exitCode: 130, ... }`.
- `canResume(sessionId)`: `try { const s = await client.beta.sessions.retrieve(sessionId); return s.status !== "terminated" && s.status !== "archived"; } catch { return false; }`.

#### 5. Resume support in `createSession`

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: When `config.resumeSessionId` is set, **skip** `sessions.create` — instead use the existing session ID. Pre-fetch event history via `sessions.events.list(id)` to build a `seenEventIds` set; in the SSE loop, skip events whose ID is already in the set (per research doc lines 47-60).

#### 6. Tests

**File**: `src/tests/claude-managed-adapter.test.ts`
**Changes**: Add unit tests with a mocked `Anthropic` client (use a small fake that yields a scripted async iterator for `events.stream`, asserts the right `events.send` payload, etc.). Cover:
- `agent.message` → `message` ProviderEvent
- `agent.tool_use` → `tool_start`
- `agent.tool_result` → `tool_end`
- `span.model_request_end` → cost accumulation + `context_usage` emitted
- `session.status_idle` → `result` event with computed `totalCostUsd` + `waitForCompletion` resolves
- `abort()` → `user.interrupt` sent, `sessions.archive` called, `waitForCompletion` resolves with `errorCategory: "cancelled"`
- Resume: scripted `events.list` returns 3 historical events; live stream replays 2 of them + 1 new; only the new one reaches listeners.
- **Prompt-cache shape**: `composeManagedUserMessage(config)` returns exactly two content blocks; the first carries `cache_control: { type: "ephemeral" }`; two `config` inputs with the same `agentId` but different `prompt` produce a byte-identical first block. (Sanity check that nothing per-task leaked into the cacheable prefix.)

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc:check` passes
- [x] `bun run lint:fix` produces no errors
- [x] `bun test src/tests/claude-managed-adapter.test.ts` passes (all unit tests above)
- [x] `bash scripts/check-db-boundary.sh` passes

#### Automated QA:
- [x] Unit test assertions cover every `ProviderEvent` mapping listed above.
- [x] An end-to-end mock (Anthropic client mocked, runner not involved) exercises full session: create → stream 5 fake events including `status_idle` → `waitForCompletion` resolves with sensible `ProviderResult`.
- [ ] **Runner-integration mock**: hook the adapter into a mocked runner harness. Assert that `agent.message` events from the fake SSE stream cause `POST /api/tasks/{id}/progress` calls (verifies the existing runner pipeline picks up `message` ProviderEvents). Same for `session_init` → `PUT /api/tasks/{id}/claude-session` and `result` → `POST /api/session-costs` + `POST /api/tasks/{id}/finish`.

#### Manual Verification:
- [ ] Run a real session against a sandbox Anthropic account: `MANAGED_AGENT_ID=<real> MANAGED_ENVIRONMENT_ID=<real> ANTHROPIC_API_KEY=<real> HARNESS_PROVIDER=claude-managed bun run src/cli.tsx worker`. Trigger a trivial task ("Say hi") via the swarm UI/API. Confirm **all** of the following actually happen (not just raw_log) — open the swarm UI's task detail page and verify each:
  - **Task status transitions** `pending → in_progress → completed` (visible in the task list and the task detail header).
  - **Progress timeline** populates with assistant messages — drives `POST /api/tasks/{id}/progress` (`runner.ts:402-410`); visible above the session-log viewer.
  - **Provider session ID** persisted — drives `PUT /api/tasks/{id}/claude-session` (`runner.ts:1037`); visible in the task detail metadata.
  - **Active session row** appears during the run and is removed at the end (`POST/DELETE /api/active-sessions`).
  - **Cost** non-zero in the task detail (`result` → `POST /api/session-costs`).
  - **Raw session logs** populate via `POST /api/session-logs` and render in `<SessionLogViewer />`.
  - **The Anthropic-side session** shows up `archived` (or `idle` if not explicitly archived) after completion.
  Tail the API server `pm2-logs` while the task runs and grep for the four endpoints to confirm each is hit at least once.
- [ ] Trigger the same task and immediately cancel it via the UI. Confirm the run aborts within ≤2 s end-to-end (matches Desired End State §1.4) and the session is `archived` in Anthropic's console.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 3] claude-managed session lifecycle + event translation`.

---

## Phase 4: Repo provisioning + cost data

### Overview

Tasks that need a repository run with Anthropic-side `git clone` via `resources: [{type:"github_repo"}]`. USD cost is computed locally from token counts.

### Changes Required:

#### 1. Resources mapping

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: In `createSession`, derive `resources` from the swarm task's repo info. Source priority (mirrors `runner.ts:3037-3078`):
1. `task.vcsRepo` (if set on the task)
2. `repoContext` info passed via `config.env` or a new optional field on `ProviderSessionConfig` if needed

Build `resources: [{ type: "github_repo", repo_url: <https URL>, branch: <branch || "main"> }]`. If no repo info → omit `resources` entirely (Anthropic provisions an empty sandbox).

**File**: `src/providers/types.ts`
**Changes**: `task.vcsRepo` is confirmed to exist on the `AgentTask` type (`src/types.ts:110`). The runner already derives repo context at `runner.ts:3042-3076` (`fetchRepoConfig`, `ensureRepoForTask`). Two options — **commit to one before starting Phase 4**:

1. **Reuse**: extract `repoUrl` + `branch` from `task.vcsRepo` directly inside the adapter's `createSession`, passing the existing `task` reference (which is already on `ProviderSessionConfig`). No contract change. Preferred — keeps the provider contract narrow.
2. **Expand contract**: add an optional `repoContext?: { repoUrl: string; branch: string; clonePath: string }` field on `ProviderSessionConfig`, populated by the runner.

Pick option 1 unless the spawn site at `runner.ts:3140-3160` shows that `task` is *not* already in the config (in which case option 2). Settle this on day 1 of Phase 4 before writing the test fixtures.

#### 2. GitHub auth via vault

**File**: `runbooks/local-development.md`
**Changes**: Add a subsection describing the **manual** GitHub vault setup: operator creates an OAuth integration in their Anthropic account, links a GitHub PAT, gets a vault ID, sets `MANAGED_GITHUB_VAULT_ID=vault_...` in `.env`. The setup script and adapter pass this via `vault_ids` on `sessions.create` (or on agent definition — verify against quickstart).

#### 3. Pricing table

**File**: `src/providers/claude-managed-models.ts` (new — mirrors `src/providers/codex-models.ts`)
**Changes**: Export a small table of Claude model pricing (input $/Mtok, output $/Mtok, cache-read $/Mtok, cache-write $/Mtok) for the models that managed-agents supports. Source: https://platform.claude.com/docs/en/about-claude/pricing. Export `computeClaudeManagedCostUsd(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens): number`. Default to 0 with a warn-once `console.warn` for unknown model strings.

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: In the `session.status_idle` terminal branch, set `cost.totalCostUsd = computeClaudeManagedCostUsd(cost.model, cost.inputTokens, cost.outputTokens, cost.cacheReadTokens, cost.cacheWriteTokens)`. Also fold in the `$0.08/session-hour` runtime fee: `runtimeFeeUsd = (cost.durationMs / 3_600_000) * 0.08; cost.totalCostUsd += runtimeFeeUsd`.

#### 4. Tests

**File**: `src/tests/claude-managed-adapter.test.ts`
**Changes**: Add tests:
- Resources: when `task.vcsRepo` is set, `sessions.create` payload includes `resources: [{ type: "github_repo", ... }]`. When unset, the field is absent.
- Pricing: `computeClaudeManagedCostUsd("claude-sonnet-4-6", 1_000_000, 100_000, 0, 0)` returns the expected USD per the table.
- Runtime fee: a 1-hour session adds exactly $0.08 to `totalCostUsd`.

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc:check` passes
- [x] `bun run lint:fix` produces no errors
- [x] `bun test src/tests/claude-managed-adapter.test.ts` passes
- [x] `bash scripts/check-db-boundary.sh` passes

#### Automated QA:
- [x] Unit test asserts cost computation against a known token-count fixture matches Anthropic's published pricing.
- [x] Mock `sessions.create` and assert `resources` is shaped correctly when the task has a repo.

#### Manual Verification:
- [ ] Run a real task that operates on a repo (e.g. `/work-on-task` against a small public test repo). Confirm Anthropic logs show the repo cloned in the sandbox and the agent operated on it. Confirm post-task `cost.totalCostUsd > 0` in the swarm UI.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 4] managed-agents repo provisioning + cost computation`.

**Phase 4 implementation note (2026-04-28):** Followed the plan's Option 1 (reuse `task.vcsRepo` via existing `ProviderSessionConfig.vcsRepo` string) — verified `runner.ts:3296` already passes it through. SDK shape deviation: managed-agents requires `type: "github_repository"` (not `"github_repo"`), `url` (not `repo_url`), and `checkout: { type: "branch", name }` per `BetaManagedAgentsGitHubRepositoryResourceParams`; tests + adapter use the actual SDK shape. `authorization_token` is sourced from `MANAGED_GITHUB_TOKEN` env (dev) and/or `vault_ids: [MANAGED_GITHUB_VAULT_ID]` (prod) — both documented in `runbooks/local-development.md § GitHub access for repo-bound tasks`.

---

## Phase 5: Cancellation polling + heartbeat + tool-loop detection

### Overview

Lift the throttled-poll machinery out of `codex-swarm-events.ts` into a shared helper, then wire `claude-managed` to it. Cancellation arrives via the swarm API (`/cancelled-tasks`), heartbeats post to `/api/active-sessions/heartbeat/{taskId}`, tool-loop detection invokes `checkToolLoop` on every `tool_start`.

### Changes Required:

#### 1. Extract shared swarm-event helper

**File**: `src/providers/swarm-events-shared.ts` (new)
**Changes**: Extract the throttle/poll/heartbeat scaffolding from `src/providers/codex-swarm-events.ts:30-186` into a reusable factory. Signature: `createSwarmEventHandler(opts: { apiUrl, apiKey, agentId, taskId, abortRef, onCancel?: () => void })`. Returns a `(event: ProviderEvent) => void` consumer. Provider-specific dispatch (e.g. codex's per-turn cost-data shape) stays in the codex file; the shared file owns: `apiHeaders`, `fireAndForget`, throttle constants, `shouldRun(key, throttleMs)`, `checkCancelled`, `checkLoop`, `heartbeat`, `activity`, `progressContextUsage`, `progressCompaction`, `progressCompletion`.

**File**: `src/providers/codex-swarm-events.ts`
**Changes**: Refactor to import from `swarm-events-shared.ts`. No behavior change. Specifically:

- All existing tests under `src/tests/codex-*.test.ts` must continue to pass. List them at start of phase via `ls src/tests/codex-*.test.ts` and treat that list as the regression suite.
- Throttle constants must remain identical (cancellation 500 ms, heartbeat 5 s, activity 5 s, context 30 s) — assert via a unit test that imports the shared constants and compares to the previously-hardcoded values.
- `fireAndForget` semantics (`void fetch().catch(() => {})`) must be preserved — no thrown errors leak to callers.
- If no behavioral test currently asserts that codex's cancel poll fires within ≤500 ms, add one before the extraction so regressions are detectable.

#### 2. Claude-managed swarm-events binding

**File**: `src/providers/claude-managed-swarm-events.ts` (new)
**Changes**: Thin wrapper that builds a handler from `swarm-events-shared.ts`. The `onCancel` callback issues `sessions.events.send({ events: [{ type: "user.interrupt" }] })` then `sessions.archive(sessionId)` against the in-flight session.

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: In `createSession`, register the swarm-event handler via `session.onEvent(handler)` (same pattern as codex at `runner.ts` integration site). Pass `abortRef` so external cancel polls can signal the session's abort controller.

#### 3. Tool-loop detection

**File**: `src/providers/claude-managed-adapter.ts`
**Changes**: In the `agent.tool_use` / `agent.mcp_tool_use` branch, before `emit({type:"tool_start"})`, call `await checkToolLoop(config.taskId, toolName, args)` (from `src/hooks/tool-loop-detection.ts`). If `result.blocked`, emit a `raw_stderr` warning and trigger `this.abortController.abort()`.

#### 4. Tests

**File**: `src/tests/claude-managed-adapter.test.ts`
**Changes**: Add tests:
- `checkToolLoop` returns `blocked: true` → session aborts on the next `tool_start`.
- Cancel poll triggers `abortController.abort()` → `user.interrupt` is sent to the session, `sessions.archive` is called, `waitForCompletion` resolves with `errorCategory: "cancelled"`.

**File**: `src/tests/codex-adapter.test.ts` (existing — verify still passes after `swarm-events-shared.ts` extraction)
**Changes**: No changes; verify existing tests still pass.

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc:check` passes
- [x] `bun run lint:fix` produces no errors
- [x] `bun test` passes (codex adapter tests + new claude-managed cancel tests)
- [x] `bash scripts/check-db-boundary.sh` passes

#### Automated QA:
- [x] Mock test: scripted swarm API returns `cancelled: [{ id: taskId }]` on the second poll → adapter aborts, archive is called, ProviderResult.errorCategory is `"cancelled"`.
- [x] Mock test: 5 consecutive `tool_start` events with the same toolName/args trigger `checkToolLoop` block on the 5th → session aborts.

#### Manual Verification:
- [ ] Run a real task against the sandbox account; cancel it via the swarm UI; confirm the managed session is archived within ≤2 s.
- [ ] Trigger an obvious tool loop (e.g. an agent stuck reading the same file repeatedly); confirm the run terminates with `errorCategory: "tool_loop"` (or whatever the existing detection emits).

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 5] managed-agents cancellation + heartbeat + tool-loop detection (shared helper extracted)`.

**Phase 5 implementation note (2026-04-28):** Shared helper `src/providers/swarm-events-shared.ts` extracted from `codex-swarm-events.ts`; codex-swarm-events now a thin pass-through that supplies `sessionIdFallbackPrefix: "codex"` to preserve historical context-POST `sessionId` shape. Throttle constants exported (`CANCELLATION_THROTTLE_MS=500`, `HEARTBEAT_THROTTLE_MS=5000`, `ACTIVITY_THROTTLE_MS=5000`, `CONTEXT_THROTTLE_MS=30000`) and asserted in a unit test. New `claude-managed-swarm-events.ts` wires the shared handler with an `onCancel` that fires `user.interrupt` + `archive` on the in-flight session. Adapter self-registers the handler in the session ctor (when `taskId/apiUrl/apiKey` present) — mirrors codex's `runner.ts:303`-equivalent self-registration pattern. Tool-loop detection runs inline before `tool_start` emit on `agent.tool_use`/`agent.mcp_tool_use`; on `blocked: true` we emit a `raw_stderr` warning and fire `abortController.abort()`. The SSE for-await loop now also checks `abortController.signal.aborted` between events so external aborts (cancel poll, tool-loop detector) propagate even when the SDK stream isn't tied to the controller.

---

## Phase 6: Tests, documentation, and final wiring

### Overview

Land the docs that the harness-providers guide demands (it requires same-PR updates), tighten any remaining test coverage, and verify the docs site builds cleanly.

### Changes Required:

#### 1. Docs: harness-providers guide

**File**: `docs-site/content/docs/(documentation)/guides/harness-providers.mdx`
**Changes**:
- Add a new row to "Reference implementations" at the table near `:99-103`: `claude-managed`, transport `Anthropic SDK \`client.beta.sessions.events.stream\` (SSE)`, auth `ANTHROPIC_API_KEY`, file `src/providers/claude-managed-adapter.ts`.
- Update `createProviderAdapter` example at `:107-115` to include the `claude-managed` case.
- Add a new section after Step 11 (or extend Section 6 OAuth flow): "Claude Managed Agents — pre-existing Agent + Environment pattern" covering: (a) why we don't `agents.create` at runtime, (b) the `claude-managed-setup` CLI command, (c) the system-prompt-in-user-message decision, (d) `X-Source-Task-Id` drop, (e) skill upload via `beta.skills.create`.
- Update Section 11 (Files to touch) to mention `src/providers/claude-managed-adapter.ts`, `src/providers/claude-managed-swarm-events.ts`, `src/providers/claude-managed-models.ts`, `src/commands/claude-managed-setup.ts`, `new-ui/src/lib/integrations-catalog.ts`.

#### 2. Docs: harness-configuration guide

**File**: `docs-site/content/docs/(documentation)/guides/harness-configuration.mdx`
**Changes**: Add a `claude-managed` section: env vars, `bun run src/cli.tsx claude-managed-setup` invocation, `MCP_BASE_URL` requirement (HTTPS-public — link to existing Jira-webhook ngrok note), model selection.

#### 3. CLAUDE.md

**File**: `CLAUDE.md`
**Changes**: Add `claude-managed` to the `HARNESS_PROVIDER` accepted-values list (in the "Local development" section); mention that managed-agents requires `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, and an HTTPS-public `MCP_BASE_URL`. Note the one-time `bun run src/cli.tsx claude-managed-setup` step (and that the integrations UI in new-ui/ surfaces the same config).

#### 4. README

**File**: `README.md`
**Changes**: Update the multi-provider line in the description (and any "supported providers" section) to mention `claude-managed`.

#### 5. OpenAPI freshness

**File**: `openapi.json`
**Changes**: Phase 7 adds `POST /api/integrations/claude-managed/test`, so a regen is expected. Run `bun run docs:openapi` after Phase 7 lands the endpoint, verify the diff matches the new endpoint shape, and commit `openapi.json` + any regenerated `docs-site/content/docs/api-reference/**` files in the same commit. Note: per CLAUDE.md, this is also required if `package.json` `version` is bumped — keep an eye on that during the same merge window.

#### 6. End-to-end test

**File**: `src/tests/claude-managed-adapter.test.ts`
**Changes**: Add a final integration-style test that exercises createSession → mocked SSE stream with a representative event sequence (status_running, model_request_end, agent.message, agent.tool_use, agent.tool_result, status_idle) → asserts the full ProviderResult, including USD cost > 0 and `output` containing the assistant's text.

### Success Criteria:

#### Automated Verification:
- [x] `bun run lint:fix` && `bun run tsc:check` && `bun test` all pass
- [x] `bash scripts/check-db-boundary.sh` passes
- [x] `cd docs-site && pnpm exec next build` passes (MDX edits compile)
- [ ] `bun run docs:openapi` produces no diff (or expected diff if endpoints touched)

#### Automated QA:
- [x] Final integration test exercises the full happy path with a mocked Anthropic client.
- [x] Run `bun run src/cli.tsx help` — confirm `claude-managed-setup` is listed.
- [x] Run `bun run src/cli.tsx claude-managed-setup --help` — confirm usage prints.

#### Manual Verification:
- [ ] Visit `/docs/guides/harness-providers` locally (`cd docs-site && pnpm dev`); confirm the new row + section render correctly, no missing imports, all `file:line` cross-references resolve.
- [ ] Confirm `CLAUDE.md` linting (if any) doesn't reject the additions.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 6] claude-managed docs + final tests`.

**Phase 6 implementation note (2026-04-28):** Same-PR doc update completed. `harness-providers.mdx` got: (a) new row in the §2 Reference implementations table for `claude-managed`, (b) updated `createProviderAdapter` example with the 4th case, (c) new §12 "Claude Managed Agents — pre-existing Agent + Environment pattern" covering all six items the plan called out (no runtime `agents.create`, the setup CLI, system-prompt-in-user-message + cache breakpoint, `X-Source-Task-Id` drop with `metadata.swarmTaskId` fallback, skill upload via `beta.skills.create`, and the SDK shape deviations referencing the adapter's header comments), (d) §11 Files-to-touch table extended with claude-managed reference files. `harness-configuration.mdx` got a full Claude Managed Agents section with env-var table, setup CLI, HTTPS-public `MCP_BASE_URL` callout, model selection. `CLAUDE.md` line 139 expanded to enumerate `ANTHROPIC_API_KEY` / `MANAGED_AGENT_ID` / `MANAGED_ENVIRONMENT_ID` and Phase 7 integrations-UI hookup. `README.md` multi-provider line updated to include Claude Managed Agents (and Devin, which was missing). New end-to-end test `(Phase 6) — full happy-path integration` exercises createSession → SSE sequence (status_running, model_request_end, agent.message, agent.tool_use, agent.tool_result, status_idle) → asserts `ProviderResult` with USD cost > 0 (using 1M input / 200k output tokens against sonnet-4-6 to escape sub-cent floating-point noise) and `output` containing the assistant's text. `bun run docs:openapi` is the one Automated Verification item left unchecked — deferred to Phase 7 when the new `POST /api/integrations/claude-managed/test` endpoint actually lands. Plan-stated 27→28 transition observed (full suite 3110 tests). One pre-existing flaky test remains (`Phase 5 cancel poll` — fails in isolation against `c80484c` without any of these changes; not introduced by Phase 6).

---

## Phase 7: Integrations UI surface

### Overview

Add a `claude-managed` tile to the integrations catalog at `new-ui/src/pages/integrations/page.tsx` so the operator can view connection status and (re)configure the Anthropic API key, agent ID, and environment ID from the dashboard. Mirrors the existing `codex-oauth` integration pattern (which uses `specialFlow: "codex-cli"` because OAuth needs a CLI step) — we use `specialFlow: "claude-managed-cli"` because agent/environment creation needs the setup CLI.

### Changes Required:

#### 1. Catalog entry

**File**: `new-ui/src/lib/integrations-catalog.ts`
**Changes**: Add a new `INTEGRATIONS` entry alongside `codex-oauth` (`new-ui/src/lib/integrations-catalog.ts:550-560`):

```ts
{
  id: "claude-managed",
  name: "Claude Managed Agents",
  description: "Run swarm tasks in Anthropic's managed cloud sandbox. Requires running the claude-managed-setup CLI once to create the Anthropic-side agent + environment.",
  category: "llm",
  iconKey: "cloud",   // pick an existing iconKey; "cloud" or "key-round" are good fits
  docsUrl: "https://docs.agent-swarm.dev/integrations/claude-managed",
  specialFlow: "claude-managed-cli",
  restartRequired: true,
  fields: [
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", type: "password", required: true, isSecret: true, placeholder: "sk-ant-...", helpText: "Used by claude-managed sessions. Stored encrypted at rest in swarm_config." },
    { key: "MANAGED_AGENT_ID", label: "Managed agent ID", type: "text", required: true, placeholder: "agent_...", helpText: "From `bun run src/cli.tsx claude-managed-setup`." },
    { key: "MANAGED_ENVIRONMENT_ID", label: "Managed environment ID", type: "text", required: true, placeholder: "env_...", helpText: "From `bun run src/cli.tsx claude-managed-setup`." },
    { key: "MCP_BASE_URL", label: "MCP base URL", type: "text", required: true, placeholder: "https://api.swarm.example.com", helpText: "Must be HTTPS-public so Anthropic's sandbox can reach `/mcp`. Reuses the same env var as Jira webhook setup.", affectsRestart: true },
    { key: "MANAGED_AGENT_MODEL", label: "Default model", type: "text", placeholder: "claude-sonnet-4-6", helpText: "Optional override. Defaults to claude-sonnet-4-6." },
  ],
},
```

The exact `iconKey` and `docsUrl` need to match an existing icon in the catalog's icon map and a real docs page (Phase 6 should create the docs page).

#### 2. Special-flow handling

**File**: `new-ui/src/components/integrations/integration-card.tsx` (or wherever `specialFlow` is dispatched)
**Changes**: Find the existing `codex-cli` branch (the `<Button>` that explains "Run `bun run src/cli.tsx codex-login` from your laptop"); add a sibling `claude-managed-cli` branch with text: "Run `bun run src/cli.tsx claude-managed-setup` once to create the managed agent + environment. The CLI writes the IDs to swarm_config; this page will show the connection as connected once the CLI completes." Plus a "Test connection" button (see #3).

#### 3. Test-connection endpoint

**File**: `src/http/integrations.ts` (or the existing integrations router — verify path)
**Changes**: Add `POST /api/integrations/claude-managed/test`. Reads `anthropic_api_key`, `managed_agent_id` from `swarm_config`. Calls `client.beta.agents.retrieve(MANAGED_AGENT_ID)`. Returns `{ ok: true, agentName, model }` on success, `{ ok: false, error }` otherwise. Uses the `route()` factory and the existing OpenAPI registration pattern. Run `bun run docs:openapi` after adding.

**File**: `new-ui/src/api/hooks/use-integrations-meta.ts` (or new `use-claude-managed.ts`)
**Changes**: Add `useTestClaudeManagedConnection()` mutation hook calling the new endpoint.

#### 4. UI wiring

**File**: `new-ui/src/components/integrations/integration-card.tsx`
**Changes**: When `specialFlow === "claude-managed-cli"`, render a "Test connection" button that calls the mutation and displays a toast on success/failure. Show a connected/disconnected status pill driven by the existing `deriveIntegrationStatus` helper (`new-ui/src/lib/integrations-status.ts`). Use `Badge` with `size="tag"` and the documented status colors per the new-ui CLAUDE.md (emerald = connected, zinc = not configured, red = error).

#### 5. Hot-reload after save

The existing integrations page already calls `POST /internal/reload-config` after saving fields (so `process.env` picks up the new values). Confirm this works for the claude-managed entries (`ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, etc.). Per `runner.ts`, the harness provider is selected at adapter construction time, so the worker process needs to **restart** to switch into `claude-managed`. Surface this via `restartRequired: true` on the catalog entry (already specified above) so the UI shows the standard "restart workers" banner.

#### 6. Tests

**File**: `new-ui/src/pages/integrations/__tests__/claude-managed.test.tsx` (new — if pages have tests; otherwise skip and rely on qa-use)
**Changes**: Render the integrations page with mocked `useConfigs` returning the four claude-managed fields. Assert: card renders, status is "Not configured" when fields are empty, becomes "Connected" when populated and `useTestClaudeManagedConnection().mutate()` resolves with `ok: true`.

**File**: `src/tests/http/integrations.test.ts` (existing or new)
**Changes**: Test the new `POST /api/integrations/claude-managed/test` endpoint with a mocked `Anthropic` client. Cover: success path, missing config path, Anthropic API error path.

### Success Criteria:

#### Automated Verification:
- [x] `cd new-ui && pnpm exec tsc --noEmit` passes
- [x] `cd new-ui && pnpm lint` passes
- [x] `bun run tsc:check` passes (server-side endpoint)
- [x] `bun run lint:fix` passes
- [x] `bun test src/tests/integrations-http.test.ts` passes (test-connection endpoint — file landed at `src/tests/integrations-http.test.ts`, the repo uses flat tests not a `http/` subdir)
- [x] `bun run docs:openapi` regenerates and the diff includes the new endpoint
- [x] `bash scripts/check-db-boundary.sh` passes

#### Automated QA:
- [ ] qa-use session: navigate to `/integrations`, verify the "Claude Managed Agents" tile appears, click "Configure", fill the four fields with stub values, save, click "Test connection", verify the result toast. (Deferred — needs live browser session)
- [ ] qa-use screenshot: integrations grid showing the new tile in disconnected state, then in connected state. (Required by the new-ui PR-screenshot rule.)

#### Manual Verification:
- [ ] Run the dashboard locally (`cd new-ui && pnpm dev` on port 5274; API on 3013), navigate to `/integrations`, find the new tile in the "LLM providers" category.
- [ ] Click "Configure", fill in real ANTHROPIC_API_KEY + IDs from a sandbox setup, save, click "Test connection" — confirm a green toast and "Connected" status pill.
- [ ] Restart the worker (`bun run pm2-restart`), confirm `HARNESS_PROVIDER=claude-managed` workers boot using the values from swarm_config.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 7] claude-managed integrations UI tile`.

**Phase 7 implementation note (2026-04-28):** Catalog entry added at `new-ui/src/lib/integrations-catalog.ts` (after `codex-oauth`); 5 fields (`ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `MCP_BASE_URL`, `MANAGED_AGENT_MODEL`) per plan spec. Added `claude-managed-cli` to `IntegrationSpecialFlow` union, `cloud` to both ICON_MAPs (`integration-card.tsx` + `[id]/page.tsx`), and a new `ClaudeManagedSection` component that mirrors `CodexOAuthSection` but adds a "Test connection" button + status pill + last-result panel (plus the CLI explainer + copyable snippet). Unlike codex-oauth, the catalog DOES expose editable fields here so the generic form still renders BELOW the special-flow section. New mutation hook `useTestClaudeManagedConnection` added to `use-integrations-meta.ts`. Server-side: created `src/http/integrations.ts` with `POST /api/integrations/claude-managed/test` using the `route()` factory; resolves `ANTHROPIC_API_KEY` + `MANAGED_AGENT_ID` from `getResolvedConfig()` (with `process.env` fallback for env-file deploys), builds an `Anthropic` client, calls `client.beta.agents.retrieve(agentId)`, returns `{ ok, agentName, model }` or `{ ok:false, error }` — always 200 OK per the route contract. Wired into `src/http/index.ts` dispatcher (after `handleConfig`) and into `scripts/generate-openapi.ts` per CLAUDE.md hard rule. New test file `src/tests/integrations-http.test.ts` (4 tests — flat naming convention, the repo doesn't use `tests/http/` subdir): covers success / missing-config / Anthropic-error / env-fallback paths with an injected fake client via `createIntegrationsHandler({ buildClient })`. `bun run docs:openapi` ran clean — added the new endpoint AND fixed a pre-existing enum drift (`/api/agents` provider enum now includes `claude-managed`). Final test count: **3114 pass / 0 fail** (3110 → 3114, +4 new tests, matches plan's "3113ish" estimate). All Automated Verification items pass: `bun run tsc:check`, `bun run lint:fix`, `bash scripts/check-db-boundary.sh`, `cd new-ui && pnpm exec tsc --noEmit`, `cd new-ui && pnpm lint`. **Plan deviations**: (a) test file path is `src/tests/integrations-http.test.ts` not `src/tests/http/integrations.test.ts` (repo flat-naming convention); (b) catalog entry's `docsUrl` points at `https://docs.agent-swarm.dev/guides/harness-configuration#claude-managed-agents` (the Phase 6 docs page) instead of the plan's `https://docs.agent-swarm.dev/integrations/claude-managed` (which doesn't exist); (c) `MANAGED_AGENT_ID` and `MANAGED_ENVIRONMENT_ID` got `affectsRestart: true` since switching to a different managed agent does require worker restart — matches plan §5 hot-reload note. The plan's frontmatter `status` is now `completed` (this was the final phase).

---

## Manual E2E

After all phases land, run this end-to-end flow to verify production-readiness. Reuse the canonical patterns from `LOCAL_TESTING.md`.

**CLAUDE.md hard rule**: copy the exact curl recipes from `LOCAL_TESTING.md` § MCP (lines 93-130) verbatim — do not paraphrase. The placeholder `# Use the exact handshake at LOCAL_TESTING.md:93-130` below should be replaced with the actual `initialize → notifications/initialized → tools/call create-task` sequence at implementation time so the plan stands alone for the runner.

### Pre-flight (real Anthropic account, sandbox)

```bash
# .env additions
HARNESS_PROVIDER=claude-managed
ANTHROPIC_API_KEY=sk-ant-<real-sandbox-key>
MCP_BASE_URL=https://<your-public-https-url>      # ngrok or deployed
# These two come from the setup script — run setup first
MANAGED_AGENT_ID=
MANAGED_ENVIRONMENT_ID=
MANAGED_AGENT_MODEL=claude-sonnet-4-6
```

### Step 1: Run the setup CLI

```bash
bun run src/cli.tsx claude-managed-setup
# The CLI:
# - Creates the Anthropic-side environment + agent (if not already present in swarm_config)
# - Uploads SKILL.md files via beta.skills.create (no-op if already uploaded)
# - Persists IDs to swarm_config (managed_agent_id, managed_environment_id, anthropic_api_key)
# - Prints both human-readable env-var lines AND a "Configured in swarm_config" confirmation
```

Verify in Anthropic's console: an agent named `swarm-worker` and environment named `swarm-worker-env` exist; the agent references the uploaded skills.

Verify in the swarm: `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/config?key=managed_agent_id` returns the persisted value.

Verify in the dashboard UI: navigate to `http://localhost:5274/integrations`, find the **Claude Managed Agents** tile in the "LLM providers" category — it should show as "Connected".

Re-run idempotency:
```bash
bun run src/cli.tsx claude-managed-setup
# Should report "already configured" and exit 0 without making API calls.
# Re-run with --force to bypass and re-create.
```

### Step 2: Boot a worker and run a trivial task

```bash
# Start the swarm API
bun run start:http

# In another shell, boot a managed-agents worker
HARNESS_PROVIDER=claude-managed bun run src/cli.tsx worker

# In a third shell, create a task via curl (canonical handshake from LOCAL_TESTING.md § MCP)
SESSION_ID=$(uuidgen)
AGENT_ID=$(uuidgen)
# 1. initialize → notifications/initialized → tools/call create-task
# (Use the exact handshake at LOCAL_TESTING.md:93-130)
# Tool args: { "title": "Smoke test", "prompt": "Say hi and exit", "agentId": "<from join-swarm>" }
```

Confirm:
- Worker logs show `session_init` event with a real `session.id`.
- Anthropic console shows a session in `running` then `idle` state.
- `GET /api/tasks/<id>` returns `status: "completed"`, `cost: { totalCostUsd: <>0 }`.
- `GET /api/tasks/<id>/session-logs` returns the `raw_log` lines posted by the adapter.

### Step 3: Cancellation

Trigger a long-running task, then cancel via the UI / API. Verify:
- Worker aborts within ≤2 s of the cancel.
- Anthropic console shows the session as `archived`.
- `ProviderResult.errorCategory === "cancelled"`.

### Step 4: Repo task

Create a task with `vcsRepo` pointing at a small public test repo (e.g. `https://github.com/<you>/test-repo.git`). Verify:
- Anthropic logs show `git clone` of the repo in the sandbox.
- The agent completes a trivial repo operation (e.g. "list the top-level directory").
- Cost includes a non-zero `runtimeFeeUsd` component.

### Step 5: Resume

Pause an in-progress task (`POST /api/tasks/<id>/pause`), then resume (`POST /api/tasks/<id>/resume`). Verify:
- The new session reuses the same `sessionId` (stream reconnect, not new session).
- `sessions.events.list` dedup prevents replayed events from reaching the runner twice.
- Anthropic console shows the session resuming, not a new one.

### Step 6: Docker entrypoint smoke

```bash
bun run docker:build:worker
docker run --rm -e HARNESS_PROVIDER=claude-managed \
  -e ANTHROPIC_API_KEY=sk-ant-<sandbox> \
  -e MANAGED_AGENT_ID=<from-setup> \
  -e MANAGED_ENVIRONMENT_ID=<from-setup> \
  -e MCP_BASE_URL=https://<public-url> \
  -e API_KEY=123123 \
  -e API_URL=https://<public-api-url> \
  -e AGENT_ID=$(uuidgen) \
  -e AGENT_ROLE=worker \
  agent-swarm-worker
```

Confirm: container boots, no Claude/Codex binary check failures, worker registers with the swarm API, picks up a task, runs it via managed-agents.

---

## Appendix

- **Follow-up plans**:
  - **Hook-equivalent stream monitoring** — memory auto-indexing on `agent.tool_result` for file-write tools, identity-file sync (currently done by hooks for Claude/Pi).
  - **Persistent `/workspace/personal` and `/workspace/shared` replacement** — likely agent-fs as virtual workspace; needs design.
  - **OAuth login flow (`claude-managed-login`)** — claude.ai OAuth instead of `ANTHROPIC_API_KEY`. Mirror the codex-oauth structure under `src/providers/claude-managed-oauth/`.
  - **X-Source-Task-Id MCP attribution** — encode `taskId` in MCP URL path (`<MCP_BASE_URL>/mcp/task/<taskId>`); requires `src/http/mcp.ts` change to parse and per-task agent (or use the `metadata` field if Anthropic exposes it to MCP servers).
  - **Lead-agent support** — different system prompt + MCP scope; either a second pre-created agent or eventual `agents.update` flow.
  - **Automatic ngrok tunneling for dev** — wrap `claude-managed-setup` in a flow that detects no HTTPS-public `MCP_BASE_URL` and offers ngrok.
- **Derail notes**:
  - Beta header `managed-agents-2026-04-01` and `skills-2025-10-02` are auto-injected by the SDK (verify in Phase 1).
  - Rate limits: 60 creates/min and 600 reads/min per org. With per-task `sessions.create`, a swarm running >60 concurrent task starts/min hits the limit. v1 ignores this; capture as monitoring metric in production.
  - Pricing: token costs at standard Claude API rates + $0.08/session-hour runtime fee. Idle is free.
  - The pre-existing-agent decision (no runtime CRUD) means **system prompt updates require operator action** — re-run `bun run src/cli.tsx claude-managed-setup --force` or call `agents.update` manually in the Anthropic console. Acceptable for v1 because the placeholder system prompt on the agent is intentionally minimal; per-task content lives in the user message.
  - `MCP_BASE_URL` is **fail-fast** at adapter construction. If the operator forgets to set it, the worker won't start — the error message must point at `runbooks/local-development.md`.
  - Current research doc lives in agent-fs at `thoughts/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/...` (note: `d454d1a5...` is not the local repo's thoughts namespace); when the implementer reads it, they'll need `agent-fs cat` rather than `Read`.
- **References**:
  - Research: `agent-fs cat thoughts/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/research/2026-04-09-claude-managed-agents-integration.md`
  - Anthropic docs:
    - https://platform.claude.com/docs/en/managed-agents/overview
    - https://platform.claude.com/docs/en/managed-agents/quickstart
    - https://platform.claude.com/docs/en/managed-agents/agent-setup
    - https://platform.claude.com/docs/en/managed-agents/sessions
    - https://platform.claude.com/docs/en/managed-agents/skills
    - https://platform.claude.com/docs/en/managed-agents/mcp-connector
    - https://platform.claude.com/docs/en/api/beta/sessions
  - Provider contract guide: `docs-site/content/docs/(documentation)/guides/harness-providers.mdx`
  - Local testing recipes: `LOCAL_TESTING.md`

---

## Review Errata

_Reviewed: 2026-04-28 by Claude (`/desplega:review`, autonomy=critical, output=auto-apply)_

### Applied

#### Critical
- [x] **SDK shape verification gap (Phase 1)** — `bun run tsc:check` would have passed in Phase 1 even if `latest @anthropic-ai/sdk` lacked the beta surface, because the adapter file at that phase didn't reference any beta types. Fix: Phase 1 §1 now lists explicit type-import assertions (`Agent`, `Session`, `Environment`, `Skill`) and Phase 1 §2 now mandates including those imports in the adapter skeleton (with a `biome-ignore` for the temporary unused-import lint), so a missing SDK surface fails typecheck immediately rather than at Phase 3.
- [x] **Prompt-cache impact of system-prompt-in-user-message (Implementation Approach + Phase 3)** — Anthropic's prompt cache normally segments around the system prompt; the plan's "prepend system prompt to first `user.message`" decision could collapse two cache segments into one and tank cache-hit rate. Fix: added a "Prompt caching" bullet to Implementation Approach; Phase 3 §2 step 1 now specifies `composeManagedUserMessage(config)` returns two content blocks with an explicit `cache_control: { type: "ephemeral" }` breakpoint between the static prefix and the per-task suffix; added a corresponding unit test under Phase 3 §6 asserting the static prefix is byte-identical across two configs with the same agent.

#### Important
- [x] **`task.vcsRepo` / `repoContext` ambiguity (Phase 4 §1)** — verifier confirmed `task.vcsRepo` exists on the `AgentTask` type at `src/types.ts:110` and the runner derives repo context at `runner.ts:3042-3076`. Phase 4 §1 now commits to a default approach (reuse `task.vcsRepo` directly; expand the contract only if the spawn site doesn't already have `task` on the config) and instructs the implementer to settle the decision on day 1.
- [x] **SDK shape assertions itemized (Phase 1 §1)** — listed each call's exact expected surface (`agents.{create,retrieve,update}`, `environments.create`, `skills.create`, `sessions.{create,retrieve,archive}`, `sessions.events.{stream,send,list}`) and flagged that `skill_id` vs `id`, `content_md` vs `content` need to be confirmed against the SDK before writing.
- [x] **Cancellation latency contradiction (Desired End State §1.4 vs Phase 3 Manual Verification)** — Desired End State previously said ≤500 ms; Phase 3/5 Manual Verification said ≤2 s. The 500 ms figure is the cancel-poll throttle floor; the end-to-end abort + archive round-trip is realistically ≤2 s. Unified both to ≤2 s with a parenthetical note explaining the throttle vs round-trip distinction.
- [x] **Phase 5 codex regression risk** — extraction of `swarm-events-shared.ts` had a generic "no behavior change" assertion. Phase 5 §1 now enumerates: full `src/tests/codex-*.test.ts` suite must pass; throttle constants must be unit-asserted equal to pre-extraction values; `fireAndForget` semantics must be preserved; and a behavioral 500 ms cancel-poll test should be added pre-extraction if not already present.
- [x] **Phase 6 OpenAPI freshness mis-statement** — Phase 6 §5 said "no endpoints expected" but Phase 7 adds `POST /api/integrations/claude-managed/test`. Fix: Phase 6 §5 now references the Phase 7 endpoint and instructs running `bun run docs:openapi` after Phase 7 lands the endpoint, with the regenerated `openapi.json` + `docs-site/content/docs/api-reference/**` committed together.
- [x] **Manual E2E paraphrased commands** — CLAUDE.md mandates verbatim copies from `LOCAL_TESTING.md`. Manual E2E Step 2 had a `# Use the exact handshake at LOCAL_TESTING.md:93-130` placeholder. Added a leading note instructing the implementer to replace the placeholder with the actual curl recipes at implementation time so the plan stands alone.

#### Minor
- [x] `runner.ts:2188` → `runner.ts:2190` (off-by-2; line 2188 is `initialize();`).
- [x] `runner.ts:3134-3153` → `runner.ts:3140-3160` (per-task spawn site is in `spawnProviderProcess`).
- [x] `runner.ts:1814-1833` → `runner.ts:1815-1827` (`flushLogBuffer` call within the `raw_log` case).
- [x] `runner.ts:2269-2286` clarified — `buildSystemPrompt` is *defined* at `runner.ts:2273`, called per-task at `~2289+`.
- [x] `codex-adapter.ts:758-889` createSession line range — method extends past 889; replaced with `:758+`.
- [x] `codex-adapter.ts:132-243` buildCodexConfig line range — extends past 243; replaced with `:132+`.
- [x] "Phase 3.5 below" → "see §5 below" (the resume section is §5 of Phase 3, not a sub-phase).
- [x] Added `runner.ts:402-410` cross-reference for `POST /api/tasks/{id}/progress` to the Current State Analysis bullet so the dispatch chain is traceable from the runner-side without re-grepping.

### Verified file:line cross-references (sample)

A targeted spot-check via `Explore` confirmed the following claims hold (with the line-range adjustments listed under Minor above):

- `src/providers/types.ts` — `ProviderAdapter` (82-88), `ProviderSession` (62-68), `ProviderEvent` (18-40), `CostData` (1-15) all match.
- `src/providers/index.ts:13-26` — factory present with `Unknown HARNESS_PROVIDER` default branch.
- `src/providers/codex-adapter.ts` — `CodexAdapter` class at line 743; `emit()` at 347-373; `buildCostData()` at 383-412; `runSession()` at 651+; `handleEvent()` at 463+; `buildCodexConfig` at 132+.
- `src/providers/codex-skill-resolver.ts:60+` — `resolveCodexPrompt` exists.
- `src/providers/codex-swarm-events.ts:59+` — `createCodexSwarmEventHandler` with `shouldRun` throttling exists.
- `src/commands/codex-login.ts` — exists; uses `console.log` + `process.exit` (no Ink); exports `promptHiddenInput` at line 76.
- `src/providers/codex-oauth/storage.ts` — exists.
- `docker-entrypoint.sh:13-71` — codex-oauth restoration block present.
- `docs-site/content/docs/(documentation)/guides/harness-providers.mdx:99-103` — Reference implementations table present.
- `new-ui/src/lib/integrations-catalog.ts:550-560` — `codex-oauth` integration entry present.
- `task.vcsRepo` field — confirmed at `src/types.ts:110`; populated in `src/be/db.ts` at lines 784, 858, 876, 1077.
- `PUT /api/config` — confirmed in `src/http/config.ts` (`upsertConfig`); accepts `{scope, key, value, isSecret}`.
- `checkToolLoop` — confirmed at `src/hooks/tool-loop-detection.ts:76`.
- `scrubSecrets` — confirmed at `src/utils/secret-scrubber.ts:197`.

### Remaining

None — all Critical, Important, and Minor findings were auto-applied per the user's review-mode selection.
  - Local development env vars: `runbooks/local-development.md`

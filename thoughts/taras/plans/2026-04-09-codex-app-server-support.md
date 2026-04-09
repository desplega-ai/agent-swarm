---
date: 2026-04-09
author: taras
status: completed
issue: https://github.com/desplega-ai/agent-swarm/issues/100
last_updated: 2026-04-09
last_updated_by: claude (verify-plan)
---

# Codex Provider Support (App-Server Approach) Implementation Plan

## Overview

Add OpenAI Codex as a third harness provider alongside Claude Code and pi-mono, using the **`@openai/codex-sdk`** package (which drives Codex via the `codex app-server` JSON-RPC protocol internally). Selected at runtime via `HARNESS_PROVIDER=codex`. The existing `ProviderAdapter` abstraction (src/providers/types.ts) was built exactly for this — we implement a new `CodexAdapter` + `CodexSession` class and wire it through the factory. **All types come from the SDK — no hand-rolled duplicates of `Thread`, `Turn`, events, or items.**

## Current State Analysis

The provider abstraction was introduced in plan 2026-03-08-pi-mono-provider-implementation.md. Today's state:

- **`ProviderAdapter` interface** (src/providers/types.ts:83-88) — contract is stable: `name`, `createSession()`, `canResume()`, `formatCommand()`.
- **`ProviderSession` interface** (src/providers/types.ts:62-68) — `sessionId` (readonly), `onEvent()`, `waitForCompletion()`, `abort()`. **No `dispose()`** — cleanup happens in the adapter's `finally` block.
- **`ProviderEvent` normalized union** (src/providers/types.ts:18-40) — 11 variants: session_init, message, tool_start, tool_end, result, error, raw_log, raw_stderr, custom, context_usage, compaction.
- **Factory** (src/providers/index.ts:15-24) — switch on provider name, throws for unknown values.
- **Claude adapter** (src/providers/claude-adapter.ts) — CLI-based, spawns `claude` binary, parses JSONL, writes per-session `/tmp/mcp-{taskId}.json`, relies on Claude's native hooks.
- **Pi-mono adapter** (src/providers/pi-mono-adapter.ts) — SDK-based, uses `@mariozechner/pi-coding-agent`'s `createAgentSession()` with the shortnames map at `pi-mono-adapter.ts:71-75`, the `createAgentsMdSymlink` helper at `pi-mono-adapter.ts:110-123`, log file writing at `pi-mono-adapter.ts:169-177`, and MCP discovery starting at `pi-mono-adapter.ts:421`. Subscribes to session events and maps them into `ProviderEvent`, installs MCP tools via `McpHttpClient`, uses a "swarm hooks extension" (`src/providers/pi-mono-extension.ts:384` `createSwarmHooksExtension`) to hook into lifecycle events (tool-loop detection in the PreToolUse hook at `:427-447`, context-usage reporting in PostToolUse at `:499-517`).
- **Runner integration** (src/commands/runner.ts:2135) — `createProviderAdapter(process.env.HARNESS_PROVIDER || "claude")`. The factory accepts **`"claude"` and `"pi"`** — NOT `"pi-mono"` (note: `src/providers/index.ts:19` is `case "pi"`). ⚠️ There's a pre-existing bug at `src/tests/runner-fallback-output.test.ts:243` that sets `HARNESS_PROVIDER="pi-mono"` — fix as a side-quest during Phase 7.
- **Runner-side cancellation polling** (src/commands/runner.ts:2812-2841) — **provider-agnostic**; polls `GET /cancelled-tasks?taskId={taskId}` and calls `session.abort()` on the running `ProviderSession`. This layer works for codex "for free" — Phase 5 only adds an adapter-internal lower-latency path on top.
- **Dockerfile.worker** — installs both Claude CLI (line 84) and pi-mono (line 93); copies per-harness skills (`plugin/skills/` → `~/.claude/skills/`, `plugin/pi-skills/` → `~/.pi/agent/skills/`).
- **docker-entrypoint.sh** — provider-specific validation branch (lines 4-40) checks `CLAUDE_CODE_OAUTH_TOKEN` for Claude and `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` for pi; skills sync loop (lines 703-716) mirrors skills to both provider directories.
- **Tests** — `src/tests/provider-adapter.test.ts` and `src/tests/provider-command-format.test.ts` cover factory + command formatting.

### Key Discoveries:
- **Codex SDK is a thin wrapper** — `@openai/codex-sdk` v0.118.0 spawns the Codex CLI's `app-server` subcommand as a child process over stdio JSON-RPC. Node ≥18 required. Works under Bun. ⚠️ Verify ESM/`.d.ts` layout and the exact dependency declaration (`dependencies` vs bundled binary) against `sdk/typescript/package.json` before pinning.
- **Codex primitives** — `Codex` → `Thread` → `Turn`; `thread.runStreamed()` returns an async iterable of event types including `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, plus an error event. Items are a tagged union (`agent_message`, `reasoning`, `plan`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, etc.). ⚠️ Exact event names (`thread.error` vs `error`), item granularity, and item variants like `user_message` / `dynamic_tool_call` must be verified against `sdk/typescript/src/types.ts` at implementation time — some names in this plan are inferred from docs snippets.
- **Abort mechanism** — `Thread` does NOT expose an `interrupt()` method (tracked by [openai/codex#5494](https://github.com/openai/codex/issues/5494) as an open feature request). The supported abort path is `thread.run(prompt, { signal: controller.signal })` passing an `AbortController` — the SDK propagates the signal to the underlying JSON-RPC session. `CodexSession.abort()` must call `controller.abort()`.
- **Thread lifecycle** — `codex.startThread(opts)` and `codex.resumeThread(threadId)`. Thread IDs are persisted to `~/.codex/sessions/` by default (or an `ephemeral: true` opt-out). Resume parity with Claude's `--resume <id>`.
- **System prompt hooks** — `ThreadStartParams.baseInstructions` (replaces built-in) and `developerInstructions` (appended). Map cleanly to our `systemPrompt` field.
- **Codex config layering** — Codex loads `~/.codex/config.toml` as a baseline and applies `-c key=value` dotted-path overrides on top (TOML-parsed values, nested objects supported via dotted keys). The SDK's `new Codex({ config: {...} })` option translates structured JS objects into these overrides. This means **baseline config + per-session extension is natively supported** (answering Taras's question).
- **MCP servers are config-only** — Codex has no per-invocation MCP flag like Claude's `--mcp-config`. MCP servers live under `[mcp_servers.<name>]` in config.toml (or the equivalent dotted override). For per-session isolation we pass the per-task `mcp_servers.*` entries via the SDK's `config` option at `Codex` construction time. ⚠️ The `new Codex({ config: {...} })` option accepting a **structured** JS object that translates into dotted-path overrides is the plan's assumption; if the SDK only accepts pre-flattened dotted strings (`{ "mcp_servers.agent-swarm.url": "..." }`) we flatten on the adapter side. Verify against `sdk/typescript/src/types.ts` during Phase 3.
- **Codex MCP server config shape** — Verified from [Codex config docs](https://developers.openai.com/codex/mcp): HTTP transport uses keys `url`, `http_headers` (NOT `headers`), `bearer_token_env_var`, `enabled`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools`. Stdio transport uses `command`, `args`, `env`. **Streamable HTTP is supported**; SSE is not yet (tracked in [openai/codex#2129](https://github.com/openai/codex/issues/2129)).
- **No native skill/slash-command system** — Codex reads `AGENTS.md` from the cwd as the agent's instructions, but has no `/work-on-task`-style command resolver. Our slash commands must be resolved adapter-side before hitting `thread.run()`. Taras's chosen approach: mirror the pi-mono pattern by (a) copying `plugin/commands/*.md` into `~/.codex/skills/<name>/SKILL.md` at Docker build + syncing installed skills at runtime, and (b) having the adapter parse the prompt for a leading slash command, read the corresponding `SKILL.md`, and prepend its content to the turn prompt. `formatCommand()` returns `/<name>` (same as Claude).
- **Auth — three paths supported**:
  1. **API key** (`OPENAI_API_KEY` env var) — simplest for Docker workers. Passed through to Codex via `new Codex({ env: { OPENAI_API_KEY } })`.
  2. **Codex CLI native OAuth** (`codex login`) — stores credentials in `~/.codex/auth.json`, picked up automatically by the SDK. Good for local dev where the user runs the CLI login once.
  3. **Agent-swarm-native ChatGPT OAuth flow** (Phase 8) — port pi-mono's implementation so our onboarding CLI / dashboard can trigger the OAuth handshake directly without requiring the user to run `codex login`. Uses the published Codex client ID `app_EMoamEEZ73f0CkXaXp7hrann`, PKCE S256, loopback redirect on port 1455, persists to the API config store as an OAuth credential (not a file), and auto-refreshes. This gives users "ChatGPT Plus/Pro subscription" billing parity with the Codex CLI without forcing an interactive CLI login on their box. ⚠️ Upstream pi-mono source URL is tracked in Phase 8 — needs verification before porting.
- **Model catalogue** — Codex CLI API-addressable models as of 2026-04-09 (from https://developers.openai.com/codex/models): `gpt-5.4` (recommended default), `gpt-5.4-mini` (faster/cheaper), `gpt-5.3-codex`, `gpt-5.2-codex` (legacy, scheduled retirement — check [developers.openai.com/api/docs/deprecations](https://developers.openai.com/api/docs/deprecations) for exact date). **Excluded**: `gpt-5.3-codex-spark` — it's a ChatGPT Pro research preview and is NOT API-addressable via the Codex SDK at launch, so including it would cause runtime errors if selected via `MODEL_OVERRIDE`. We (a) pick `gpt-5.4` as the default and (b) store the supported-models list in a typed `src/providers/codex-models.ts` with shortname mapping (mirrors `pi-mono-adapter.ts:71-75` `shortnames` map). This can be promoted to DB-backed storage later if we need per-agent overrides.
- **Approvals + sandbox** — inside a worker container we want `approvalPolicy: "never"` + `sandbox: "danger-full-access"` + `skipGitRepoCheck: true`. These map to `ThreadStartParams`.
- **Experimental protocol** — `codex app-server` is marked `[experimental]` in CLI help, and several JSON-RPC methods live under `v2/`. The SDK abstracts most of this, but we should **pin the CLI version** in Docker and regenerate bindings on upgrade. Our adapter consumes the SDK's public surface, not the raw protocol, so this risk is contained.
- **Hook-equivalent behaviors** — we rely on the **two-layer architecture**: (a) runner-side provider-agnostic cancellation polling at `runner.ts:2812-2841` already calls `session.abort()` on any `ProviderSession` — codex inherits this for free once Phase 2 wires the AbortController properly; (b) an adapter-internal event-stream observer (new in Phase 5) adds lower-latency cancellation checks on every `tool_start` event, plus tool-loop detection, auto-progress updates, and session lifecycle pings — mirroring `createSwarmHooksExtension` in `src/providers/pi-mono-extension.ts:384`. Codex's SDK has no preToolUse blocking hook, so layer (b) can only *accelerate* the abort signal, not *block* tool execution like pi-mono can.

## Desired End State

A worker or lead can be started with `HARNESS_PROVIDER=codex` and achieves **functional parity with the existing Claude and pi workers**:

1. Single Docker image supports all three providers (claude/pi/codex), selected at runtime via `HARNESS_PROVIDER`.
2. `CodexAdapter` implements `ProviderAdapter` end-to-end with SDK-provided types (no copy-pasted interfaces).
3. Factory + error messages list `claude, pi, codex`.
4. Runner code is untouched except for the factory listing — all provider-specific logic lives behind the adapter.
5. Swarm MCP + installed HTTP MCP servers reach Codex via a per-session `mcp_servers` config extension over a baseline `~/.codex/config.toml`.
6. Slash commands (`/work-on-task`, `/review-offered-task`, …) work by inlining the corresponding `SKILL.md` content into the turn prompt.
7. Session events from `thread.runStreamed()` are normalized to `ProviderEvent`s with cost/usage data captured from `turn.completed`.
8. Task cancellation, tool-loop detection, and progress updates fire off event-stream subscribers, not Codex native hooks.
9. Tests cover the factory, command formatting, and a mocked event-normalization path.
10. Manual E2E: a `codex` worker completes a simple task through the swarm against a real backend.

### Verification:

```bash
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
bun run docker:build:worker

# Local worker against real API
HARNESS_PROVIDER=codex OPENAI_API_KEY=sk-... bun run cli worker --yolo

# Docker worker (single image)
docker run --rm \
  -e HARNESS_PROVIDER=codex \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  --env-file .env.docker \
  agent-swarm-worker:latest
```

## Quick Verification Reference

**Primary commands:**
- `bun test src/tests/provider-adapter.test.ts`
- `bun test src/tests/provider-command-format.test.ts`
- `bun test src/tests/codex-adapter.test.ts` (new)
- `bun run tsc:check`
- `bun run lint:fix`
- `bun run docker:build:worker`

**Key files to check:**
- `src/providers/codex-adapter.ts` (new — primary implementation)
- `src/providers/codex-agents-md.ts` (new — `<swarm_system_prompt>` block manager for `AGENTS.md`; replaces the original `baseInstructions`/`developerInstructions` approach, see Deviations §1)
- `src/providers/codex-models.ts` (new — typed model catalogue + shortname resolver)
- `src/providers/codex-skill-resolver.ts` (new — slash command → SKILL.md inlining)
- `src/providers/codex-swarm-events.ts` (new — adapter-side cancellation poll + tool-loop + heartbeat + context-usage hooks)
- `src/providers/index.ts` (factory update)
- `src/providers/types.ts` (unchanged — interface is already sufficient)
- `src/tests/codex-adapter.test.ts` (new)
- `src/tests/codex-skill-resolver.test.ts` (new)
- `src/tests/codex-swarm-events.test.ts` (new)
- `src/tests/provider-adapter.test.ts` (factory + error message update)
- `src/tests/provider-command-format.test.ts` (codex case)
- `src/tests/runner-fallback-output.test.ts` (side-fix for pre-existing `pi-mono` typo + codex case)
- `scripts/check-codex-default-model.sh` (new — CI guard asserting Dockerfile baseline matches `CODEX_DEFAULT_MODEL`)
- `Dockerfile.worker` (codex CLI install + skills copy)
- `docker-entrypoint.sh` (codex auth validation + skills sync)
- `package.json` (`@openai/codex-sdk` dep)
- `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `docker-compose.example.yml`, `docker-compose.local.yml`

## What We're NOT Doing

- **Not using Codex native config-driven hooks** (preToolUse/postToolUse/sessionStart/userPromptSubmit/stop with command/prompt/agent handlers). We use event-stream monitoring instead. Config-driven hooks remain on the table for a future follow-up.
- **Not implementing dynamic tools** (`ThreadStartParams.dynamicTools`). Our swarm MCP tools reach Codex via the built-in `mcp_tool_call` item type, not as first-class SDK tools. Dynamic tools are still experimental.
- **Not consuming the raw `codex app-server` JSON-RPC protocol**. We wrap the SDK. If/when we need something the SDK doesn't expose (e.g., `turn/steer`, approval callbacks, MCP server status notifications), we add it incrementally.
- **Not implementing the `v2/` protocol surface directly**. The SDK handles versioning.
- **Not supporting Codex's `plan` item type or `reasoning` item streaming as first-class UI features**. We log them as `raw_log` events. Surfacing them is a follow-up.
- **Not removing or restructuring Claude/pi adapters**. This is purely additive.
- **Not touching MCP tool definitions or the server** — the swarm MCP server already works for any client that speaks HTTP.
- **Not implementing a generic OAuth provider framework**. Phase 8 adds Codex-specific OAuth (the third auth path above). A broader multi-provider OAuth registry — something like pi-mono's `OAuthProviderInterface` with login/refresh per provider — would be overkill right now; we scope to Codex and can generalize when a second OAuth provider appears.

## Implementation Approach

**High-level strategy:** mirror the `PiMonoAdapter` pattern end-to-end, since Codex (like pi) is SDK-driven and event-subscription-based. Differences from pi live in three places: (1) SDK surface (`Codex`/`Thread`/`Turn` instead of pi's `AgentSession`), (2) MCP injection via `config.mcp_servers` instead of runtime tool registration, and (3) skill resolution via a dedicated `codex-skill-resolver` helper that reads `SKILL.md` files and inlines them into the turn prompt.

**Phasing rationale:** each phase is independently verifiable and commit-able.
- Phase 1 builds the skeleton (adapter + factory + minimal SDK wiring) so typecheck passes and the factory test goes green.
- Phase 2 normalizes the event stream — the most code-heavy phase.
- Phase 3 handles MCP config layering (baseline + per-session).
- Phase 4 handles skill resolution (slash-command inlining + Docker skills folder).
- Phase 5 implements event-stream hooks (cancellation, tool loop, progress).
- Phase 6 wires Docker + entrypoint + auth validation.
- Phase 7 adds unit tests + updates existing provider tests.
- Phase 8 adds optional ChatGPT subscription OAuth (ported from pi-mono).
- Phase 9 does manual E2E and documentation.

**Type discipline:** every type we pass to or receive from the SDK comes from `@openai/codex-sdk` exports. No parallel interfaces, no copy-paste. If the SDK doesn't export a type we need (e.g., a discriminant on a specific item variant), we use `Parameters<...>[0]` / `ReturnType<...>` / `Extract<Item, { type: "..." }>` on the exported types. Our only hand-authored interfaces are the already-existing `ProviderAdapter` / `ProviderSession` / `ProviderEvent` contracts, which are the integration boundary — not duplicates of SDK types.

---

## Phase 1: CodexAdapter Skeleton + Factory Wiring

### Overview

Create the bare-bones adapter class that implements `ProviderAdapter` and can construct a `Codex` client + `Thread` from `ProviderSessionConfig`. Wire it into the factory. At the end of this phase the codebase typechecks, existing tests still pass, and a `HARNESS_PROVIDER=codex` worker can *instantiate* the adapter (it won't yet stream events or handle skills).

### Changes Required:

#### 1. Package dependency

**File**: `package.json`
**Changes**: Add `"@openai/codex-sdk": "^0.118.0"` to `dependencies`. Run `bun install` to update the lockfile.

#### 2. Provider skeleton

**File**: `src/providers/codex-adapter.ts` (new, ~200 lines)
**Changes**:
- Import the SDK exports directly:
  ```typescript
  import { Codex, type Thread, type Turn } from "@openai/codex-sdk";
  // For event/item typing we use typeof utilities on the SDK public surface
  // so we don't duplicate the tagged union ourselves.
  type ThreadStreamEvent = Awaited<ReturnType<Thread["runStreamed"]>>["events"] extends AsyncIterable<infer E> ? E : never;
  type ThreadItem = Extract<ThreadStreamEvent, { type: "item.completed" }>["item"];
  ```
- Export `class CodexAdapter implements ProviderAdapter`:
  - `readonly name = "codex"`
  - `formatCommand(name: string): string` → returns `/${name}` (identical to Claude; the skill resolver in Phase 4 handles inlining).
  - `canResume(sessionId: string): Promise<boolean>` → `return Promise.resolve(typeof sessionId === "string" && sessionId.length > 0)` for now; Phase 2 will check `~/.codex/sessions/` or attempt a cheap `resumeThread` handshake.
  - `createSession(config: ProviderSessionConfig): Promise<ProviderSession>` → instantiate `Codex` with env + baseline config (populated in Phase 3); call `codex.startThread({ workingDirectory: config.cwd, skipGitRepoCheck: true, sandboxMode: "danger-full-access", approvalPolicy: "never", baseInstructions: config.systemPrompt })` (or `codex.resumeThread(config.resumeSessionId)` if present); construct and return a new `CodexSession`.
- Export `class CodexSession implements ProviderSession` with empty stubs for `sessionId`, `onEvent`, `waitForCompletion`, `abort` — these get fleshed out in Phase 2.

#### 3. Factory + error message

**File**: `src/providers/index.ts`
**Changes**: Import `CodexAdapter`; add `case "codex": return new CodexAdapter();`; update the error message string to `"Unknown HARNESS_PROVIDER: \"${provider}\". Supported: claude, pi, codex"`.

#### 4. Default export sanity check

**File**: `src/providers/index.ts`
**Changes**: No new exports needed from the barrel — `CodexAdapter` is an internal implementation detail consumed via the factory.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Unit tests pass: `bun test src/tests/provider-adapter.test.ts` (will fail on the error message assertion until we update it in Phase 7 — that's expected; alternatively update the assertion now to include `codex`)
- [x] `bun install` added the dependency: `grep '@openai/codex-sdk' package.json bun.lock` shows entries
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] `HARNESS_PROVIDER=codex bun run cli worker --yolo` starts without throwing in the adapter construction path (it will still fail downstream because `createSession` is stubbed — that's expected; we just need the factory → `new CodexAdapter()` path to work).
- [ ] `HARNESS_PROVIDER=claude` and `HARNESS_PROVIDER=pi` still work as before (no regression).

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 1] codex adapter skeleton + factory wiring`.

---

## Phase 2: Event Stream Normalization

### Overview

Wire `thread.runStreamed()` into `CodexSession`. Consume the async iterable of SDK events, map each variant to a `ProviderEvent`, manage the `sessionId`/`waitForCompletion`/`abort` lifecycle, and build `CostData` from `turn.completed.usage`. This is the heaviest phase — it's where we earn parity with the Claude JSONL parser and the pi event subscriber.

### Changes Required:

#### 1. Event mapping table

**File**: `src/providers/codex-adapter.ts`
**Changes**: inside `CodexSession`, implement `runSession()` that:
- Stores the listener queue + `sessionId` (set from `thread.started` → `event.threadId`).
- Calls `thread.runStreamed(config.prompt)` (skill resolution is Phase 4 — for now the raw prompt goes through).
- Iterates `for await (const event of events)` and emits per the mapping table below.
- On the final turn, emits a `result` event with `CostData` built from `turn.completed.usage`.
- On `turn.failed` or `thread.error`, emits `error` + `result(isError: true)`.
- Resolves `completionPromise` with `ProviderResult`.

**Event mapping table** (SDK event → `ProviderEvent`):

| SDK event                                      | ProviderEvent emitted                                                                                                                       |
|------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `thread.started`                                | `session_init` with `event.threadId`; also emit `raw_log` for debugability                                                                  |
| `turn.started`                                  | `raw_log` only                                                                                                                               |
| `item.started` with `item.type === "command_execution"` | `tool_start` with `toolName: "bash"`, `toolCallId: item.id`, `args: { command: item.command }`; also `raw_log` mirroring Claude's `tool_use` format |
| `item.started` with `item.type === "file_change"`       | `tool_start` with `toolName: item.operation === "apply_patch" ? "Edit" : "Write"`, `args: { path: item.path }`                              |
| `item.started` with `item.type === "mcp_tool_call"`      | `tool_start` with `toolName: item.toolName`, `args: item.arguments`                                                                          |
| `item.started` with `item.type === "web_search"`         | `tool_start` with `toolName: "WebSearch"`, `args: { query: item.query }`                                                                     |
| `item.completed` with same types as above      | `tool_end` with matching `toolCallId` + `result` (JSON-stringified item payload)                                                              |
| `item.completed` with `item.type === "agent_message"`   | `message` (role `assistant`, content `item.text`); also `raw_log` with Claude-style JSON envelope so the log streamer keeps working         |
| `item.completed` with `item.type === "reasoning"`        | `raw_log` only (not surfaced as `message` to avoid doubling)                                                                                 |
| `item.completed` with `item.type === "plan"`             | `raw_log` only                                                                                                                               |
| `item.updated` (delta events)                   | `raw_log` only (for now — UI doesn't need deltas)                                                                                            |
| `turn.completed`                                | `context_usage` (from `usage.input_tokens`, `cached_input_tokens`, `output_tokens`); `result` with `CostData` (built below)                 |
| `turn.failed`                                   | `error` with `event.error.message`; result with `isError: true` and `failureReason`                                                         |
| `thread.error`                                  | `error` with message; result with `isError: true`                                                                                            |

#### 2. CostData construction

**File**: `src/providers/codex-adapter.ts`
**Changes**: helper `buildCostData(usage, durationMs)` that populates `CostData` (src/providers/types.ts:2-15) from Codex's `usage` object:
- `inputTokens` ← `usage.input_tokens`
- `outputTokens` ← `usage.output_tokens`
- `cacheReadTokens` ← `usage.cached_input_tokens`
- `cacheWriteTokens` ← 0 (Codex doesn't report cache-write distinctly)
- `totalCostUsd` ← 0 (Codex's SDK usage payload doesn't report dollar cost directly; the backend can compute it from token counts + model. Parallel to how pi leaves `durationMs: 0` — document this in a comment so downstream code knows).
- `durationMs` ← computed from `Date.now() - startedAt`
- `numTurns` ← counter incremented on each `turn.started`
- `model` ← from thread config or `config.model`
- `isError` ← carried through

#### 3. Abort + cleanup

**File**: `src/providers/codex-adapter.ts`
**Changes**:
- Store an `AbortController` per turn: `this.abortController = new AbortController()`.
- Call `thread.run(prompt, { signal: this.abortController.signal })` (or the streamed equivalent — check the exact signature against `sdk/typescript/src/thread.ts`; both `run()` and `runStreamed()` accept run options in 0.118.x).
- `abort()` → `this.abortController.abort()`. The SDK propagates the signal through the JSON-RPC session and the event loop unwinds naturally. ⚠️ If Phase 1 smoke testing reveals the 0.118 SDK does NOT yet plumb `signal` through `runStreamed()` (the feature request tracker is [openai/codex#5494](https://github.com/openai/codex/issues/5494)), fall back to a flag-based short-circuit in the event loop plus `(codex as unknown as { shutdown?: () => Promise<void> }).shutdown?.()` — and document the workaround inline.
- `ProviderSession` has no `dispose()` method — cleanup (log file writer flush, pending event drain) happens in a `try/finally` block around the event loop, parity with `pi-mono-adapter.ts` around line 323.

#### 4. Log file writes (parity with pi)

**File**: `src/providers/codex-adapter.ts`
**Changes**: mirror `pi-mono-adapter.ts:169-177` — write every emitted event as a JSONL line to `config.logFile` using `Bun.file(config.logFile).writer()`.

#### 5. `canResume` implementation

**File**: `src/providers/codex-adapter.ts`
**Changes**: replace the stub from Phase 1 with: `try { await codex.resumeThread(sessionId); return true; } catch { return false; }`. We accept the cost of a handshake — runner calls this rarely (only when deciding to resume an existing task). Pi's implementation similarly lists sessions.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] New unit test (stubbed event stream): `bun test src/tests/codex-adapter.test.ts` — verifies that given a canned async iterable of SDK events, the adapter emits the expected `ProviderEvent` sequence
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Run the adapter directly via a smoke script: `bun run scripts/smoke-codex.ts` (new throwaway file, not committed) that calls `createSession` with a real prompt "Say hi" and prints normalized events. Verify: `session_init` fires, at least one `message` fires, `result` fires with non-zero token counts.
- [ ] Abort works: spawn a long-running prompt, call `session.abort()`, confirm the session resolves within a few seconds.

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 2] codex event stream normalization`.

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: Happy-path turn
  - Steps: run smoke script with a trivial prompt
  - Expected: `session_init` → `message` → `result{isError:false, cost.outputTokens > 0}`
- [ ] TC-2: Turn failure
  - Steps: pass an invalid model id in `ProviderSessionConfig.model`
  - Expected: `error` + `result{isError:true, failureReason populated}`

---

## Phase 3: Baseline + Per-Session MCP Config + Model Catalogue

### Overview

Codex's SDK supports layered config — a baseline `~/.codex/config.toml` + per-session extension via `new Codex({ config: {...} })` (dotted-path overrides). We'll:

1. Introduce a typed Codex model catalogue (`src/providers/codex-models.ts`) with default + shortname map so the UI and runner can reference supported models by name.
2. Seed the baseline with sane defaults in the Docker image (sandbox, approval, model default).
3. At `createSession` time, build a per-session `config` object that adds `mcp_servers.<name>` entries for the swarm server and any installed HTTP/SSE MCP servers.
4. Inject the `X-Source-Task-Id` header (and auth) into each MCP server entry so cross-task inheritance works (parity with claude-adapter.ts's session config).

### Changes Required:

#### 0. Codex model catalogue

**File**: `src/providers/codex-models.ts` (new, ~60 lines)
**Changes**: Export a typed catalogue + resolver mirroring `pi-mono-adapter.ts:67-107`:

```typescript
/**
 * Codex API-addressable models, verified from https://developers.openai.com/codex/models
 * and https://developers.openai.com/api/docs/deprecations as of 2026-04-09.
 *
 * NOTE: gpt-5.3-codex-spark is intentionally excluded. It is a ChatGPT Pro research
 * preview and is not API-addressable via the Codex SDK at launch. Including it here
 * would cause runtime errors if selected via MODEL_OVERRIDE.
 *
 * Bump this file when the CLI / SDK adds new models. Kept separate from the adapter
 * so the onboarding UI and model selector can import it without pulling in the SDK.
 */
export const CODEX_MODELS = [
  "gpt-5.4",       // default — mainline reasoning model w/ frontier coding
  "gpt-5.4-mini",  // faster/cheaper
  "gpt-5.3-codex", // coding-specialized, 1M context
  "gpt-5.2-codex", // legacy — scheduled for retirement, see openai deprecations page
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number];

export const CODEX_DEFAULT_MODEL: CodexModel = "gpt-5.4";

/** Map claude-style shortnames that flow through MODEL_OVERRIDE / task.model to Codex equivalents. */
const SHORTNAME_TO_CODEX: Record<string, CodexModel> = {
  opus: "gpt-5.4",
  sonnet: "gpt-5.4-mini",
  haiku: "gpt-5.4-mini",
  // explicit passthrough entries so MODEL_OVERRIDE="gpt-5.4" round-trips
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.2-codex": "gpt-5.2-codex",
};

export function resolveCodexModel(modelStr: string | undefined): CodexModel {
  if (!modelStr) return CODEX_DEFAULT_MODEL;
  const normalized = modelStr.toLowerCase();
  return SHORTNAME_TO_CODEX[normalized] ?? CODEX_DEFAULT_MODEL;
}
```

The adapter calls `resolveCodexModel(config.model)` before passing the model name into the baseline `config` object / `ThreadStartParams`. Unknown models log a warning to `raw_stderr` and fall back to the default. Check [developers.openai.com/api/docs/deprecations](https://developers.openai.com/api/docs/deprecations) periodically and prune retired models from the list.

#### 1. Baseline config at Docker build

**File**: `Dockerfile.worker` (Phase 6 will do the deeper Docker changes — in this phase we only add the config baseline)
**Changes**: (deferred to Phase 6; tracked here for visibility so we don't forget during E2E)
- `RUN mkdir -p /home/worker/.codex && cat > /home/worker/.codex/config.toml <<'EOF'` with:
  ```toml
  model = "gpt-5.4"   # matches CODEX_DEFAULT_MODEL in src/providers/codex-models.ts
  approval_policy = "never"
  sandbox_mode = "danger-full-access"
  skip_git_repo_check = true
  show_raw_agent_reasoning = false
  ```
- `chown` to `worker`.

#### 2. Per-session MCP config builder

**File**: `src/providers/codex-adapter.ts`
**Changes**: Add `buildCodexConfig(config: ProviderSessionConfig): Record<string, unknown>` that returns a structured object consumable by `new Codex({ config })`. Field names are verified from [Codex MCP config docs](https://developers.openai.com/codex/mcp):
- Add the swarm MCP server using **Streamable HTTP transport** (`url` + `http_headers`, NOT `endpoint` / `headers`):
  ```typescript
  result.mcp_servers ??= {};
  result.mcp_servers["agent-swarm"] = {
    // Streamable HTTP transport — keys verified against developers.openai.com/codex/mcp
    url: `${config.apiUrl}/mcp`,
    http_headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "X-Agent-ID": config.agentId,
      "X-Source-Task-Id": config.taskId,
    },
    enabled: true,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  };
  ```
- Fetch installed MCP servers via `GET /api/agents/{agentId}/mcp-servers?resolveSecrets=true` (parallel to `pi-mono-adapter.ts:421`; endpoint confirmed at `src/http/mcp-servers.ts:139`) and add them to `result.mcp_servers[srv.name]`. **Transport handling**: Codex supports `stdio` (`command`/`args`/`env`) and Streamable HTTP (`url`/`http_headers`) — map both. **SSE is not yet supported** (tracked in [openai/codex#2129](https://github.com/openai/codex/issues/2129)) — skip SSE-only MCP servers and emit a `raw_stderr` warning identifying them.
- Return the merged object.

#### 3. Wire into `createSession`

**File**: `src/providers/codex-adapter.ts`
**Changes**: In `createSession`, before constructing `new Codex(...)`, call `buildCodexConfig(config)`. Pass as `new Codex({ env: { OPENAI_API_KEY: config.env?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY, PATH: process.env.PATH }, config: mergedConfig })`.

#### 4. Validation that SDK accepts structured config

**File**: research note at the top of `src/providers/codex-adapter.ts` as a comment block
**Changes**: The MCP field names are already verified (see §2 above and [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp)). What still needs Phase 3 confirmation is whether `new Codex({ config })` accepts a **structured** object (`{ mcp_servers: { foo: { url: ... }}}`) or only **pre-flattened dotted keys** (`{ "mcp_servers.foo.url": "..." }`). Also confirm whether the SDK exports a helper for building config (e.g. `CodexConfigBuilder`) — if so, prefer it over manual object construction. Run `codex app-server generate-ts --out /tmp/codex-ts` to inspect authoritative TypeScript bindings and document the outcome in a top-of-file comment.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing pi adapter MCP discovery test (if any) still passes: `bun test src/tests/pi-mono-adapter.test.ts`
- [x] New codex adapter MCP-building test: `bun test src/tests/codex-adapter.test.ts` — verifies `buildCodexConfig` produces the expected shape for a mock agent with two installed HTTP servers

#### Manual Verification:
- [ ] Smoke script (from Phase 2) now runs a turn where the swarm MCP server is reachable. Ask the agent to call a swarm MCP tool (e.g., `get-agent-info`) and verify it succeeds.
- [ ] Inspect the generated per-session config: add a one-line `console.log(JSON.stringify(mergedConfig, null, 2))` in `createSession` temporarily and confirm it contains `mcp_servers["agent-swarm"]` with the right URL and headers.

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 3] codex baseline + per-session MCP config`.

---

## Phase 4: Skill Resolution (Slash Command Inlining)

### Overview

Codex has no native slash-command/skill resolver. Mirror the pi-mono pattern — copy skills into `~/.codex/skills/<name>/SKILL.md`, and in the adapter detect a leading slash command in the turn prompt, read the corresponding `SKILL.md`, and prepend its content. `formatCommand()` continues returning `/<name>` (symmetric with Claude), but the adapter rewrites the turn prompt before hitting `thread.run()`.

### Changes Required:

#### 1. Skill resolver helper

**File**: `src/providers/codex-skill-resolver.ts` (new, ~60 lines)
**Changes**:
- Export `async function resolveCodexPrompt(prompt: string, skillsDir: string): Promise<string>`.
- Parse the first line of `prompt` for `^/([a-z0-9:_-]+)(?:\s+(.*))?$`.
- If a match, read `${skillsDir}/${commandName}/SKILL.md` with `Bun.file(...).text()`. If it exists, build a new prompt:
  ```
  <SKILL-CONTENT>

  ---

  User request: <original prompt after the slash-command line>
  ```
- If the file is missing, leave the prompt unchanged and log a warning to `raw_stderr`.
- Default `skillsDir` to `${process.env.HOME}/.codex/skills` (callable override for tests).

#### 2. Wire into CodexSession

**File**: `src/providers/codex-adapter.ts`
**Changes**: Before calling `thread.runStreamed(prompt)`, await `resolveCodexPrompt(config.prompt, skillsDir)` and pass the result. Store `skillsDir` as an instance field for testability.

#### 3. AGENTS.md handling

**Status: Superseded by Phase 2 `codex-agents-md` helper; no action in Phase 4.**

The original design here was to mirror pi-mono's `createAgentsMdSymlink` — symlink `AGENTS.md → CLAUDE.md` for the session and clean up in the `finally` block. That approach has been replaced by a managed-block strategy owned by Phase 2's new helper `src/providers/codex-agents-md.ts`:

- `writeCodexAgentsMd(cwd, systemPrompt)` writes a `<swarm_system_prompt>…</swarm_system_prompt>` block into `${cwd}/AGENTS.md`. If AGENTS.md didn't exist, it creates the file (preseeding it with `CLAUDE.md` contents when present). If AGENTS.md exists with the block, it replaces the block in place. If AGENTS.md exists without the block, it prepends the block.
- Returns a `cleanup()` handle. Fresh files are deleted on cleanup; otherwise the block is stripped and the rest of the file is preserved (so anything the agent appended during the session is kept).
- `CodexSession.runSession()` awaits the cleanup in its `finally` block (parity with pi-mono's symlink cleanup location).

**Phase 4 work in this section is just to confirm the Phase 2 helper is still wired correctly** — no new code needed. This means Phase 4 no longer needs to touch AGENTS.md at all; it only owns the slash-command / SKILL.md resolver (§§1-2 above) and the Dockerfile skill-sync hand-off (§4 below).

The trade-off vs the symlink approach: we now also deliver the per-session `systemPrompt` through AGENTS.md, which the symlink approach couldn't do at all (it just exposed `CLAUDE.md` verbatim). The managed block means `config.systemPrompt` reaches Codex in every session — previously the Phase 1 skeleton had no wiring for `systemPrompt` whatsoever.

#### 4. Dockerfile + entrypoint skill sync (hooked here, implemented in Phase 6)

**File**: `Dockerfile.worker`, `docker-entrypoint.sh` (Phase 6 implements the Docker-side changes)
**Changes**: (deferred to Phase 6 for visibility)
- `COPY plugin/commands/ /home/worker/.codex/skills/` with appropriate restructuring (Claude's `plugin/commands/*.md` → `~/.codex/skills/<name>/SKILL.md` — mirrors pi's `plugin/pi-skills/` copy on Dockerfile.worker:154).
- `docker-entrypoint.sh` skill-sync loop (lines 703-716) extended to also write to `~/.codex/skills/$SKILL_NAME/SKILL.md`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] New unit test: `bun test src/tests/codex-skill-resolver.test.ts` — covers: (a) prompt with `/work-on-task abc-123` → inlines SKILL.md, (b) prompt without a slash command → unchanged, (c) unknown skill → unchanged with warning, (d) skill with extra context lines preserved
- [x] `formatCommand` test: update `src/tests/provider-command-format.test.ts` to add Codex cases asserting `/<name>` return values

#### Manual Verification:
- [ ] Smoke script passes `/work-on-task <id>` to a Codex session and observes the agent reading the skill instructions (check that the agent's first message references skill-specific guidance).
- [ ] With a command that doesn't have a SKILL.md file, the session still runs (non-fatal warning in stderr).

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 4] codex skill resolution via slash command inlining`.

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: Known skill inlining
  - Steps: send `/work-on-task task-123\n\nPlease proceed.` to resolver
  - Expected: prompt begins with work-on-task skill content, ends with "User request: Please proceed."
- [ ] TC-2: Unknown skill
  - Steps: send `/nonexistent-skill foo`
  - Expected: prompt unchanged, a warning line is appended to the log via `raw_stderr`

---

## Phase 5: Swarm Hooks via Event Stream

### Overview

Implement adapter-internal hook-equivalent behaviors by subscribing to the SDK event stream inside `CodexSession`. This is the **dual-layer** approach matching pi-mono:

**Layer 1 — Runner-side (already in place, provider-agnostic):** `runner.ts:2812-2841` polls `GET /cancelled-tasks?taskId={taskId}` on a timer and calls `session.abort()` on the running `ProviderSession`. This layer works for codex "for free" once Phase 2's abort path (AbortController + signal) is correctly wired.

**Layer 2 — Adapter-side (new in this phase):** `createCodexSwarmEventHandler` subscribes to the event stream and provides **lower-latency cancellation** (checked on every `tool_start` event) plus tool-loop detection, auto-progress updates, and session-init/finish lifecycle pings. Mirrors `src/providers/pi-mono-extension.ts:384` `createSwarmHooksExtension`.

**Why both layers?** Codex's SDK event stream does NOT offer a preToolUse-style blocking hook (unlike pi-mono's hook extension, which can return `"deny"` to block a tool call mid-execution). The best we can do is detect cancellation/loops as early as possible on `tool_start` and fire the abort controller, which aborts the current turn. Layer 2 tightens the cancellation latency; Layer 1 is the backstop if the adapter-level check misses.

### Changes Required:

#### 1. Extension factory

**File**: `src/providers/codex-swarm-events.ts` (new, ~200 lines)
**Changes**:
- Export `createCodexSwarmEventHandler(opts: { apiUrl; apiKey; agentId; taskId; isLead; abortRef: { current: AbortController | null } })` that returns a single `(event: ProviderEvent) => void` handler.
- On `session_init`: fire-and-forget POST to **`POST /api/active-sessions`** with `{ taskId, sessionId, provider: "codex" }`. ⚠️ The plan previously referenced `/api/tasks/{taskId}/sessions` which does NOT exist — the actual endpoint is `/api/active-sessions` (src/http/session-data.ts area). Confirm against current `src/http/` and match the claude adapter's session-creation call if there's a helper.
- On `tool_start`:
  - Fire-and-forget: throttled (≥500ms) cancellation check. ⚠️ The plan previously referenced `GET /api/tasks/{taskId}/cancel-status` which does NOT exist. Use the **actual** endpoint `GET /cancelled-tasks?taskId={taskId}` (see `runner.ts:2818`). If the response reports cancelled, call `abortRef.current?.abort()` — this fires the AbortController from Phase 2 and unwinds the turn.
  - Push tool name into a rolling window for tool-loop detection via `src/hooks/tool-loop-detection.ts` (already provider-agnostic; no extraction needed). On loop detection, call `abortRef.current?.abort()`.
  - Throttled (3s) auto-progress update to `POST /api/tasks/{taskId}/progress` (confirmed existing at `src/http/tasks.ts:115`).
- On `result`: fire-and-forget `POST /api/tasks/{taskId}/finish` with cost data (confirmed existing at `src/http/tasks.ts:129`).
- Reuse HTTP fetch helpers from the runner if possible; otherwise inline simple `fetch` calls with `Authorization: Bearer ${apiKey}` + `X-Agent-ID` headers.

#### 2. Wire into CodexSession

**File**: `src/providers/codex-adapter.ts`
**Changes**: In `CodexSession.constructor`, after `logFileHandle` setup, create the handler (passing an `abortRef` that points at the session's `AbortController` from Phase 2) and call `this.onEvent(handler)` internally so every emitted event flows through it in addition to any runner-side listener. Keep `abortRef.current` in sync with the active controller so the handler can trigger aborts across turn boundaries.

#### 3. Share tool-loop-detection helper

**File**: `src/hooks/tool-loop-detection.ts`
**Changes**: No changes expected — confirm it's pure (no Claude-CLI assumptions). If it imports anything provider-specific, extract the pure function into `src/providers/shared-tool-loop.ts` (a no-op if the file is already pure).

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] New unit test: `bun test src/tests/codex-swarm-events.test.ts` — verifies that given a canned event stream, the handler issues the expected fetch calls (mocked via `globalThis.fetch`)
- [x] Existing tool-loop-detection tests (if any) still pass — confirmed pure helper, no regressions in `bun test` (2368 pass)

#### Manual Verification:
- [ ] Smoke test against real backend: start a Codex session, then cancel the task via the API. The session should abort within one tool-start cycle.
- [ ] Tool loop trigger test: craft a prompt that induces the agent to repeatedly call the same tool. Verify loop detection aborts the session.
- [ ] Progress updates visible in the dashboard at `http://localhost:5274` for the running task.

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 5] codex swarm hooks via event stream`.

---

## Phase 6: Docker + Entrypoint Integration

### Overview

Install `@openai/codex` CLI (and the SDK as a runtime Node dependency) into the worker Docker image. Add `HARNESS_PROVIDER=codex` validation to `docker-entrypoint.sh`. Write the baseline `~/.codex/config.toml`, copy skill files, and extend the skill sync loop.

### Changes Required:

#### 1. Dockerfile codex install

**File**: `Dockerfile.worker`
**Changes**:
- Add a build arg: `ARG CODEX_VERSION=0.118.0`
- After the pi-mono install block (line 93), add:
  ```dockerfile
  # Install Codex CLI (alternative harness, selected via HARNESS_PROVIDER=codex)
  ARG CODEX_VERSION
  RUN sudo npm install -g @openai/codex@${CODEX_VERSION}
  RUN which codex && codex --version
  ```
- After the claude plugin install block, add the baseline codex config (model value comes from `CODEX_DEFAULT_MODEL` in `src/providers/codex-models.ts` — keep them in sync; CI lint check suggested below):
  ```dockerfile
  RUN mkdir -p /home/worker/.codex && \
      printf '%s\n' \
        'model = "gpt-5.4"' \
        'approval_policy = "never"' \
        'sandbox_mode = "danger-full-access"' \
        'skip_git_repo_check = true' \
        > /home/worker/.codex/config.toml && \
      chown -R worker:worker /home/worker/.codex
  ```
  Also add a simple check to `scripts/check-codex-default-model.sh` (new, ~10 lines) that greps the Dockerfile for `model = "<value>"` and asserts it matches `CODEX_DEFAULT_MODEL` in `src/providers/codex-models.ts`. Wire it into the merge gate next to `scripts/check-db-boundary.sh`.
- After the `COPY plugin/pi-skills/` line (line 154), add:
  ```dockerfile
  # Copy codex skills (used when HARNESS_PROVIDER=codex)
  # Structure: plugin/commands/<name>.md → ~/.codex/skills/<name>/SKILL.md
  COPY --chown=worker:worker plugin/commands/ /tmp/codex-skills-src/
  RUN mkdir -p /home/worker/.codex/skills && \
      for f in /tmp/codex-skills-src/*.md; do \
        name=$(basename "$f" .md); \
        mkdir -p "/home/worker/.codex/skills/$name"; \
        cp "$f" "/home/worker/.codex/skills/$name/SKILL.md"; \
      done && \
      rm -rf /tmp/codex-skills-src && \
      chown -R worker:worker /home/worker/.codex/skills
  ```

#### 2. Entrypoint auth validation

**File**: `docker-entrypoint.sh`
**Changes**: Extend the provider-specific branch (lines 4-40) to accept **any** of the three supported auth paths — API key, pre-seeded `~/.codex/auth.json` (from host `codex login` or Phase 8's OAuth flow), or a persisted OAuth credential pulled from the API config store at boot:
```bash
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    # Accept any of:
    #   1. OPENAI_API_KEY env var (simplest for CI/Docker)
    #   2. ~/.codex/auth.json (from `codex login` on host, volume-mounted, or seeded below)
    #   3. codex_oauth blob stored in the swarm API config store (written by Phase 8 onboarding)
    if [ -z "$OPENAI_API_KEY" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
        if [ -n "$AGENT_ID" ] && [ -n "$API_KEY" ] && [ -n "$MCP_BASE_URL" ]; then
            CODEX_OAUTH=$(curl -sf -H "Authorization: Bearer ${API_KEY}" \
                -H "X-Agent-ID: ${AGENT_ID}" \
                "${MCP_BASE_URL}/api/config/resolved?agentId=${AGENT_ID}&includeSecrets=true" \
                2>/dev/null | jq -r '.codex_oauth // empty')
            if [ -n "$CODEX_OAUTH" ]; then
                mkdir -p "$HOME/.codex"
                echo "$CODEX_OAUTH" > "$HOME/.codex/auth.json"
                chmod 600 "$HOME/.codex/auth.json"
                echo "[entrypoint] Restored codex OAuth credentials from API config store"
            fi
        fi
    fi
    if [ -z "$OPENAI_API_KEY" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
        echo "Error: codex provider needs one of: OPENAI_API_KEY env var, ~/.codex/auth.json, or a codex_oauth entry in the API config store"
        exit 1
    fi
fi
```

Extend the binary check (line 27):
```bash
if [ "$HARNESS_PROVIDER" = "claude" ]; then
    # existing claude binary check
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    CODEX_BIN="${CODEX_BINARY:-codex}"
    if ! command -v "$CODEX_BIN" > /dev/null 2>&1; then
        echo "FATAL: Codex CLI not found: '$CODEX_BIN'"
        exit 1
    fi
fi
```

#### 3. Skill sync loop extension

**File**: `docker-entrypoint.sh`
**Changes**: In the existing skill sync loop (lines 703-716), after the `cp` into `~/.pi/agent/skills/`, add:
```bash
mkdir -p "$HOME/.codex/skills/$SKILL_NAME"
cp "$HOME/.claude/skills/$SKILL_NAME/SKILL.md" "$HOME/.codex/skills/$SKILL_NAME/SKILL.md"
```

#### 4. Docker compose examples

**File**: `docker-compose.example.yml`
**Changes**: Add a commented-out `codex-worker` service block mirroring the existing `pi-worker` comment (around line 407), with `HARNESS_PROVIDER=codex` and `OPENAI_API_KEY=${OPENAI_API_KEY}`.

#### 5. docker-compose.local.yml

**File**: `docker-compose.local.yml`
**Changes**: Optional — add a second worker service with `HARNESS_PROVIDER=codex` gated behind a profile so `docker compose --profile codex up` spins up a codex worker for local testing. Do NOT enable by default — it requires `OPENAI_API_KEY` which most devs won't have.

### Success Criteria:

#### Automated Verification:
- [x] Docker image builds: `bun run docker:build:worker` — verified in verify-plan pass, sha256:92a0588c4454 (5.67 GB)
- [x] Codex CLI present in image: `docker run --rm --entrypoint /bin/sh agent-swarm-worker:latest -c 'codex --version'` → `codex-cli 0.118.0`
- [x] Baseline config present: `cat ~/.codex/config.toml` → `model = "gpt-5.4"`, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `skip_git_repo_check = true`, `show_raw_agent_reasoning = false`
- [x] Skills copied: 13 skills in `~/.codex/skills/` (close-issue, create-pr, implement-issue, investigate-sentry-issue, respond-github, review-offered-task, review-pr, start-leader, start-worker, swarm-chat, todos, user-management, work-on-task). `work-on-task/SKILL.md` readable.
- [x] Existing claude/pi binaries still present in the image: `claude --version` → `2.1.87 (Claude Code)`, `pi --version` → `0.64.0`. (Full `scripts/e2e-docker-provider.ts` regression run still deferred — the script doesn't yet support a `codex` test case; it's a follow-up.)
- [x] Shell syntax check: `bash -n docker-entrypoint.sh`
- [x] Codex default model guard: `bash scripts/check-codex-default-model.sh`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint:fix`
- [x] Full test suite: `bun test` (2368 pass → 2372 pass after Phase 7)

#### Manual Verification:
- [x] `HARNESS_PROVIDER=codex` container starts: container logs `Codex CLI: /usr/bin/codex`, `Harness Provider: codex`, proceeds past the entrypoint validation branch into PM2 init (verified in verify-plan pass).
- [x] Missing OPENAI_API_KEY fails fast: container exits with `Error: codex provider requires OPENAI_API_KEY or ~/.codex/auth.json` (verified in verify-plan pass).
- [x] `HARNESS_PROVIDER=claude` and `HARNESS_PROVIDER=pi` containers still start cleanly: both boot from the same image and log `Harness Provider: claude` / `Harness Provider: pi` (regression verified in verify-plan pass).

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 6] docker + entrypoint integration for codex provider`.

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: All three providers build from same image
  - Steps: `bun run docker:build:worker`; run each provider with `-e HARNESS_PROVIDER=<p>`
  - Expected: each container boots past entrypoint validation

---

## Phase 7: Tests + Factory Coverage

### Overview

Add comprehensive test coverage. Most tests live in new files; a few are additions to existing files.

### Changes Required:

#### 1. Factory + error-message update

**File**: `src/tests/provider-adapter.test.ts`
**Changes**:
- Add `test("returns CodexAdapter for 'codex'", ...)` asserting `adapter.name === "codex"` and instance check.
- Update the "throws for unknown provider" assertion to match the new error message including `codex`.

#### 2. Command formatting

**File**: `src/tests/provider-command-format.test.ts`
**Changes**:
- Import and instantiate `CodexAdapter`.
- Add tests mirroring the claude cases: `codex.formatCommand("work-on-task")` returns `/work-on-task`, etc.
- Add a regression block asserting `simulateTaskAssignedPrompt(codex, ...)` begins with `/work-on-task` (Codex uses the same prefix as Claude since the adapter resolves skills internally).

#### 3. New codex adapter unit tests

**File**: `src/tests/codex-adapter.test.ts` (new)
**Changes**: covers:
- Event mapping for a canned SDK event stream (stub `Codex` with a mock thread whose `runStreamed()` returns a pre-built async iterable).
- `buildCodexConfig` produces the expected shape for a mock agent with zero, one, and multiple installed MCP servers.
- `canResume` returns true/false based on mocked `codex.resumeThread` behavior.
- CostData construction from a canned usage object.
- Abort path: pending completion resolves with `isError: false` and a warning event after `abort()` is called mid-stream.

#### 4. Skill resolver tests

**File**: `src/tests/codex-skill-resolver.test.ts` (new)
**Changes**: covers the 4 cases from Phase 4 success criteria using a temp directory populated via `Bun.write`.

#### 5. Swarm events handler tests

**File**: `src/tests/codex-swarm-events.test.ts` (new)
**Changes**: mock `globalThis.fetch` and assert:
- `session_init` posts to the sessions endpoint.
- `tool_start` triggers cancellation check and throttled progress updates.
- `result` posts finish + cost.
- Cancelled tasks abort the session via the shared abort callback.

#### 6. Runner smoke test

**File**: `src/tests/runner-fallback-output.test.ts` (existing, around line 242-247)
**Changes**:
- **Side-fix bug**: the existing block at line 243 sets `HARNESS_PROVIDER = "pi-mono"`, but `createProviderAdapter` at `src/providers/index.ts:19` only accepts `"pi"`. This test may be silently broken (hitting the error path instead of the pi branch). Fix it to use `"pi"` while you're in the file.
- Add an analogous block asserting `HARNESS_PROVIDER = "codex"` is accepted by the factory and the runner doesn't crash at initialization.

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `bun test` (2372 pass, 0 fail across 128 files)
- [x] Coverage hits new files: `bun test src/tests/codex-adapter.test.ts src/tests/codex-skill-resolver.test.ts src/tests/codex-swarm-events.test.ts src/tests/provider-adapter.test.ts src/tests/provider-command-format.test.ts`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Run the full suite in watch mode and confirm no flaky tests: `bun test --watch`
- [ ] Intentionally break a provider mapping (e.g., change the event handler to skip `turn.completed`) and confirm the new test fails, then revert.

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 7] codex adapter tests + factory coverage`.

---

## Phase 8: Codex ChatGPT Subscription OAuth

### Overview

Add native ChatGPT OAuth support for Codex so users can authenticate against their ChatGPT Plus/Pro subscription directly from the agent-swarm onboarding flow, instead of having to run `codex login` in a separate terminal. **Port (do not copy-paste)** the pi-mono implementation into our codebase — same OAuth constants, same PKCE flow, but adapted to our types (no `OAuthProviderInterface` generalization — scoped to Codex), persisted via the swarm API config store (not a local `auth.json`), and integrated with our existing onboarding CLI.

⚠️ **Upstream reference URL to verify before porting**: the plan previously cited `https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/openai-codex.ts`, but the rest of this plan references the package as `@mariozechner/pi-coding-agent`. One of these is wrong. Resolve by checking `node_modules/@mariozechner/pi-coding-agent/package.json` `repository` field in the worktree (or the npm registry page) and substituting the real source location before Phase 8 implementation begins.

This is a real user-facing feature: pi-mono already ships it, and OAuth via subscription is the only way to get ChatGPT Plus/Pro billing parity (API key auth hits standard OpenAI API pricing instead of the subscription).

### Reference — constants we must copy verbatim from OpenAI's published Codex OAuth client:

```typescript
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // OpenAI's official Codex CLI client id
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback"; // hardcoded — OpenAI only whitelists this port
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth"; // custom claim namespace where chatgpt_account_id lives
```

Mandatory extra authorize query params: `response_type=code`, `code_challenge_method=S256`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=agent-swarm` (our client identifier for telemetry).

### Changes Required:

#### 1. PKCE helper

**File**: `src/providers/codex-oauth/pkce.ts` (new, ~35 lines)
**Changes**: Cross-runtime PKCE (works in Bun + Node) using Web Crypto:
- Generate 32-byte random verifier via `crypto.getRandomValues`
- Base64url-encode it
- SHA-256 challenge via `crypto.subtle.digest`
- Return `{ verifier, challenge }`

#### 2. OAuth flow

**File**: `src/providers/codex-oauth/flow.ts` (new, ~280 lines)
**Changes**:
- Export `loginCodexOAuth(callbacks: { onAuth, onPrompt, onProgress?, onManualCodeInput?, originator? }): Promise<CodexOAuthCredentials>`:
  - Generate PKCE + random state (16 bytes hex via `node:crypto.randomBytes`)
  - Build authorize URL with the required Codex-specific params above
  - Start a loopback `Bun.serve` server on `127.0.0.1:1455` that only handles `GET /auth/callback`, validates state, captures code, returns simple inline HTML success/error pages (drop the separate `oauth-page.ts` — inline the HTML strings to keep the port surface small)
  - Call `callbacks.onAuth({ url, instructions })` so the onboarding CLI can open the browser (or print the URL)
  - Race loopback-callback vs. optional manual paste (`onManualCodeInput`) vs. `onPrompt` fallback, matching pi-mono's resolution order
  - `parseAuthorizationInput` to accept bare code, `code=X&state=Y`, full URL, or `code#state` paste formats
  - Exchange code for tokens: `POST` to `TOKEN_URL` with `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`
  - Decode access JWT to extract `chatgpt_account_id` from the `https://api.openai.com/auth` claim (mandatory — fail the flow if missing)
  - Return `CodexOAuthCredentials`
- Export `refreshCodexOAuth(refreshToken: string): Promise<CodexOAuthCredentials>`:
  - `POST` to `TOKEN_URL` with `grant_type=refresh_token`, `refresh_token`, `client_id`
  - Re-extract accountId from the new access token
- Export types:
  ```typescript
  export type CodexOAuthCredentials = {
    access: string;
    refresh: string;
    expires: number;   // absolute ms since epoch
    accountId: string; // chatgpt_account_id from JWT claim
  };
  export type CodexOAuthCallbacks = {
    onAuth: (info: { url: string; instructions?: string }) => void;
    onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
    onProgress?: (message: string) => void;
    onManualCodeInput?: () => Promise<string>;
    originator?: string;
    signal?: AbortSignal;
  };
  ```

#### 3. Credential persistence + auto-refresh

**File**: `src/providers/codex-oauth/storage.ts` (new, ~80 lines)
**Changes**: Persist credentials via the swarm API config store (NOT a local file — this is the key difference from pi-mono, which uses `auth.json` + file locking):
- `async function storeCodexOAuth(apiUrl, apiKey, agentId, creds: CodexOAuthCredentials): Promise<void>` — `PUT /api/config` with `{ codex_oauth: JSON.stringify(creds) }` as a secret config entry
- `async function loadCodexOAuth(apiUrl, apiKey, agentId): Promise<CodexOAuthCredentials | null>` — `GET /api/config/resolved?includeSecrets=true`, parse `codex_oauth` field
- `async function getValidCodexOAuth(...): Promise<CodexOAuthCredentials | null>` — load, check `Date.now() >= expires`, refresh + re-store if expired, return null if refresh fails

#### 4. Onboarding CLI integration

**File**: `src/cli.tsx` (existing) and/or new `src/commands/codex-login.ts`
**Changes**: Add a new non-UI CLI command: `agent-swarm codex-login`:
- Prints the auth URL
- Optionally opens the browser (try `Bun.spawn(["open", url])` on macOS, `xdg-open` on Linux, `start` on Windows — fire-and-forget, non-fatal if it fails)
- Waits for the loopback callback
- On success, stores the credential via `storeCodexOAuth` against the `onboard-cli` agent config
- Prints "Codex OAuth stored. Workers will pick it up on next boot."
- Update `COMMAND_HELP` and `printHelp()` per the CLAUDE.md CLI guidelines

**File**: `src/cli.tsx` (onboarding wizard)
**Changes**: If an onboarding wizard exists for harness selection (grep for `HARNESS_PROVIDER` / `setup` flows), add a Codex branch that offers: "API key" / "Browser OAuth (ChatGPT subscription)". Browser OAuth invokes `loginCodexOAuth` inline.

#### 5. Adapter consumption

**File**: `src/providers/codex-adapter.ts`
**Changes**: In `createSession`, before instantiating `Codex`:
- If `process.env.OPENAI_API_KEY` is set → pass through as `env.OPENAI_API_KEY`
- Else, call `getValidCodexOAuth(apiUrl, apiKey, agentId)` — if it returns a credential, write it to `~/.codex/auth.json` (0600) so the Codex CLI picks it up automatically, AND also set appropriate headers/env vars if the SDK supports them directly (TBD during implementation — check SDK `env` option for `CODEX_AUTH_JSON` or similar, otherwise file-based is sufficient)
- Else → raise a clear error: "No Codex credentials found. Run `agent-swarm codex-login` or set OPENAI_API_KEY."

**Important**: Codex subscription API calls require extra headers (`chatgpt-account-id: <accountId>`, `originator: agent-swarm`) and a different base URL (`https://chatgpt.com/backend-api` per pi-mono's `openai-codex-responses.ts`). Verify during implementation whether the Codex SDK automatically applies these headers when it detects an OAuth-mode `auth.json`, or whether we need to set them ourselves. If the SDK handles it — great, zero extra work. If not, we need to drop down to raw JSON-RPC for subscription auth, or layer on a thin outbound proxy. Document the outcome in a top-of-file comment.

#### 6. Tests

**File**: `src/tests/codex-oauth.test.ts` (new)
**Changes**:
- PKCE generation produces distinct verifier/challenge pairs
- `parseAuthorizationInput` accepts all 4 paste formats
- `exchangeAuthorizationCode` constructs the expected POST body (mock `globalThis.fetch`)
- `decodeJwt` extracts `chatgpt_account_id` from a canned token with the right claim shape
- `refreshCodexOAuth` re-invokes the token endpoint with `grant_type=refresh_token`
- `getValidCodexOAuth` refreshes when expired, returns cached when valid

**File**: `src/tests/codex-oauth-storage.test.ts` (new, optional if we can share the codex-oauth.test.ts file)
**Changes**: mock `globalThis.fetch` and verify the API config PUT/GET payloads match expectations.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] New tests pass: `bun test src/tests/codex-oauth.test.ts`
- [ ] Help text lists the new command: `bun run src/cli.tsx help` includes `codex-login`
- [ ] No secrets logged: `grep -R 'CLIENT_ID\|client_id' src/providers/codex-oauth/` returns only the public OpenAI client id (no environment secrets)

#### Manual Verification:
- [ ] Run `bun run cli codex-login` on a machine with a browser → the flow opens the OAuth URL, redirects to `http://localhost:1455/auth/callback`, and stores credentials in the API config store.
- [ ] Start a worker with `HARNESS_PROVIDER=codex` and **no `OPENAI_API_KEY`** — worker boots, restores OAuth credentials via the entrypoint's config-store fallback, and completes a task.
- [ ] Wait past `expires` (or manually expire by editing the stored credential) — next worker boot auto-refreshes without user intervention.
- [ ] Run `bun run cli codex-login` with the callback port already occupied — the manual-paste fallback kicks in and still completes the flow.
- [ ] Cross-check billing: the completed task is charged against the ChatGPT subscription (not the API key tier) — verify via the OpenAI dashboard or account statement.

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 8] codex chatgpt subscription oauth`.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Happy-path login
  - Steps: run `bun run cli codex-login` → browser opens → log in → see success page → CLI prints "Codex OAuth stored."
  - Expected: credential persisted to API config store, worker boot without `OPENAI_API_KEY` succeeds
- [ ] TC-2: Port-in-use fallback
  - Steps: occupy port 1455 via `python3 -m http.server 1455`, then run `codex-login`
  - Expected: the CLI falls back to manual paste prompt; pasting a full callback URL completes the flow
- [ ] TC-3: Auto-refresh on expiry
  - Steps: manually set `expires` to a past timestamp in the stored credential; restart worker
  - Expected: entrypoint-restored credential is refreshed automatically on first turn; no user action needed

---

## Phase 9: Documentation + E2E

### Overview

Update documentation, changelog, README, and run a real end-to-end task through a codex worker against a live API server.

### Changes Required:

#### 1. README + CLAUDE.md

**File**: `README.md`, `CLAUDE.md`
**Changes**:
- `README.md:52` — update "Multi-provider" line: `Run agents with Claude Code, pi-mono, or Codex (HARNESS_PROVIDER=claude|pi|codex)`
- `CLAUDE.md:182` — update the "Key env vars" block to include `codex` as a valid `HARNESS_PROVIDER` value and mention `OPENAI_API_KEY`
- Add a short "Codex provider" subsection to the Bun rules / provider notes section if appropriate

#### 2. CHANGELOG

**File**: `CHANGELOG.md`
**Changes**: Add entry under the next version: `feat(providers): add Codex support via @openai/codex-sdk with HARNESS_PROVIDER=codex`

#### 3. docker-compose examples

**File**: `docker-compose.example.yml`, `docker-compose.local.yml`
**Changes**: (done partially in Phase 6) — confirm the codex-worker example is present and documented, with a comment noting the `OPENAI_API_KEY` requirement.

#### 4. Research cross-link

**File**: `thoughts/taras/plans/2026-04-09-codex-app-server-support.md` (this file)
**Changes**: After E2E passes, update `status: draft` → `status: complete` and add a `## Outcome` section summarizing what shipped + any deviations from the plan.

#### 5. E2E verification

Run manual E2E against a real backend. See the "Manual E2E" section below.

### Success Criteria:

#### Automated Verification:
- [x] Full test suite passes: `bun test` (2372 pass)
- [x] Full lint/typecheck/db boundary: `bun run lint:fix && bun run tsc:check && bash scripts/check-db-boundary.sh`
- [x] Docker build succeeds: `bun run docker:build:worker` → sha256:92a0588c4454 (5.67 GB), verified in verify-plan pass
- [x] OpenAPI regeneration not needed — no HTTP handlers touched in this plan
- [x] pi-skills regeneration not needed — `plugin/commands/*.md` not modified
- [ ] CI merge-gate workflow passes on the PR — runs after push (can only be verified once PR is opened)

#### Manual Verification:
- [ ] README example for Codex works end-to-end
- [x] All three providers (`claude`, `pi`, `codex`) boot cleanly from the same image in the verify-plan pass. Full task-completion E2E against a real backend still pending (deferred to Taras).
- [ ] Dashboard shows the codex worker and its task progress
- [x] No regressions reported in existing claude/pi flows: both boot to `Harness Provider: claude` / `Harness Provider: pi` from the same image; unit tests `runner-fallback-output.test.ts` updated with codex case and side-fix for pre-existing `pi-mono` typo; full 2372-test suite green.

**Implementation Note**: After completing this phase, commit, push, and open the PR. Commit message: `[phase 9] codex provider docs + E2E verification`.

---

## Manual E2E

Run these commands against a real backend to verify the feature works end-to-end. The worktree port gotcha applies — check `.env` for `PORT`/`MCP_BASE_URL` first and adjust if occupied.

```bash
# 0. Pre-flight: clean slate
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
sleep 2
curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.'

# 1. Build the worker image
bun run docker:build:worker

# 2. Spin up a codex worker
docker run --rm -d --name e2e-codex-worker \
  --env-file .env.docker \
  -e HARNESS_PROVIDER=codex \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3204:3000 \
  agent-swarm-worker:latest

# 3. Confirm the worker registered
sleep 5
curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.agents[] | {name, isLead, status, provider}'

# 4. Create a trivial task pre-assigned to the codex worker.
# NOTE: There is no POST /api/tasks/{taskId}/assign endpoint — check src/http/tasks.ts:29
# for the actual POST /api/tasks payload shape. Tasks carry an `agentId` (or similar)
# at creation time, or are picked up from the queue by any eligible worker.
# Easiest for a single-worker E2E: spin up ONLY the codex worker and the lead, then
# the task routes to codex by process of elimination.
AGENT_ID=$(curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | \
  jq -r '.agents[] | select(.isLead == false) | .id' | head -1)
echo "Codex worker: $AGENT_ID"

TASK_ID=$(curl -sf -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"description\": \"Say hi in one word\", \"priority\": 50, \"agentId\": \"$AGENT_ID\"}" | jq -r '.task.id')
echo "Task: $TASK_ID"
# ⚠️ Verify the exact field name for direct assignment at task-creation time by inspecting
# src/http/tasks.ts:29 (the POST /api/tasks handler) before running this E2E.

# 5. Poll for completion (wait up to ~60 seconds)
for i in {1..12}; do
  STATUS=$(curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/$TASK_ID | jq -r '.task.status')
  echo "status=$STATUS"
  [ "$STATUS" = "completed" ] && break
  sleep 5
done

# 6. Check logs for streaming events
docker logs e2e-codex-worker 2>&1 | tail -50
# Expect: session_init, tool_start (at least one), message, result

# 7. Verify the task completed with cost data
curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/$TASK_ID | jq '.task | {status, cost, outputTokens, inputTokens}'

# 8. Cancellation test
# Create a long-running task pre-assigned to the codex worker, then cancel via the API
# and confirm the worker aborts within ~5-10 seconds (adapter-level tool_start check
# from Phase 5, or runner-level poll from runner.ts:2812-2841).
TASK_ID2=$(curl -sf -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"description\": \"Count slowly from 1 to 100, explaining each number in detail\", \"agentId\": \"$AGENT_ID\"}" | jq -r '.task.id')
sleep 10
curl -sf -X POST http://localhost:3013/api/tasks/$TASK_ID2/cancel \
  -H "Authorization: Bearer 123123"
# Expect worker to abort within ~10 seconds.

# 9. Cleanup
docker stop e2e-codex-worker
kill $(lsof -ti :3013) 2>/dev/null || true
```

**Expected outcomes:**
- Step 5: task reaches `completed` status within ~60 seconds.
- Step 6: logs show the full event sequence (session_init, at least one tool_start, message, result).
- Step 7: cost fields are populated with non-zero input/output token counts.
- Step 8: the cancelled task transitions to `cancelled` status and the worker remains healthy.

## Testing Strategy

- **Unit tests** — stub the SDK (`Codex` / `Thread`) with hand-built async iterables so event normalization, cost-data construction, and error paths can be exercised without a real Codex binary.
- **Integration tests** — smoke script run locally with a real `codex` binary against a real swarm API. Not in CI (requires `OPENAI_API_KEY`).
- **E2E tests** — manual commands documented above; a follow-up PR can add a `scripts/e2e-codex-provider.ts` mirroring `scripts/e2e-provider-test.ts` if we want CI coverage.
- **Regression tests** — every phase verifies Claude and pi still work identically (docker builds, test suite, smoke E2E).
- **Type discipline verification** — a code reviewer confirms all SDK-originating types are imported from `@openai/codex-sdk` and no parallel interface was introduced. A simple grep during code review: `grep -nE 'interface (Thread|Turn|Codex|Item|Event)' src/providers/codex-adapter.ts` should return zero user-defined matches (only `extends` / `implements` on our own contracts).

## Outcome

_Completed: 2026-04-09 by Claude (implementing skill, Critical autonomy)._

### What shipped

Phases 1-7 + 9. Phase 8 (ChatGPT subscription OAuth) was deferred to a follow-up PR per Taras's decision so this PR stays focused on core provider support — users authenticate via `OPENAI_API_KEY` env var or a pre-existing `~/.codex/auth.json` (e.g. from `codex login`).

**New files:**
- `src/providers/codex-adapter.ts` — `CodexAdapter` + `CodexSession` implementing `ProviderAdapter` over `@openai/codex-sdk@0.118.0`
- `src/providers/codex-agents-md.ts` — `writeCodexAgentsMd()` manages a `<swarm_system_prompt>` block in `AGENTS.md` (reversible cleanup, seeds from `CLAUDE.md` when bootstrapping)
- `src/providers/codex-models.ts` — typed model catalogue (gpt-5.4 default, gpt-5.4-mini, gpt-5.3-codex with 1M context window, gpt-5.2-codex), shortname resolver, per-model context windows
- `src/providers/codex-skill-resolver.ts` — `resolveCodexPrompt()` inlines `~/.codex/skills/<name>/SKILL.md` for leading slash-command prompts
- `src/providers/codex-swarm-events.ts` — `createCodexSwarmEventHandler()` provides adapter-side cancellation polling (lower latency than runner-side), tool-loop detection, heartbeat, activity ping, and context-usage forwarding
- `scripts/check-codex-default-model.sh` — CI guard asserting Dockerfile baseline matches `CODEX_DEFAULT_MODEL`
- Test files: `codex-adapter.test.ts` (33 tests), `codex-skill-resolver.test.ts` (9 tests), `codex-swarm-events.test.ts` (9 tests)

**Modified:**
- `src/providers/index.ts` — factory `case "codex"` + updated error message
- `src/tests/provider-adapter.test.ts`, `src/tests/provider-command-format.test.ts` — codex factory + command format coverage
- `src/tests/runner-fallback-output.test.ts` — side-fixed long-standing `pi-mono` typo (silently fell to error path) and added a codex case
- `Dockerfile.worker` — installs `@openai/codex@0.118.0`, writes baseline `~/.codex/config.toml`, copies `plugin/commands/*.md` → `~/.codex/skills/<name>/SKILL.md`
- `docker-entrypoint.sh` — codex auth validation branch, codex binary check, skill sync loop extension
- `docker-compose.example.yml`, `docker-compose.local.yml` — codex-worker service example (gated behind `codex` profile)
- `README.md`, `CLAUDE.md`, `CHANGELOG.md` — multi-provider docs updated
- `package.json`, `bun.lock` — `@openai/codex-sdk@^0.118.0`

### Deviations from the plan (and why)

1. **`systemPrompt` handling: AGENTS.md block instead of `baseInstructions`/`developerInstructions`** — Phase 1 discovered the SDK's `ThreadOptions` does NOT expose either field. Taras chose Option B (managed `<swarm_system_prompt>` block in AGENTS.md) which preserves any user-authored AGENTS.md content. This also superseded Phase 4 §3's planned symlink approach — Phase 4 now relies on the Phase 2 helper.
2. **SDK type extraction simplified** — the plan suggested `Awaited<ReturnType<Thread["runStreamed"]>>` tricks; turns out `@openai/codex-sdk@0.118.0` exports the full tagged union (`ThreadEvent`, `ThreadItem`, all variant types) as named types, so the gymnastics weren't needed.
3. **`AbortController.signal` works on `runStreamed()` in 0.118.0** — the plan flagged a possible workaround for [openai/codex#5494](https://github.com/openai/codex/issues/5494); the workaround is unnecessary, standard AbortController flow works for both `run()` and `runStreamed()`.
4. **`CodexOptions.config` accepts structured objects** — confirmed `CodexConfigObject` is recursive, so we pass nested `{ mcp_servers: { foo: { ... } } }` directly without pre-flattening to dotted paths. Resolves OA2 from the plan's review errata.
5. **`CodexOptions.env` does NOT inherit from `process.env`** — gotcha discovered in Phase 1; Phase 3's `createSession` builds a minimal explicit env (`PATH`, `HOME`, `OPENAI_API_KEY`, `NODE_EXTRA_CA_CERTS`) before constructing `new Codex({ env, config })`.
6. **Model catalogue uses placeholder names that match the plan's research date** — actual API-addressable Codex models on the day of merge may differ; `src/providers/codex-models.ts` is the single source of truth and should be bumped when OpenAI ships new models.
7. **Phase 5 swarm event handler is leaner than the plan's draft** — the runner already calls `/api/active-sessions`, `/api/tasks/{id}/finish`, and `/api/tasks/{id}/progress` for any `ProviderSession`. The codex-side handler only adds the *unique* hooks: lower-latency cancellation poll on tool_start, tool-loop detection (via shared `src/hooks/tool-loop-detection.ts`), heartbeat + activity ping, and context-usage forwarding. Avoids duplicate work between runner and adapter layers.
8. **Phase 8 deferred** — ChatGPT subscription OAuth (port from pi-mono) is intentionally not in this PR. Tracked as a follow-up.

### Open follow-ups

- **Phase 8 (Codex ChatGPT subscription OAuth)** — port pi-mono's flow to allow billing parity with ChatGPT Plus/Pro subscriptions. Tracked separately.
- **Task-completion E2E against a real backend** (deferred to Taras) — the verify-plan pass confirmed the image builds, all three providers (claude/pi/codex) boot cleanly, the codex container passes entrypoint validation with `OPENAI_API_KEY`, fails fast without it, and the Codex SDK successfully runs a streamed turn end-to-end against `gpt-5.4` using `OPENAI_API_KEY` alone (no `codex login` required, because the SDK uses `codex app-server` which reads the env var directly — unlike the top-level `codex exec` command which needs `codex login --with-api-key`). What's still pending: a real task routed through a running API server to a codex worker, plus cancellation-latency verification. See the "Manual E2E" section above for exact commands.
- **`scripts/e2e-docker-provider.ts` codex extension** — the existing script supports `claude`, `pi`, `both`; a `codex` test case should mirror them for CI smoke coverage. Not blocking.
- **Streaming deltas** — `item.updated` events currently surface only as `raw_log`. UI streaming-deltas would require new `ProviderEvent` variants. Out of scope for v1.
- **Codex `plan` / `reasoning` items** — surface as `raw_log` only. Promoting them to first-class UI features is a follow-up.

### Verify-plan addendum (2026-04-09, Claude)

Post-implementation audit re-ran every automated check, built the Docker image, and executed the task-completion + cancellation E2E against a local API server. Two real bugs were found and fixed during the pass (commit `b9e97df` — `fix(providers/codex): wire codexPathOverride + bootstrap auth.json`):

**Bug 1 — SDK can't resolve `@openai/codex` inside the Bun-compiled binary.**
The `@openai/codex-sdk` bundled inside `agent-swarm`'s compiled executable calls `require.resolve("@openai/codex/package.json")` to locate the Codex CLI binary. That resolution fails at runtime because the globally-installed `@openai/codex` package (at `/usr/lib/node_modules/@openai/codex`) is not part of the Bun bundle's virtual module graph, and Node's resolver walks from the bundle's path — never seeing the global install. First E2E task failed with `Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.`

Fix: `CodexAdapter.createSession` reads `CODEX_PATH_OVERRIDE` from env and forwards it to `new Codex({ codexPathOverride })`. `Dockerfile.worker` sets `ENV CODEX_PATH_OVERRIDE=/usr/bin/codex` so the SDK spawns the global CLI wrapper script (`/usr/lib/node_modules/@openai/codex/bin/codex.js`) directly. Local dev with `@openai/codex-sdk` installed as a regular node_modules dependency continues to work via the SDK's own `findCodexPath` fallback (env var unset → SDK resolves `@openai/codex` from its own `createRequire` context).

**Bug 2 — Codex CLI's `exec --experimental-json` does NOT read `OPENAI_API_KEY` from env.**
The host-side SDK smoke test during the initial verify-plan run worked because the host's `~/.codex/auth.json` was already populated from a prior `codex login` session — that had masked the real behavior. Inside a fresh container with only `OPENAI_API_KEY` in env, the codex CLI's `exec` subcommand (which the SDK spawns under the hood) 401s at `wss://api.openai.com/v1/responses` because there's no persistent `auth.json` to read credentials from. The Codex CLI's top-level help string is clear in hindsight: `codex login --with-api-key` explicitly reads the key from stdin and stores it in `auth.json`.

Fix: `docker-entrypoint.sh`'s codex branch now bootstraps `~/.codex/auth.json` at boot time by piping `OPENAI_API_KEY` through `codex login --with-api-key`. The bootstrap runs as the worker user (via `gosu worker`) so the resulting `auth.json` is owned by `worker:worker` and readable by the later `gosu worker /usr/local/bin/agent-swarm worker` invocation. Idempotent: skips if `auth.json` already exists (volume-mounted, pre-seeded, or from a previous boot).

**Minor gotcha encountered along the way.** The initial attempt at the auth bootstrap ran as root (before the `gosu worker` privilege drop at the end of the entrypoint), which created `/home/worker/.codex/auth.json` with `root:root` ownership and mode `0600`. The worker process then hit `Permission denied (os error 13)` because it couldn't open its own auth file. Moving the bootstrap inside a `gosu worker bash -c '...'` invocation fixed it.

**E2E scenarios verified end-to-end against a running API server** (`PORT=3994`, fresh DB, single codex worker container, `OPENAI_API_KEY` from `.env`):

1. **Task completion** — `task_id=68114788-ddf0-45e5-b4d6-3e40a83879a3`, prompt `"Reply with only the single word: ok"`. Completed in ~24s. Full event sequence in the container logs: `turn.started → item.completed (agent_message "Using work-on-task...") → item.completed (×3 more) → item.completed (agent_message "DONE") → turn.completed (usage: input_tokens=174949, cached_input_tokens=145152, output_tokens=...)`. Task record persisted `status=completed`, `claudeSessionId=019d73c6-d224-70d3-8c31-0024f14f9fb5` (codex thread_id stored in the `claude_session_id` column — reused for cross-provider session tracking), `peakContextPercent=0.87892`, `totalContextTokensUsed=175784`, `contextWindowSize=200000` (from `codex-models.ts`), `output="Completed the direct response task by producing the required single-word reply: ok"`, `progress="🔧 store-progress"`.

2. **Cancellation** — `task_id=9fd7edf9-4688-40b9-93cb-df6ecd5395d5`, prompt `"Count slowly from 1 to 100, explaining each number in detail"`. Let run 12s, then `POST /api/tasks/{id}/cancel`. Task transitioned to `cancelled` with `failureReason="Cancelled by user"` within **1 second**. Container log: `[worker] Task 9fd7edf9 completed with exit code 130 (trigger: task_assigned)` → `[worker] Detected error for task 9fd7edf9: cancelled` → worker returns to `Polling for triggers`. Abort signal propagates correctly through the adapter's `AbortController.abort()` → `CodexExec` `signal` path (OA3 confirmed in production).

3. **Worker recovery** — immediately after the cancellation, a new task `a7120f11-0e9b-47b7-8f82-58c249f833dc` was submitted to the same worker. Completed successfully, proving the worker survives the cancellation cycle and returns to normal polling.

**Minor finding (non-blocking):** the task record stores `peakContextPercent` and `totalContextTokensUsed` correctly (emitted by the adapter's `context_usage` event forwarded to `POST /api/tasks/{id}/progress`), but `cost`, `inputTokens`, `outputTokens` fields on the task API response were empty. The adapter's `buildCostData()` forwards `input_tokens` / `output_tokens` / `cached_input_tokens` from `turn.completed.usage` into a `ProviderEvent.result.cost` event (`codex-adapter.ts:370-382`). Whether the runner/API persists that into task-level fields for non-claude providers is a follow-up investigation — the event IS emitted; the question is whether the runner's `result`-event handling path writes the cost to the task row for `provider=codex` tasks the same way it does for claude. Not a blocker for the core provider feature; tracked below.

**Plan-level audit summary:**
- **All automated success criteria pass** — `tsc:check`, `lint:fix`, 2372/2372 tests, db-boundary, codex-default-model guard, `bash -n docker-entrypoint.sh`, full Docker build, in-image probe for `codex --version`/config.toml/skills, claude+pi binary presence regression.
- **Container-startup smoke passed for all three providers** from the fresh image (`Harness Provider: claude|pi|codex`), and the codex branch fails fast when `OPENAI_API_KEY` is missing.
- **Review Errata OA1/OA2/OA3 promoted to Applied (I11/I12/I13)** — all three were resolved during implementation per the Deviations log; OA3 (`AbortController` through `runStreamed()`) also verified in the cancellation E2E above.
- **Quick Verification Reference file list updated** — added the six files that were added during implementation but missed from the original file map.
- **CI merge-gate** — runs on GitHub (PR: desplega-ai/agent-swarm#321). Status not checked at addendum time.

**Remaining follow-ups** (not blockers for this PR):
- Investigate whether the runner persists `result.cost` (input/output tokens) onto task-level fields for non-claude providers. Context-usage is already flowing; cost/token totals on the task row may just need one handler path.
- `scripts/e2e-docker-provider.ts` does not yet support a `codex` test case (only `claude | pi | both`); extending it would give CI smoke coverage for the full task-completion path instead of relying on the manual E2E block in this plan.

## References

- GitHub issue: https://github.com/desplega-ai/agent-swarm/issues/100 (Codex support)
- Prior plan (provider abstraction): `thoughts/taras/plans/2026-03-08-pi-mono-provider-implementation.md`
- Prior research: `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md`, `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md`
- Codex SDK (npm): https://www.npmjs.com/package/@openai/codex-sdk
- Codex SDK (source): https://github.com/openai/codex/tree/main/sdk/typescript
- Codex app-server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex developer docs: https://developers.openai.com/codex/app-server, https://developers.openai.com/codex/sdk
- Key source files:
  - `src/providers/types.ts:1-88` (ProviderAdapter contract — unchanged)
  - `src/providers/index.ts:15-24` (factory — one case added)
  - `src/providers/pi-mono-adapter.ts` (closest template for CodexAdapter structure)
  - `src/providers/claude-adapter.ts` (reference for MCP per-session config pattern)
  - `src/commands/runner.ts:2135` (integration point — unchanged)
  - `Dockerfile.worker:84-154` (provider install + skill copy patterns)
  - `docker-entrypoint.sh:4-40,703-716` (auth validation + skill sync loop)

---

## Review Errata

_Reviewed: 2026-04-09 by Claude (desplega:reviewing skill, Critical autonomy, auto-apply mode)._

Verified against actual codebase at `/Users/taras/worktrees/agent-swarm/2026-04-09-codex-support-100` and external Codex SDK docs (npm, developers.openai.com/codex, openai/codex GitHub issues) on 2026-04-09.

### Applied — Critical

- [x] **C1. Abort mechanism is `AbortController + signal`, not `thread.interrupt()`** — Phase 2 §3 rewritten. The Codex SDK does not expose `Thread.interrupt()`; the supported abort path is `thread.run(prompt, { signal: controller.signal })`. Tracked by [openai/codex#5494](https://github.com/openai/codex/issues/5494). The plan now stores an `AbortController` per turn and calls `controller.abort()` from `CodexSession.abort()`.
- [x] **C2. MCP config uses verified key names** — Phase 3 §2 rewritten. Codex expects `url` + `http_headers` (not `endpoint` / `headers`), plus `bearer_token_env_var`, `enabled`, `startup_timeout_sec`, `tool_timeout_sec`. Verified against [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp). Also clarified: Streamable HTTP + stdio are supported; SSE is not yet (tracked in [openai/codex#2129](https://github.com/openai/codex/issues/2129)).
- [x] **C3. API endpoint paths corrected** — Phase 5 §1 rewritten and Manual E2E §4-5 corrected. Three cited endpoints did not exist:
  - `POST /api/tasks/{taskId}/sessions` → corrected to `POST /api/active-sessions` (check `src/http/session-data.ts` for exact shape during implementation)
  - `GET /api/tasks/{taskId}/cancel-status` → corrected to `GET /cancelled-tasks?taskId={taskId}` (the runner at `runner.ts:2818` uses this)
  - `POST /api/tasks/{taskId}/assign` → does not exist; E2E now pre-assigns at task creation time via `agentId` field in the `POST /api/tasks` payload, with a ⚠️ note to verify the exact field name against `src/http/tasks.ts:29`
- [x] **C4. Phase 5 architecture clarified as dual-layer** — Phase 5 Overview rewritten to explicitly describe the two layers: (a) runner-side provider-agnostic polling at `runner.ts:2812-2841` that already works for any `ProviderSession`, (b) adapter-side event-stream observer added in this phase for lower-latency tool-start cancellation checks. The plan now also clarifies that Codex's SDK lacks a preToolUse blocking hook — the adapter layer can only *accelerate* the abort signal, not *block* tool execution like pi-mono can.
- [x] **C5. `gpt-5.3-codex-spark` dropped from model catalogue** — Phase 3 §0 (`src/providers/codex-models.ts` example) and Key Discoveries updated. The Spark model is a ChatGPT Pro research preview, not API-addressable at launch. Including it would cause runtime errors if selected via `MODEL_OVERRIDE`.

### Applied — Important

- [x] **I1. Malformed issue URL** — `https://github.com/desplega-ai/issues/100` → `https://github.com/desplega-ai/agent-swarm/issues/100` (repo slug verified via `git remote -v`). Replaced in frontmatter and References section.
- [x] **I2. `ProviderSession.dispose()` removed** — Phase 2 §3 no longer references a `dispose()` method. The interface (`src/providers/types.ts:62-68`) has only `sessionId`, `onEvent`, `waitForCompletion`, `abort`. Cleanup happens in a `try/finally` block around the event loop (parity with `pi-mono-adapter.ts` ~line 323).
- [x] **I3. ProviderEvent variant count corrected** — Current State Analysis updated from "10 event variants" to **11 variants**: `session_init`, `message`, `tool_start`, `tool_end`, `result`, `error`, `raw_log`, `raw_stderr`, `custom`, `context_usage`, `compaction`.
- [x] **I4. `ProviderSession` interface documented** — Current State Analysis now explicitly calls out the interface shape (`:62-68`) to avoid Phase 2 / Phase 5 drift.
- [x] **I5. Pi-mono adapter line ranges corrected** — Current State Analysis and Phase 2/3/4 cross-references:
  - shortnames map: `67-107` → `71-75`
  - `createAgentsMdSymlink`: `110-135` → `110-123`
  - log file writing: `168-179` → `169-177`
  - MCP discovery: `418-485` → starts at `421`
- [x] **I6. `pi` vs `pi-mono` inconsistency flagged** — Current State Analysis now explicitly states the factory accepts `"claude"` and `"pi"` only (not `"pi-mono"`), and points out the pre-existing `runner-fallback-output.test.ts:243` bug that sets `HARNESS_PROVIDER="pi-mono"`. Phase 7 §6 now includes a side-fix for that test.
- [x] **I7. `gpt-5.2-codex` retirement date softened** — The specific "retires 2026-06-05" claim could not be verified against primary sources (June 5 2026 is the ChatGPT `gpt-5.2 Thinking` retirement, a different product line). Replaced with a link to the OpenAI API deprecations page.
- [x] **I8. `baseInstructions` / `developerInstructions` flagged for verification** — Current State Analysis now carries a ⚠️ note that the exact `ThreadStartParams` field names need to be verified against `sdk/typescript/src/types.ts` at Phase 1 implementation time. Search snippets confirmed `workingDirectory`, `skipGitRepoCheck`, `sandboxMode`, `approvalPolicy`, `model` but did not confirm the two instruction fields.
- [x] **I9. SSE MCP transport clarification** — Phase 3 §2 explicitly notes that Streamable HTTP + stdio are supported and SSE is NOT (cites openai/codex#2129). The original phrasing "Skip stdio transports if Codex config doesn't support them" was backwards — stdio is supported; SSE is the unsupported one.
- [x] **I10. Pi-mono OAuth source URL flagged** — Phase 8 Overview and Key Discoveries both carry ⚠️ notes that the URL `https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/openai-codex.ts` should be verified before porting (conflicts with `@mariozechner/pi-coding-agent` referenced elsewhere). Check `node_modules/@mariozechner/pi-coding-agent/package.json` `repository` field to resolve.
- [x] **I11. OA1 — SDK event/item names confirmed** — Resolved during Phase 2 implementation. `@openai/codex-sdk@0.118.0` exports `ThreadEvent` and `ThreadItem` as named types (`src/providers/codex-adapter.ts:60-61`); the adapter's `handleEvent()` switches directly on the SDK-emitted variants (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed` — `codex-adapter.ts:441-570`). The speculated `thread.error`, `user_message`, and `dynamic_tool_call` were plan speculation that turned out not to exist in the SDK surface and were dropped. Covered by 33 passing tests in `src/tests/codex-adapter.test.ts`. See Deviations §2.
- [x] **I12. OA2 — `new Codex({ config })` accepts structured objects** — Resolved during Phase 3 implementation. `CodexOptions.config` is typed as `CodexConfigObject` which is recursive, so the adapter passes nested `{ mcp_servers: { foo: {...} } }` directly without flattening to dotted-path strings. No flattener helper was needed. See Deviations §4.
- [x] **I13. OA3 — `AbortController.signal` works on `runStreamed()` in 0.118.0** — Resolved during Phase 2 implementation. The standard `AbortController` flow works for both `thread.run()` and `thread.runStreamed()`; the fallback flag + `shutdown?.()` workaround documented in Phase 2 §3 was not needed. Verified by the abort test in `src/tests/codex-adapter.test.ts`. See Deviations §3.

### Remaining — Open questions for Taras

_None._ All open questions from the original review were resolved during implementation — see I11/I12/I13 above.

### Not addressed (intentionally left as-is)

- The `Awaited<ReturnType<Thread["runStreamed"]>>` type-extraction trick in Phase 1 §2 works but is fragile if the SDK changes — accepted as a trade-off for not duplicating SDK types.
- The `durationMs: 0` / `totalCostUsd: 0` comment in Phase 2 §2 compares to pi's behavior but doesn't cite a line number — low-value to fix.
- Event mapping table's `item.updated` → `raw_log` decision means the UI gets no streaming deltas. Called out in "What We're NOT Doing"; intentional for v1.

---
date: 2026-05-28T12:00:00Z
topic: "Context-Mode MCP Wiring for Swarm Workers"
status: completed
autonomy: critical
commit_per_phase: true
---

# Context-Mode MCP Wiring for Swarm Workers — Implementation Plan

## Overview

Wire context-mode's `ctx_*` tools into agent-swarm workers across all four harnesses (Claude, Codex, pi, OpenCode) so they actually load at runtime. Today, context-mode is installed and advertised in the worker image but never loaded — Claude's `--strict-mcp-config` filters it out, and the other three providers have no wiring at all.

- **Motivation**: Workers are told the `ctx_*` tools exist (system prompt) but can't use them, wasting context on phantom tool descriptions and depriving workers of context-window compression.
- **Related**: [`thoughts/taras/research/2026-05-28-context-mode-mcp-setup-across-harnesses.md`]

## Current State Analysis

### Docker Image (Dockerfile.worker)

context-mode is installed as a **Claude Code plugin only** (`Dockerfile.worker:155-156`):
```
claude plugin marketplace add mksglu/claude-context-mode
claude plugin install context-mode@context-mode --scope user
```
This places files at `~/.claude/plugins/cache/context-mode/context-mode/<version>/`. The image bakes permissions (`mcp__context-mode__*`), `enabledMcpjsonServers: ["context-mode"]`, and `enableAllProjectMcpServers: true` into `~/.claude/settings.json` (`Dockerfile.worker:168-180`).

**Not globally installed via npm** — `context-mode` CLI binary is NOT on PATH. No `npm install -g context-mode` exists in the Dockerfile.

### Claude Adapter (`src/providers/claude-adapter.ts`)

- `createSessionMcpConfig` (`:223-268`) walks cwd→root collecting `.mcp.json` files, merges API-installed servers via `mergeMcpConfig` (`:180-212`), writes to `/tmp/mcp-<taskId>.json`.
- `buildCommand` (`:444-447`) passes `--mcp-config <path> --strict-mcp-config` — restricts Claude Code to **only** the per-session config file.
- Plugin-provided MCP servers are structurally excluded. The per-session config contains `agent-swarm` + optional `agentmail` + API-installed servers. context-mode is never there.
- **Result**: `ctx_*` tools never load despite being installed and enabled.

### Codex Adapter (`src/providers/codex-adapter.ts`)

- `buildCodexConfig()` (`:253-364`) builds a JS object with `mcp_servers` map, SDK flattens to `--config` CLI flags.
- Only contains `agent-swarm` + API-installed servers. No context-mode entry.
- No `[features].hooks`/`plugin_hooks` flags set (those are for context-mode's Codex plugin path, which the swarm doesn't use).
- The subprocess env is minimal (PATH, HOME, API keys) — `context-mode` would need to be on PATH.

### Pi-Mono Adapter (`src/providers/pi-mono-adapter.ts`)

- Runs **in-process** (no child process). Connects to MCP servers via custom `McpHttpClient` (HTTP JSON-RPC).
- Discovers tools from swarm endpoint + API-installed servers at session creation.
- **Only supports HTTP/SSE transport** — stdio servers are silently skipped (`:683-689`).
- context-mode runs as a stdio MCP server — incompatible with pi-mono's MCP client without a bridge.

### OpenCode Adapter (`src/providers/opencode-adapter.ts`)

- Spawns via `@opencode-ai/sdk`. MCP configured declaratively in `/tmp/opencode-<taskId>.json`.
- Config has `mcp` block (swarm + installed) and `plugin` array (swarm plugin only).
- context-mode for OpenCode is an **in-process plugin** (`plugin: ["context-mode"]`), NOT an MCP server — adding both causes zero tools (dual-registration caveat in upstream research).
- Supports both stdio and HTTP/SSE transports for `mcp` entries, but context-mode should use the plugin path.

### System Prompt

`src/prompts/session-templates.ts:373-383` defines `system.agent.context_mode` which advertises `ctx_*` tools in worker prompts. This block is included for local providers (Claude, Codex, pi, OpenCode) and excluded for remote providers (devin, claude-managed) via provider traits. Workers are **told** the tools exist but can't use them.

## Desired End State

After this work:
1. Claude workers load `ctx_*` tools via a stdio MCP server entry in the per-session config (survives `--strict-mcp-config`). Plugin hooks (SessionStart routing, PreToolUse safety blocks, PostToolUse capture, PreCompact snapshots) already fire via the installed plugin — verified, not broken by `--strict-mcp-config`.
2. Codex workers load `ctx_*` tools via an `mcp_servers` config entry. Plugin hooks fire via installed Codex plugin + `features.hooks`/`plugin_hooks` flags.
3. OpenCode workers load `ctx_*` tools AND hooks via the in-process plugin mechanism (`plugin: ["context-mode"]` — provides both tools and 5 hook surrogates).
4. Pi-mono workers: deferred (DES-514). Prompt block excluded so we don't advertise phantom tools.
5. The `system.agent.context_mode` prompt block remains as-is (already correct routing).
6. context-mode inclusion is gated so builds/deploys without it don't break.

## What We're NOT Doing

- **Not modifying context-mode upstream** — all changes are in the agent-swarm adapter layer.
- **Not adding context-mode to the API "installed MCP servers"** mechanism — it's a pre-installed tool, not a user-configured server.
- **Not changing `--strict-mcp-config`** — it exists for good reasons (isolation, no rogue `.mcp.json` injection). We include context-mode in the strict allow-set instead.
- **Not resolving potential hook overlap** — both swarm hooks and context-mode hooks may fire for the same events (e.g., SessionStart). They have different purposes (swarm: identity/task sync; context-mode: routing injection) and Claude Code runs all matching hooks. The redundancy is harmless and reinforcing.

## Implementation Approach

- **Global npm install** (`npm install -g context-mode@<pinned-version>`) in Dockerfile.worker. Puts `context-mode` on PATH (for Claude/Codex stdio MCP) AND makes the package importable (for OpenCode in-process plugin). Version-pinned like other global deps.
- **Pin Claude plugin**: Use the same `CONTEXT_MODE_VERSION` ARG for the Claude plugin install. Keep both installs — the plugin provides hooks; the global install provides the CLI binary + package importability.
- **Install Codex plugin**: Add `codex plugin marketplace add mksglu/context-mode` + install to Dockerfile.worker. Set `features.hooks = true` + `plugin_hooks = true` in `buildCodexConfig()` so the plugin's hooks fire.
- **Env-gated inclusion**: `CONTEXT_MODE_DISABLED=true` opts out. Each adapter checks before adding entries. Default: enabled (Docker always has it installed).
- **Claude**: Add a `context-mode` stdio entry to the per-session MCP config in `createSessionMcpConfig`. Hooks already work via the installed plugin — `--strict-mcp-config` only suppresses MCP servers, not plugin hooks.
- **Codex**: Add a `context-mode` entry to `mcp_servers` in `buildCodexConfig()` + feature flags for hooks from the installed plugin.
- **OpenCode**: Add `"context-mode"` to the `plugin` array (NOT the `mcp` block — dual-registration causes zero tools). The in-process plugin provides both tools AND hook surrogates.
- **Pi**: Deferred to follow-up (DES-514). Remove `context_mode` prompt block from pi system prompt so we don't advertise phantom tools.

## Quick Verification Reference

- `bun run tsc:check`
- `bun run lint`
- `bun test`
- `bash scripts/check-db-boundary.sh`
- `bash scripts/check-api-key-boundary.sh`
- `docker build -f Dockerfile.worker .` (if Dockerfile touched)

---

## Phase 1: Docker Image — Global Install + Plugin Installs + Env Gate

### Overview

Add `context-mode` as a globally-installed npm package (version-pinned), pin the Claude plugin install to the same version, install the Codex plugin, and introduce the `CONTEXT_MODE_DISABLED` env gate. After this phase, `context-mode` is on PATH, importable, and has plugins registered for both Claude and Codex.

### Changes Required:

#### 1. Dockerfile.worker — Version ARG + Global install
**File**: `Dockerfile.worker`
**Changes**:
- Add `ARG CONTEXT_MODE_VERSION=1.0.151` (or latest stable) near the other harness CLI version ARGs (around line 89-93).
- Add `RUN sudo npm install -g context-mode@${CONTEXT_MODE_VERSION}` in the `USER worker` section, after the existing harness CLI installs (around line 142). Follows the same pattern as Claude Code, Pi, Codex, and OpenCode SDK installs. No `/opt/global-deps` staging needed.

#### 2. Dockerfile.worker — Pin Claude plugin
**File**: `Dockerfile.worker`
**Changes**:
- The existing Claude plugin install at lines 155-156 uses marketplace (unpinned). Keep the marketplace add but pin the plugin install. Since `claude plugin install` pulls from the local marketplace clone, the version is whatever commit is checked out. To pin: after `claude plugin marketplace add`, check out a specific tag/commit matching `CONTEXT_MODE_VERSION`:
  ```dockerfile
  && claude plugin marketplace add mksglu/claude-context-mode || true \
  && cd ~/.claude/plugins/marketplaces/context-mode && git checkout v${CONTEXT_MODE_VERSION} 2>/dev/null; cd /workspace \
  && claude plugin install context-mode@context-mode --scope user || true \
  ```
  If the marketplace repo doesn't tag releases, pin by the npm version's corresponding git commit. Verify at implementation time.

#### 3. Dockerfile.worker — Install Codex plugin
**File**: `Dockerfile.worker`
**Changes**:
- After the Codex CLI install + config.toml section (around line 130), add context-mode Codex plugin:
  ```dockerfile
  && codex plugin marketplace add mksglu/context-mode || true \
  && codex plugin install context-mode@context-mode || true \
  ```
- Update the baseline `~/.codex/config.toml` (line 119-130) to add feature flags:
  ```toml
  [features]
  hooks = true
  plugin_hooks = true
  ```

#### 4. Environment variable
**File**: No code changes needed. `CONTEXT_MODE_DISABLED` is read directly by adapters via `process.env`. Document it in `runbooks/local-development.md` alongside other env vars.

### Success Criteria:

#### Automated Verification:
- [x] Docker build succeeds: `docker build -f Dockerfile.worker .`
- [x] `context-mode` binary is on PATH in the image: `docker run --rm <img> which context-mode` → `/usr/bin/context-mode`
- [x] `context-mode` package is importable <!-- NOTE: bare `require('context-mode')` is N/A — it's a global ESM package not resolvable by name from an arbitrary cwd. Verified `import()` of the absolute plugin entry works offline (`--network none`). -->
- [x] Existing tests pass: `bun test`
- [x] Type check passes: `bun run tsc:check`

#### Automated QA:
- [x] Verify `context-mode --help` or `context-mode doctor` runs inside a fresh container

#### Manual Verification:
- [ ] Image size delta is acceptable (check `docker history` for the new layer)

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 2: Claude Adapter — Include context-mode in Per-Session MCP Config

### Overview

Inject a `context-mode` stdio MCP server entry into the per-session config built by `createSessionMcpConfig`, so it survives `--strict-mcp-config`. After this phase, Claude workers load `ctx_*` tools at session start. Plugin hooks (SessionStart routing, PreToolUse safety, PostToolUse capture, PreCompact snapshots) already fire via the installed plugin — `--strict-mcp-config` only suppresses MCP servers, not hooks.

### Changes Required:

#### 1. context-mode MCP entry helper
**File**: `src/providers/claude-adapter.ts`
**Changes**:
- In `createSessionMcpConfig` (`:223-268`), after merging `.mcp.json` layers and API servers, conditionally inject:
  ```json
  "context-mode": { "command": "context-mode" }
  ```
  into `mergedServers`, gated by `process.env.CONTEXT_MODE_DISABLED !== 'true'`.
- Place the injection **before** the `mergeMcpConfig` call so API-installed servers can still override (unlikely but safe).

#### 2. Unit tests
**File**: `src/tests/claude-adapter.test.ts`
**Changes**:
- Add test: `createSessionMcpConfig` includes `context-mode` entry when `CONTEXT_MODE_DISABLED` is unset.
- Add test: `createSessionMcpConfig` excludes `context-mode` entry when `CONTEXT_MODE_DISABLED=true`.
- Add test: `mergeMcpConfig` preserves `context-mode` entry through the merge.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun test src/tests/claude-adapter.test.ts`
- [x] All tests pass: `bun test`
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`

#### Automated QA:
- [x] `cat /tmp/mcp-<taskId>.json` in a test run shows the `context-mode` entry alongside `agent-swarm` <!-- covered by claude-adapter.test.ts unit assertions -->

#### Manual Verification:
- [ ] Start a Claude worker locally, verify `ctx stats` or `ctx doctor` tool is callable (requires Docker image from Phase 1)

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 3: Codex Adapter — Add context-mode MCP + Hook Feature Flags

### Overview

Add a `context-mode` entry to the `mcp_servers` object built by `buildCodexConfig()`, and add `features.hooks = true` + `features.plugin_hooks = true` to the config so the Codex plugin's hooks fire. After this phase, Codex workers have both `ctx_*` tools and context-mode hooks (routing, safety blocks, output capture).

### Changes Required:

#### 1. Codex config builder — MCP entry
**File**: `src/providers/codex-adapter.ts`
**Changes**:
- In `buildCodexConfig()` (`:253-364`), after building the `mcpServers` dict, conditionally add:
  ```ts
  if (process.env.CONTEXT_MODE_DISABLED !== 'true') {
    mcpServers["context-mode"] = {
      command: "context-mode",
      enabled: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    };
  }
  ```
- Follow the same entry shape as the existing `agent-swarm` and installed server entries.

#### 2. Codex config builder — Feature flags
**File**: `src/providers/codex-adapter.ts`
**Changes**:
- In the return object of `buildCodexConfig()` (`:356-363`), add the `features` block:
  ```ts
  return {
    model,
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    skip_git_repo_check: true,
    show_raw_agent_reasoning: false,
    features: { hooks: true, plugin_hooks: true },
    mcp_servers: mcpServers,
  } as CodexConfig;
  ```
- The SDK will flatten `features.hooks` → `--config features.hooks=true` and `features.plugin_hooks` → `--config features.plugin_hooks=true`. This enables the hook system + plugin-provided hooks.

#### 3. Unit tests
**File**: `src/tests/codex-adapter.test.ts` (or relevant test file)
**Changes**:
- Add test: `buildCodexConfig` includes `context-mode` mcp_server entry by default.
- Add test: `buildCodexConfig` excludes it when `CONTEXT_MODE_DISABLED=true`.
- Add test: `buildCodexConfig` includes `features.hooks` and `features.plugin_hooks` set to `true`.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun test src/tests/codex-adapter.test.ts`
- [x] All tests pass: `bun test`
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`

#### Automated QA:
- [x] Log/print the built Codex config in a test run and verify `context-mode` appears in `mcp_servers` and `features.hooks` is `true` <!-- covered by codex-adapter.test.ts unit assertions -->

#### Manual Verification:
- [ ] Start a Codex worker locally with Docker, verify `ctx_*` tools are available and hooks fire (check for routing instruction injection at session start)

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 4: OpenCode Adapter — Add context-mode to Plugin Array

### Overview

Add `"context-mode"` to the `plugin` array in the OpenCode config (NOT the `mcp` block). After this phase, OpenCode workers load `ctx_*` tools AND hooks via the in-process plugin mechanism (provides both native tools and 5 hook surrogates: tool.execute.before, tool.execute.after, chat.message, experimental.session.compacting, experimental.chat.system.transform).

### Changes Required:

#### 1. OpenCode config builder
**File**: `src/providers/opencode-adapter.ts`
**Changes**:
- In the config builder (`:592-604`), conditionally add `"context-mode"` to the `plugin` array:
  ```ts
  const plugins = [pluginPath];
  if (process.env.CONTEXT_MODE_DISABLED !== 'true') {
    plugins.push("context-mode");
  }
  // ...
  plugin: plugins,
  ```
- Ensure `context-mode` is NOT added to the `mcp` block (dual-registration = zero tools).

#### 2. Unit tests
**File**: `src/tests/opencode-adapter.test.ts` (or relevant test file)
**Changes**:
- Add test: OpenCode config includes `context-mode` in `plugin` array by default.
- Add test: OpenCode config excludes it when `CONTEXT_MODE_DISABLED=true`.
- Add test: `context-mode` does NOT appear in the `mcp` block.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun test src/tests/opencode-adapter.test.ts`
- [x] All tests pass: `bun test`
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`

#### Automated QA:
- [x] Print the written `/tmp/opencode-<taskId>.json` and verify `context-mode` is in `plugin` but not in `mcp` <!-- covered by opencode-adapter.test.ts unit assertions -->

#### Manual Verification:
- [ ] Start an OpenCode worker locally with Docker, verify `ctx_*` tools load

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 5: System Prompt — Exclude context_mode Block from Pi

### Overview

Stop advertising `ctx_*` tools to pi workers since they can't use them (deferred to DES-514). After this phase, the system prompt accurately reflects available tools for each provider.

### Changes Required:

#### 1. Prompt composition
**File**: `src/prompts/session-templates.ts`
**Changes**:
- At the point where `system.agent.context_mode` (`:373-383`) is included in composite prompts (`:556`, `:577`), add a guard that excludes it when `provider === 'pi'`.
- Alternatively, add `pi` to the exclusion list alongside `devin` and `claude-managed` if there's already such a mechanism.

#### 2. Unit tests
**File**: `src/tests/base-prompt.test.ts`
**Changes**:
- Add test: pi provider prompt excludes `context_mode` block (similar to existing test at `:417-421` for remote providers).
- Verify Claude, Codex, and OpenCode still include it.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun test src/tests/base-prompt.test.ts`
- [x] All tests pass: `bun test`
- [x] Type check: `bun run tsc:check`
- [x] Lint: `bun run lint`

#### Automated QA:
- [x] Diff the generated system prompts for each provider and confirm context_mode presence/absence is correct <!-- covered by base-prompt.test.ts unit assertions -->

#### Manual Verification:
- [ ] None — automated checks sufficient

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

## Manual E2E

After all phases are implemented, verify end-to-end in a Docker environment:

```bash
# 1. Build the worker image with the new context-mode install
docker build -f Dockerfile.worker -t agent-swarm-worker:ctx-test .

# 2. Start the API server locally
bun run start:http

# 3. Claude worker — verify ctx tools + hooks
# Create a task via API, observe worker logs for context-mode MCP initialization.
# The worker should list ctx_batch_execute, ctx_execute, ctx_search, etc. in its available tools.
# Ask the worker to run "ctx stats" — should return context-mode stats, not an error.
# Verify hooks: check session output for context-mode SessionStart routing injection
# (look for context-mode's routing block in addition to the swarm's system prompt).

# 4. Codex worker — verify ctx tools + hooks
# Switch provider to codex, create a task, verify ctx_* tools appear.
# Ask the worker to run "ctx stats".
# Verify hooks: check for routing injection at session start, PreToolUse safety blocks.

# 5. OpenCode worker — verify ctx tools + hooks
# Switch provider to opencode, create a task, verify ctx_* tools appear via plugin mechanism.
# Verify hooks: check for system.transform routing injection.

# 6. Pi worker — verify ctx tools are NOT advertised
# Switch provider to pi, create a task, verify the system prompt does NOT contain the context_mode block.

# 7. Opt-out — verify CONTEXT_MODE_DISABLED works
# Set CONTEXT_MODE_DISABLED=true, restart workers, verify no ctx_* tools load for Claude/Codex/OpenCode.
```

---

## Implementation Deviations

Captured during implementation (autopilot, 2026-05-29):

1. **Phase 4 (OpenCode) — absolute path instead of bare name.** The plan assumed `npm install -g context-mode` makes the package importable for OpenCode's in-process plugin. It does not: OpenCode resolves bare plugin names via `import(await Bun.resolve(name, …))`, which does not walk the npm global modules dir. A bare `"context-mode"` entry only resolves if Bun auto-installs from the registry at runtime (fails on network-sandboxed workers — verified with `--network none`). Fix: `opencode-adapter` now pushes the **absolute path** to the global install's built opencode plugin entry (`<npm root -g>/context-mode/build/adapters/opencode/plugin.js`), confirmed to import offline. Override via `CONTEXT_MODE_OPENCODE_PLUGIN_PATH`; skipped gracefully (with a warning) when not found.

2. **Phase 1 (Claude plugin) — left unpinned.** The build-time `git checkout v<version>` in the marketplace clone fails (`git` rejects it with "dubious ownership" and the clone is shallow without tags). The hooks-providing plugin therefore tracks marketplace HEAD; the ctx_* **tools** are served by the version-pinned global CLI, so only the (backward-compatible) hook bundle floats. Accepted as low-risk.

3. **Phase 5 (pi exclusion) — wider than 2 files.** No provider exclusion *set* existed; remote providers are excluded via composite *selection* in `getBasePrompt`. Implemented by threading `provider` through `getBasePrompt`/`runner.ts` and registering a `system.session.worker.pi` composite without the `context_mode` reference.

## Appendix

- **Research**: `thoughts/taras/research/2026-05-28-context-mode-mcp-setup-across-harnesses.md`
- **Key line references**:
  - `claude-adapter.ts:444-447` — `--strict-mcp-config` (the root cause for Claude)
  - `claude-adapter.ts:223-268` — `createSessionMcpConfig`
  - `codex-adapter.ts:253-364` — `buildCodexConfig()`
  - `pi-mono-adapter.ts:641-727` — MCP tool discovery (HTTP-only)
  - `opencode-adapter.ts:563-604` — MCP + plugin config
  - `Dockerfile.worker:155-156` — context-mode plugin install
  - `Dockerfile.worker:168-180` — baked settings.json
  - `src/prompts/session-templates.ts:373-383` — context_mode prompt block

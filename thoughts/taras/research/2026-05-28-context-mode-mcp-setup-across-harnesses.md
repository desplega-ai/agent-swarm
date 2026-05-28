---
date: 2026-05-28T00:00:00-04:00
researcher: Claude (Opus 4.8)
git_commit: 7b005dc1
branch: main
repository: agent-swarm (doc host) — subject under research is context-mode @ a5f1fb7 (v1.0.151)
topic: "How context-mode sets up / registers its MCP across the harnesses it supports (Claude Code, Codex, pi, OpenCode)"
tags: [research, context-mode, mcp, plugin, harness, claude-code, codex, pi, opencode, install, agent-swarm, strict-mcp-config]
status: complete
autonomy: verbose
last_updated: 2026-05-28
last_updated_by: Claude (Opus 4.8)
follow_ups:
  - "Why context-mode never runs in agent-swarm workers (--strict-mcp-config) — see section at end"
---

# Research: How context-mode sets up its MCP across harnesses (Claude Code, Codex, pi, OpenCode)

**Date**: 2026-05-28
**Researcher**: Claude (Opus 4.8)
**Git Commit (doc host repo)**: 7b005dc1 (agent-swarm, branch `main`)
**Subject under research**: `context-mode` v1.0.151, commit `a5f1fb7` (`ci: update install stats`), source `github.com/mksglu/context-mode`, freshly cloned to `/tmp/context-mode-latest` to guarantee latest published code. (Local marketplace clone was the older v1.0.146.)

> **Note on locations**: All `file:line` references below are relative to the context-mode repo root (`/tmp/context-mode-latest/...`), **not** the agent-swarm repo this document is filed in. The two repos are unrelated; agent-swarm is only the host for this research note.

---

## Research Question

> "I want to change how context-mode is set up so that it works in all the harnesses it supports. The current plugin approach might not work properly, as I believe it does not auto-install the MCP. Can you check how it works for the different harnesses (claude, codex, pi and opencode)?"

This document maps **as-built** how context-mode exposes its `ctx_*` tools to each of the four named harnesses, and specifically whether the MCP server is auto-installed or requires manual steps. Per the research skill it is documentarian (describes what *is*); the closing **Surface Area for Change** section adds neutral pointers to where the relevant code lives, with no recommendations.

---

## Summary

context-mode ships as a **single npm package** (`context-mode`) that simultaneously acts as (a) a stdio MCP server, (b) a `context-mode` CLI binary, and (c) a multi-format plugin/extension for ~15 harnesses. There is **no unified installer and no `install`/`setup` CLI subcommand**; instead each harness is wired by one of **three different integration models**. The user's hypothesis is correct: the "plugin approach" only auto-registers the MCP for **Claude Code** out of the box. Codex auto-registers the MCP only via its own plugin marketplace + manually-enabled feature flags; **pi** and **OpenCode** have no auto-install at all, and OpenCode deliberately runs with **no MCP child process** whatsoever.

The four named harnesses each use a distinct mechanism:
- **Claude Code** — a Claude Code plugin whose manifest declares the MCP server *inline* (`mcpServers`), so `/plugin install` registers MCP + hooks + skills automatically. This is the "fully automatic" baseline.
- **Codex** — a Codex plugin manifest pointing at `.codex-plugin/mcp.json` (stdio child). Codex's *own* plugin loader wires the MCP, but only after the user hand-enables `[features].hooks` + `[features].plugin_hooks` in `config.toml` and trusts the hooks. context-mode's adapter code **never writes the `[mcp_servers]` block** — it only writes `hooks.json` + the feature flag.
- **pi** — discovered via the npm package's top-level `"pi"` field. Pi 0.73.x has no native MCP, so context-mode's pi **extension** spawns `server.bundle.mjs` as a stdio MCP child *itself* and bridges every tool into Pi's native registry via `pi.registerTool()`. Installation into Pi is fully manual.
- **OpenCode** — an **in-process TypeScript plugin** (`opencode.json` → `"plugin": ["context-mode"]`). OpenCode `import()`s the package and calls its plugin factory in-process; the 11 `ctx_*` tools are registered from the existing tool registry **with no stdio MCP child**. Installation is fully manual.

The cross-cutting backbone is one adapter abstraction in `src/adapters/detect.ts` (`detectPlatform()` / `getAdapter()` → 15 adapters). Crucially, **adapters describe storage dirs, hook commands, and health checks — none of them write MCP configuration into a harness**. The `postinstall` script configures no harness; it only guards Linux/Node, fixes Windows shims, and self-heals the Claude Code plugin registry.

---

## At-a-glance matrix

| Harness | Integration model | Where MCP is declared | MCP transport | MCP auto-installed? | Manual steps required |
|---|---|---|---|---|---|
| **Claude Code** | Claude Code plugin (marketplace) | `.claude-plugin/plugin.json` → `mcpServers` (inline) | stdio child `node ${CLAUDE_PLUGIN_ROOT}/start.mjs` | **Yes — fully automatic** | only optional statusline edit to `~/.claude/settings.json` |
| **Codex CLI** | Codex plugin (marketplace) | `.codex-plugin/plugin.json` → `mcpServers: "./.codex-plugin/mcp.json"` | stdio child `node ./start.mjs` | **Conditional** — Codex's plugin loader wires it, gated behind manual `[features].hooks` + `plugin_hooks` flags + hook trust | enable feature flags + trust hooks; or full manual `config.toml` (`[mcp_servers.context-mode]`) + `hooks.json` on builds without `plugin_hooks` |
| **pi (Pi Coding Agent)** | npm `"pi"` extension field → `build/adapters/pi/extension.js` | no Pi-side server decl that Pi launches; the **extension** spawns the server | extension spawns `server.bundle.mjs` as stdio child, bridges via `pi.registerTool()` | **No installer** — extension self-registers once Pi loads the package, but loading it is manual | `npm i -g context-mode` → `pi install npm:context-mode` (or `settings.json` `packages`) → add `~/.pi/agent/mcp.json` → restart |
| **OpenCode** | in-process TS plugin (`opencode.json` `"plugin": ["context-mode"]`) | n/a — no MCP server; tools registered in-process | **none** (no stdio child) | **No** | npm install + edit `opencode.json` + optional `AGENTS.md` copy + restart |

---

## Detailed Findings

### 0. Shared backbone — the adapter abstraction

All harness selection flows through a single abstraction:

- `src/adapters/detect.ts` — `detectPlatform()` resolves the active harness in precedence order: MCP `clientInfo` → `CONTEXT_MODE_PLATFORM` override → platform env vars → `~/.<dir>` config-dir existence → fallback `claude-code`.
- `getAdapter()` (`src/adapters/detect.ts:560-645`) lazily imports one of **15 adapters**: `claude-code, gemini-cli, kilo, opencode, openclaw, codex, vscode-copilot, jetbrains-copilot, cursor, antigravity, kiro, zed, qwen-code, omp, pi`.
- Each adapter (`src/adapters/<harness>/index.ts`) describes storage dirs, hook command shape, capability flags, and health checks. **No adapter contains an `installHarness`/`registerHarness` function that writes MCP config** — registration is performed by the host's plugin system or by the user.
- The stdio-vs-in-process split is hardcoded in the CLI: `IN_PROCESS_PLUGIN_PLATFORMS = new Set(["opencode", "kilo"])` (`src/cli.ts:153`).

The `ctx_*` tool set (11 tools) is registered once into `REGISTERED_CTX_TOOLS` by a monkey-patched `server.registerTool` (`src/server.ts:281-296`): six sandbox tools (`ctx_batch_execute`, `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`) + five meta-tools (`ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`).

### 1. Claude Code — inline plugin `mcpServers` (fully automatic)

**Mechanism.** The Claude Code plugin manifest declares the MCP server *inline*, so installing the plugin registers the MCP automatically — no `claude mcp add`, no user `.mcp.json`.

`.claude-plugin/plugin.json:22-29`:
```json
"mcpServers": {
  "context-mode": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/start.mjs"]
  }
}
```
- Transport: stdio (default; no `url`/`type`). `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code to the installed plugin dir.
- The same command is mirrored in `.mcp.json.example:1-8` for manual/non-plugin use.
- Marketplace entry: `.claude-plugin/marketplace.json:11-32` (`source: "./"`).

**Install (automatic).** README labels this path "plugin marketplace, fully automatic" (`README.md:65`). Two lines:
```
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```
(`README.md:71-74`). README states the plugin "registers all hooks (PreToolUse, PostToolUse, PreCompact, SessionStart) and 11 MCP tools" (`README.md:86`).

**What the plugin bundles.** `plugin.json` declares only `mcpServers` (`:22-29`) and `"skills": "./skills/"` (`:30`). Hooks are discovered by convention from `hooks/hooks.json` (no `hooks` key in `plugin.json`). There is **no** `commands/` dir (slash commands are implemented as skills) and **no** `agents/` dir. The 6 skills under `skills/` surface the `/context-mode:ctx-*` slash commands.

**Hooks** (`hooks/hooks.json:1-132`): five Claude Code lifecycle hooks — PostToolUse (`:4-13`), PreCompact (`:15-25`), PreToolUse (`:26-108`), UserPromptSubmit (`:109-119`), SessionStart (`:120-130`) — each running `node "${CLAUDE_PLUGIN_ROOT}/hooks/<script>.mjs"` directly (not the `context-mode hook ...` CLI form). The SessionStart hook injects routing instructions at runtime, which is why no routing file is written to the project.

**MCP-only fallback (manual, no hooks/slash commands):** `claude mcp add context-mode -- npx -y context-mode` (`README.md:115`).

**Not auto-registered:** the optional status line — Claude Code's plugin manifest can't declare one, so it's a one-time manual edit to `~/.claude/settings.json` (`README.md:98-109`). The MCP server itself needs no manual edit.

### 2. Codex CLI — plugin `mcp.json` wired by Codex (flag-gated) + manual fallback

**Mechanism.** The Codex plugin manifest points at a separate MCP file:

`.codex-plugin/plugin.json:22-23`:
```json
"mcpServers": "./.codex-plugin/mcp.json",
"hooks": "./.codex-plugin/hooks.json",
```
`.codex-plugin/mcp.json` (full):
```json
{ "mcpServers": { "context-mode": { "command": "node", "args": ["./start.mjs"], "cwd": "." } } }
```
- stdio transport, `node ./start.mjs`.

**Two documented paths** (`README.md:521-627`):

*Plugin/marketplace path* (`README.md:526-571`):
1. `codex plugin marketplace add mksglu/context-mode` (`:528-532`).
2. Hand-enable flags in `config.toml` (`:534-540`):
   ```toml
   [features]
   plugin_hooks = true
   hooks = true
   ```
3. Restart + verify `ctx stats` (`:555`); trust hooks if prompted (`:560-562`).
- README claim (`:564-567`): "No manual `[mcp_servers.context-mode]` block or `$CODEX_HOME/hooks.json` is needed when `plugin_hooks` is enabled and the plugin hooks are trusted." Note the asymmetry: even here the user still hand-edits `[features]`; the MCP block + hooks.json are what the plugin provides.
- Flags: `[features].hooks` (preferred) / `[features].codex_hooks` (legacy alias) / `codex --enable hooks` gate hooks; `[features].plugin_hooks` is the extra gate that makes *bundled* plugin hooks fire (`README.md:542-545`). MCP works after plugin install regardless of hook flags (`README.md:557-558`, `:625`).

*Manual fallback* (Codex builds without `plugin_hooks`, `README.md:573-625`):
1. `npm install -g context-mode` (`:577-579`).
2. Hand-add to `~/.codex/config.toml` (`:581-589`):
   ```toml
   [features]
   hooks = true
   [mcp_servers.context-mode]
   command = "context-mode"
   ```
3. Hand-create `$CODEX_HOME/hooks.json` (`:591-604`).
4. Copy `configs/codex/AGENTS.md` (`:612-619`); restart (`:621`).

**Code proof context-mode never auto-writes the MCP block.** `checkPluginRegistration()` (`src/adapters/codex/index.ts:609-648`) only *reads* `config.toml` and returns a **manual** fix string (`Add [mcp_servers.context-mode] to ...`, line 639) — it never writes. `configureAllHooks()` (`:658-709`) writes only `hooks.json` (`writeHooksConfig`, line 685) and the `[features].hooks` flag (`ensureCodexHooksFeature`, `:697-705`) — no `[mcp_servers]` write. `getInstalledVersion()` returns `"standalone"` with the comment "Codex uses standalone MCP registration; there is no platform-owned plugin version" (`:650-654`). Capability flags: `canModifyArgs: false`, `canModifyOutput: false`, `canInjectSessionContext: true` (`:222-230`); Codex PreToolUse is deny/block only (no input rewrite — upstream `openai/codex#18491`).

**Hooks** (`.codex-plugin/hooks.json:3-63`): 6 events (PreToolUse, PostToolUse, SessionStart, PreCompact, UserPromptSubmit, Stop), each `node "${PLUGIN_ROOT}/hooks/codex/<event>.mjs"`. The manual-path equivalent `configs/codex/hooks.json` uses the CLI form `context-mode hook codex <event>` (`:7,14,21,28,35,42`).

**Node/PATH:** Node.js ≥ 22.5 (or Bun), Codex CLI installed (`README.md:524`). "context-mode still needs `node` visible to the Codex process … it does not vendor Node or inherit login-shell PATH fixes" (`README.md:569-571`).

### 3. pi (Pi Coding Agent) — npm `"pi"` extension that self-bridges an MCP child

**Mechanism.** pi is integrated as a **native in-process JS extension**, not a Pi-side MCP declaration. Discovery is by the published package's top-level `"pi"` field.

`package.json:30-37`:
```json
"pi": {
  "extensions": [ "./build/adapters/pi/extension.js" ],
  "skills": [ "./skills" ]
}
```
- The in-repo `.pi/extensions/context-mode/index.ts:1` is a thin shim: `export { default } from "../../../build/adapters/pi/extension.js";` (kept only as a version-sync target, `scripts/version-sync.mjs:31`; `.pi/` is **not** shipped in the npm tarball — `package.json files[]` ships `build/`).
- Real entrypoint: `src/adapters/pi/extension.ts:424` — `export default function piExtension(pi)` — wires `pi.on(...)` lifecycle hooks + `pi.registerCommand(...)`.
- `PiAdapter` declares `paradigm = "mcp-only"` with all-false capabilities (`src/adapters/pi/index.ts:67-77`) precisely so the generic JSON-stdio hook machinery never tries to register stdio hooks for Pi (`:6-19`).

**MCP via a self-spawned stdio bridge.** Pi 0.73.x has no native MCP support, so the extension spawns the server itself:
- `src/adapters/pi/extension.ts:850-897` ("MCP tool bridge #426"): spawns `resolve(pluginRoot, "server.bundle.mjs")` (`:879`) via `bootstrapMCPTools(pi, serverBundle)` (`:881`) and registers each tool with `pi.registerTool()`.
- `src/adapters/pi/mcp-bridge.ts:1-22`: spawns a long-lived stdio child, performs the MCP handshake (`protocolVersion: "2025-06-18"`, `clientInfo.name: "pi-coding-agent-context-mode-bridge"`, `:623-635`), calls `tools/list` once, and forwards each tool's `execute()` to `client.callTool(...)` → `tools/call` (`:874-905`). It spawns node/bun (never `pi` itself — fork-bomb guard #516, `:457-464`); if neither is on PATH it logs a warning and registers nothing (`:819-829`).
- The README's `~/.pi/agent/mcp.json` `{ "command": "context-mode" }` entry exists, but the functional path is the extension's own bridge child.

**Install (manual; extension self-registers once loaded).** No installer copies anything into `~/.pi/`. README (`README.md:826-868`):
1. `npm install -g context-mode`
2. `pi install npm:context-mode` (or add `{ "packages": ["npm:context-mode"] }` to `~/.pi/agent/settings.json`)
3. Add `~/.pi/agent/mcp.json`: `{ "mcpServers": { "context-mode": { "command": "context-mode" } } }`
4. Restart Pi. Routing: "Automatic" once installed (`:868`).
- **No pi branch in the CLI setup/upgrade flow.** `configureAllHooks()`, `setHookPermissions()`, `generateHookConfig()`, `updatePluginRegistry()` are explicit no-ops (`src/adapters/pi/index.ts:129-131, 218-229`). `checkPluginRegistration()` treats the presence of `~/.pi/extensions/context-mode/package.json` as "installed", fix hint `Run: context-mode upgrade` (`:162-195`).

**Hooks/routing** (`pi.on(...)` callbacks in `extension.ts:446-797`): `session_start` (init), `tool_call` (PreToolUse — blocks inline HTTP / unsafe curl/wget), `tool_result` (PostToolUse capture), `before_agent_start` (SessionStart-equivalent — re-injects the routing block **every turn** because Pi rebuilds the system prompt each turn, `:619-626`), `before_provider_response`, `session_before_compact` (resume snapshot), `session_compact`, `session_shutdown` (shuts the bridge down). Slash commands `ctx-stats` / `ctx-doctor` (`:801,814`). Instruction file: `AGENTS.md` (`configs/pi/AGENTS.md`).

**Prerequisites:** Node.js ≥ 22.5 (or Bun), Pi installed (`README.md:828`); node/bun must be on PATH for the bridge.

### 4. OpenCode — in-process TS plugin, no MCP child (+ KiloCode, vs OpenClaw)

**Mechanism.** OpenCode loads the npm package as an in-process plugin. Config is minimal — `configs/opencode/opencode.json:1-6`:
```json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["context-mode"] }
```
- The package `main`/`exports["."]` point at the compiled OpenCode plugin so `import("context-mode")` resolves to it (`package.json:51-56`).
- `createContextModePlugin` builds native tools by importing the existing MCP registry **without starting any stdio transport** (`src/adapters/opencode/plugin.ts:375-391`, gated by `CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS=1`), maps each `REGISTERED_CTX_TOOLS` entry into a native OpenCode tool with the same Zod schema + handler (`:414-458`), and returns `tool: nativeTools` (`:466-469`). Adapter `paradigm = "ts-plugin"` (`src/adapters/opencode/index.ts:96`).
- README (`:422`): "the `plugin` entry registers all 11 `ctx_*` tools natively … there is no redundant stdio MCP child per session."

**Dual-registration caveat.** If a config has BOTH `plugin: ["context-mode"]` AND `mcp.context-mode`, OpenCode registers **zero** tools (`README.md:436`). Suppression logic: `shouldSuppressMcpToolsForNativePluginHost()` (`src/server.ts:105-114`) returns true for opencode/kilo when both entries exist; `registerTool` then short-circuits and an empty `tools/list` is installed (`:276-296`). `context-mode upgrade` strips the legacy `mcp.context-mode` entry; `ctx_doctor` warns (`src/adapters/opencode/index.ts:420-424`).

**Install (fully manual).** `README.md:407-434`: add `"plugin": ["context-mode"]` to `opencode.json` (project or `~/.config/opencode/opencode.json`); optionally `cp node_modules/context-mode/configs/opencode/AGENTS.md AGENTS.md`; restart; verify `ctx stats`. Nothing is automatic; routing-file auto-write was deliberately removed (`README.md:1223`, issues #158/#164; plugin header `plugin.ts:20-21`).

**Hooks (5 surrogates):** `tool.execute.before` (PreToolUse — throws to block, `:473-500`), `tool.execute.after` (PostToolUse + first-fire AGENTS.md scan, `:504-528`), `chat.message` (UserPromptSubmit surrogate, `:536-567`), `experimental.session.compacting` (PreCompact / resume snapshot, `:571-621`), `experimental.chat.system.transform` (SessionStart surrogate — injects routing block + resume snapshot, `:630-699`). There is **no real SessionStart hook** in OpenCode (`README.md:440`; issues #14808, #5409).

**KiloCode = same adapter.** `plugin.ts` is "OpenCode / KiloCode TypeScript plugin entry point" (`:1`); one `OpenCodeAdapter` serves both (`PlatformId "opencode" | "kilo"`, `index.ts:90-95`), differing only in config paths (`kilo.json`, `~/.config/kilo/`, `index.ts:229-241`) + a zod3→zod4 shim. Install is the same manual flow (`README.md:447-472`).

**OpenClaw ≠ OpenCode.** OpenClaw is a *separate* harness with its own `OpenClawAdapter` (`src/adapters/openclaw/index.ts:75`), config shape (`configs/openclaw/openclaw.json:1-13`, `plugins.entries...` not a `plugin` array), and a **scripted installer** `npm run install:openclaw` → `scripts/install-openclaw-plugin.sh` (builds TS, rebuilds better-sqlite3, copies the plugin into `$OPENCLAW_STATE_DIR/extensions/context-mode`, registers it, signals the gateway via SIGUSR1). It registers as a native gateway plugin via `api.on()`/`api.registerHook()` with no separate MCP server (`README.md:483-517`). So the repo-root `.openclaw-plugin/` dir is **unrelated** to the opencode harness.

### 5. Shared install / CLI machinery

**Package shape** (`package.json`): `"bin": { "context-mode": "./cli.bundle.mjs" }` (`:58-60`); `"main": "./build/adapters/opencode/plugin.js"` + `exports` (`.`, `./plugin`, `./openclaw`, `./cli`); plus plugin-manifest fields `pi.extensions`, `pi.skills`, `openclaw.extensions`, `omp.extensions`.

**No one-line installer script** (no `curl … | sh`). Documented install entrypoints are all per-harness (see matrix + README). Global manual install `npm install -g context-mode` is the path for Gemini CLI, VS Code/JetBrains Copilot, Codex manual fallback, Qwen Code, Kiro, Zed, OMP manual.

**`postinstall` (`scripts/postinstall.mjs`) configures no harness.** It only: hard-fails Linux + Node < 22.5 + no Bun (`:22-78`, #564); gates the rest behind `isGlobalInstall()` (`:89+`); repairs `~/.claude/plugins/installed_plugins.json` + sweeps stale `.mcp.json` via `heal-installed-plugins.mjs` (`:110-203`); fixes Windows global-install shims (`:248-324`). No MCP registration into any harness.

**The `context-mode` CLI (`src/cli.ts`).** Plain `if/else` dispatch (`:156-203`), **no `install`/`setup`/`stats`/`purge` subcommand**. Subcommands: *(default)* start MCP server (`import("./server.js")`, `:200-202`); `doctor` (`:174-175`, impl `:381`); `upgrade` (`:176-191`, impl `:1051`); `hook <platform> <event>` (`:192-193`, impl `:129` — what every harness `hooks.json` invokes); `insight [port]` (`:194-195`, impl `:945`); `statusline` (`:196-199`). **No subcommand auto-registers the MCP for a harness.** `upgrade` only re-syncs/rebuilds an already-installed Claude Code marketplace clone (`git -C ~/.claude/plugins/marketplaces/context-mode fetch/reset`, `:1075-1115`) and strips legacy `mcp.context-mode` for opencode/kilo. The user-facing `ctx stats|doctor|upgrade|purge|insight` are **MCP tools / Claude Code slash commands**, not CLI subcommands.

### 6. Self-heal / repair layer

`start.mjs` is the live heal harness, running on **every MCP boot** before importing the server bundle (`:456-471`):
- `heal-installed-plugins.mjs` (shared, also called by postinstall): re-syncs `installed_plugins.json` versions, re-populates `enabledPlugins[...]`, rewrites tmpdir-prefixed `mcpServers.context-mode.args[0]` back to `${CLAUDE_PLUGIN_ROOT}/start.mjs` (#523), sweeps stale `.mcp.json` (#609).
- `heal-better-sqlite3.mjs` + `hooks/ensure-deps.mjs`: repair native binding/ABI on boot.
- `plugin-cache-integrity.mjs` (`start.mjs:431-453`): if a critical sibling file is missing from a partial install, prints an actionable report and `process.exit(2)`.
- `start.mjs` Layers: registry↔symlink fixes (#46915), deploy + register a global SessionStart cache-heal hook in `~/.claude/.../settings.json` (`:227+`, `:240-338`), Windows `hooks.json`/`plugin.json` normalization (#378, `:340-362`).

`scripts/version-sync.mjs` (release-time `npm version` hook) stamps `package.json`'s version into all 8 manifest files; `pi`/`omp` blocks intentionally carry no version (loaders stamp from top-level `package.json`).

---

## Surface Area for Change (neutral pointers)

> Factual pointers to where the relevant extension points live, for a future change that makes MCP setup work uniformly across harnesses. No recommendations or proposed designs — those belong in a `/create-plan` follow-up.

1. **The adapter abstraction** — `src/adapters/detect.ts` (`getAdapter()`, 15 adapters) and `src/adapters/<harness>/index.ts`. This is the only per-harness behavior layer. Today adapters expose `configureAllHooks()`, `checkPluginRegistration()`, `getInstalledVersion()`, capability flags, and storage/hook-path resolvers — but **no method writes MCP config** into a harness. Any uniform-install logic would attach here.
2. **The CLI dispatch** — `src/cli.ts:156-203`. There is currently **no `install`/`setup` subcommand**; the dispatch is a plain `if/else` chain. This is the entrypoint a unified installer command would be added to.
3. **Per-harness MCP/config templates already exist** — `configs/<harness>/{mcp.json,hooks.json,config.toml,settings.json}`. These are the canonical config shapes any auto-writer would emit (e.g. `configs/gemini-cli/mcp.json`, `configs/codex/config.toml`, `configs/opencode/opencode.json`, the `~/.pi/agent/mcp.json` shape in the README). They are presently documentation/copy-paste templates, not written programmatically (except OpenClaw via `register-openclaw-config.mjs`).
4. **What writes vs. doesn't write today**: Codex adapter writes `hooks.json` + `[features].hooks` but not `[mcp_servers]` (`src/adapters/codex/index.ts:658-709`); pi adapter hook config is all no-ops (`src/adapters/pi/index.ts:129-131,218-229`); the only true scripted per-harness installer is `scripts/install-openclaw-plugin.sh`.
5. **`postinstall.mjs`** — runs on global `npm install -g` but configures no harness (`scripts/postinstall.mjs`). It is the existing hook where a global install could detect installed harnesses and write their configs.
6. **The stdio-vs-in-process split** — `IN_PROCESS_PLUGIN_PLATFORMS = {opencode, kilo}` (`src/cli.ts:153`) and the MCP-suppression logic (`src/server.ts:105-114`). Any change must respect that OpenCode/Kilo (and OpenClaw, OMP, pi) deliberately avoid a redundant stdio MCP child; "auto-install the MCP" is not meaningful for the in-process plugins in the same way it is for stdio harnesses.
7. **Marketplace coverage today**: Claude Code marketplace is shipping (auto). Codex marketplace works but is flag-gated. Cursor marketplace is awaiting review (`#485/#489`) — `.cursor-plugin/plugin.json` already declares `mcpServers` (`command: "npx", args: ["-y","context-mode"]`).

---

## Code References

| File | Line | Description |
|------|------|-------------|
| `.claude-plugin/plugin.json` | 22-30 | Claude Code inline `mcpServers` + `skills` (auto-registration crux) |
| `.claude-plugin/marketplace.json` | 11-32 | Claude marketplace entry, `source: "./"` |
| `.mcp.json.example` | 1-8 | Standalone copy of the Claude MCP launch command |
| `hooks/hooks.json` | 1-132 | 5 Claude Code lifecycle hooks |
| `.codex-plugin/plugin.json` | 22-23 | Codex manifest → `mcp.json` + `hooks.json` pointers |
| `.codex-plugin/mcp.json` | (all) | Active Codex plugin MCP server: `node ./start.mjs`, stdio |
| `.codex-plugin/hooks.json` | 3-63 | 6 Codex plugin hooks (`node "${PLUGIN_ROOT}/hooks/codex/*.mjs"`) |
| `configs/codex/config.toml` | (all) | Manual-path example: `[features].hooks` + `[mcp_servers.context-mode]` |
| `src/adapters/codex/index.ts` | 609-648 | `checkPluginRegistration()` — only reads, returns manual fix string |
| `src/adapters/codex/index.ts` | 658-709 | `configureAllHooks()` — writes hooks.json + `[features].hooks` only |
| `package.json` | 30-37 | pi discovery field (`pi.extensions`, `pi.skills`) |
| `src/adapters/pi/extension.ts` | 424, 850-897 | pi extension entrypoint + MCP bridge bootstrap |
| `src/adapters/pi/mcp-bridge.ts` | 1-22, 457-464 | Self-spawned stdio MCP child + `pi.registerTool()` bridge |
| `src/adapters/pi/index.ts` | 67-77, 129-131, 218-229 | `paradigm = "mcp-only"`; no-op hook config |
| `configs/opencode/opencode.json` | 1-6 | OpenCode `"plugin": ["context-mode"]` config |
| `src/adapters/opencode/plugin.ts` | 375-391, 466-469 | In-process native tool build (no stdio child) |
| `src/server.ts` | 105-114, 281-296 | `REGISTERED_CTX_TOOLS` registry + MCP suppression for native-plugin hosts |
| `src/adapters/opencode/index.ts` | 96, 420-433 | `paradigm = "ts-plugin"`; legacy-MCP warn; SessionStart surrogate |
| `scripts/install-openclaw-plugin.sh` | (all) | Only true scripted per-harness installer (OpenClaw, not OpenCode) |
| `src/adapters/detect.ts` | 560-645 | `getAdapter()` — 15-adapter dispatch (harness abstraction) |
| `src/cli.ts` | 153, 156-203 | `IN_PROCESS_PLUGIN_PLATFORMS`; CLI dispatch (no install subcommand) |
| `scripts/postinstall.mjs` | 22-78, 110-203 | Linux/Node guard; Claude registry self-heal (configures no harness) |
| `start.mjs` | 240-366, 431-471 | Boot-time self-heal layers + server import |
| `README.md` | 71-115, 407-517, 521-627, 826-868 | Install sections: Claude, OpenCode/Kilo/OpenClaw, Codex, pi |

---

## Open Questions

- **Antigravity / Kiro / Zed hook gap**: README (`:1076`) notes no hook support in the current release for some harnesses → no session tracking. Not investigated in depth (out of the four named harnesses).
- **Cursor marketplace status**: `.cursor-plugin/plugin.json` declares `mcpServers`, but auto-install awaits Cursor review (`#485/#489`). Whether it currently auto-registers was not verified end-to-end.
- **OMP (Oh My Pi)**: a fifth in-process model (`omp plugin install context-mode` → `build/adapters/omp/plugin.js`) exists but was out of scope; relevant if "all harnesses" includes OMP.
- **Behavior under agent-swarm**: ~~not examined~~ → **ANSWERED** in the follow-up section below (`## Follow-up (2026-05-28): Why context-mode never runs in agent-swarm workers`). Short version: it's installed + enabled + advertised in the worker image, but `--strict-mcp-config` filters it out at spawn.

---

## Appendix

- **Architecture notes**: context-mode uses a single npm package as MCP server + CLI + multi-format plugin. Three integration models: (1) host plugin with inline/linked `mcpServers` (Claude Code, Codex, Cursor) → stdio child; (2) in-process plugin/extension, no stdio child (OpenCode, KiloCode, OpenClaw, OMP); (3) extension that self-spawns a stdio MCP child and bridges tools (pi). One `getAdapter()` dispatch (15 adapters) selects per-harness behavior, but adapters describe rather than install MCP config. Heavy self-heal layer in `start.mjs`/`postinstall.mjs` exists to repair Claude Code plugin-registry breakage across Claude Code auto-updates.
- **Source freshness**: researched against a fresh clone (`/tmp/context-mode-latest`, v1.0.151, commit `a5f1fb7`) because the local marketplace clone (`~/.claude/plugins/marketplaces/context-mode`) was v1.0.146.
- **Related research**: none found in `thoughts/` referencing context-mode (this is the first).

---

## Follow-up (2026-05-28): Why context-mode never runs in agent-swarm workers

**Question (Taras):** "I haven't seen ctx-mode usages in the swarm, and it's weird — locally I see it a lot."

> Scope note: this section is about the **agent-swarm repo** (`/Users/taras/Documents/code/agent-swarm`, the host repo for this doc), not upstream context-mode. All `file:line` refs in this section are relative to the agent-swarm repo root.

### Headline

context-mode **is installed, enabled, and advertised** in the Claude worker image — but it is **effectively filtered out at spawn time by `--strict-mcp-config`**. The only MCP a swarm worker actually loads is the swarm's own HTTP MCP (`agent-swarm`) plus any API-registered servers. Locally you see `ctx_*` heavily because your interactive Claude Code loads the plugin normally (no `--strict-mcp-config`); swarm workers run Claude in strict mode that excludes plugin-provided MCP servers. For Codex / pi / OpenCode there is no context-mode wiring at all.

### The chain of evidence

1. **The worker image installs the plugin** (build-time, `Dockerfile.worker:155-156`):
   ```dockerfile
   && claude plugin marketplace add mksglu/claude-context-mode || true \
   && claude plugin install context-mode@context-mode --scope user || true \
   ```
   (`|| true` swallows failures silently. Note `context-mode@context-mode` — the corrected marketplace ID; an earlier bug used the wrong name, per `thoughts/taras/research/2026-04-01-docker-plugin-install-failure.md`.)

2. **The image enables + allows it** in `~/.claude/settings.json` (`Dockerfile.worker:168-180`):
   ```json
   "permissions": { "allow": ["mcp__agent-swarm__*", "mcp__context-mode__*"] },
   "enableAllProjectMcpServers": true,
   "enabledMcpjsonServers": ["agent-swarm", "context-mode"]
   ```

3. **The worker system prompt advertises it** — `src/prompts/session-templates.ts:373-383` defines `system.agent.context_mode` ("You have access to the `context-mode` MCP tools (`batch_execute`, `execute`, …) which compress tool output…"), included in the worker + lead composites (`:556`, `:577`). Remote providers (devin / claude-managed) exclude it via provider traits (asserted in `src/tests/base-prompt.test.ts:417-421`); the local Claude provider includes it — so the worker is *told* the tools exist.

4. **But the Claude adapter spawns with `--strict-mcp-config`** (`src/providers/claude-adapter.ts:411-412`, verified directly):
   ```ts
   if (this.sessionMcpConfig) {
     cmd.push("--mcp-config", this.sessionMcpConfig, "--strict-mcp-config");
   }
   ```
   `--strict-mcp-config` makes Claude Code use **only** the servers in the passed `--mcp-config` file and ignore all other MCP sources — `.mcp.json`, user/project `settings.json`, **and plugin-provided MCP servers**. That makes the `enabledMcpjsonServers`/`enableAllProjectMcpServers` settings from step 2 dead with respect to context-mode.

5. **The per-session config never contains context-mode** — `createSessionMcpConfig` (`claude-adapter.ts:223-268`) collects every `.mcp.json` from cwd→root and merges API-installed servers via `mergeMcpConfig` (`:180-212`). context-mode is plugin-provided, so it's in neither source. The `.mcp.json` written by the entrypoint contains only `agent-swarm` (+ optional `agentmail`) (`docker-entrypoint.sh:513-556`):
   ```sh
   MCP_JSON=$(jq -n --arg url "${MCP_URL}/mcp" --arg apiKey "Bearer ${API_KEY}" \
     '{mcpServers: {"agent-swarm": {type: "http", url: $url, headers: {Authorization: $apiKey}}}}')
   # ... echo "$MCP_JSON" > /workspace/.mcp.json
   ```

6. **Other providers don't wire it either** — Codex adapter writes `mcp_servers` for `agent-swarm` + API-installed only (`src/providers/codex-adapter.ts:257-361`); OpenCode/pi fetch installed MCP servers via the API (`opencode-adapter.ts:565`) with no context-mode reference.

7. **No runtime install path** — a worker's Claude-plugin set is fixed at image build time; the only runtime-configurable MCP mechanism is the API "installed MCP servers" list (for arbitrary user-registered HTTP/stdio servers), not a Claude-Code-plugin installer.

### Net

The `ctx_*` tools are installed and enabled in the image but **never loaded**, because the Claude adapter's `--strict-mcp-config` restricts the worker to the per-session allow-set (`agent-swarm` + API servers), which structurally cannot include a plugin-provided MCP like context-mode.

### Follow-up code references (agent-swarm repo)

| File | Line | Description |
|------|------|-------------|
| `Dockerfile.worker` | 155-156 | Installs context-mode plugin (marketplace add + install, `\|\| true`) |
| `Dockerfile.worker` | 168-180 | Bakes `enabledMcpjsonServers`/`enableAllProjectMcpServers`/permissions for context-mode |
| `src/providers/claude-adapter.ts` | 411-412 | **`--strict-mcp-config`** added with every per-session `--mcp-config` (the filter) |
| `src/providers/claude-adapter.ts` | 180-212 | `mergeMcpConfig` — `.mcp.json` + API servers only |
| `src/providers/claude-adapter.ts` | 223-268 | `createSessionMcpConfig` — builds the strict allow-set |
| `docker-entrypoint.sh` | 513-556 | Writes `/workspace/.mcp.json` with only `agent-swarm` (+ optional agentmail) |
| `src/prompts/session-templates.ts` | 373-383, 556, 577 | `system.agent.context_mode` prompt template + composite inclusion |
| `src/tests/base-prompt.test.ts` | 417-421 | Asserts remote providers exclude the context-mode prompt |
| `src/providers/codex-adapter.ts` | 257-361 | Codex MCP config — agent-swarm + API only, no context-mode |

<!-- review-line-start(a437380a) -->
### Surface area for a fix (neutral pointers)
<!-- review-line-end(a437380a): ok give me a prompt to create a plan out of it pls -->

- The decisive line is `claude-adapter.ts:412`. Options visible in the code (not recommendations): include context-mode in the per-session `--mcp-config` the swarm writes (so it survives strict mode), or change how strict mode is applied. Whether dropping `--strict-mcp-config` is acceptable depends on why it's there — the comment at `:410` cites avoiding race conditions with concurrent sessions, and strict mode also prevents a cloned repo's own `.mcp.json` from injecting unexpected servers.
- Because context-mode for Claude is a stdio plugin MCP (`node ${CLAUDE_PLUGIN_ROOT}/start.mjs`, see upstream §1), adding it to the per-session config would mean emitting a stdio server entry pointing at the installed plugin path inside the worker image — distinct from the swarm's HTTP `agent-swarm` entry.
- Codex/pi/OpenCode would each need their own wiring (none exists today); for OpenCode that means the in-process `plugin: ["context-mode"]` form (no MCP), not an MCP entry — see upstream §4.

---
date: 2026-07-18T12:00:00+02:00
researcher: Claude
git_commit: ebba27fa
branch: main
repository: agent-swarm
topic: "Extension system for agent-swarm — extend/script the swarm without contributing to core"
tags: [research, codebase, extensions, plugins, scripts-runtime, workflows, event-bus, pi-mono, prior-art, proposal]
status: complete
autonomy: autopilot
last_updated: 2026-07-18
last_updated_by: Claude
---

# Research: Extension System for Agent-Swarm

**Date**: 2026-07-18
**Researcher**: Claude
**Git Commit**: ebba27fa
**Branch**: main

## Research Question

How could agent-swarm be made extensible/scriptable without contributing to core? Study pi-mono's extension system as the prime example, plus other prior art (Claude Code plugins, OpenCode, VS Code, n8n, etc.). The swarm already has many primitives (scripts-runtime, workflows, MCP tools, hooks, prompt-template registry, integrations). Target: something someone could ship as an npm package, OR the swarm's own agents could build as a runtime-pluggable thing — e.g. new integrations, changing behavior, reacting to events.

Deliverable includes (explicitly requested): proposal ideas + gaps/changes needed in the current architecture.

## Summary

**The swarm already has ~70% of an extension system — what's missing is the connective tissue, not the primitives.** Today an external MCP client or an in-swarm agent can: register versioned, typechecked TS scripts into a catalog (`script_upsert`); compose them into workflow DAGs with 11 node types; schedule workflows/scripts/tasks on cron; publish any script as a public HTTP endpoint (`script_apis`); register typed API connections with host-scoped secret injection (script-connections); override prompt-template bodies per global/agent/repo scope at runtime; and edit per-agent behavior files (soulMd/toolsMd/claudeMd/setupScript) live. That is already "runtime-pluggable things built by agents."

**The four missing pieces are:** (1) **reacting to events** — an in-process `workflowEventBus` exists and task/GitHub/GitLab events land on it, but nothing lets user code *subscribe* (wait-nodes can match events mid-run, but there's no durable "on `task.completed` run script X" primitive, and Slack/Linear/Jira never emit); (2) **changing behavior** — every interception point (worker hooks, tool admission, prompt composition structure, task routing) is compile-time TypeScript with no veto/mutate handler registry; (3) **adding agent-visible tools** — the MCP tool registry is a hardcoded import list in `src/server.ts`; a catalog script cannot be surfaced as a tool; (4) **a packaging unit** — nothing bundles scripts + workflows + subscriptions + prompt overrides + skills + connections into one installable, upgradable artifact, even though the seeder framework (`src/be/seed/`) was explicitly designed to grow into exactly this.

**Prior art points at a clear shape.** pi-mono is the strongest reference: a default-exported TS factory receiving an `ExtensionAPI`, ~27 lifecycle events each returning a *narrow typed result* (block/transform/replace — never a generic mutation blob), tool/command/provider registration, jiti zero-build loading, npm/git "pi packages", and a `project_trust` gate. Its philosophy ("every feature you add to the core is a feature the agent can no longer reason about"; "pi can create extensions — ask it to build one") matches the swarm's agent-authored goal exactly. Meanwhile *no* surveyed system (Claude Code, OpenCode, VS Code, n8n, Obsidian) achieves real sandboxing — they all rely on curation or manual review. Agent-swarm's `Bun.spawn` + ulimit + stdin-config scripts sandbox is therefore a genuine differentiator: the swarm can safely let *untrusted agents* author extensions, which none of the prior art can.

The proposal (§Proposal) is a four-layer design — durable event subscriptions, sandboxed hook points with pi-style typed results, script-backed tools, and a "swarm pack" manifest installed through the existing seeder — with an MVP slice that is mostly wiring, not new machinery.

## Detailed Findings

### 1. Existing extensibility primitives (the asset inventory)

#### 1.1 Scripts-runtime — the sandboxed execution primitive

- **Sandbox**: `src/scripts-runtime/executors/native.ts` spawns `sh -c` with a ulimit preamble (`memoryMb: 512, cpuTimeSec: 60, wallClockMs: 30_000, maxProcs: 32, maxFdCount: 64, maxStdoutBytes: 1MB` — `executors/types.ts:80-88`) and `env -i` environment scrubbing. Config (agentId, bearer, mcpBaseUrl) flows as JSON over **stdin**, with the bearer wrapped in `Redacted<string>` (`swarm-config.ts:4-33`) — user code never sees the raw key.
- **Import allowlist**: only `swarm-sdk`, `stdlib`, `zod`, relative imports (`import-allowlist.ts:3-4`); `node:*`, `bun:*`, `fs`, `child_process` are banned.
- **Typed SDK**: `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) maps SDK methods → registered MCP tools, verified at build time by `scripts/bundle-script-types.ts` (boots a real server, asserts every method resolves) and CI (`scripts/check-sdk-tool-registration.ts`). Notably scripts can already call `workflow_create/patch/trigger` and `script_run`/`script_search` — **scripts can compose workflows and invoke other scripts**.
- **Catalog + versioning**: `scripts` + `script_versions` tables (`src/be/migrations/064_scripts.sql`), unique `(name, scope, scopeId)`, content-hash version pinning (`pinHash`), embeddings for semantic search (migration 065), `argsSchema` Zod validation, `tsc --noEmit` typecheck on upsert (`src/be/scripts/typecheck.ts`).
- **Executor registry**: `executors/registry.ts:4-16` is a name→factory map keyed by `SCRIPT_EXECUTOR` — a ready-made seam for E2B/Docker backends, currently `native` only.
- **script_apis**: any script can be published as `POST /api/x/script/<endpointId>` (`src/http/x.ts`) — public endpoint id, optional encrypted bearer, timeout header up to 300s. This is already "turn a script into a webhook handler," minus signature verification and event semantics.
- **Credential broker**: `[REDACTED:<configKey>]` placeholders substituted by a patched `fetch` **only for hostnames on the binding's `allowedHosts`** (`credential-broker/fetch-patch.ts:63-91`) — host-scoped, SSRF-safe secret injection. Connections registry (`script_connections`, kinds `raw/openapi/mcp/graphql`, migrations 101/102/112) types the external APIs scripts talk to.
- **Seeder framework**: `src/be/seed/` + `src/be/seed-scripts/catalog/` (~24 built-ins) with pristine-vs-user-modified content-hash tracking (`seed_state`, migration 069). `runbooks/seed-scripts.md` explicitly says: "the mechanism is generic so future kinds (workflows, schedules, skills, …) plug in the same way."
- **What's absent**: no event/cron trigger owned by scripts-runtime itself (invocation = explicit tool call, workflow node, or published endpoint), and no hook/extension registry of any kind (`grep` confirms).

#### 1.2 Workflow engine + event bus — the reaction machinery

- **Node types** (11, each self-describing via `z.toJSONSchema`, exposed at `GET /api/executor-types` — `src/http/workflows.ts:259-282`): `property-match`, `code-match`, `notify`, `raw-llm`, `script`, `swarm-script`, `vcs`, `validate` (instant); `agent-task`, `human-in-the-loop`, `wait` (async). Registry: `src/workflows/executors/registry.ts`.
- **Triggers**: manual (`trigger-workflow` MCP + HTTP), webhook (`POST /api/webhooks/{workflowId}`), schedule (scheduler with `targetType: agent-task|workflow|script`, migration 103, `src/scheduler/scheduler.ts:120,248,379`). `triggerSchema` validates trigger data uniformly (`engine.ts:54-60`).
- **Event bus**: `src/workflows/event-bus.ts` — `InProcessEventBus` over Node `EventEmitter`, singleton `workflowEventBus`. **In-process only; multi-replica deployments won't propagate** (documented limitation).
- **Emit sites**: task lifecycle (`task.completed/failed/cancelled/created/progress/budget_refused` from `src/be/db.ts`), `approval.resolved` (`src/http/approval-requests.ts:183`), `agentmail.message.received`, GitHub (`github.pull_request.<action>`, `github.issue.<action>`, `github.issue_comment.created`, `github.pull_request_review.submitted` — `src/http/webhooks.ts:268-302`), GitLab (`:385-418`). **Not wired**: Slack, Linear, Jira, Sentry, Stripe, claude-managed callbacks.
- **Consumption**: only `wait` nodes (event mode, dot-path or sandboxed-`Function` filters) inside an *already-running* workflow run, plus external signal injection endpoints (`POST /api/workflow-runs/{id}/events`, `POST /api/workflow-events`). There is **no subscription registry** that starts a script/workflow when an event fires.

#### 1.3 Tool registry, prompts, per-agent customization

- **MCP tools**: hardcoded — ~150 `registerXTool(server)` calls in `src/server.ts:9-190`. Registration goes through `createToolRegistrar` (`src/tools/utils.ts:141`; OTel span + secret scrubbing + RequestInfo injection). Two surfaces: full agent-facing (`server.ts`) and curated 5-tool user-facing (`server-user.ts:59-87`, uniformly gated by `decideToolAdmission` — `src/rbac/admission.ts:46`). The main surface self-guards via inline `can()` in 36 tool files instead. `tool-config.ts` splits `CORE_TOOLS`/`DEFERRED_TOOLS` (ToolSearch discovery) — context optimization, not access control. `SCRIPTS_ONLY_MCP=true` collapses the surface to script tools only.
- **Runtime-CRUD-able registries already exist** for prompt templates (`src/tools/prompt-templates/`), skills (`src/tools/skills/`), MCP servers (`src/tools/mcp-servers/`), script connections (`src/tools/script-connections/`) — i.e., several "contribution kinds" are already data, just not bundled or event-driven.
- **Prompt registry**: two layers — compile-time `registerTemplate()` map (`src/prompts/registry.ts:33`; ~27 templates in `session-templates.ts`) + runtime DB **body** overrides scoped repo > agent > global (`resolver.ts`, `{{@template[id]}}` recursion, `skip_event` sentinel; workers resolve over HTTP via `POST /api/prompt-templates/render`). **Which sections exist and compose in what order is compile-time** (`base-prompt.ts:96-295` branches in TS).
- **Per-agent surface**: `claudeMd`, `soulMd`, `identityMd`, `toolsMd`, `setupScript`, `heartbeatMd` (64KB each, `src/types.ts:737-751`), spliced into the system prompt at runtime, editable live via `update-profile` (self-edit or lead coaching, with disk sync into the running container — `update-profile.ts:277-320`). `capabilities` gate task routing, **not** tool access.

#### 1.4 Worker hooks + harness-side plugin bundle

- **Hooks**: `src/hooks/hook.ts` (1318 lines) implements Claude Code lifecycle hooks (SessionStart/PreToolUse/PostToolUse/PreCompact/UserPromptSubmit/Stop), wired via `settings.json` **baked into the worker image** (`Dockerfile.worker:238-255`). Behavior (cancellation check, tool-loop detection, heartbeat, session summary) is fixed; parity re-implementations exist per harness: `src/providers/pi-mono-extension.ts:419` (`createSwarmHooksExtension` — the swarm is *already a pi extension author*) and `plugin/opencode-plugins/agent-swarm.ts` (`@opencode-ai/plugin`).
- **plugin/ dir**: 13 slash commands (`plugin/commands/*.md` with `<!-- claude-only -->`/`<!-- pi-only -->` markers), 4 subagents, skills, and a generated pi-skills conversion (`plugin/build-pi-skills.ts`) — shipped inside the npm package (`package.json` files array). This is the existing harness-side distribution pipeline: one authoring format → per-harness transforms.
- **Providers**: `ProviderAdapter` interface (`src/providers/types.ts`) with a hardcoded 6-case switch factory (`providers/index.ts:24-55`), but **selection** is data-driven and live-reconciled every poll cycle from `swarm_config` (`runner.ts:4108-4113`).

#### 1.5 Integrations — the bespoke corner

Each of GitHub/Slack/Linear/Jira/Kapso is a hand-built top-level dir (`app.ts`/`oauth.ts`/`webhook.ts`/`outbound.ts`); the only shared abstraction is the `OAuthProviderConfig` shape (`src/oauth/wrapper.ts:6`). Adding a 5th integration = core PR touching webhook routes, RBAC, event emission, secret storage. The Composio prototype (`docs-site/.../integrations/composio.mdx`, `swarm_x` tool) already outsources *outbound* third-party tool access (Gmail/Notion/HubSpot via Tool Router sessions + Connect Links) — the docs themselves call the long-term shape "API-mediated integration where the swarm server owns auth."

### 2. pi-mono's extension system (the exemplar)

Source studied at `/tmp/pi-mono-research` (shallow clone of `badlogic/pi-mono`; ephemeral — re-clone if needed). Core: `packages/coding-agent/docs/extensions.md` (2944 lines), `src/core/extensions/{types.ts,loader.ts,runner.ts}`, ~90 examples in `examples/extensions/`.

**Shape**: default-exported factory `(pi: ExtensionAPI) => void | Promise<void>`. The API (`types.ts:1167-1402`):
- `pi.on(event, handler)` — 27 typed overloads; `pi.registerTool/registerCommand/registerShortcut/registerFlag/registerProvider/registerMessageRenderer`; session actions (`sendMessage`, `appendEntry`, `setSessionName`); runtime control (`setModel`, `setActiveTools`); inter-extension `pi.events` bus.

**The five design lessons that matter for the swarm:**
1. **Narrow typed results per event, never a generic mutation blob.** `tool_call` → `{block: true, reason}`; `input` → `continue | transform | handled`; `context` → filtered message array; `message_end` → replacement message (same role enforced); `before_agent_start` → inject message / rewrite system prompt. Handler chaining is defined (load order, each sees the previous result). This is the single cleanest part of the design.
2. **Two-tier context to prevent deadlocks**: event handlers get safe `ExtensionContext`; only command handlers get `ExtensionCommandContext` (adds `waitForIdle/newSession/fork/reload`) because those can deadlock the agent loop.
3. **Zero-build TS loading** (jiti, `tryNative: false`, virtual modules in the compiled binary; npm deps via a sibling `package.json`). Discovery: project `.pi/extensions/` (gated behind a `project_trust` event) + global `~/.pi/agent/extensions/` + settings/CLI paths; packages via `pi install npm:@foo/bar` bundling extensions+skills+prompts+themes under a `pi` manifest key in `package.json`.
4. **State persistence pattern**: store extension state in tool-result `details`, reconstruct on `session_start` by walking the session branch — survives forking. Two visibility tiers: messages (LLM-visible) vs entries (session-durable, TUI-only).
5. **Philosophy** (Zechner's blog + docs): "Every feature you add to the agent core is a feature the agent can no longer reason freely about" — even MCP support is an extension, not core. And the first line of the extensions doc: "pi can create extensions. Ask it to build one for your use case." Extensions run with full user permissions; trust = the `project_trust` gate + "only install what you trust."

Representative examples: `permission-gate.ts` (confirm dangerous bash), `protected-paths.ts`, `git-checkpoint.ts`, `todo.ts` (stateful tool + command), `dynamic-tools.ts` (post-startup registration), `subagent/` (1015-line subagent orchestrator), `custom-provider-anthropic/` (full OAuth provider), `ssh.ts` (reroutes all built-in tools to a remote machine via pluggable `*Operations`), `doom-overlay/`.

Note: the swarm's prior deep dive `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` §4 already sketched "agent profile could gain customTools / extension paths" and a `HARNESS_EXTENSIONS` env — worker-side loading of pi extensions is essentially solved design.

### 3. Prior art survey (condensed)

| System | Unit / distribution | Hook model | Veto/mutate? | Sandbox | Discovery |
|---|---|---|---|---|---|
| **pi** | TS module, jiti-loaded; file drop or npm "pi package" | 27 lifecycle events, typed results | **Yes** (block/transform/replace) | None; `project_trust` gate | None (npm/file) |
| **Claude Code plugins** | Dir + `.claude-plugin/plugin.json` (name-only manifest, conventional dirs auto-discovered: commands/agents/skills/hooks/.mcp.json) | ~12+ hook events, regex matchers, external process | **Yes** (exit 2 / `permissionDecision: deny`) | None (manual review) | Git-repo marketplaces (`marketplace.json`), official + community |
| **OpenCode** | JS/TS module or npm pkg (auto `bun install` from config) | 25+ events (`tool.execute.before`, `session.idle`…) | **Yes** | None (host Bun process) | npm itself |
| **VS Code** | npm-style pkg, declarative `contributes` + activation events | Activation gating only | No | Process isolation (Extension Host) but full app privileges | Central marketplace |
| **n8n community nodes** | npm pkg `n8n-nodes-*`, `INodeType` + credentials classes | N/A (workflow node unit) | No | None; **2-tier trust** (unverified self-host-only vs Verified: vetted, no runtime deps, provenance) | In-app for Verified |
| **Zapier CLI** | JS app pushed to Zapier infra | N/A (declarative triggers/actions/auth) | No | Runs on their infra | Curated app store |
| **Obsidian** | Dir + manifest + main.js, curated registry | Observational events | Limited | None (full Electron) | Curated in-app |
| **Mastra / LangGraph** | MCP-as-plugin-system / Python middleware | MCP protocol / `before_model`-style hooks | LangGraph: yes | None | MCP ecosystem / none |

**Cross-cutting takeaways:**
- Veto/mutate hooks are the norm for agent-adjacent systems, absent from static connector platforms. The swarm needs both kinds: n8n-style *connector* contributions (integrations) AND pi-style *interception* hooks (behavior).
- **Nobody sandboxes.** Trust is curation (n8n Verified: no runtime deps + provenance attestation; Obsidian/Raycast review) or a warning label (pi, Claude Code, OpenCode). VS Code's Extension Host isolates for *stability*, not security. The swarm's scripts sandbox is the only real capability boundary in this whole comparison set.
- Manifest-optional auto-discovery (Claude Code: only `name` required) is the best authoring ergonomics surveyed; explicit manifests (n8n/VS Code) buy static validation and marketplace metadata.
- VS Code's activation events (lazy: declare contributions, boot on trigger) is the pattern for keeping a large installed base cheap — analogous to the swarm's existing CORE/DEFERRED tool split.
- Distribution: git-repo marketplaces (Claude Code) need zero hosting; npm gives versioning/provenance for free. n8n proves npm + naming convention + keyword is a viable discovery layer without building anything.

### 4. Historical context (from thoughts/)

- `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` — §4 "Extensions and Custom Tools" already flags "agent-swarm's tool set is static… no mechanism for agents to register custom tools or users to add extensions", and sketches 4 extension layers for the pi adapter.
- `thoughts/taras/research/2026-03-10-configurable-event-prompts.md` — ~25 hardcoded webhook→task prompt templates in `src/github|gitlab|agentmail/handlers.ts`; evaluated workflows vs DB table vs config for making them configurable (the prompt-template registry has since shipped, but the *event→handler binding* remains hardcoded).
- `thoughts/taras/plans/2026-03-25-generic-events-table.md` — a designed-but-separate `events` table (category/event/data JSON, batch worker ingestion) for telemetry; relevant as the durable-events substrate the current in-process bus lacks.
- `thoughts/taras/research/2026-03-18-workflow-redesign.md` — the workflow engine's design history.
- Project memory: the scripts-only MCP experiment (3v3 matrix) found the **full MCP tool surface beat code-mode on Claude** ($1.83 vs $3.13) with context a wash thanks to ToolSearch — a counterweight to pi's "no baked-in tool schemas" argument; deferred-tool discovery makes a *growing* tool surface tolerable, so extension-registered tools don't have to be rationed aggressively.

## Proposal

> Requested explicitly: proposal ideas + gaps. Everything below is proposal, not documentation of current state.

### Design stance

Two authoring personas, one mechanism:
- **Community/human**: ships a versioned npm package ("swarm pack") — n8n-style naming + manifest, installed by an operator.
- **The swarm's own agents**: call the same underlying CRUD primitives (`script_upsert`, `workflow_create`, `subscription_create`, …) directly at runtime — no package needed; a pack is *only* the bundling/versioning/distribution layer over primitives that must each work standalone.

And one hard architectural choice: **server-side extension code runs in the scripts sandbox, not in the API process.** pi/OpenCode load extensions in-process because they're single-user local tools; the swarm is a multi-tenant server where agents author extensions. The sandbox (already built: ulimits, env scrubbing, Redacted bearer, host-gated secrets, SDK allowlist) is the trust story no prior-art system has. An in-process "native extension" tier for operators (OpenCode-style npm module loaded into the API server) can be a later opt-in for people self-hosting who need custom node executors — keep it out of v1.

Worker-side (harness) extensibility stays native per harness — pi extensions, CC plugin, opencode plugin — distributed through the pack as assets, exactly like `plugin/` does today.

### Layer 1 — Event subscriptions ("react to things")

The single highest-leverage addition. A `subscriptions` table:

```
subscription: { id, eventPattern ("task.completed", "github.*", glob),
                target: {type: "script", name, args} | {type: "workflow", id},
                filter (same dot-path/code filter language as wait-nodes, reuse src/workflows/wait-filter.ts),
                scope (global|agent|repo), enabled, createdByAgentId,
                delivery: {maxConcurrency, retries, timeoutMs} }
```

- Delivery is **durable outbox, not EventEmitter**: emit sites write an event row (the 2026-03-25 generic-events-table design is the substrate) inside the same transaction as the state change; a dispatcher (same pattern as `wait-poller.ts` / scheduler loop) claims rows and invokes targets at-least-once. Fixes the documented multi-replica limitation of `workflowEventBus` at the same time.
- Script targets receive `ctx.event` in the sandbox; a subscription-triggered script that wants an agent involved calls `task_create` or `workflow_trigger` via the SDK — that already works.
- Prereq wiring: put Slack/Linear/Jira/Sentry/heartbeat-findings emitters on the bus (already one-line follow-ups per `runbooks/workflows.md`).
- New MCP tools: `subscription-create/list/delete/pause` + SDK methods. RBAC: `subscription.write` verb; global scope requires lead.

This alone gives: auto-triage on `task.failed`, Slack digests on `task.completed`, label-driven routing on `github.issue.opened`, budget alerts on `task.budget_refused` — all agent-authorable today-shaped scripts.

### Layer 2 — Interception hooks ("change behavior")

pi's key lesson applied server-side: a small set of **named hook points, each with a narrow typed result**, handlers being catalog scripts registered against them:

| Hook point | Fires | Typed result |
|---|---|---|
| `task.before_create` | in `createTaskExtended` path | `continue \| {transform: patch} \| {block, reason}` |
| `task.before_assign` | pool claim / routing | `continue \| {assignTo} \| {block, reason}` |
| `tool.before_call` | server-side MCP tool dispatch (in `createToolRegistrar`) | `allow \| {deny, reason}` |
| `event.before_task` | webhook handler → task creation (GitHub/Slack/… prompts) | `continue \| {transform: description/config} \| {drop}` |
| `prompt.compose` | `getBasePrompt` assembly | `{insert: [{anchor, body}]}` |

- Handlers run **synchronously in-request** in the sandbox with a tight budget (e.g. 2–5s wall, distinct from the 30s script default), explicit per-hook-point fail-open/fail-closed config, priority ordering, and pi-style chaining (each handler sees the previous transform).
- `tool.before_call` dovetails with RBAC increment-5 (MCP tool admission) — the hook is the *user-extensible* layer on top of the declarative `rbac:` posture, mirroring how `server-user.ts` already wraps admission.
- `prompt.compose` fixes the "sections are compile-time" gap without opening full prompt rewriting: extensions insert bodies at named anchors (registered in `src/prompts/registry.ts`), headers stay non-overridable.
- Worker-side (PreToolUse-style veto *inside the harness*) stays with the harness's native mechanism; the pack can carry a pi extension / CC hook for that. Don't rebuild pi inside the worker.

Performance note: hot paths (tool dispatch) must skip the subprocess entirely when zero handlers are registered (one indexed lookup, cached), and per-hook results can be memoized where semantics allow. Sandbox spawn overhead (~tens of ms) is acceptable for task/webhook paths, borderline for `tool.before_call` — consider restricting v1 of that hook to matcher-scoped registration (Claude Code-style tool-name matchers) so it only fires for named tools.

### Layer 3 — Script-backed tools ("add capabilities agents can see")

A `script_tools` registration: expose a catalog script as an MCP tool — name, description, JSON schema derived from its `argsSchema` (Zod → JSON Schema is already how executor types self-describe), scope global/agent/repo. `createToolRegistrar` consults this table at tool-list time; all script-backed tools are DEFERRED_TOOLS (ToolSearch handles surface growth — validated by the scripts-only experiment). Combined with script-connections, this makes "new integration" = connection + scripts + tools + subscriptions, **zero core code**. Optionally same treatment for workflow-backed tools (`triggerSchema` → tool schema).

### Layer 4 — Swarm packs (the unit + distribution)

Manifest, n8n/pi hybrid — npm package named `swarm-pack-*` (or `@scope/swarm-pack-*`) with a `swarm` key:

```jsonc
// package.json
{ "name": "@acme/swarm-pack-sentry",
  "swarm": {
    "packVersion": 1,
    "scripts": ["./scripts/*.ts"],            // → script catalog (typechecked on install)
    "workflows": ["./workflows/*.json"],
    "subscriptions": ["./subscriptions.json"],
    "hooks": ["./hooks.json"],                 // hook-point registrations
    "tools": ["./tools.json"],                 // script-backed tool defs
    "promptOverrides": ["./prompts/*.md"],
    "connections": ["./connections.json"],     // declares required config keys + allowedHosts
    "skills": ["./skills/*"],                  // harness-side, fed through plugin/ conversion pipeline
    "configSchema": { }                        // JSON Schema for pack settings, surfaced at install
  } }
```

- **Installer = the seeder.** `agent-swarm pack install npm:@acme/swarm-pack-sentry@1.2.0` fetches the tarball, validates the manifest, typechecks scripts, checks connection `allowedHosts` + required secrets, then ingests every kind through the existing `Seeder` framework — which already gives pristine-hash upgrade semantics (user-modified entities never clobbered on `pack update`). A `packs` table tracks installed packs, versions, and owned-entity ids for clean uninstall.
- **Agent-authored path**: an agent that has built scripts/subscriptions can run `pack export` to snapshot them into a pack (publishable or just archived to agent-fs) — closing the loop where the swarm builds its own extensions and they become distributable.
- **Discovery**: v1 is n8n-style — npm search on the naming convention + keyword. No marketplace infra to build. A curated "verified" list (JSON in the repo or docs-site page) is the v2 trust tier.
- **Trust model**: all pack code runs sandboxed (unique vs all prior art); network egress limited to declared `allowedHosts` per connection; secrets only via `[REDACTED:key]` broker; install requires operator/lead RBAC (`pack.install`); hooks show provenance ("blocked by @acme/swarm-pack-policy") in logs/UI. Later: n8n-style verified tier (review + provenance attestation).

### What this enables (concrete scenarios)

1. **Sentry integration as a pack**: connection (Sentry API + HMAC secret) + a generic-webhook script published via `script_apis` (needs Gap 6's signature verification) emitting `sentry.issue.created` + subscription → triage workflow + a `sentry_search_issues` script-backed tool. No core PR — versus today, where Sentry would be a 6th bespoke `src/sentry/` dir.
2. **Org policy pack**: `tool.before_call` handler denying `db-query` for non-lead agents outside work hours; `task.before_create` enforcing budget tags.
3. **Agent-built automation**: an agent notices repeated manual triage, writes a script, creates a subscription on `task.failed` — live in one conversation, no deploy.
4. **Prompt pack**: a team ships tuned `system.agent.*` overrides + extra sections via `prompt.compose` anchors + matching skills for all three harnesses.

### Suggested sequencing (MVP → full)

1. **MVP (mostly wiring)**: durable events table + outbox dispatcher; missing bus emitters; `subscriptions` (script/workflow targets) + MCP tools; webhook-signature support on `script_apis` endpoints. → "react to things" done.
2. **Script-backed tools** (Layer 3) — small, high leverage, exercises the Zod→JSON-schema path.
3. **Hook points** (Layer 2), starting with `event.before_task` + `task.before_create` (cold paths, immediately useful, low perf risk); `tool.before_call` last.
4. **Pack manifest + installer** over the seeder; `pack export` for agents.
5. Later: verified tier, native in-process extension tier for self-hosters, workflow-node-executor contributions, provider adapters as packs.

## Gaps / changes needed in current architecture

| # | Gap | Change | Where |
|---|---|---|---|
| 1 | Event bus is in-process, single-replica, and consumable only by in-flight wait-nodes | Durable `events` outbox (reuse 2026-03-25 design) + dispatcher loop; keep `workflowEventBus` as a thin shim over it | `src/workflows/event-bus.ts`, new `src/be/events.ts`, emit sites in `src/be/db.ts` + `src/http/webhooks.ts` |
| 2 | Slack/Linear/Jira/Sentry/heartbeat never emit events | Add emit calls (documented as one-liners in `runbooks/workflows.md`) | `src/slack/`, `src/linear/webhook.ts`, `src/jira/webhook.ts`, `src/heartbeat/heartbeat.ts` |
| 3 | No subscription primitive | `subscriptions` table + migration + MCP tools + SDK methods + dispatcher; reuse `wait-filter.ts` filter language | new `src/be/subscriptions.ts`, `src/tools/subscriptions/`, scheduler-style poller |
| 4 | No interception/hook registry; all behavior compile-time | Named hook points with typed results; registration table; sandbox execution with tight budgets + fail-open/closed config | `createTaskExtended` path, `src/tools/utils.ts` (`createToolRegistrar`), webhook handlers, `src/prompts/base-prompt.ts` |
| 5 | Tool registry hardcoded; scripts can't surface as tools | `script_tools` table consulted by registrar; Zod `argsSchema` → JSON Schema; register as DEFERRED_TOOLS; admission via existing `decideToolAdmission` | `src/server.ts`, `src/tools/utils.ts`, `src/rbac/admission.ts` |
| 6 | `script_apis` endpoints lack webhook semantics | Optional per-endpoint HMAC signature verification (secret via connections) + "emit event" mode | `src/http/x.ts`, `script_apis` schema |
| 7 | Prompt sections/composition are compile-time | Named anchor points in `base-prompt.ts`; `prompt.compose` insertions; keep header non-overridable | `src/prompts/registry.ts`, `base-prompt.ts` |
| 8 | Scripts sandbox lacks hook/event context + hook-grade budgets | `ctx.event`/`ctx.hook` in `SwarmConfigPayload`; per-invocation resource profile (2–5s hook budget); warm-spawn or matcher gating for hot paths | `src/scripts-runtime/loader.ts`, `eval-harness.ts`, `executors/types.ts` |
| 9 | SDK surface unversioned; external authors need a stable target | Publish `@desplega.ai/swarm-script-sdk` types package (generated `.d.ts` already exists via `bundle-script-types.ts`); semver it; pack manifest declares `sdkVersion` | `scripts/bundle-script-types.ts`, npm publish pipeline |
| 10 | Seeder only seeds built-ins | Generalize `Seeder` input to user-supplied packs; `packs` table (version, owned entities, pristine hashes); install/uninstall/update CLI + MCP tools | `src/be/seed/`, new `src/be/packs.ts`, CLI command |
| 11 | RBAC verbs missing for new surfaces | `subscription.write`, `hook.register`, `pack.install`, `tool.publish` etc. in permissions + legacy-policy; extension-registered non-GET routes N/A (no new routes beyond pack/subscription CRUD) | `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts` |
| 12 | Multi-replica double-fire risk for dispatchers | Claim/lease semantics on outbox rows (same pattern as task claim path) | dispatcher implementation |
| 13 | Harness-side pack assets need per-harness conversion | Generalize `plugin/build-pi-skills.ts` pipeline to consume pack `skills/` at install time; deliver via existing skills runtime CRUD | `plugin/build-pi-skills.ts`, `src/tools/skills/` |
| 14 | Integrations bespoke; no generic inbound path | Covered by Gaps 3+6 (generic webhook → event → subscription); existing four integrations stay native, new ones start as packs; Composio remains the managed-auth outbound complement | — |

### Open design questions

- **`tool.before_call` latency**: is per-call subprocess spawn acceptable even matcher-gated, or does this hook need a resident hook-runner process (warm sandbox pool)? Measure `native.ts` spawn overhead first.
- **Fail-open vs fail-closed defaults** per hook point (policy hooks want fail-closed; enrichment hooks fail-open) — needs an explicit table before implementation.
- **Pack-scoped secrets UX**: `configSchema` at install prompts the operator; where do values live — `swarm_config` scoped keys vs connections? (Probably connections for anything with egress, config for the rest.)
- **Workflow-node executors as contributions** (true custom node types, not just `swarm-script`) require in-process code — defer to the native-extension tier or model them as script nodes with richer output schemas?
- **The scripts-only-MCP counterpoint**: pi argues against baked-in tool schemas; the swarm's own experiment says the full surface + ToolSearch wins on Claude. Proposal follows the experiment (script-backed tools as deferred tools) — revisit if the deferred surface grows past ToolSearch's discrimination ability.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/scripts-runtime/executors/native.ts` | 123-134 | ulimit + `env -i` sandbox spawn |
| `src/scripts-runtime/sdk-allowlist.ts` | — | `SDK_TOOL_NAME_MAP` — curated SDK→MCP bridge |
| `src/scripts-runtime/executors/registry.ts` | 4-16 | pluggable executor backend seam (native-only today) |
| `src/scripts-runtime/credential-broker/fetch-patch.ts` | 63-91 | host-gated `[REDACTED:key]` secret substitution |
| `src/http/x.ts` | — | `POST /api/x/script/<endpointId>` public script endpoints |
| `src/be/seed/` + `runbooks/seed-scripts.md` | — | generic seeder, "future kinds plug in the same way" |
| `src/workflows/event-bus.ts` | — | in-process `workflowEventBus` (EventEmitter, single-replica) |
| `src/workflows/executors/registry.ts` | — | 11 node types, self-describing schemas |
| `src/http/webhooks.ts` | 268-302, 385-418 | GitHub/GitLab event emission |
| `src/scheduler/scheduler.ts` | 120, 248, 379 | schedule dispatch (`agent-task`/`workflow`/`script` targets) |
| `src/server.ts` | 9-190 | hardcoded tool registration (~150 calls) |
| `src/tools/utils.ts` | 121, 141 | `createToolRegistrar` — the tool-dispatch chokepoint for hooks/admission |
| `src/rbac/admission.ts` | 46 | `decideToolAdmission` (used only by `server-user.ts` today) |
| `src/tools/tool-config.ts` | — | CORE/DEFERRED tool split (ToolSearch) |
| `src/prompts/registry.ts` | 33 | compile-time template registration |
| `src/prompts/resolver.ts` | 30, 73, 149 | DB overrides (repo>agent>global), HTTP resolver for workers, `{{@template}}` recursion |
| `src/prompts/base-prompt.ts` | 96-295 | compile-time prompt composition (anchor-point candidate) |
| `src/hooks/hook.ts` | 422, 943 | worker hook dispatch (fixed behavior, image-baked) |
| `src/providers/pi-mono-extension.ts` | 419 | `createSwarmHooksExtension` — swarm as pi-extension author |
| `plugin/build-pi-skills.ts` | 22-36 | per-harness skill conversion pipeline |
| `src/tools/update-profile.ts` | 277-320 | live per-agent behavior editing (soulMd/toolsMd/setupScript) |
| `src/oauth/wrapper.ts` | 6 | `OAuthProviderConfig` — only shared integration abstraction |
| `/tmp/pi-mono-research/packages/coding-agent/src/core/extensions/types.ts` | 1167-1402 | pi `ExtensionAPI` (ephemeral clone) |
| `/tmp/pi-mono-research/packages/coding-agent/docs/extensions.md` | — | pi extension spec (2944 lines) |

## Open Questions

Carried in §Open design questions above; additionally:
- Whether `src/tools/mcp-servers/` runtime CRUD already covers "attach external MCP server per agent" well enough to serve as the outbound-integration path for packs (not deep-dived here).
- Exact spawn latency of the native executor (drives the `tool.before_call` design).

## Appendix

- **Architecture notes**: API server is sole DB owner; workers HTTP-only (`scripts/check-db-boundary.sh`) — any extension mechanism must respect this split, which is why sandboxed server-side scripts + HTTP-consuming worker assets is the natural shape. RBAC (grantsAll no-op in prod today) is the admission substrate for pack/hook/subscription verbs.
- **Historical context (from thoughts/)**: see §4.
- **Related research**:
  - `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` — pi integration + first extension-gap observation
  - `thoughts/taras/research/2026-03-10-configurable-event-prompts.md` — hardcoded event→task prompts (solved by `event.before_task` hook + prompt registry)
  - `thoughts/taras/plans/2026-03-25-generic-events-table.md` — durable events substrate for Layer 1
  - `thoughts/taras/research/2026-03-18-workflow-redesign.md` — workflow engine design history

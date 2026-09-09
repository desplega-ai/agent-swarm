# Harness providers runbook

Operational rules for editing or adding harness providers (claude, codex, opencode, pi, devin, acp, future).

## Supported providers

| Provider | `HARNESS_PROVIDER` | Adapter | Notes |
|----------|--------------------|---------|-------|
| Claude Code | `claude` | `ClaudeAdapter` | CLI by default; optional Agent SDK transport |
| Codex | `codex` | `CodexAdapter` | Starts a fresh `codex app-server` for each task. OpenAI/ChatGPT OAuth |
| opencode | `opencode` | `OpencodeAdapter` | Spawns `opencode` CLI; OpenRouter primary; agent-swarm plugin auto-injected. See [harness-configuration § Opencode](/docs/guides/harness-configuration#opencode) |
| pi-mono | `pi` | `PiMonoAdapter` | In-process library; OpenRouter, Anthropic, or Amazon Bedrock (via `MODEL_OVERRIDE=amazon-bedrock/*` — see Bedrock auth below) |
| Devin | `devin` | `DevinAdapter` | Cloud-managed via Cognition `/sessions` API |
| Claude Managed | `claude-managed` | `ClaudeManagedAdapter` | Anthropic managed sandbox; SSE relay |
| ACP | `acp` | `ACPAdapter` | Curated `opencode` preset or a custom [Agent Client Protocol](https://agentclientprotocol.com) command. Session knobs such as model use `session/set_config_option` when advertised, with target-specific startup fallbacks. No swarm-side *model-provider* credential — the target owns its own model auth. The target receives the worker's swarm API key as the swarm MCP bearer, so point custom targets only at binaries you trust |

## Claude transport selection

`CLAUDE_TRANSPORT=cli|sdk` selects execution inside `ClaudeAdapter`. CLI remains the default.
The SDK uses the installed Claude executable with pinned SDK `0.3.266`.
Both transports share configuration, credentials, normalized events, and adapter-owned summaries.
Both transports remove the legacy `AGENT_SWARM_CLAUDE_OAUTH_TOKEN` mirror from the Claude child environment.
Adapter-owned summaries retain their selected credentials outside that child.
Claude filters its standard OAuth variable from command hooks, but retains API keys. Only enable trusted project hooks.
The worker persists `providerMeta.transport` on session initialization.

The runtime endpoint accepts `claude: { transport: "cli" | "sdk" | null }`.
Omission preserves the agent's transport override. `null` deletes the override and restores inheritance.
The dashboard shows the inherited effective value and preserves Claude settings when another harness hides the selector.

Resolve transport from each session's fresh configuration, including repository scope when available.
Do not export scoped transport values into `process.env` at boot or during reload.
That would retain an override after its configuration row was deleted.
In-flight sessions retain their original transport.

Reject SDK selection when a supported, direct, or legacy bridge is effective.
Preserve the bridge flag's existing fallback without OAuth credentials.
Custom executable prefixes must speak the SDK protocol. Never silently remove their arguments.
Swarm context preambles remain the continuation mechanism. Native SDK resume stays disabled.

## `HARNESS_PROVIDER` resolution + live re-assignment

Workers resolve their effective harness provider on each poll iteration, with this precedence (highest first):

1. **swarm_config** `HARNESS_PROVIDER` (scope precedence: repo > agent > global)
2. **`process.env.HARNESS_PROVIDER`** (container env)
3. **`"claude"`** (final default)

Operators flip a worker's provider in either of two ways:

- `PUT /api/config` with `{ scope: "agent", scopeId: <agentId>, key: "HARNESS_PROVIDER", value: "<provider>" }`
- `PATCH /api/agents/{id}/harness-provider` (also writes the swarm_config row + updates the `agents.harness_provider` column for dashboards)

The worker reconciles within ~10s (one poll cycle). In-flight task sessions stay on the old adapter; new spawns pick up the new one. Failures during swap (invalid value, adapter init error) log and stay on the current provider — never wedge the worker. Implementation: `src/utils/harness-provider.ts` + the `lastHarnessReconcileAt` block in `src/commands/runner.ts`'s poll loop.

Invalid `HARNESS_PROVIDER` values are rejected at write time (HTTP 400 from `PUT /api/config` or the MCP `set-config` tool) — see `validateConfigValue` in `src/be/swarm-config-guard.ts`.

### ACP target configuration

The dashboard runtime editor is the preferred configuration path. Selecting ACP on a non-ACP agent starts with the OpenCode preset; an older ACP agent with no `ACP_TARGET` row remains `custom` for backward compatibility. The editor writes the harness, model, and ACP target fields in one `PATCH /api/agents/{id}/runtime` transaction.

OpenCode runs `opencode acp`. Before the first prompt, the adapter applies `MODEL_OVERRIDE` through ACP's advertised `model` config option. It also injects the model into `OPENCODE_CONFIG_CONTENT` before spawn, because the process environment cannot be changed after `session/new`; that startup value is the fallback when the target omits or rejects the protocol option. Missing or rejected options are logged and do not fail the session.

Custom targets use `ACP_TARGET_COMMAND` plus JSON-array `ACP_TARGET_ARGS`. `ACP_TARGET_ENV_KEYS` is a JSON array of environment/config keys explicitly allowed into the child process; the adapter never forwards the complete resolved environment. `ACP_MODEL_ENV_KEY` optionally maps `MODEL_OVERRIDE` into a target-specific environment variable as its model fallback. `ACP_CONFIG_OPTIONS` is a JSON object of additional string or boolean ACP option values.

All projected config-option strings pass through `scrubSecrets` before the adapter emits session metadata, including grouped choices. Boolean values and non-secret model IDs and descriptions retain their values. This protects both credential-status persistence and the diagnostic mirror.

The latest sanitized `configOptions` advertised by a target are stored in the agent's credential-status telemetry and shown read-only in the dashboard. No report means no ACP session has reported options yet; an empty list means a session explicitly advertised none.

The `docker-entrypoint.sh` swarm_config-fetch step explicitly **skips** `HARNESS_PROVIDER` when exporting config to env. Baking it would shadow swarm_config deletes with the stale value persisted in `process.env`.

**Canonical conceptual reference:** [docs-site/.../guides/harness-providers.mdx](../docs-site/content/docs/(documentation)/guides/harness-providers.mdx). That guide is the source of truth for how the `ProviderAdapter` interface, the runner's poll→spawn→events→finish flow, system-prompt composition, entrypoint credential restoration, and OAuth flows fit together. Read it before non-trivial work.

## Tool-result handling (isError propagation)

MCP tools return `isError` on the wire `CallToolResult` (see [runbooks/mcp-tool-results.md](./mcp-tool-results.md) for the full server-side contract). Adapters that wrap the MCP client for an in-process agent library must propagate that flag explicitly rather than assuming a resolved call means success.

**pi**: `mcpToolsToDefinitions` in `src/providers/pi-mono-adapter.ts` calls `mcpClient.callTool(...)` and gets the raw result back. pi-agent-core derives a tool call's error flag from whether the wrapped `execute()` **throws** — not from any field on a resolved return value. The adapter therefore checks `result.isError` and `throw`s (rather than returning) when it's true; without that, a failed script/tool call would resolve normally and pi-agent-core would report it to the model as a success.

## Live task steering

`ProviderSession.deliverSteering?(delivery: SteerDelivery): Promise<SteerDeliveryResult>` is the optional live-input seam. `ProviderTraits.steerModes` advertises the modes an adapter can provide; an absent field means `[]`.

| Provider | `steer` | `queue` | Delivery behavior |
|---|---|---|---|
| `pi` | Native `agentSession.steer()` | Native `agentSession.followUp()` | Richest semantics; both modes preserve the session. |
| `claude-managed` | Yes | Yes | Sends ordered `user.message` events to the managed session. |
| `opencode` | Lossy: SDK abort, then `promptAsync` | Native `promptAsync` | Interrupt discards the in-flight turn before re-prompting; queue is the zero-loss path. |
| `devin` | No | Yes | `sendMessage` accepts a working session but does not guarantee interruption, so the adapter always reports `mode: "queue"`. |
| `claude` | No | Conditional | Both transports queue input at a turn boundary. CLI uses the version gate below. SDK enables queueing unless explicitly disabled. |
| `codex` | Native `turn/steer` | Adapter queue | The per-task app-server receives steering over JSON-RPC. `steer` interrupts the active turn. `queue` starts after that turn ends. See below. |
| `acp` | No | No | ACP has one in-flight `session/prompt` and no queue primitive; `session/cancel` is a full abort, not an interrupt. Advertises `[]`. |

The server-side `PROVIDER_STEER_CAPABILITIES` map in `src/types.ts` must deep-equal each adapter's `traits.steerModes ?? []`. `src/tests/provider-steering-capabilities.test.ts` iterates the canonical `ProviderNameSchema` list through `createProviderAdapter()` and names the offending provider on drift. Adding a provider requires updating the schema, factory, adapter traits, and capability map together.

Steering is disabled by default; `STEERING_ENABLED=true|1` is the global opt-in (set it on the API server and worker containers). While off, new steering requests are rejected, steering MCP/UI surfaces are removed, and worker delivery polling is skipped. Existing read-only message history, in-flight worker delivery callbacks, and terminal-status promotion remain available so pre-existing rows can be inspected and drain to a terminal state.

### Claude queue-steering gate

These version checks apply to the CLI transport.
The SDK always uses streaming input and enables queued delivery unless `CLAUDE_QUEUE_STEERING` explicitly disables it.
The SDK rejects bridge selection before starting a session.

Claude's queued steering needs `--input-format stream-json`. That input mode is mutually exclusive with the long-standing `-p <prompt>` invocation, so enabling it changes startup for every Claude task, including tasks that are never steered.

With `CLAUDE_QUEUE_STEERING` unset, the adapter enables stream-json input only when the effective Claude binary:

1. reports Claude Code `>= 2.1.205` from `--version`, and
2. is the stock binary rather than the claude-bridge/tmux wrapper path.

`CLAUDE_QUEUE_STEERING=0|false|off|no` forces the feature off and keeps `-p`. `CLAUDE_QUEUE_STEERING=1|true|on|yes` is an operator force-on override and skips the automatic version/wrapper decision. Invalid or empty values behave like unset.

When disabled, the adapter keeps `-p <prompt>` and the live session exposes no `deliverSteering`; an undeliverable message is promoted to a follow-up task. The provider trait remains queue-capable because the stock, supported Claude runtime implements that mode; the per-session gate is an operational availability check.

### Codex app-server delivery

Production Codex sessions start a fresh `codex app-server` inside the existing isolated per-task runner. The parent adapter and task runner keep their JSONL control channel open. The task runner uses JSON-RPC with the app-server.

- `steer` sends native `turn/steer`. Codex adds the input to the active turn.
- `queue` stores the message in the adapter. Delivery succeeds only after Codex accepts the next native turn.
- If the session ends before that turn starts, delivery fails and the pending message remains eligible for follow-up promotion.
- Queue acknowledgements do not block cancellation or polling other tasks.
- A message accepted before app-server readiness remains pending until the connection is ready.
- `abort()` sends the native turn interrupt request. If it cannot complete within the bounded grace period, the runner terminates the task process group.

The adapter creates no shared app-server daemon and never resumes a native Codex thread. Task continuity still uses the swarm context preamble.

### Codex hook delivery for legacy exec sessions

`src/hooks/codex-hook.ts` remains for legacy `codex exec` sessions. The worker image registers it for `SessionStart`, `PostToolUse`, and `Stop` through `/etc/codex/requirements.toml`. It polls pending steering messages, marks each row delivered, then injects the rendered envelope through hook output.

App-server sessions set `SWARM_CODEX_APP_SERVER=1`. The hook exits before polling in that mode. This prevents a hook and the worker from delivering the same message. `PreToolUse` remains unregistered because Codex drops its `additionalContext`.

## Per-task `outputSchema` support

Tasks may carry an optional JSON Schema on `outputSchema` (see `CreateTaskOptions` in `src/be/db.ts`). Enforcement depends on the harness:

| Provider | Supported | Notes |
|----------|-----------|-------|
| `claude` | Yes | Via MCP + `claude -p --json-schema` extraction fallback in `handleStructuredOutputFallback` |
| `claude-managed` | Yes | Via MCP |
| `codex` | Yes | Via MCP |
| `opencode` | Yes | Via MCP |
| `pi` (`pi-mono`) | Yes | Via MCP |
| `devin` | Conditional | Only when `HAS_MCP=true`. In default mode the schema is **not** enforced — Devin's free-form output is stored as-is. |

When supported, validation happens in the `store-progress` MCP tool (see `src/tools/store-progress.ts:159-190`). When the schema is missing or violated, the tool call fails and the agent is asked to retry.

### `task.output` fallback order on clean session end

When a session ends without an explicit `store-progress` call, `ensureTaskFinished` (`src/commands/runner.ts`) fills `task.output` from the first of:

1. Adapter-owned `ProviderResult.output` (`claude`, `pi`/`pi-mono`, `claude-managed`, `devin`).
2. **Runner-buffered last assistant text** — the runner's provider-event loop buffers the last non-empty assistant `message` event (`trackAssistantText`), capped at 30,000 characters (`… [truncated]` marker beyond that). Used only when the adapter didn't populate `output` itself (`codex` today; any future adapter that emits `message` events but no `ProviderResult.output`). Empty buffer (for example `opencode`, which never emits `message` events) is a no-op — behavior is byte-identical to having no `providerOutput` at all.
3. `claude -p --json-schema` extraction fallback (`handleStructuredOutputFallback`), when the task has an `outputSchema` and neither #1 nor #2 produced text that validates against it. The extraction prompt includes the captured text (from #1 or #2) as a "Final Agent Message" section ahead of progress-log history.
4. Sentinel `"Process completed successfully (no output captured)"` when no schema and no text of any kind was captured.

A schema'd task whose captured text is free-form prose (not valid against `outputSchema`) no longer hard-fails — it falls through to step 3's extraction instead. Buffered/adapter text is never truncated *after* it passes schema validation; only the pre-validation capture (step 2) is capped. Failure paths (non-zero exit) never consult the buffer — `failureReason` is the only signal.

**Devin caveat, corrected:** `providerOutput` from any adapter — including default-mode Devin, where `HAS_MCP=false` and the schema isn't enforced in `store-progress` — goes through the same `validateProviderOutputIfNeeded` gate in `ensureTaskFinished` before landing in `task.output`. A schema'd task is not written unvalidated; a violation falls through to step 3 above like any other harness. Callers can rely on `JSON.parse(task.output)` succeeding for a schema'd, `completed` task regardless of harness.

## Reasoning / effort control

`PATCH /api/agents/{id}/runtime` accepts an optional `reasoning_effort` field — a normalized, closed enum `off | low | medium | high | xhigh | max` — persisted as the agent-scoped `swarm_config` key `REASONING_EFFORT_OVERRIDE` (reloadable, same mechanism as `MODEL_OVERRIDE`). The runner resolves it independently of the model/`modelTier` axis and sets `ProviderSessionConfig.reasoningEffort`. `minimal` remains out of scope because Codex `*-codex` models reject it. `max` is capability-gated and Codex-only: non-Codex harnesses filter it even when an upstream model snapshot advertises it.

`src/providers/reasoning-effort.ts` owns capability gating (`reasoningCapability(harness, model)`) and per-harness translation (`applyReasoningEffort(harness, model, level)`). Capability data is hybrid: the models.dev `reasoning_options` snapshot (`src/providers/modelsdev-reasoning.json`, derived from `src/be/modelsdev-cache.json` by `scripts/refresh-modelsdev-pricing.ts`) wins where present; otherwise a hand-authored `{low, medium, high}` fallback, plus a small harness-specific override table for quirks the cache doesn't encode. `PATCH /api/agents/{id}/runtime` validates the requested level against this lookup and 400s unsupported combos with `{ error, harness, model, level, allowed }`.

When unset, every adapter behaves exactly as it does today — no fleet-wide default is injected.

| Provider | Transport | Notes |
|----------|-----------|-------|
| `claude` | `CLAUDE_CODE_EFFORT_LEVEL` env var | `off` on a legacy budget_tokens-capable model sets `MAX_THINKING_TOKENS=0` instead (omits the effort env). No CLI flag — `--effort` is buggy in `-p` mode. **Precedence**: if an operator's `additionalArgs` includes `--effort`, the CLI flag wins over `CLAUDE_CODE_EFFORT_LEVEL` (Claude CLI's own precedence) — this is the existing "`additionalArgs` is an escape hatch" behavior, not special-cased. |
| `codex` | `model_reasoning_effort` config field | `off` maps to `'none'`; `max` passes through for capability-advertising models such as GPT-5.6. `show_raw_agent_reasoning` stays pinned `false` regardless — operators setting higher effort pay for reasoning tokens (visible in `reasoning_output_tokens` cost telemetry) but get no visible reasoning trace in the dashboard. `*-codex` (non-`max`) models reject `xhigh`; `*-codex-max` models accept it. |
| `pi` | `thinkingLevel` session option | Top-level sibling of `model` on `CreateAgentSessionOptions`; native vocabulary already includes `off`. |
| `opencode` | Provider-keyed `options` in the per-task `opencode.json` | `anthropic/*` models: `thinking.budgetTokens` (internal numeric translation — not a user-facing knob). `openrouter/*` models: `reasoning.effort`. OpenAI-compatible models: `reasoningEffort`. `off` omits reasoning keys entirely (noop) — Opencode has no explicit off switch. |

The adapter's actually-applied level flows back through `ProviderResult.appliedReasoningEffort` (`null` on a capability-rejected noop) into `agents.cred_status.latestModel.reasoningEffort`, surfaced in the dashboard's runtime editor, the `HarnessCell` tooltip, and the agents-list Model column (`[|||]`-style badge, more bars = higher effort).

Refs: [reasoning-effort runtime control research](../thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md).

## pi-mono + Amazon Bedrock auth

### Mode selection

Bedrock mode is active when **either**:

1. `BEDROCK_AUTH_MODE=sdk` is set in `swarm_config` (explicit), **or**
2. `BEDROCK_AUTH_MODE` is absent and `MODEL_OVERRIDE` starts with `amazon-bedrock/` (prefix-inference fallback — preserves the earlier prefix-inference behavior).

`BEDROCK_AUTH_MODE=bearer` is recognised and validated but the full bearer-token path is not implemented yet. Workers in `bearer` mode fall through to the standard credential check (key / auth.json).

### Credential probe

When Bedrock SDK mode is active, `checkPiMonoCredentials` runs a **real** enumeration pass — `ListFoundationModels` + `ListInferenceProfiles` via `@aws-sdk/client-bedrock` (dynamically imported — the API binary never loads the SDK). The same call both verifies the credential chain and lists the usable models. This replaces the previous optimistic always-ready return.

- **Success** → `ready: true, satisfiedBy: "sdk-delegated"`. The worker proceeds to claim tasks.
- **Failure** → `ready: false` with a classified hint (auth / throttle / access / model) via `classifyAwsSdkError`. The worker parks in `credential-wait` until credentials are corrected.

Any source the AWS SDK accepts works: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`), `AWS_PROFILE` + `~/.aws/credentials`, SSO sessions in `~/.aws/config`, EC2 IMDS / ECS task role, web-identity / OIDC, `credential_process`, assume-role chains.

### Configuration keys

| Key | Values | Default |
|-----|--------|---------|
| `BEDROCK_AUTH_MODE` | `sdk` \| `bearer` | inferred from `MODEL_OVERRIDE` prefix |
| `AWS_REGION` | any Bedrock-enabled region | **required** — unset reports a not-ready Bedrock state (no region is fabricated) |

`BEDROCK_AUTH_MODE` is a validated optional `swarm_config` key (see `src/be/swarm-config-guard.ts`) and a reloadable env key (see `src/commands/runner.ts`).

### Live model enumeration

The credential enumeration also produces the usable model set. **Usable = harness-drivable ∩ AWS-invocable**, region-scoped to `AWS_REGION`:

1. **AWS-invocable** — the union of:
   - `ListFoundationModels` filtered to on-demand TEXT foundation models whose `modelLifecycle.status` is `ACTIVE` (the base model ids), **and**
   - `ListInferenceProfiles` ids — the cross-region inference-profile ids (`us.` / `eu.` / `apac.` / `au.` / `global.`). The newest Claude models on Bedrock are invocable **only** through an inference profile and never appear in `ListFoundationModels`, so this union is what keeps the current Claude models in the list.
2. **Harness-drivable** — the catalog from `getModels("amazon-bedrock")` (pi-ai's Converse harness). Each entry is a valid pi-ai id (base or profile), so the matched id round-trips through `MODEL_OVERRIDE=amazon-bedrock/<id>` unchanged.

Ids are matched exactly and the **pi-ai id is stored/displayed** (it is the id the harness can actually drive). Entries AWS lists but the harness can't drive — and harness models the account can't invoke — are both excluded, so the picker never surfaces a model that would fail with `invalid model identifier` at inference time.

`ListFoundationModels` lists models that *exist* in the region, not strictly ones the account has *enabled access* to; the on-demand/ACTIVE filtering narrows it, but base on-demand access-grant is not fully enumerable from the catalog. The inference-profile union is what makes the **current** models accurate.

The worker reports the intersected list up the `PUT /api/agents/:id/credential-status` channel as an optional `bedrock` block inside `cred_status` JSON (migration 055 column — no new column). The `bedrock` block carries `{ region, probedAt, ready, models: [{id, name}], error? }`. When Bedrock mode is not active, the block is `null`.

The dashboard's pi harness model picker prefers the worker-reported live list when present and falls back to the `modelsdev-cache.json` static snapshot until a worker reports. The picker is NEVER blank, and a failed probe (`ready:false`) surfaces its reason as picker subtext rather than a silently disabled group.

### Notes

- `AWS_REGION` must be set explicitly to the region where your Bedrock models are accessible; the enumeration region must match where inference runs. When `AWS_REGION` is unset the worker reports a not-ready Bedrock state with a "set AWS_REGION" hint and **does not** guess a region.
- The enumeration runs at boot AND on a throttled periodic refresh inside the reconcile loop (`BEDROCK_REFRESH_INTERVAL_MS`, default 5 minutes), decoupled from the harness-change gate — so enabling Bedrock access after boot surfaces within a few minutes without a worker restart. Each refresh is one bounded AWS round-trip; a transient throttle error won't permanently block the worker — the next tick re-enumerates.
- Credential errors during inference continue to surface via structured pi-coding-agent events (handled in `PiMonoSession`) and are classified by `classifyAwsSdkError`.
- The `validateProviderCredentials` live-test arm for `pi` + Bedrock is a pass-through (`presenceCheckOk`) — the real check is the probe above, not a second SDK call.
- The API binary never imports `@aws-sdk/client-bedrock`; all SDK work is worker-side.

### Bedrock probe card (Credentials tab)

A dedicated **AWS Bedrock** card appears in the Credentials tab for all `pi`-harness agents. It renders a read-only ready/blocked/pending classification at parity with the main credentials card, plus region, probe timestamp, usable model count, and error text when blocked. Implemented in `apps/ui/src/pages/agents/[id]/credentials-panel.tsx` (`BedrockProbeCard`).

| Dot color | State | Meaning |
|-----------|-------|---------|
| Green | `ready` | SDK credential chain is valid; models enumerated. |
| Red | `blocked` | Probe failed; error text shown. Worker is parked at `credential-wait`. |
| Grey | `pending` | Worker hasn't reported yet (booting, or Bedrock mode not active). |

## Native session resume is deprecated (2026-05-28)

The runner no longer asks any harness to resume a prior session. Follow-up continuity flows entirely through the bounded context preamble (`src/commands/context-preamble.ts`), which is rebuilt deterministically from the parent-task chain held in the API DB and survives worker-container restarts. The earlier path — `claude --resume <UUID>` / `codex.resumeThread(id)` / managed-cloud `events.list` replay — depended on an on-disk transcript that disappears on deploy/OOM/autoscaler reschedule; when it died, users perceived the agent as having forgotten the conversation.

Concretely:

- `src/commands/runner.ts` calls `resolveResumeSession(...)` and `logResumeResolution(...)` for observability only; the runner never threads `resumeSessionId` into `spawnProviderProcess`.
- `src/commands/resume-session.ts` is reduced to an observability shim — every non-empty candidate ends up in `resolution.skipped` with reason `"native resume deprecated — using context preamble"`. `resolveResumeSession` always returns `resumeSessionId: undefined`.
- All local adapters (`claude`, `claude-managed`, `codex`) warn + ignore any stray `resumeSessionId` and spawn a fresh session. `CodexAdapter.canResume()` returns `false` unconditionally.
- `ProviderSessionConfig.resumeSessionId` stays in the type for backwards compatibility but is marked `@deprecated`. New writes to `tasks.claudeSessionId` / `provider` / `providerMeta` continue for observability; no migration was run.
- **Out of scope**: Devin. Its server-side continuation lives in Cognition's cloud and is immune to the container-restart bug — Devin's resume path is unchanged.

Refs: [`thoughts/taras/plans/2026-05-28-deprecate-native-resume.md`](../thoughts/taras/plans/2026-05-28-deprecate-native-resume.md). When rolling back, prefer `git revert` over re-introducing a runtime flag — the deprecation was intentionally one-shot to avoid keeping dead resume paths around.

## Same-PR doc-update rule

Any **observable** change must update the docs-site guide in the **same PR** as the code change. Observable means:

- `ProviderAdapter` interface changes
- Factory dispatch logic
- Adapter event-translation, log format, or abort semantics
- Runner's poll→spawn→events→finish flow
- Provider steering traits or `deliverSteering` behavior
- System-prompt composition (`src/prompts/`)
- `docker-entrypoint.sh` credential restoration
- OAuth flows

Internal refactors that don't change observable behavior don't need a doc update.

## Adding a new provider

1. Read the docs-site guide's "Reference implementations" section to see how `claude`, `pi`, `codex`, and `devin` are wired.
2. Implement the `ProviderAdapter` in `src/providers/<name>/`.
3. Add its name to `ProviderNameSchema`, wire `createProviderAdapter`, and keep `traits.steerModes` synchronized with `PROVIDER_STEER_CAPABILITIES`.
4. Branch in `docker-entrypoint.sh` for credential restoration if the provider needs auth files.
5. Update the docs-site guide:
   - Add to "Reference implementations" table.
   - Add to "Files to touch" checklist.
6. Add the new provider to `README.md`'s multi-provider bullet.
7. Add adapter tests for advertised steering modes and SDK rejection.
8. Verify the docs build per [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).

## Alt-binary: claude-bridge

User-facing guide: [docs-site/.../guides/claude-bridge-experimental.mdx](../docs-site/content/docs/(documentation)/guides/claude-bridge-experimental.mdx). Engineering notes below.

[`@desplega.ai/claude-bridge`](https://github.com/desplega-ai/claude-bridge) is a Desplega-owned drop-in front for common `claude -p` automation. It drives interactive `claude` inside `tmux`, sends the prompt through the pane, tails Claude's JSONL transcript, and emits Claude-compatible `text`, `json`, or `stream-json`. It accepts the flags the swarm passes today (`-p`, `--model`, `--verbose`, `--output-format stream-json`, `--permission-mode`, `--append-system-prompt`, `--mcp-config`, `--strict-mcp-config`, `--dangerously-skip-permissions`), so `ClaudeAdapter.buildCommand()` does not branch — only the argv prefix changes.

**Billing guidance, checked September 9, 2026.** Anthropic paused the separate SDK credit pool on June 15.
Its [support update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says SDK and `claude -p` usage still consume subscription limits.
OAuth success alone does not prove account billing behavior.
Existing bridge configuration remains effective on CLI.
SDK sessions reject an effective bridge because it cannot speak the SDK control protocol.

### Bridge toggle

`SWARM_USE_CLAUDE_BRIDGE` is the supported opt-in. `true` and `1` enable it; `false`, `0`, empty, and unset disable it. The key is reloadable: it is included in `RELOADABLE_ENV_KEYS` in `src/commands/runner.ts`, and `ClaudeAdapter.createSession` resolves it from `config.env || process.env`.

Resolution order:

1. **swarm_config** `SWARM_USE_CLAUDE_BRIDGE` (scope: repo > agent > global) — overlay value in `config.env`.
2. **`process.env.SWARM_USE_CLAUDE_BRIDGE`** — container env, set at boot or live-reloaded by the runner.
3. **disabled** — final default.

When enabled, the adapter ignores `CLAUDE_BINARY` for the effective argv and uses:

| Raw prefix | Resulting argv prefix |
|---|---|
| `claude-bridge` | `["claude-bridge"]` |

The published npm package is `@desplega.ai/claude-bridge`; version `0.1.13` is pinned in `Dockerfile.worker` under `/opt/global-deps/package.json`, with bin `claude-bridge` pointing at `src/cli.ts` and a Bun shebang. The global-deps install symlinks that bin onto `PATH`, so bridge mode does not perform a runtime `bunx` fetch.

`src/utils/internal-ai/complete-structured.ts` (the `claude -p --json-schema` fallback used when the harness can't enforce `outputSchema` directly) applies the same bridge toggle before falling back to `CLAUDE_BINARY`.

### Tmux fail-fast

`createSession` calls `Bun.which("tmux")` when `SWARM_USE_CLAUDE_BRIDGE=true` and throws `SWARM_USE_CLAUDE_BRIDGE=true requires 'tmux' on PATH …` if it's missing. claude-bridge's own startup surfaces a clear message if `claude` is missing, so the swarm doesn't double-check that one.

### Prompt pre-clear

The adapter runs the same `$HOME/.claude.json` project trust pre-seed for
bridge mode that it uses for the legacy bridge compatibility path before
spawning the binary. This is required because bridge mode launches interactive
Claude Code inside `tmux`; if Claude hits the first-run "is this a project you
trust?" prompt before the bridge is ready, the pane can exit or hang with no
useful stderr.

claude-bridge also handles first-run blocking prompts itself after startup:

- edits Claude's global config so `projects[workdir].hasTrustDialogAccepted` and `hasCompletedProjectOnboarding` are set
- writes `.claude/settings.local.json` with dangerous-mode bypass settings
- launches `claude` with `--dangerously-skip-permissions`
- watches `tmux capture-pane` for supported startup prompts and sends `Enter`

### Deprecated legacy bridge compatibility

`CLAUDE_BINARY` remains supported for custom argv prefixes and for existing legacy bridge deployments, but that compatibility path is deprecated. If the configured `CLAUDE_BINARY` matches the legacy bridge binary, `createSession` emits a warning pointing at `SWARM_USE_CLAUDE_BRIDGE=true`.

`CLAUDE_BINARY` still follows the same overlay-then-fallback precedence as before:

1. **swarm_config** `CLAUDE_BINARY` (scope: repo > agent > global) — overlay value in `config.env`.
2. **`process.env.CLAUDE_BINARY`** — container env, set at boot.
3. **`"claude"`** — final default.

The resolved raw string is parsed by `parseClaudeBinary`: trim + whitespace-split. No shell parsing. Existing forms still work:

| `CLAUDE_BINARY` | Resulting argv prefix |
|---|---|
| (unset) or empty | `["claude"]` — default, no behavior change |
| legacy bridge binary | deprecated global install |
| legacy bridge absolute path | deprecated absolute path |
| legacy bridge package command | deprecated no-install form |
| legacy bridge npm command | deprecated npm form |

The legacy compatibility gates remain unchanged: tmux fail-fast plus the shared `preseedClaudeTrustDialog(cwd, homeDir?)` helper, which writes `$HOME/.claude.json` to set `projects[cwd].hasTrustDialogAccepted = true` and `hasCompletedProjectOnboarding = true`. The helper is idempotent and read-merge-write. Bun's `os.homedir()` caches the real passwd entry and ignores `process.env.HOME` mutations, so the helper defaults to `process.env.HOME ?? homedir()` for testability.

### Auth

Same env vars as the default claude flow: `CLAUDE_CODE_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY`. The credential check is unchanged. The adapter passes OAuth directly into the bridge process; when bridge mode is enabled with Anthropic local auth instead of OAuth, the adapter adds `--desplega-local-auth` so claude-bridge forwards the local auth env into the tmux-launched Claude process.

### Not a new `HARNESS_PROVIDER`

claude-bridge is an env-based alternate binary on the existing `claude` adapter, not a separate provider. There is no `HARNESS_PROVIDER=claude-bridge`. `buildCommand()` is shared, and the same MCP / stop-hook plumbing applies.

## Trigger paths

This runbook applies when modifying:

- `src/providers/*`
- `src/commands/runner.ts` (provider dispatch)
- `src/prompts/*` (system-prompt composition)
- `docker-entrypoint.sh` (provider branches)
- Or adding a new provider end-to-end

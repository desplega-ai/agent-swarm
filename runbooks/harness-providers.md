# Harness providers runbook

Operational rules for editing or adding harness providers (claude, codex, opencode, pi, devin, acp, dsh, amp, future).

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
| DeepSeek Harness | `dsh` | `DshAdapter` | Spawns `dsh --profile headless --json` per task; OpenRouter or direct DeepSeek API. See [DeepSeek Harness](#deepseek-harness-dsh) below |
| Amp | `amp` | `AmpAdapter` | Spawns `amp -x --stream-json --stream-json-input` per task; `AMP_API_KEY`; every thread is stored on ampcode.com. See [Amp](#amp-amp) below |

## Amp (`amp`)

Set `HARNESS_PROVIDER=amp` and `AMP_API_KEY`. Amp is a proprietary CLI and a hosted
service: every thread (prompts, tool calls, tool output) is stored on ampcode.com.
The adapter passes `--visibility private`; there is no local-only mode, and Amp's
own storage is outside any model vendor's retention setting. Accept that data
flow before using it, and read [the terms](https://ampcode.com/terms) before
publishing an image that contains the binary.

The full worker image installs the pinned `@ampcode/cli` platform binary
(`AMP_VERSION` in `Dockerfile.worker`, SHA-512 verified, equal to `AMP_PACKAGE` in
`src/providers/amp-adapter.ts`; a test fails when they drift). The slim image has no
amp: the entrypoint and adapter fail when the executable is absent. `AMP_BINARY`
selects a trusted preinstalled executable. Amp releases several times a day and
auto-updates by default; the per-task settings turn that off. Bump the version
with a live run (`bun run e2e --only health --harness amp`).

What the adapter does, and why:

- **Spawn.** `amp -x --stream-json --stream-json-input -m agent-swarm --title
  "swarm task <id>" --settings-file <f> --mcp-config <f> --plugin-ready-timeout 30
  --visibility private --no-notifications --no-ide --no-color`. `XDG_CONFIG_HOME`
  points at a per-task temporary tree, so the plugin and settings live there and are
  removed at session end. The prompt is the first JSONL stdin message. `--title`
  skips Amp's own title-generation requests.
- **Model selection.** No model flag exists. `modelTier` maps to Amp's modes
  (`DEFAULT_MODEL_TIER_MAP.amp`: `low`, `medium`, `high`, `ultra`). A concrete model
  is a mode or a `provider/model` pin (`src/utils/amp-models.ts`; validated at
  send-task, agent runtime and session start). A pin runs on the `medium` mode's
  prompt and tools. Measured 2026-10-05: `low` is GLM-5.3 Flash (cheapest), `medium` is
  Claude Opus 5.5, so the regular tier is not cheap. The Runtime editor defaults to `low`.
- **System prompt.** The plugin route: a generated plugin registers one agent mode
  that `extends` the base mode and appends the swarm prompt as `instructions`
  (live verified). The prompt is a JSON literal. AGENTS.md was not needed.
- **Reasoning effort.** The CLI has no effort flag (`--effort` is rejected). The
  plugin agent's `reasoningEffort` carries it, only for a pinned model whose
  catalog entry lists levels (`off` -> `none`).
- **Swarm MCP.** Per-task `--mcp-config` (`0600`) with the five identity headers.
  The session fails when Amp does not report the server `connected` (`reconnecting`
  was seen live when the agent id was unknown to the API).
- **Tool search.** `hasToolSearch: true`, with the `system.agent.tool_discovery.amp`
  text: Amp reaches MCP tools through its own `tool_search` and `code_exec`, names
  underscored (`store_progress`). Direct exposure of the 131 swarm tools (excluding
  both) measured about 98k input tokens against about 37k, so it is not used.
- **Tokens, context and cost.** Stream usage drives `context_usage` (window unknown
  until the end). After exit, `amp threads export <id>` names the model per request
  and Amp's window; `CostData` carries `provider: "amp"`, `totalCostUsd: 0` and a
  per-model breakdown, priced from the `amp` rows (models.dev `anthropic`, `openai`,
  `google`, `fireworks-ai`). Cache-creation tokens are cache writes for Anthropic
  models and input for the rest. Subagent threads are not counted. One retry covers a
  thread killed mid-run.
- **Steering.** `steerModes: ["queue"]`. Amp emits `result` only on stdin EOF, so
  input ends at the first top-level assistant message with no tool call and no
  unechoed queued message. A later steer returns `delivered: false`.
- **Cancel and failure.** Every stop (cancel, MCP failure, stdin failure, the exit
  watchdog) is SIGTERM then SIGKILL, plus every descendant: Amp runs shell commands in
  their own session (`setsid`), so a group kill alone leaves them as orphans of PID 1
  (`terminateProcessTree` in `src/utils/process-group.ts`). The session settles only
  after the stop finishes.
- **Credentials.** Readiness is the presence of `AMP_API_KEY`. The worker live test is
  `amp usage` (no inference, 5 second limit, clean config dir so a stored login
  cannot mask a bad key). A missing key parks the worker in the credential wait.
- **Failure path.** With MCP, an agent ends a task `failed` through `store-progress`.
  A result other than `success`, a non-zero exit or a missing result fails the task.

Not covered: installed MCP servers are not forwarded; no native resume; subagent
tokens are not in the cost; Amp's billed credits can differ from the list-price
estimate.

## DeepSeek Harness (`dsh`)

Set `HARNESS_PROVIDER=dsh` and `OPENROUTER_API_KEY` in the worker environment or
agent-scoped config. This runs DeepSeek's own harness with the same defaults as
pi: smol/regular `openrouter/deepseek/deepseek-v4.1-flash`, smart
`openrouter/deepseek/deepseek-v4-pro-0813`, ultra `openrouter/anthropic/claude-opus-5.5`.

Routing follows the model prefix, even when both keys are available:
`MODEL_OVERRIDE=openrouter/<model-id>` uses the bundled `llm-pi-ai` adapter with
`OPENROUTER_API_KEY`, strips only `openrouter/`, and honors `OPENROUTER_BASE_URL`
(default `https://openrouter.ai/api/v1`). The selected model is explicitly declared
so newly released IDs do not depend on the bundled catalog. For direct DeepSeek,
set `DEEPSEEK_API_KEY` and a bare `MODEL_OVERRIDE` such as `deepseek-v4-pro`;
this retains the native `llm-deepseek` route. The native Flash ID is
`deepseek-flash` (V4.1 Flash); OpenRouter uses `deepseek/deepseek-v4.1-flash`.
There is no fallback across providers when the selected route's key is missing.

The full worker image installs `@deepseek-ai/dsh@0.2.1-alpha.1` at build time
in `worker-full-base`, alongside the optional tools in `/opt/global-deps-full`.
The slim image does not include dsh: use `worker-full` or provision the pinned
package in your custom image before starting a dsh worker. Both the entrypoint
and adapter fail when the executable is absent; startup never downloads npm
packages. `DSH_BINARY` selects a trusted preinstalled executable, otherwise the
adapter finds `dsh` on PATH. Use the pinned alpha for its required stdin/JSON
surface.

The adapter launches `--profile headless --patch <temporary-file> --json -`,
sends the task over stdin, sets the child working directory, and applies
everything else through the profile patch. Patch files are private (`0600`) and
removed after exit or cancellation. Credential readiness accepts either environment
key; session startup requires the key matching the selected model. Readiness
does not inspect dsh's managed credential store or verify inference.

What the patch sets, and why:

- **Swarm MCP.** The headless profile does not mount dsh's MCP client, so the
  patch inserts `@deepseek-ai/dsh-mcp-client` as `agent-swarm` over
  `streamable-http` to `${MCP_BASE_URL}/mcp`, with the same per-task headers the
  other adapters send (`Authorization`, `X-Agent-ID`, `X-Source-Task-Id`,
  `X-Context-Key`, `X-Runtime-Instance-ID`). Tools appear as
  `mcp__agent-swarm__<tool>`, so `traits.hasMcp` is `true` and dsh gets the
  full worker prompt. dsh downgrades a plugin that fails to start to a
  `did not activate` warning and runs on without it; the adapter treats that
  warning as a session failure instead. Installed MCP servers (the
  `mcp-servers` catalog) are not forwarded yet.
- **Failure path.** With MCP, a dsh agent reports a blocked or impossible task
  through `store-progress` with `status: "failed"`, the same as every other
  harness; the runner's later `/finish` is a no-op on a terminal task. A turn
  that ends in anything but `completed` also exits non-zero and fails the task.
- **Sandbox.** dsh's `workspace-write` policy makes only the cwd and `/tmp`
  writable, has no setting for more roots, and refuses escalation headless, so
  a dsh agent could not write `/workspace/shared` or `/workspace/personal`. The
  patch sets `sandbox-policy` to `danger-full-access` and `approval` to `never`:
  the worker container is the sandbox, as it is for codex.
- **Reasoning effort.** `REASONING_EFFORT_OVERRIDE` (Runtime editor) becomes
  `agent-default-model.reasoningEffort`. Levels come from the catalog for the
  model: `low`/`high`/`max` on OpenRouter DeepSeek models (the adapter declares
  them on the model, since pi-ai treats a hand-declared model as
  non-reasoning), plus `off` on the direct DeepSeek API, where it is a real
  thinking toggle. `deepseek-flash` is not in the models.dev catalog, so it
  offers no effort and is unpriced.
- **Cost and context.** Each `status.step_end.usage` (one model call) becomes a
  `context_usage` snapshot (`input + cacheRead + cacheWrite + output`), and the
  summed tokens become a `CostData` record with `provider: "dsh"` and
  `totalCostUsd: 0`. The API prices it from the `dsh` pricing rows, projected
  from the models.dev `openrouter` section (`openrouter/` stripped) and the
  `deepseek` section (bare ids).
- **Model observability.** dsh's stream never names the model it called. The
  adapter logs a `{"type":"model","provider","model","reasoningEffort"}` line
  first, which the dashboard renders as a `model.selected` row. That is the
  model the swarm asked for; proving the model served needs dsh to emit it.

Still missing: live steering (`steerModes: []`) and native resume (follow-ups use
the context preamble). Developer-preview compatibility can change.

Verified against the [upstream headless documentation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/bundle/headless/README.md)
and the installed CLI's top-level and headless help.

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

After `session/prompt` completes, the adapter persists a bounded, scrubbed `custom` raw-log entry named `acp_prompt_response`. Its `data` contains `sessionId`, `stopReason`, `usage` (`null` when absent), and `_meta` when supplied. Token classes from the optional prompt usage map directly into `CostData`; missing counters remain `undefined` at the adapter boundary. The session-cost API and DB coalesce missing input/output/cache counters to zero, so persisted costs and UI displays cannot distinguish absent usage from measured zero. The raw diagnostic retains that distinction. Context `usage_update` totals do not substitute for billing tokens. No ACP pricing identity is inferred from the target or requested model.

The latest sanitized `configOptions` advertised by a target are stored in the agent's credential-status telemetry and shown read-only in the dashboard. No report means no ACP session has reported options yet; an empty list means a session explicitly advertised none.

The `docker-entrypoint.sh` swarm_config-fetch step explicitly **skips** `HARNESS_PROVIDER` when exporting config to env. Baking it would shadow swarm_config deletes with the stale value persisted in `process.env`.

**Canonical conceptual reference:** [docs-site/.../guides/harness-providers.mdx](../docs-site/content/docs/(documentation)/guides/harness-providers.mdx). That guide is the source of truth for how the `ProviderAdapter` interface, the runner's poll→spawn→events→finish flow, system-prompt composition, entrypoint credential restoration, and OAuth flows fit together. Read it before non-trivial work.

## Tool-result handling (isError propagation)

MCP tools return `isError` on the wire `CallToolResult` (see [runbooks/mcp-tool-results.md](./mcp-tool-results.md) for the full server-side contract). Adapters that wrap the MCP client for an in-process agent library must propagate that flag explicitly rather than assuming a resolved call means success.

**pi**: `mcpToolsToDefinitions` in `src/providers/pi-mono-adapter.ts` calls `mcpClient.callTool(...)` and gets the raw result back. pi-agent-core derives a tool call's error flag from whether the wrapped `execute()` **throws** — not from any field on a resolved return value. The adapter therefore checks `result.isError` and `throw`s (rather than returning) when it's true; without that, a failed script/tool call would resolve normally and pi-agent-core would report it to the model as a success.

On success the pi wrapper also returns the server's `structuredContent` next to the text, and sets `outputSchema` from `tools/list`. pi never sends `structuredContent` to the model; codemode scripts receive it instead of text. pi does not validate `outputSchema`, so our loose `z.looseObject` schemas pass as plain JSON Schema.

**pi installed MCP servers** go through pi's MCP extension, not our client: the adapter maps them with `toPiMcpServers` and the swarm hook registers them on `session_start`. The adapter must call `session.bindExtensions({})`, since the SDK never emits `session_start` by itself. Keep the replaced `loadConfig` so pi never reads `mcp.json` files, and keep escaping resolved values with `escapePiConfigValue`.

**pi tool deferral** (`PI_TOOL_DEFERRAL`, default off): non-core swarm tools get `exposure: "deferred"` and the session adds pi's `tool_search`. The adapter's `traits` getter reads the same flag for `hasToolSearch`, so the prompt and the session agree. Keep both reads on `process.env`. Pilot procedure: the harness-providers guide, section "pi tool deferral".

**pi codemode** (`PI_CODEMODE`, default off): adds `createCodemodeExtension({ mode: "on", models })` (`models` follows `PI_CODEMODE_MODELS`, default off, only with codemode on; the usage of a script's `models.*` calls reaches `getSessionStats()` cost, proven in `src/tests/providers/pi-cost.test.ts`), wrapped by `createBoundedCodemodeExtension` (120 s per-script deadline, 32 nested calls, 4 concurrent), and `+codemode` on every pi session. Never switch to `mode: "only"`: lifecycle tools must stay directly callable.

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

Steering is enabled by default; `STEERING_ENABLED=false|0` is the global opt-out (set it on the API server and worker containers). While off, new steering requests are rejected, steering MCP/UI surfaces are removed, and worker delivery polling is skipped. Existing read-only message history, in-flight worker delivery callbacks, and terminal-status promotion remain available so pre-existing rows can be inspected and drain to a terminal state.

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

App-server sessions set `SWARM_CODEX_APP_SERVER=1`. The hook exits before polling in that mode. This prevents a hook and the worker from delivering the same message. `PreToolUse` carries no steering because Codex drops its `additionalContext`. The image registers it for the PR body leak guard (`src/hooks/pr-body-guard.ts`), which runs in every session mode and blocks `gh pr create|edit` on a public repo with exit code 2.

## Per-task `outputSchema` support

Tasks may carry an optional JSON Schema on `outputSchema` (see `CreateTaskOptions` in `src/be/db.ts`). Enforcement depends on the harness:

| Provider | Supported | Notes |
|----------|-----------|-------|
| `claude` | Yes | Via MCP + `claude -p --json-schema` extraction fallback in `handleStructuredOutputFallback` |
| `claude-managed` | Yes | Via MCP |
| `codex` | Yes | Via MCP |
| `opencode` | Yes | Via MCP; the runner also validates the final assistant message (see the fallback order below) |
| `pi` (`pi-mono`) | Yes | Via MCP |
| `devin` | Conditional | Only when `HAS_MCP=true`. In default mode the schema is **not** enforced — Devin's free-form output is stored as-is. |

When supported, validation happens in the `store-progress` MCP tool (see `src/tools/store-progress.ts:159-190`). When the schema is missing or violated, the tool call fails and the agent is asked to retry.

### `task.output` fallback order on clean session end

When a session ends without an explicit `store-progress` call, `ensureTaskFinished` (`src/commands/runner.ts`) fills `task.output` from the first of:

1. Adapter-owned `ProviderResult.output` (`claude`, `pi`/`pi-mono`, `claude-managed`, `devin`).
2. **Runner-buffered last assistant text** — the runner's provider-event loop buffers the last non-empty assistant `message` event (`trackAssistantText`), capped at 30,000 characters (`… [truncated]` marker beyond that). Used only when the adapter didn't populate `output` itself (`codex` and `opencode`; any future adapter that emits `message` events but no `ProviderResult.output`). `opencode` emits one assistant `message` per finalized assistant message, built from its non-synthetic, non-ignored `text` parts, so the last one is the final answer. An empty buffer (an adapter that emits no assistant `message` events) is a no-op — behavior is byte-identical to having no `providerOutput` at all. For a task with an `outputSchema`, a buffered final message that is valid JSON matching the schema becomes `task.output`; otherwise the task falls through to #3, which for every non-`claude` adapter fails it with the "not provided via store-progress" reason.
3. `claude -p --json-schema` extraction fallback (`handleStructuredOutputFallback`), when the task has an `outputSchema` and neither #1 nor #2 produced text that validates against it. The extraction prompt includes the captured text (from #1 or #2) as a "Final Agent Message" section ahead of progress-log history.
4. Sentinel `"Process completed successfully (no output captured)"` when no schema and no text of any kind was captured.

A schema'd task whose captured text is free-form prose (not valid against `outputSchema`) no longer hard-fails — it falls through to step 3's extraction instead. Buffered/adapter text is never truncated *after* it passes schema validation; only the pre-validation capture (step 2) is capped. Failure paths (non-zero exit) never consult the buffer — `failureReason` is the only signal.

**Devin caveat, corrected:** `providerOutput` from any adapter — including default-mode Devin, where `HAS_MCP=false` and the schema isn't enforced in `store-progress` — goes through the same `validateProviderOutputIfNeeded` gate in `ensureTaskFinished` before landing in `task.output`. A schema'd task is not written unvalidated; a violation falls through to step 3 above like any other harness. Callers can rely on `JSON.parse(task.output)` succeeding for a schema'd, `completed` task regardless of harness.

**pi empty final turn:** some models end a pi session on an assistant turn with no text block and no tool call (thinking only, or empty content). pi treats that as a clean end, so a schema'd task finished with nothing to validate. After the first `waitForIdle()`, `PiMonoSession.repromptAfterEmptyFinalTurn` sends one in-session reprompt (registered template `task.nudge.empty_final_turn`) through the normal prompt path and waits for idle again; `output` then comes from the second turn. Never more than one per session, and none when the final turn has text or a tool call, errored, or was aborted, when `abort()` was called, or after a terminal `store-progress` call (`completed` or `failed`) returned without error. A rejected reprompt keeps the original outcome. Every empty assistant turn also writes a `[pi-mono] assistant turn ended with no text and no tool call (stopReason=..., content=[...])` stderr line to session logs: block types and token count only, never content.

When provider output fails `outputSchema` validation and the fallback also fails (always for non-claude adapters), the task's `failureReason` keeps the validation error after the fallback's own reason.

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

`BEDROCK_AUTH_MODE=bearer` uses a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`, which the AWS SDK picks up as the bearer identity. `checkPiMonoCredentials` reports `AWS_BEARER_TOKEN_BEDROCK` as missing when bearer mode is set without it.

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
- The enumeration runs at boot AND on a throttled periodic refresh inside the reconcile loop (`BEDROCK_REFRESH_INTERVAL_MS`, default 5 minutes), decoupled from the harness-change gate — so enabling Bedrock access after boot surfaces within a few minutes without a worker restart. Each refresh is one bounded AWS round-trip; a not-ready probe or failed report retries on the 30-second credential recovery interval until a ready report succeeds. The runner keeps polling and uses the same runtime identity, so recovery needs no restart. `CRED_CHECK_DISABLE=1` disables these refreshes.
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

## Claude model routes (`packages/model-routing`)

The claude harness credential gate, spawn validator, and live check all derive one **default route** from the worker env with `deriveDefaultRoute("claude", env)` from `@desplega/model-routing` (issue #1800). Precedence: `CLAUDE_CODE_USE_FOUNDRY` > `CLAUDE_CODE_USE_BEDROCK` > `CLAUDE_CODE_USE_VERTEX` > non-Anthropic `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`. A non-Anthropic `ANTHROPIC_BASE_URL` is always a gateway route: with no gateway key it is not ready and names `ANTHROPIC_AUTH_TOKEN`, even when `CLAUDE_CODE_OAUTH_TOKEN` is set. It never falls back to the subscription (fail closed).

- **Gate** (`checkClaudeCredentials`, `validateClaudeCredentials`): `routeCredentialStatus` checks the route provider's `requiredEnv` (gateway key; `ANTHROPIC_FOUNDRY_RESOURCE`; `AWS_REGION`; `CLOUD_ML_REGION` + `ANTHROPIC_VERTEX_PROJECT_ID`). No route → the legacy two-variable missing list.
- **Live check** (`validateProviderCredentials("claude")`): `validateRoute` runs the provider's `validate` through `createScopedFetch(route.baseUrl)`, which refuses any other origin and never follows redirects. A gateway key is checked with `GET {ANTHROPIC_BASE_URL}/v1/models` (2xx verified, 401/403 failed, 404/405 configured). Subscription is presence-only. Foundry/Bedrock/Vertex have no `validate`, so the report carries no live test and the rollup shows `configured`.
- **Spawn env** (`withClaudeRouteEnv`): on every route except `claude-subscription`, `CLAUDE_CODE_OAUTH_TOKEN` is blanked; on gateway and cloud routes even when only `process.env` carries it. Claude Code 2.1.286 sends the OAuth token as `Authorization: Bearer` to `ANTHROPIC_BASE_URL` when no gateway key is set; a blank token counts as unset.
- **Internal AI** (`resolveCredential`): `ANTHROPIC_API_KEY` is skipped when `ANTHROPIC_BASE_URL` names a gateway, because pi-ai would send it to `api.anthropic.com`.
- The `claude-subscription` provider declares `harnesses: ["claude"]`; `assertRouteHarness` rejects it elsewhere.

The package is pure (no `src/`, SQLite, or filesystem imports; enforced by the `no-package-imports-src` dep-cruiser rule). Other harnesses return `null` from `deriveDefaultRoute` and keep their own checks.

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
4. Branch in `docker-entrypoint.sh` for credential restoration if the provider needs auth files, and give it its own branch in the `verify_provider_binary` chain (or add it to the final `!= "pi"` guard when it has no binary).
5. Run `bun run test:root -- src/tests/provider-registration.test.ts`. It iterates `ProviderNameSchema` over every mandatory touch point (credential checkers, the live Test-connection switch, both unknown-provider messages, `PricingProviderSchema`, the pricing seeder, the local-harness lists on server and dashboard, the dashboard's `PROVIDER_NAMES`, and both entrypoint chains) and names the provider and file on a miss. When a touch point should not carry the provider, add it to that touch point's `exempt` map with a one-line reason; an exemption for a provider that is present fails as stale.
6. Update the docs-site guide:
   - Add to "Reference implementations" table.
   - Add to "Files to touch" checklist.
7. Add the new provider to `README.md`'s multi-provider bullet.
8. Add adapter tests for advertised steering modes and SDK rejection.
9. Verify the docs build per [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).

A harness that only spawns and returns text is not done. Each item below was
missed once (dsh, 2026-10-01) and found only by running real tasks; ship them in
the adapter PR or document the gap in this runbook and the guide.

10. **Swarm MCP.** Wire the swarm MCP server with the per-task headers
    (`Authorization`, `X-Agent-ID`, `X-Source-Task-Id`, `X-Context-Key`,
    `X-Runtime-Instance-ID`) and set `traits.hasMcp: true`. Fail the session if
    the harness starts without the MCP tools; never let it run on silently. If
    the harness has no MCP client, keep `hasMcp: false`, say so here with the
    evidence, and accept that it is not a general worker.
11. **Failure path.** An agent must be able to end a task `failed`. With MCP,
    that is `store-progress` `status: "failed"`. Without it, the adapter needs a
    harness-level signal. A non-`completed` turn end must exit non-zero.
12. **Sandbox.** The harness must be able to write `/workspace/shared`,
    `/workspace/personal` and `/tmp`. If it sandboxes writes to the cwd, add
    those roots or run it unsandboxed inside the container.
13. **Provider on every task row.** `agent_tasks.provider` is written by
    `session_init`. Check that a spawn failure also records it: the runner
    sends `provider` on `/finish`, so do not bypass `ensureTaskFinished`.
14. **Cost and context.** Emit `context_usage` per model call and return
    `CostData` with `provider: "<name>"`. Add the provider's routing prefixes to
    `src/be/pricing-normalize.ts` and project its models in
    `src/be/seed-pricing.ts` so the default tier models price as
    `costSource: pricing-table`. Update the cost guide and
    `src/providers/pricing-sources.md`.
15. **Model observability.** Log the model the session actually calls. If the
    harness does not report it, log the model the adapter configured and say so.
16. **Reasoning effort.** Map `config.reasoningEffort` to the harness's real
    setting, add the harness to `REASONING_HARNESSES` and its model-string rules
    to `packages/model-catalog/src/reasoning.ts`, and offer only levels the
    harness honours on that route.
17. **Dashboard.** Add a logs-parser adapter in
    `apps/ui/src/logs-parser/adapters.ts` (otherwise every row renders as
    `UNKNOWN`), with a fixture from real persisted rows. Add the harness to the
    Runtime editor (`apps/ui/src/lib/agent-runtime-models.ts`): `LOCAL_HARNESSES`,
    `isLocalHarness`, a model-group branch, and effort levels.
18. **QA in production.** Run the procedure below before the harness takes
    general worker duty.

## How to QA a new harness

Unit tests prove the adapter builds the right command. They do not prove the
harness can do swarm work. Run this on the deployed swarm before calling a
harness ready.

### Setup

1. Pick a low-usage worker agent. Record its current `harness_provider`,
   `MODEL_OVERRIDE`, `REASONING_EFFORT_OVERRIDE` and `AGENT_MAX_TASKS`
   (Runtime editor, or `GET /api/agents/<id>/runtime` plus agent-scoped config).
   Check it has no in-flight tasks.
2. Switch it with `PATCH /api/agents/<id>/runtime` (`harness_provider`, `model`,
   `reasoning_effort`) or the Runtime editor. Set the harness credentials as
   agent-scoped config. Wait for the worker to pick up the change (next task).
3. Send each scenario as a task pinned to that agent
   (`routingReason: human_pinned`).

### Gates on every task

- `agent_tasks.provider` is the new harness, including for tasks that failed
  to spawn. A NULL or another harness means a silent fallback.
- `agent_tasks.model` matches the requested model, and the session log shows
  the model line.
- The dashboard renders the session with no `UNKNOWN` rows.
- A `session_costs` row exists with `costSource: pricing-table` and non-zero
  tokens, and the task shows context usage.

### Scenarios

| # | Scenario | Pass when |
|---|---|---|
| 1 | Smoke: reply with a sentinel string | Exact sentinel, completed |
| 2 | Write a file under `/workspace/shared`, return its sha256 | File exists, digest matches |
| 3 | Pure compute (e.g. sum of primes below 10000) | Correct value |
| 4 | Read the repo and cite a file and line | Correct citation |
| 5 | `modelTier` and an explicit `model` | Row model and logged model match each |
| 6 | Model whose credential is missing | `failed` fast, clear reason, `provider` set |
| 7 | Call MCP tools (`memory-search`, `store-progress`) | Tool calls succeed |
| 8 | Impossible task (read a file that does not exist) | Status `failed`, not `completed` |
| 9 | Cancel a long `sleep` | `cancelled`, agent back to idle, no orphan process |
| 10 | Send more tasks than `AGENT_MAX_TASKS` | Extra task rejected at capacity |
| 11 | Large output with unicode | Intact, untruncated |
| 12 | Follow-up via `parentTaskId` | Parent context carried |
| 13 | Steer a running task | Matches the advertised `steerModes` |

### Bar for general worker duty

Scenarios 1, 2, 3, 6, 7, 8 and 9 must pass, plus every gate. A harness that
fails 2, 7 or 8 can only take read-only or self-contained work, because it
cannot hand off through `/workspace/shared`, report progress, or fail a task.
Scenarios 5 and 10 to 13 may pass as a documented degrade.

### Restore

Put the agent back on the values recorded in setup with the same `PATCH`, and
remove any credentials you added for the test. Confirm the next task on that
agent records the original provider.

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

Same env vars as the default claude flow (see [Claude model routes](#claude-model-routes-packagesmodel-routing)). The bridge only runs on the subscription route: gateway and cloud routes blank `CLAUDE_CODE_OAUTH_TOKEN`, so the bridge falls back to stock `claude`. The adapter passes OAuth directly into the bridge process; when bridge mode is enabled with Anthropic local auth instead of OAuth, the adapter adds `--desplega-local-auth` so claude-bridge forwards the local auth env into the tmux-launched Claude process.

### Not a new `HARNESS_PROVIDER`

claude-bridge is an env-based alternate binary on the existing `claude` adapter, not a separate provider. There is no `HARNESS_PROVIDER=claude-bridge`. `buildCommand()` is shared, and the same MCP / stop-hook plumbing applies.

## Trigger paths

This runbook applies when modifying:

- `src/providers/*`
- `src/commands/runner.ts` (provider dispatch)
- `src/prompts/*` (system-prompt composition)
- `docker-entrypoint.sh` (provider branches)
- Or adding a new provider end-to-end

# Harness providers runbook

Operational rules for editing or adding harness providers (claude, codex, opencode, pi, devin, future).

## Supported providers

| Provider | `HARNESS_PROVIDER` | Adapter | Notes |
|----------|--------------------|---------|-------|
| Claude Code | `claude` | `ClaudeAdapter` | Default; spawns `claude` CLI |
| Codex | `codex` | `CodexAdapter` | Spawns `codex` CLI; OpenAI/ChatGPT OAuth |
| opencode | `opencode` | `OpencodeAdapter` | Spawns `opencode` CLI; OpenRouter primary; agent-swarm plugin auto-injected. See [harness-configuration § Opencode](/docs/guides/harness-configuration#opencode) |
| pi-mono | `pi` | `PiMonoAdapter` | In-process library; OpenRouter, Anthropic, or Amazon Bedrock (via `MODEL_OVERRIDE=amazon-bedrock/*` — see Bedrock auth below) |
| Devin | `devin` | `DevinAdapter` | Cloud-managed via Cognition `/sessions` API |
| Claude Managed | `claude-managed` | `ClaudeManagedAdapter` | Anthropic managed sandbox; SSE relay |
| AI SDK Agent | `ai-sdk-agent` | `AiSdkAgentAdapter` | In-process Vercel AI SDK `ToolLoopAgent`; OpenAI; adds provider-local `Skill` tool |

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

The `docker-entrypoint.sh` swarm_config-fetch step explicitly **skips** `HARNESS_PROVIDER` when exporting config to env. Baking it would shadow swarm_config deletes with the stale value persisted in `process.env`.

**Canonical conceptual reference:** [docs-site/.../guides/harness-providers.mdx](../docs-site/content/docs/(documentation)/guides/harness-providers.mdx). That guide is the source of truth for how the `ProviderAdapter` interface, the runner's poll→spawn→events→finish flow, system-prompt composition, entrypoint credential restoration, and OAuth flows fit together. Read it before non-trivial work.

## ai-sdk-agent `Skill` tool

`ai-sdk-agent` synthesizes a model-facing `Skill` tool inside `src/providers/ai-sdk-agent-adapter.ts`. This is intentionally provider-local: it is not registered in `createServer()`, `CORE_TOOLS`, the MCP bridge, or the swarm-script SDK allowlist. Other harnesses continue to use slash-skill prompt resolution.

The local tool loads only the current agent's installed skills, resolves exact normalized skill names/slugs before fuzzy name/description matches, and applies `MAX_SKILL_CHARS` truncation before returning `SKILL.md` content to the AI SDK loop.

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

**Caveat for default-mode Devin:** `ensureTaskFinished` in `src/commands/runner.ts` writes Devin's `providerOutput` directly into `task.output` without schema validation. Callers consuming a schema'd task's output should not assume `JSON.parse(task.output)` will succeed when the task ran on default-mode Devin.

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

A dedicated **AWS Bedrock** card appears in the Credentials tab for all `pi`-harness agents. It renders a read-only ready/blocked/pending classification at parity with the main credentials card, plus region, probe timestamp, usable model count, and error text when blocked. Implemented in `ui/src/pages/agents/[id]/credentials-panel.tsx` (`BedrockProbeCard`).

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
- System-prompt composition (`src/prompts/`)
- `docker-entrypoint.sh` credential restoration
- OAuth flows

Internal refactors that don't change observable behavior don't need a doc update.

## Adding a new provider

1. Read the docs-site guide's "Reference implementations" section to see how `claude`, `pi`, `codex`, and `devin` are wired.
2. Implement the `ProviderAdapter` in `src/providers/<name>/`.
3. Wire factory dispatch in `src/commands/runner.ts`.
4. Branch in `docker-entrypoint.sh` for credential restoration if the provider needs auth files.
5. Update the docs-site guide:
   - Add to "Reference implementations" table.
   - Add to "Files to touch" checklist.
6. Add the new provider to `README.md`'s multi-provider bullet.
7. Verify the docs build per [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).

## Alt-binary: claude-bridge (subscription-pool variant)

User-facing guide: [docs-site/.../guides/claude-bridge-experimental.mdx](../docs-site/content/docs/(documentation)/guides/claude-bridge-experimental.mdx). Engineering notes below.

[`@desplega.ai/claude-bridge`](https://github.com/desplega-ai/claude-bridge) is a Desplega-owned drop-in front for common `claude -p` automation. It drives interactive `claude` inside `tmux`, sends the prompt through the pane, tails Claude's JSONL transcript, and emits Claude-compatible `text`, `json`, or `stream-json`. It accepts the flags the swarm passes today (`-p`, `--model`, `--verbose`, `--output-format stream-json`, `--permission-mode`, `--append-system-prompt`, `--mcp-config`, `--strict-mcp-config`, `--dangerously-skip-permissions`), so `ClaudeAdapter.buildCommand()` does not branch — only the argv prefix changes.

**Why it exists.** Starting **2026-06-15**, `claude -p` (and the Agent SDK / GitHub Actions surfaces) draws from a dedicated programmatic-credit pool rather than the Max/Pro subscription quota. Interactive `claude` sessions stay on the subscription pool. Routing the harness through claude-bridge keeps swarm runs on the subscription pool for users who pay for one.

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

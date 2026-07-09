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

## Reasoning / effort control

`PATCH /api/agents/{id}/runtime` accepts an optional `reasoning_effort` field — a normalized, closed enum `off | low | medium | high | xhigh` — persisted as the agent-scoped `swarm_config` key `REASONING_EFFORT_OVERRIDE` (reloadable, same mechanism as `MODEL_OVERRIDE`). The runner resolves it independently of the model/`modelTier` axis and sets `ProviderSessionConfig.reasoningEffort`. `minimal` and `max` are intentionally out of scope for v1 (`minimal` is rejected by Codex `*-codex` models; `max` has known persistence bugs on Claude).

`src/providers/reasoning-effort.ts` owns capability gating (`reasoningCapability(harness, model)`) and per-harness translation (`applyReasoningEffort(harness, model, level)`). Capability data is hybrid: the models.dev `reasoning_options` snapshot (`src/providers/modelsdev-reasoning.json`, derived from `src/be/modelsdev-cache.json` by `scripts/refresh-modelsdev-pricing.ts`) wins where present; otherwise a hand-authored `{low, medium, high}` fallback, plus a small harness-specific override table for quirks the cache doesn't encode. `PATCH /api/agents/{id}/runtime` validates the requested level against this lookup and 400s unsupported combos with `{ error, harness, model, level, allowed }`.

When unset, every adapter behaves exactly as it does today — no fleet-wide default is injected.

| Provider | Transport | Notes |
|----------|-----------|-------|
| `claude` | `CLAUDE_CODE_EFFORT_LEVEL` env var | `off` on a legacy budget_tokens-capable model sets `MAX_THINKING_TOKENS=0` instead (omits the effort env). No CLI flag — `--effort` is buggy in `-p` mode. **Precedence**: if an operator's `additionalArgs` includes `--effort`, the CLI flag wins over `CLAUDE_CODE_EFFORT_LEVEL` (Claude CLI's own precedence) — this is the existing "`additionalArgs` is an escape hatch" behavior, not special-cased. |
| `codex` | `model_reasoning_effort` config field | `off` maps to `'none'`. `show_raw_agent_reasoning` stays pinned `false` regardless — operators setting `high` pay for reasoning tokens (visible in `reasoning_output_tokens` cost telemetry) but get no visible reasoning trace in the dashboard. `*-codex` (non-`max`) models reject `xhigh`; `*-codex-max` models accept it. |
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

## `CLAUDE_BINARY` override

`CLAUDE_BINARY` lets operators point the claude adapter at a custom argv prefix (a single binary name, an absolute path, or a whitespace-separated command string) instead of the `claude` on `PATH`. Resolved by `resolveClaudeBinary` / `parseClaudeBinary` in `src/providers/claude-adapter.ts`:

1. **swarm_config** `CLAUDE_BINARY` (scope: repo > agent > global) — overlay value in `config.env`.
2. **`process.env.CLAUDE_BINARY`** — container env, set at boot.
3. **`"claude"`** — final default.

Reloadable via `swarm_config` without a container restart (`set-config CLAUDE_BINARY=...`).

(Removed 2026-07-09: the `SWARM_USE_CLAUDE_BRIDGE` / `@desplega.ai/claude-bridge` subscription-pool variant and its legacy `tmux`-driven compatibility path — Taras confirmed it had been disabled fleet-wide for a while. `stock` is now the only claude harness path.)

## Trigger paths

This runbook applies when modifying:

- `src/providers/*`
- `src/commands/runner.ts` (provider dispatch)
- `src/prompts/*` (system-prompt composition)
- `docker-entrypoint.sh` (provider branches)
- Or adding a new provider end-to-end

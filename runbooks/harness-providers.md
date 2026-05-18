# Harness providers runbook

Operational rules for editing or adding harness providers (claude, codex, opencode, pi, devin, future).

## Supported providers

| Provider | `HARNESS_PROVIDER` | Adapter | Notes |
|----------|--------------------|---------|-------|
| Claude Code | `claude` | `ClaudeAdapter` | Default; spawns `claude` CLI |
| Codex | `codex` | `CodexAdapter` | Spawns `codex` CLI; OpenAI/ChatGPT OAuth |
| opencode | `opencode` | `OpencodeAdapter` | Spawns `opencode` CLI; OpenRouter primary; agent-swarm plugin auto-injected. See [harness-configuration § Opencode](/docs/guides/harness-configuration#opencode) |
| pi-mono | `pi` | `PiMonoAdapter` | In-process library; OpenRouter or Anthropic |
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

## Alt-binary: shannon (subscription-pool variant)

User-facing guide: [docs-site/.../guides/shannon-experimental.mdx](../docs-site/content/docs/(documentation)/guides/shannon-experimental.mdx). Engineering notes below.

[`@dexhorthy/shannon`](https://github.com/dexhorthy/shannon) is a drop-in front for `claude -p` that drives interactive `claude` inside `tmux` and tails the JSONL transcript. It accepts the same flags the swarm passes today (`-p`, `--model`, `--verbose`, `--output-format stream-json`, `--permission-mode`, `--append-system-prompt`, `--mcp-config`, `--strict-mcp-config`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`), so `ClaudeAdapter.buildCommand()` does not branch — only the argv prefix changes.

**Why it exists.** Starting **2026-06-15**, `claude -p` (and the Agent SDK / GitHub Actions surfaces) draws from a dedicated programmatic-credit pool rather than the Max/Pro subscription quota. Interactive `claude` sessions stay on the subscription pool. Routing the harness through shannon keeps swarm runs on the subscription pool for users who pay for one.

### Binary resolution

`CLAUDE_BINARY` follows the same overlay-then-fallback precedence as `HARNESS_PROVIDER`. `ClaudeAdapter.createSession` calls `resolveClaudeBinary(config.env || process.env)` (also in `claude-adapter.ts`), where `config.env` is the swarm_config overlay produced by `fetchResolvedEnv` in `src/commands/runner.ts`. Resolution order:

1. **swarm_config** `CLAUDE_BINARY` (scope: repo > agent > global) — overlay value in `config.env`.
2. **`process.env.CLAUDE_BINARY`** — container env, set at boot.
3. **`"claude"`** — final default.

This makes the binary reloadable: an operator can `PUT /api/config CLAUDE_BINARY="bunx @dexh/shannon"` and the next spawned task picks it up (~10s, one poll cycle). In-flight sessions stay on the binary they spawned with; new spawns get the new value. Same lifecycle as `HARNESS_PROVIDER` re-assignment.

The resolved raw string is then parsed by `parseClaudeBinary`: trim + whitespace-split. No shell parsing. The resulting argv tokens replace the single `"claude"` token at the head of the spawn command. Supported forms:

| `CLAUDE_BINARY` | Resulting argv prefix |
|---|---|
| (unset) or empty | `["claude"]` — default, no behavior change |
| `shannon` | `["shannon"]` — global install |
| `/usr/local/bin/shannon` | `["/usr/local/bin/shannon"]` — absolute path |
| `bunx @dexh/shannon` | `["bunx", "@dexh/shannon"]` — no install needed |
| `bunx @dexh/shannon@1.2.3` | `["bunx", "@dexh/shannon@1.2.3"]` — version pinned |
| `npx -y @dexh/shannon` | `["npx", "-y", "@dexh/shannon"]` — npm equivalent |

The shannon-detection gates (tmux check + trust pre-seed) run when the raw value (case-insensitive) `includes("shannon")`, so they fire for all forms above.

`src/utils/internal-ai/complete-structured.ts` (the `claude -p --json-schema` fallback used when the harness can't enforce `outputSchema` directly) applies the same whitespace-split to `CLAUDE_BINARY` for consistency.

### Tmux fail-fast

`createSession` calls `Bun.which("tmux")` when the binary contains `"shannon"` and throws `CLAUDE_BINARY=shannon requires 'tmux' on PATH …` if it's missing. Shannon's own startup surfaces a clear message if `claude` is missing, so the swarm doesn't double-check that one.

### Trust-dialog pre-seed

Shannon drives interactive `claude`, which prompts on first run in a fresh cwd:
```
Quick safety check: Is this a project you created or one you trust?
```
Shannon doesn't auto-accept, so the tmux pane hangs. `createSession` writes `$HOME/.claude.json` before spawning to mark `cwd` trusted:

```json
{
  "projects": { "<config.cwd>": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } }
}
```

The helper is `preseedClaudeTrustDialog(cwd, homeDir?)` — idempotent (no-op when already trusted), read-merge-write (preserves other keys + other projects). Same pattern as the existing onboarding-skip hack in `Dockerfile.worker` (`hasCompletedOnboarding` + `bypassPermissionsModeAccepted`).

Note for tests: Bun's `os.homedir()` caches the real passwd entry and ignores `process.env.HOME` mutations. The helper defaults `homeDir` to `process.env.HOME ?? homedir()` so tests can redirect by setting `HOME` to a tmp dir.

### Install

End-user docs (recommended `bunx` form, install commands): see [docs-site/.../shannon-experimental.mdx](../docs-site/content/docs/(documentation)/guides/shannon-experimental.mdx).

### Auth

Same env vars as the default claude flow: `CLAUDE_CODE_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY`. The credential check is unchanged.

### Not a new `HARNESS_PROVIDER`

Shannon is an env-based alternate binary on the existing `claude` adapter, not a separate provider. There is no `HARNESS_PROVIDER=claude-shannon`. `buildCommand()` is shared, and the same MCP / stop-hook plumbing applies.

## Trigger paths

This runbook applies when modifying:

- `src/providers/*`
- `src/commands/runner.ts` (provider dispatch)
- `src/prompts/*` (system-prompt composition)
- `docker-entrypoint.sh` (provider branches)
- Or adding a new provider end-to-end

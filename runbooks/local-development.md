# Local development runbook

How to set up env files, OAuth flows, portless dev, and Docker Compose for the swarm locally.

## Env files

| File | Used by |
|---|---|
| `.env` | API server (host) |
| `.env.docker` | Docker worker |
| `.env.docker-lead` | Docker lead |

Bun auto-loads `.env`. Don't use `dotenv`.

## Key env vars

| Var | Default | Notes |
|---|---|---|
| `AGENT_SWARM_API_KEY` (preferred) / `API_KEY` (legacy) | `123123` | Auth header `Authorization: Bearer …`. `AGENT_SWARM_API_KEY` wins when both are set — prefer it when exporting in your shell profile so the CLI works from any cwd without colliding with other tools' `API_KEY`. |
| `RBAC_ENABLED` | unset (off) | Set `=true` to gate REST calls authenticated with `aswt_` user tokens at HTTP admission against the user's RBAC role grants. Operator key and agent calls are unaffected. |
| `MCP_BASE_URL` | `http://localhost:3013` | Internal/worker-facing API base the workers/UI hit |
| `PUBLIC_MCP_BASE_URL` | falls back to `MCP_BASE_URL` | Public origin for OAuth redirect URIs + webhook URLs. No action needed locally — leave unset and it defaults to `MCP_BASE_URL`. Only relevant in split deploys where `MCP_BASE_URL` is an internal/cluster address. |
| `APP_URL` | `http://localhost:5274` | Dashboard URL |
| `SLACK_DISABLE` / `GITHUB_DISABLE` / `JIRA_DISABLE` / `LINEAR_DISABLE` | unset | Set `=true` to disable each integration |
| `SCRIPTS_ONLY_MCP` | unset (full surface) | Set `=true` on the API **and** agent containers as a global override to trim the external MCP surface to the 8 script tools ("code-mode") — all other swarm ops go through `script-run` + the scripts SDK. Per-agent `swarm_config` rows can enable the mode without setting this environment variable. See [docs-site guide "Scripts-only mode"](../docs-site/content/docs/(documentation)/guides/scripts-only-mode.mdx). |
| `TRUST_BODY_REQUESTED_BY_USER_ID` | unset (off) | Set `=true` to let `POST /api/tasks` attribute a task to a body-supplied `requestedByUserId` (validated against a real user row) when no authenticated/owned-task identity is available. **Only safe in a single-tenant deployment where every caller of the shared/operator API key is already trusted** — it lets any such caller attribute a task to any user by choosing that body value. Upstream default (off) keeps PR #939's anti-spoofing behavior: the body field is ignored for operator/global-key callers. |
| `CONTEXT_MODE_DISABLED` | unset (enabled) | Set `=true` to opt a worker out of context-mode. Default-enabled — the worker image bakes in context-mode, and the Claude/Codex/OpenCode adapters wire it in unless this is `true`. |
| `HARNESS_PROVIDER` | `claude` | `claude`, `pi`, `codex`, `devin`, or `claude-managed` |
| `TEMPLATE_ID` | unset | e.g. `official/coder` |
| `TEMPLATE_REGISTRY_URL` | `https://templates.agent-swarm.dev` | |

`HARNESS_PROVIDER=codex` requires `OPENAI_API_KEY` **or** `~/.codex/auth.json` **or** ChatGPT OAuth via `codex-login`. ChatGPT OAuth is stored server-side as the global `codex_oauth` config entry; codex workers restore it into `~/.codex/auth.json` at boot.

`HARNESS_PROVIDER=devin` requires `DEVIN_API_KEY` (prefix `cog_*`) and `DEVIN_ORG_ID` (prefix `org-*`). Optional: `DEVIN_POLL_INTERVAL_MS` (default 15000), `DEVIN_ACU_COST_USD` (default 2.25), `DEVIN_MAX_ACU_LIMIT` (per-session ACU cap, sent to Devin API and shown in UI budget bar), `DEVIN_API_BASE_URL` (override for testing). Repos are configured via the task's `vcsRepo` field — no env var needed. See `.env.docker-devin.example` for a full template.

`AGENT_SWARM_API_KEY` / `API_KEY` and `SECRETS_ENCRYPTION_KEY` are reserved — they cannot be stored in `swarm_config`.

SSRF guards on script-connection URL fetches (OpenAPI spec URLs, OAuth
discovery, authorize/token URLs) **fail closed**: private/loopback and plain
`http://` endpoints are rejected unless `NODE_ENV` is `development`/`test` or
`ALLOW_PRIVATE_NETWORK_URLS=true` is set. The `dev:http` / `start:http` npm
scripts set `NODE_ENV=development` for you; anything that boots `src/http.ts`
another way (custom scripts, containers pointed at local endpoints) needs the
flag to register localhost connections.

RBAC admission design: [DES-445 user policy/admission model](../thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md). The happy path does not require manual bootstrapping: migrations backfill existing users, the users-table trigger grants the default role to new users, and server boot self-heals built-in role seeds plus users that somehow have zero roles. Use `bun run src/cli.tsx rbac bootstrap` as an explicit audit/verification and on-demand repair tool before enabling `RBAC_ENABLED=true` without rebooting, after manual DB surgery or a restore that stripped user roles, and periodically if you want a drift check. It only attaches the default role to users with zero roles, so deliberately narrowed users keep their existing role set.

## Tracker integrations (Linear & Jira)

**Linear:** `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_SIGNING_SECRET` (HMAC), `LINEAR_REDIRECT_URI`.

**Jira:** `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_WEBHOOK_TOKEN` (URL-token; Atlassian doesn't HMAC-sign 3LO webhooks), `JIRA_REDIRECT_URI`.

Jira webhook registration requires `MCP_BASE_URL` to be HTTPS — point at ngrok in dev.

Both providers store `cloudId`/`siteUrl`/`webhookIds` in `oauth_apps.metadata`. v1 is single-workspace per install (first OAuth connect picks the cloudId).

Full guides:
- [docs-site/.../guides/jira-integration.mdx](../docs-site/content/docs/(documentation)/guides/jira-integration.mdx)
- [docs-site/.../guides/linear-integration.mdx](../docs-site/content/docs/(documentation)/guides/linear-integration.mdx)

OAuth token refresh behavior and local smoke testing: [runbooks/oauth-tokens.md](./oauth-tokens.md).

## Secrets encryption

`swarm_config` secret rows are encrypted at rest with AES-256-GCM. Key resolution order, backup requirements, and plaintext-migration notes: [docs-site/.../guides/secrets-encryption.mdx](../docs-site/content/docs/(documentation)/guides/secrets-encryption.mdx).

## Codex ChatGPT OAuth

Run `bun run src/cli.tsx codex-login` from your **laptop**, not inside the worker container. For a remote swarm, point `--api-url` at the public API (or SSH tunnel), then restart codex workers.

## Claude Managed Agents

`HARNESS_PROVIDER=claude-managed` runs sessions in Anthropic's managed cloud sandbox (no local CLI). One-time bootstrap from your laptop:

```bash
bun run src/cli.tsx claude-managed-setup
```

This creates an Anthropic-side environment + agent + skills (uploaded from `plugin/commands/*.md`) and persists the resulting IDs to `swarm_config`. Deployed workers restore these from the API at boot. Re-run with `--force` to recreate.

Required env vars (workers fail-fast at boot if any are missing):

```
HARNESS_PROVIDER=claude-managed
ANTHROPIC_API_KEY=sk-ant-...
MANAGED_AGENT_ID=agent_...                    # from claude-managed-setup
MANAGED_ENVIRONMENT_ID=env_...                # from claude-managed-setup
MCP_BASE_URL=https://api.swarm.example.com    # MUST be HTTPS-public — Anthropic's
                                              # sandbox calls /mcp from the cloud
MANAGED_AGENT_MODEL=claude-sonnet-4-6         # optional, default in setup CLI
```

`MCP_BASE_URL` must be HTTPS-public so Anthropic's managed sandbox can reach `/mcp` — same constraint already documented above for Jira webhook setup. Use ngrok / Cloudflare Tunnel in dev. The adapter and the docker-entrypoint both fail-fast if `MCP_BASE_URL` is unset or doesn't start with `https://`.

### GitHub access for repo-bound tasks

When a swarm task has `vcsRepo` set, the adapter passes it to Anthropic via the `resources` array on `sessions.create`:

```jsonc
{
  "resources": [{
    "type": "github_repository",
    "url": "https://github.com/<owner>/<repo>",
    "authorization_token": "<PAT or vault-managed token>",
    "checkout": { "type": "branch", "name": "main" }
  }]
}
```

Anthropic's sandbox clones the repo into `/workspace/<repo-name>` before the agent runs. The SDK requires `authorization_token` on the resource; supply it one of two ways:

**Option A — vault (recommended for prod):** the operator creates a vault entry in their Anthropic account holding a GitHub PAT, then sets the vault ID in the worker env:

```
MANAGED_GITHUB_VAULT_ID=vault_...
```

The adapter passes this through `vault_ids` on `sessions.create`. The vault becomes available to the sandboxed agent for clone auth. Vault setup is a manual step today — Anthropic exposes it in the managed-agents console (https://platform.claude.com → Vaults).

**Option B — literal PAT (dev only):** set `MANAGED_GITHUB_TOKEN=ghp_...` in the worker env. The adapter copies it into `authorization_token` directly. Strongly discouraged in production — the token is sent on every `sessions.create` call and stored on the Anthropic-side session record.

If neither is set and a task has `vcsRepo`, the `authorization_token` field is empty and Anthropic returns an authentication error from the clone step. To run repo-bound tasks under managed-agents you MUST configure one of the two options above.

Branch selection is currently hardcoded to `"main"`; per-task branch overrides will land alongside richer `repoContext` plumbing in a future plan.

### Cost computation

Managed-agents reports only token counts on `span.model_request_end`. The adapter computes USD locally using `src/providers/claude-managed-models.ts` (rates per [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)) and adds Anthropic's `$0.08/session-hour` runtime fee, billed by wallclock duration. Both components surface on the swarm `result` event's `cost.totalCostUsd`. Unknown model strings fall back to `$0` with a single deduplicated `console.warn`.

## Portless dev

`bun run dev:http` → `https://api.swarm.localhost:1355`. Set `MCP_BASE_URL` and `APP_URL` in `.env`. Worktrees auto-get `<branch>.api.swarm.localhost:1355` subdomains.

Non-portless fallback: `bun run start:http`.

## Testing the API locally

```bash
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/agents
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: <uuid>" http://localhost:3013/mcp
```

## Docker Compose

Requires `.env` with `API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`). See `docker-compose.example.yml`.

```bash
docker compose -f docker-compose.local.yml up --build
```

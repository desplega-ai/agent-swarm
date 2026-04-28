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
| `API_KEY` | `123123` | Auth header `Authorization: Bearer …` |
| `MCP_BASE_URL` | `http://localhost:3013` | Public URL the workers/UI hit |
| `APP_URL` | `http://localhost:5274` | Dashboard URL |
| `SLACK_DISABLE` / `GITHUB_DISABLE` / `JIRA_DISABLE` / `LINEAR_DISABLE` | unset | Set `=true` to disable each integration |
| `HARNESS_PROVIDER` | `claude` | `claude`, `pi`, `codex`, or `claude-managed` |
| `TEMPLATE_ID` | unset | e.g. `official/coder` |
| `TEMPLATE_REGISTRY_URL` | `https://templates.agent-swarm.dev` | |

`HARNESS_PROVIDER=codex` requires `OPENAI_API_KEY` **or** `~/.codex/auth.json` **or** ChatGPT OAuth via `codex-login`. ChatGPT OAuth is stored server-side as the global `codex_oauth` config entry; codex workers restore it into `~/.codex/auth.json` at boot.

`API_KEY` and `SECRETS_ENCRYPTION_KEY` are reserved — they cannot be stored in `swarm_config`.

## Tracker integrations (Linear & Jira)

**Linear:** `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_SIGNING_SECRET` (HMAC), `LINEAR_REDIRECT_URI`.

**Jira:** `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_WEBHOOK_TOKEN` (URL-token; Atlassian doesn't HMAC-sign 3LO webhooks), `JIRA_REDIRECT_URI`.

Jira webhook registration requires `MCP_BASE_URL` to be HTTPS — point at ngrok in dev.

Both providers store `cloudId`/`siteUrl`/`webhookIds` in `oauth_apps.metadata`. v1 is single-workspace per install (first OAuth connect picks the cloudId).

Full guides:
- [docs-site/.../guides/jira-integration.mdx](../docs-site/content/docs/(documentation)/guides/jira-integration.mdx)
- [docs-site/.../guides/linear-integration.mdx](../docs-site/content/docs/(documentation)/guides/linear-integration.mdx)

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

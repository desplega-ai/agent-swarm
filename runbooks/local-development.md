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
| `HARNESS_PROVIDER` | `claude` | `claude`, `pi`, `codex`, or `devin` |
| `TEMPLATE_ID` | unset | e.g. `official/coder` |
| `TEMPLATE_REGISTRY_URL` | `https://templates.agent-swarm.dev` | |

`HARNESS_PROVIDER=codex` requires `OPENAI_API_KEY` **or** `~/.codex/auth.json` **or** ChatGPT OAuth via `codex-login`. ChatGPT OAuth is stored server-side as the global `codex_oauth` config entry; codex workers restore it into `~/.codex/auth.json` at boot.

`HARNESS_PROVIDER=devin` requires `DEVIN_API_KEY` (prefix `cog_*`) and `DEVIN_ORG_ID` (prefix `org-*`). Optional: `DEVIN_POLL_INTERVAL_MS` (default 15000), `DEVIN_ACU_COST_USD` (default 2.25), `DEVIN_MAX_ACU_LIMIT` (per-session ACU cap, sent to Devin API and shown in UI budget bar), `DEVIN_API_BASE_URL` (override for testing). Repos are configured via the task's `vcsRepo` field — no env var needed. See `.env.docker-devin.example` for a full template.

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

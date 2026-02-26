# Environment Variables Reference

Complete reference for all environment variables used by Agent Swarm.

---

## API Server

These variables configure the MCP API server (`bun run start:http` or the `api` Docker service).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | No | `""` | Bearer token for API authentication. If empty, no auth is required. |
| `PORT` | No | `3013` | Port for the HTTP server. |
| `DATABASE_PATH` | No | `./agent-swarm-db.sqlite` | Path to the SQLite database file. In Docker: `/app/data/agent-swarm-db.sqlite`. |
| `CAPABILITIES` | No | All enabled | Comma-separated feature flags: `core`, `task-pool`, `messaging`, `profiles`, `services`, `scheduling`, `epics`, `memory`. |
| `SCHEDULER_INTERVAL_MS` | No | `10000` | Polling interval (ms) for the scheduled tasks system. |
| `OPENAI_API_KEY` | No | — | OpenAI API key for memory embeddings (`text-embedding-3-small`, 512d). Without it, memory search falls back to recency-based retrieval. |
| `APP_URL` | No | `""` | Dashboard URL. Used to generate clickable task links in Slack messages. |
| `ENV` | No | — | Set to `development` to prefix agent names with `(dev)` in Slack. |
| `NODE_ENV` | No | — | Set to `development` for verbose Slack logging. |

---

## Docker Worker / Lead Agent

These variables configure containerized agents (`ghcr.io/desplega-ai/agent-swarm-worker`).

### Required

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for Claude Code. Run `claude setup-token` to generate one. Container exits without it. |
| `API_KEY` | Must match the API server's `API_KEY`. Container exits without it. |

### Agent Identity

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ID` | Auto-generated | UUID identifying the agent. **Keep stable across restarts** to enable task resume and identity persistence. |
| `AGENT_NAME` | `<role>-<id prefix>` | Human-readable display name (e.g., `"Picateclas"`). |
| `AGENT_ROLE` | `worker` | Either `worker` or `lead`. Determines the agent's system prompt and capabilities. |

### Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_BASE_URL` | `http://host.docker.internal:3013` | URL of the API server. Use `http://api:3013` when services are on the same Docker network. |
| `SWARM_URL` | `localhost` | Base domain for service discovery. Agent services are available at `https://{AGENT_ID}.{SWARM_URL}`. |
| `SERVICE_PORT` | `3000` | Host port mapped to container port 3000 for exposed services. |

### Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `YOLO` | `false` | When `true`, the agent continues spawning sessions even if previous ones fail. |
| `MAX_CONCURRENT_TASKS` | `1` (worker), `2` (lead) | Maximum parallel tasks the agent processes. |
| `SHUTDOWN_TIMEOUT` | `30000` | Grace period (ms) before force-pausing tasks during shutdown. |
| `AI_LOOP` | `false` | Use legacy AI-based polling instead of runner-level polling. |

### System Prompt

| Variable | Default | Description |
|----------|---------|-------------|
| `SYSTEM_PROMPT` | — | Custom text appended to the agent's system prompt. |
| `SYSTEM_PROMPT_FILE` | — | Path to a file containing additional system prompt text. Process exits if file doesn't exist. |

`SYSTEM_PROMPT` takes priority over `SYSTEM_PROMPT_FILE`.

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_ID` | Random 8-char UUID | Log subdirectory name. Reuse to continue logging to the same folder. |
| `LOG_DIR` | `/logs` | Base directory for session logs. |

### Git (Worker Containers)

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub personal access token for `gh` CLI and `git push`. The entrypoint runs `gh auth setup-git` if set. |
| `GITHUB_EMAIL` | `worker-agent@desplega.ai` | Git commit email (`git config --global user.email`). |
| `GITHUB_NAME` | `Worker Agent` | Git commit name (`git config --global user.name`). |

### Startup

| Variable | Default | Description |
|----------|---------|-------------|
| `STARTUP_SCRIPT_STRICT` | `true` | When `true`, the container exits if the startup script (`/workspace/start-up.*`) fails. Set to `false` to continue despite errors. |
| `PM2_HOME` | `/workspace/.pm2` | PM2 process manager home directory. Persisted on the `/workspace` volume. |

### Sentry (Optional)

| Variable | Description |
|----------|-------------|
| `SENTRY_AUTH_TOKEN` | Sentry Organization Auth Token for `sentry-cli`. Scopes needed: `event:read`, `project:read`, `org:read`. |
| `SENTRY_ORG` | Sentry organization slug. |

---

## Slack Integration

Add these to the API server's environment.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | — | Bot User OAuth Token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | Yes | — | App-Level Token (`xapp-...`) for Socket Mode. |
| `SLACK_SIGNING_SECRET` | No | — | Signing secret. Optional when using Socket Mode. |
| `SLACK_DISABLE` | No | — | Set to `true` to disable Slack even if tokens are present. |
| `SLACK_ALLOWED_EMAIL_DOMAINS` | No | `""` | Comma-separated email domains. Only users with matching domains can interact. |
| `SLACK_ALLOWED_USER_IDS` | No | `""` | Comma-separated Slack user IDs that are always allowed (bypass domain check). |

If both `SLACK_ALLOWED_EMAIL_DOMAINS` and `SLACK_ALLOWED_USER_IDS` are empty, all Slack users can interact with the bot.

---

## GitHub App Integration

Add these to the API server's environment. See [GitHub App Setup](../DEPLOYMENT.md#github-app-integration) for full setup instructions.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_WEBHOOK_SECRET` | Yes | — | HMAC secret for verifying webhook signatures. Integration is disabled without it. |
| `GITHUB_BOT_NAME` | No | `agent-swarm-bot` | Bot username for detecting `@mentions` in issues and PRs. |
| `GITHUB_APP_ID` | No | — | GitHub App ID. Required for bot reactions (emoji acknowledgments). |
| `GITHUB_APP_PRIVATE_KEY` | No | — | GitHub App private key. Accepts raw PEM (with `\n` escapes) or base64-encoded. Required for bot reactions. |
| `GITHUB_DISABLE` | No | — | Set to `true` to disable GitHub even if webhook secret is present. |

**Two tiers:**
- **Webhooks only** (`GITHUB_WEBHOOK_SECRET`): Receives events and creates tasks. No acknowledgment sent to GitHub.
- **Webhooks + reactions** (+ `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`): Also adds emoji reactions and posts comments as the bot.

---

## AgentMail Integration

Add these to the API server's environment. AgentMail enables agents to receive and process emails.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTMAIL_WEBHOOK_SECRET` | Yes | — | Svix signing secret for verifying webhook payloads. Integration is disabled without it. |
| `AGENTMAIL_DISABLE` | No | — | Set to `true` to disable AgentMail even if webhook secret is present. |

The webhook secret can also be set dynamically via the `set-config` MCP tool (`scope: "global"`, `key: "AGENTMAIL_WEBHOOK_SECRET"`, `isSecret: true`) followed by calling `POST /internal/reload-config`.

---

## Dynamic Configuration

Environment variables can be stored in the database via the `set-config` MCP tool and loaded into `process.env` at server startup. Database values are overridden by actual environment variables on first load, but take effect on hot-reload (`POST /internal/reload-config`).

Worker containers also fetch resolved config from the API at startup (`GET /api/config/resolved`) and export all key-value pairs as environment variables before starting the agent process.

This means you can manage secrets centrally through the API instead of distributing `.env` files to every container.

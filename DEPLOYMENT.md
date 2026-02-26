# Deployment Guide

This guide covers all deployment options for Agent Swarm.

## Table of Contents

- [Docker Compose (Recommended)](#docker-compose-recommended)
- [Docker Worker](#docker-worker)
- [Server Deployment (systemd)](#server-deployment-systemd)
- [Graceful Shutdown & Task Resume](#graceful-shutdown--task-resume)
- [Environment Variables](#environment-variables)
- [Slack Integration](#slack-integration)
- [GitHub App Integration](#github-app-integration)
- [Sentry Integration](#sentry-integration)
- [System Prompts](#system-prompts)
- [Service Registry (PM2)](#service-registry-pm2)
- [Publishing (Maintainers)](#publishing-maintainers)

---

## Docker Compose (Recommended)

The easiest way to deploy a full swarm with API, workers, and lead agent.

### Quick Start

```bash
# Copy example files
cp docker-compose.example.yml docker-compose.yml

# Create a combined .env for docker-compose (combines API + worker settings)
# You can merge .env.example (API) and .env.docker.example (worker) settings
cp .env.docker.example .env

# Edit .env with your values
vim .env

# Start the swarm
docker-compose up -d
```

> **Note:** `.env.example` contains API server settings, `.env.docker.example` contains Docker worker settings. For docker-compose, you need both sets of variables in a single `.env` file.

### What's Included

The example `docker-compose.yml` sets up:

- **API service** (port 3013) - MCP HTTP server
- **2 Worker agents** - Containerized Claude workers
- **1 Lead agent** - Coordinator agent

### Configuration

Edit your `.env` file:

```bash
# Required
API_KEY=your-secret-api-key
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token  # Run `claude setup-token` to get this

# Agent IDs (optional, auto-generated if not set)
AGENT_ID=worker-1-uuid
AGENT_ID_2=worker-2-uuid
AGENT_ID_LEAD=lead-agent-uuid

# GitHub integration (optional)
GITHUB_TOKEN=your-github-token
GITHUB_EMAIL=your@email.com
GITHUB_NAME=Your Name
```

### Volumes

| Volume | Purpose |
|--------|---------|
| `swarm_api` | SQLite database persistence |
| `swarm_logs` | Session logs |
| `swarm_shared` | Shared workspace between agents (`/workspace/shared`) |
| `swarm_lead` | Lead agent's personal workspace (`/workspace/personal`) |
| `swarm_worker_*` | Personal workspace per worker (`/workspace/personal`) |

### Graceful Shutdown

The docker-compose example uses `stop_grace_period: 60s` to allow graceful task pause during deployments. When a container receives SIGTERM:

1. In-progress tasks are **paused** (not failed)
2. Task state and progress are preserved
3. After restart, paused tasks are automatically **resumed** with context

This enables zero-downtime deployments. See [Graceful Shutdown & Task Resume](#graceful-shutdown--task-resume) for details.

> **Important:** Use stable `AGENT_ID` values for each worker to enable task resume after restarts.

---

## Docker Worker

Run individual Claude workers in containers.

### Pull from Registry

```bash
docker pull ghcr.io/desplega-ai/agent-swarm-worker:latest
```

### Build Locally

```bash
# Build the worker image
docker build -f Dockerfile.worker -t agent-swarm-worker .

# Or using npm script
bun run docker:build:worker
```

### Run

```bash
# Using pre-built image
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -v ./logs:/logs \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# With custom system prompt
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e SYSTEM_PROMPT="You are a Python specialist" \
  -v ./logs:/logs \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# With system prompt from file
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e SYSTEM_PROMPT_FILE=/workspace/prompts/specialist.txt \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# Using npm script (requires .env.docker file)
bun run docker:run:worker
```

### Troubleshooting

**Permission denied when writing to /workspace**

```bash
# Option 1: Fix permissions on host directory
chmod 777 ./work

# Option 2: Run container as your current user
docker run --rm -it --user $(id -u):$(id -g) \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# Option 3: Create the file on the host first
touch ./work/.mcp.json
chmod 666 ./work/.mcp.json
```

### Architecture

The Docker worker image uses a multi-stage build:

1. **Builder stage**: Compiles `src/cli.tsx` into a standalone binary
2. **Runtime stage**: Ubuntu 24.04 with full development environment

**Pre-installed tools:**

- **Languages**: Python 3, Node.js 22, Bun
- **Build tools**: gcc, g++, make, cmake
- **Process manager**: PM2 (for background services)
- **CLI tools**: GitHub CLI (`gh`), sqlite3
- **Agent tools**: `wts` (git worktree manager), `cc-ai-tracker` (code change tracking)
- **Utilities**: git, git-lfs, vim, nano, jq, curl, wget, ssh
- **Sudo access**: Worker can install packages with `sudo apt-get install`

**Volumes:**

- `/workspace/personal` - Agent's personal workspace (isolated per agent)
- `/workspace/shared` - Shared workspace between all agents
- `/logs` - Session logs

### Startup Scripts

Run custom initialization before the worker starts. Place a script at `/workspace/start-up.*`:

**Supported formats** (priority order):
- `start-up.sh` / `start-up.bash` - Bash scripts
- `start-up.js` - Node.js scripts
- `start-up.ts` / `start-up.bun` - Bun/TypeScript scripts

**Interpreter detection:**
1. Shebang line (e.g., `#!/usr/bin/env bun`)
2. File extension (`.ts` -> bun, `.js` -> node, `.sh` -> bash)

**Error handling:**
- `STARTUP_SCRIPT_STRICT=true` (default) - Container exits if script fails
- `STARTUP_SCRIPT_STRICT=false` - Logs warning and continues

**Example: Install dependencies**

```bash
#!/bin/bash
# /workspace/start-up.sh

echo "Installing dependencies..."
if [ -f "package.json" ]; then
    bun install
fi

sudo apt-get update -qq
sudo apt-get install -y -qq ripgrep
```

**Example: TypeScript setup**

```typescript
#!/usr/bin/env bun
// /workspace/start-up.ts

console.log("Running startup...");
await Bun.$`bun install`;

if (!process.env.API_KEY) {
  console.error("ERROR: API_KEY not set");
  process.exit(1);
}
```

---

## Server Deployment (systemd)

Deploy the MCP server to a Linux host with systemd.

### Prerequisites

- Linux with systemd
- Bun installed (`curl -fsSL https://bun.sh/install | bash`)

### Install

```bash
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm
sudo bun deploy/install.ts
```

This will:
- Copy files to `/opt/agent-swarm`
- Create `.env` file (edit to set `API_KEY`)
- Install systemd service with health checks every 30s
- Start the service on port 3013

### Update

```bash
git pull
sudo bun deploy/update.ts
```

### Management

```bash
# Check status
sudo systemctl status agent-swarm

# View logs
sudo journalctl -u agent-swarm -f

# Restart
sudo systemctl restart agent-swarm

# Stop
sudo systemctl stop agent-swarm
```

---

## Graceful Shutdown & Task Resume

Agent Swarm supports graceful task handling during deployments and container restarts.

### How It Works

When a worker container receives SIGTERM (e.g., during `docker-compose down` or Kubernetes rollout):

1. **Grace period starts** - Worker waits for active tasks to complete (default: 30s, configurable via `SHUTDOWN_TIMEOUT`)
2. **Tasks are paused** - Any tasks still running after the grace period are marked as `paused` (not `failed`)
3. **State preserved** - Task progress and context are saved to the database
4. **On restart** - Worker automatically fetches and resumes its paused tasks with full context

### Task States During Shutdown

| State | Description |
|-------|-------------|
| `in_progress` | Task completes normally if it finishes within grace period |
| `paused` | Task is paused for resume after restart |
| `failed` | Only used if pause API fails (fallback) |

### Configuration

```bash
# Grace period before force-pausing tasks (milliseconds)
SHUTDOWN_TIMEOUT=30000

# Docker compose stop grace period (should be >= SHUTDOWN_TIMEOUT + buffer)
stop_grace_period: 60s
```

### Resume Behavior

When a worker starts, it:

1. Registers with the MCP server
2. Checks for paused tasks assigned to its `AGENT_ID`
3. Resumes each paused task with context:
   - Original task description
   - Previous progress (if any was saved)
   - Notification that this is a resumed task

### Best Practices

- **Use stable Agent IDs** - Set explicit `AGENT_ID` for each worker to enable resume after restarts
- **Save progress regularly** - Workers should call `store-progress` during long tasks
- **Test deployments** - Verify tasks resume correctly in staging before production

---

## Environment Variables

> For the complete reference of all environment variables, see [docs/ENVS.md](./docs/ENVS.md).

### Docker Worker Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | OAuth token for Claude CLI (run `claude setup-token`) |
| `API_KEY` | Yes | API key for MCP server |
| `AGENT_ID` | No | Agent UUID (assigned on join if not set). **Keep stable for task resume.** |
| `AGENT_ROLE` | No | Role: `worker` (default) or `lead` |
| `AGENT_NAME` | No | Display name for the agent (auto-generated if not set) |
| `MCP_BASE_URL` | No | MCP server URL (default: `http://host.docker.internal:3013`) |
| `SESSION_ID` | No | Log folder name (auto-generated if not provided) |
| `YOLO` | No | Continue on errors (default: `false`) |
| `SYSTEM_PROMPT` | No | Custom system prompt text |
| `SYSTEM_PROMPT_FILE` | No | Path to system prompt file |
| `STARTUP_SCRIPT_STRICT` | No | Exit on startup script failure (default: `true`) |
| `SHUTDOWN_TIMEOUT` | No | Grace period in ms before pausing tasks (default: `30000`) |
| `MAX_CONCURRENT_TASKS` | No | Maximum parallel tasks per worker (default: `1`) |
| `SWARM_URL` | No | Base domain for service URLs (default: `localhost`) |
| `SERVICE_PORT` | No | Host port for exposed services (default: `3000`) |
| `PM2_HOME` | No | PM2 state directory (default: `/workspace/.pm2`) |
| `GITHUB_TOKEN` | No | GitHub token for git operations |
| `GITHUB_EMAIL` | No | Git commit email (default: `worker-agent@desplega.ai`) |
| `GITHUB_NAME` | No | Git commit name (default: `Worker Agent`) |
| `SENTRY_AUTH_TOKEN` | No | Sentry Organization Auth Token for issue investigation |
| `SENTRY_ORG` | No | Sentry organization slug |

### Server Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port for MCP HTTP server | `3013` |
| `API_KEY` | API key for server authentication | - |
| `MCP_BASE_URL` | Base URL (for setup command) | `https://agent-swarm-mcp.desplega.sh` |
| `SWARM_URL` | Base domain for service discovery | `localhost` |
| `APP_URL` | Dashboard URL for Slack message links | - |
| `ENV` | Environment mode (`development` adds prefix to Slack agent names) | - |
| `SCHEDULER_INTERVAL_MS` | Polling interval for scheduled tasks | `10000` |
| `DATABASE_PATH` | SQLite database file path | `./agent-swarm-db.sqlite` |
| `OPENAI_API_KEY` | OpenAI key for memory embeddings (optional) | - |
| `CAPABILITIES` | Comma-separated feature flags | All enabled |

---

## Slack Integration

Enable Slack for task creation and agent communication via direct messages.

### Setup

1. Create a Slack App at https://api.slack.com/apps
2. Enable Socket Mode (for real-time events without public webhooks)
3. Add required scopes: `chat:write`, `users:read`, `users:read.email`, `channels:history`, `im:history`
4. Install to workspace and copy tokens

### Configuration

```bash
# Required for Slack
SLACK_BOT_TOKEN=xoxb-...      # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...      # App-Level Token (Socket Mode)
SLACK_SIGNING_SECRET=...      # Signing Secret (optional for Socket Mode)

# Disable Slack (if not using)
SLACK_DISABLE=true

# Optional: Filter allowed users
SLACK_ALLOWED_EMAIL_DOMAINS=company.com,partner.com  # Comma-separated email domains
SLACK_ALLOWED_USER_IDS=U12345678,U87654321           # Comma-separated user IDs to always allow
```

### User Filtering

By default, all Slack users can interact with the bot. To restrict access:

- **Email domains**: Only users with matching email domains can send messages
- **User ID whitelist**: Specific user IDs are always allowed (useful for admins or service accounts)

If both are set, a user must match **either** an allowed domain **or** be in the user ID whitelist.

---

## GitHub App Integration

Enable GitHub webhooks for automated task creation from PR reviews and issue assignments.

### Setup

1. Create a GitHub App at https://github.com/settings/apps/new
2. Set webhook URL to your server: `https://your-server.com/github/webhook`
3. Generate a webhook secret
4. (Optional) Generate a private key for bot reactions

### Configuration

```bash
# Required for GitHub webhooks
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional: Disable GitHub integration
GITHUB_DISABLE=true

# Optional: Bot name for @mentions (default: agent-swarm-bot)
GITHUB_BOT_NAME=your-bot-name

# Optional: Enable bot reactions (requires GitHub App)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----
# Or use base64-encoded private key:
GITHUB_APP_PRIVATE_KEY=base64-encoded-key
```

### Supported Events

| Event | Action |
|-------|--------|
| PR assigned to bot | Creates task for lead agent |
| Review requested from bot | Creates review task |
| PR/Issue comment @mentioning bot | Creates task with context |
| Issue assigned to bot | Creates task for lead agent |

### Bot Reactions

If GitHub App credentials are provided, the bot can react to comments/issues to acknowledge receipt.

---

## Sentry Integration

Docker workers include `sentry-cli` pre-installed, enabling agents to investigate and triage Sentry issues directly.

### Setup

1. Create an Organization Auth Token at `https://sentry.io/settings/{org}/auth-tokens/` with scopes:
   - `event:read` - Read issues and events
   - `project:read` - Read project data
   - `org:read` - Read organization info

2. Add to `.env.docker` or `.env`:
   ```bash
   SENTRY_AUTH_TOKEN=your-auth-token
   SENTRY_ORG=your-org-slug
   ```

3. Verify authentication in a worker:
   ```bash
   sentry-cli info
   ```

### Agent Commands

| Command | Description |
|---------|-------------|
| `/investigate-sentry-issue <url-or-id>` | Investigate a Sentry issue, get stacktrace, and triage |

### Usage

Workers can use the `/investigate-sentry-issue` command to:
- Get issue details and stacktraces
- Analyze breadcrumbs and context
- Resolve, mute, or unresolve issues

Example:
```
/investigate-sentry-issue https://sentry.io/organizations/myorg/issues/123456/
```

Or just the issue ID:
```
/investigate-sentry-issue 123456
```

---

## System Prompts

Customize Claude's behavior with system prompts for worker and lead agents.

### CLI Usage

```bash
# Inline system prompt
bunx @desplega.ai/agent-swarm worker --system-prompt "You are a Python specialist."

# System prompt from file
bunx @desplega.ai/agent-swarm worker --system-prompt-file ./prompts/python-specialist.txt

# Same options work for lead agent
bunx @desplega.ai/agent-swarm lead --system-prompt "You are a project coordinator."
bunx @desplega.ai/agent-swarm lead --system-prompt-file ./prompts/coordinator.txt
```

### Docker Usage

```bash
# Using inline system prompt
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e SYSTEM_PROMPT="You are a Python specialist." \
  ghcr.io/desplega-ai/agent-swarm-worker

# Using system prompt file
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e SYSTEM_PROMPT_FILE=/workspace/prompts/specialist.txt \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker
```

### Priority

- CLI flags > Environment variables
- Inline text (`SYSTEM_PROMPT`) > File (`SYSTEM_PROMPT_FILE`)

---

## Service Registry (PM2)

Workers can run background services on port 3000 using PM2. Services are registered for discovery and auto-restart.

### PM2 Commands

```bash
pm2 start /workspace/app/server.js --name my-api  # Start a service
pm2 stop|restart|delete my-api                     # Manage services
pm2 logs [name]                                    # View logs
pm2 list                                           # Show running processes
```

### MCP Tools

- `register-service` - Register service for discovery and auto-restart
- `unregister-service` - Remove from registry
- `list-services` - Find services exposed by other agents
- `update-service-status` - Update health status

### Starting a New Service

```bash
# 1. Start your service with PM2
pm2 start /workspace/myapp/server.js --name my-api

# 2. Register it (via MCP tool)
# register-service name="my-api" script="/workspace/myapp/server.js"

# 3. Mark healthy when ready
# update-service-status name="my-api" status="healthy"
```

### Service URL Pattern

`https://{service-name}.{SWARM_URL}`

### Health Checks

Implement a `/health` endpoint returning 200 OK for monitoring.

---

## Publishing (Maintainers)

```bash
# Requires gh CLI authenticated
bun deploy/docker-push.ts
```

This builds, tags with version from package.json + `latest`, and pushes to GHCR.

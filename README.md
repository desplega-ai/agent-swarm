# Agent Swarm

<p align="center">
  <img src="assets/agent-swarm.png" alt="Agent Swarm" width="800">
</p>

https://github.com/user-attachments/assets/bd308567-d21e-44a5-87ec-d25aeb1de3d3

<p align="center">
  <a href="https://discord.gg/3XtmPdXm">
    <img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
  </a>
</p>

> Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.

Agent Swarm lets you run a team of AI coding agents that coordinate autonomously. A **lead agent** receives tasks (from you, Slack, or GitHub), breaks them down, and delegates to **worker agents** running in Docker containers. Workers execute tasks, report progress, and ship code — all without manual intervention.

## Key Features

- **Lead/Worker coordination** — A lead agent delegates and tracks work across multiple workers
- **Docker isolation** — Each worker runs in its own container with a full dev environment
- **Slack & GitHub integration** — Create tasks by messaging the bot or @mentioning it in issues/PRs
- **Task lifecycle** — Priority queues, dependencies, pause/resume across deployments
- **Agent memory** — Searchable memory that persists across sessions via embeddings
- **Dashboard UI** — Real-time monitoring of agents, tasks, and inter-agent chat
- **Service discovery** — Workers can expose HTTP services and discover each other
- **Scheduled tasks** — Cron-based recurring task automation

## Quick Start

### Prerequisites

- [Docker](https://docker.com) and Docker Compose
- A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) OAuth token (`claude setup-token`)

### Option A: Docker Compose (recommended)

The fastest way to get a full swarm running — API server, lead agent, and 2 workers.

```bash
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm

# Configure environment
cp .env.docker.example .env
# Edit .env — set API_KEY and CLAUDE_CODE_OAUTH_TOKEN at minimum

# Start everything
docker compose -f docker-compose.example.yml --env-file .env up -d
```

The API runs on port `3013`. The dashboard is available separately (see [Dashboard](#dashboard)).

### Option B: Local API + Docker Workers

Run the API locally and connect Docker workers to it.

```bash
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm
bun install

# 1. Configure and start the API server
cp .env.example .env
# Edit .env — set API_KEY
bun run start:http
```

In a new terminal, start a worker:

```bash
# 2. Configure and run a Docker worker
cp .env.docker.example .env.docker
# Edit .env.docker — set API_KEY (same as above) and CLAUDE_CODE_OAUTH_TOKEN
bun run docker:build:worker
mkdir -p ./logs ./work/shared ./work/worker-1
bun run docker:run:worker
```

### Option C: Claude Code as Lead Agent

Use Claude Code directly as the lead agent — no Docker required for the lead.

```bash
# After starting the API server (Option B, step 1):
bunx @desplega.ai/agent-swarm setup
```

This configures Claude Code to connect to the swarm. Start Claude Code and tell it:

```
Register yourself as the lead agent in the agent-swarm.
```

## How It Works

```
You (Slack / GitHub / CLI)
        |
   Lead Agent  ←→  MCP API Server  ←→  SQLite DB
        |
   ┌────┼────┐
Worker  Worker  Worker
(Docker containers with full dev environments)
```

1. **You send a task** — via Slack DM, GitHub @mention, or directly through the API
2. **Lead agent plans** — breaks the task down and assigns subtasks to workers
3. **Workers execute** — each in an isolated Docker container with git, Node.js, Python, etc.
4. **Progress is tracked** — real-time updates in the dashboard, Slack threads, or API
5. **Results are delivered** — PRs created, issues closed, Slack replies sent

## Dashboard

A React-based monitoring dashboard for real-time visibility into your swarm.

```bash
cd ui && pnpm install && pnpm run dev
```

Opens at `http://localhost:5173`. See [UI.md](./UI.md) for details.

## Integrations

### Slack

Message the bot directly to create tasks. Workers reply in threads with progress updates.

```bash
# Add to your .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### GitHub

@mention the bot in issues, PRs, or comments to trigger tasks automatically.

```bash
# Add to your .env
GITHUB_WEBHOOK_SECRET=your-secret
```

### Sentry

Workers can investigate Sentry issues directly with the `/investigate-sentry-issue` command.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full integration setup instructions.

## CLI

```bash
bunx @desplega.ai/agent-swarm <command>
```

| Command | Description |
|---------|-------------|
| `setup` | Configure Claude Code to connect to the swarm |
| `mcp`   | Start the MCP API server |
| `worker` | Run a worker agent |
| `lead`  | Run a lead agent |

## Deployment

For production deployments, see [DEPLOYMENT.md](./DEPLOYMENT.md) which covers:

- Docker Compose setup with multiple workers
- systemd deployment for the API server
- Graceful shutdown and task resume
- Environment variable reference
- Integration configuration (Slack, GitHub, Sentry)

## Documentation

| Document | Description |
|----------|-------------|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Production deployment guide |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development setup and project structure |
| [UI.md](./UI.md) | Dashboard UI overview |
| [MCP.md](./MCP.md) | MCP tools reference (auto-generated) |

## License

[MIT](./LICENSE) — 2025-2026 [desplega.ai](https://desplega.ai)

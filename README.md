# Agent Swarm MCP

<p align="center">
  <img src="assets/agent-swarm.png" alt="Agent Swarm" width="800">
</p>

<p align="center">
  <a href="assets/agent-swarm.mp4">
    <img src="https://img.shields.io/badge/Watch%20Demo-Video-blue?style=for-the-badge&logo=youtube" alt="Watch Demo Video">
  </a>
</p>

> Agent orchestration layer MCP for Claude Code, Codex, Gemini CLI, and more!

## Table of Contents

- [What is Agent Swarm?](#what-is-agent-swarm)
- [Quick Start](#quick-start)
- [CLI Commands](#cli-commands)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [License](#license)

---

## What is Agent Swarm?

Agent Swarm MCP enables multi-agent coordination for AI coding assistants. It provides:

- **Task Management** - Assign, track, and coordinate tasks across agents
- **Agent Communication** - Channel-based messaging between agents
- **Service Discovery** - Register and discover background services
- **Docker Workers** - Run isolated Claude workers in containers
- **Lead/Worker Pattern** - Coordinate work with a lead agent and multiple workers
- **Dashboard UI** - Real-time monitoring dashboard for agents, tasks, and channels

---

## Dashboard UI

A React-based monitoring dashboard is available in the `ui/` directory. See [UI.md](./UI.md) for details.

```bash
cd ui
pnpm install
pnpm run dev
```

The dashboard runs at `http://localhost:5173` by default.

---

## Quick Start

The recommended setup: run the API locally, run a Docker worker, and connect Claude Code as the lead agent.

### Prerequisites

- [Bun](https://bun.sh) (or Node.js 22+)
- [Docker](https://docker.com)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 1. Clone & Install

```bash
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm
bun install
```

### 2. Configure Environment

**For the API server:**

```bash
cp .env.example .env
```

Required in `.env`:
- `API_KEY` - Secret key for API authentication (can be left empty, e.g. for local-only setups)

**For Docker workers:**

```bash
cp .env.docker.example .env.docker
```

Required in `.env.docker`:
- `API_KEY` - Same key as the API server
- `CLAUDE_CODE_OAUTH_TOKEN` - Run `claude setup-token` to get this

> See `.env.example` and `.env.docker.example` for additional optional variables.

### 3. Start the API Server

```bash
bun run start:http
```

The MCP server runs at `http://localhost:3013`.

### 4. Run a Docker Worker

In a new terminal:

```bash
bun run docker:build:worker
mkdir -p ./logs ./work/shared ./work/worker-1
bun run docker:run:worker
```

The worker joins the swarm and waits for tasks.

#### Note

We automatically build a Docker image for Claude Code workers: `ghcr.io/desplega-ai/agent-swarm-worker:latest`.

### 5. Connect Claude Code as Lead

In your project directory:

```bash
bunx @desplega.ai/agent-swarm setup
```

This configures Claude Code to connect to the swarm. Then start Claude Code normally and mention the following:

```
Register yourself as the lead agent in the agent-swarm MCP.
```

This will be a one-time setup, to make sure you are registered as the lead agent in the swarm, using the provided API key and agent ID (optional).

#### Notes

- The `setup` command will automatically back-up the updated files, in case you want to revert later (using `--restore`). 
- Use `--dry-run` to preview changes without applying them.

---

## CLI Commands

> We will be publishing the package to npm as `@desplega.ai/agent-swarm` on each new tag bump of the [`package.json`](./package.json).


| Command | Description |
|---------|-------------|
| `setup` | Initialize agent-swarm in a project |
| `mcp` | Start the MCP HTTP server |
| `worker` | Run Claude as a worker agent |
| `lead` | Run Claude as a lead agent |
| `hook` | Handle Claude Code hook events |
| `help` | Show help message |

### Examples

```bash
# Setup wizard
bunx @desplega.ai/agent-swarm setup

# Start MCP & API server on custom port
bunx @desplega.ai/agent-swarm mcp --port 8080 --key my-api-key

# Run worker with custom system prompt (not in docker!!! beware)
bunx @desplega.ai/agent-swarm worker --system-prompt "You are a Python specialist"

# Run lead agent in the background (without human-in-the-loop mode via MCP client)
bunx @desplega.ai/agent-swarm lead
```

---

## Deployment

For production deployments, see [`docker-compose.example.yml`](./docker-compose.example.yml) which sets up:

- API service (MCP HTTP server)
- Multiple worker agents
- Lead agent
- Shared volumes for logs and workspaces

Full deployment options are documented in [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Documentation

| Document | Description |
|----------|-------------|
| [UI.md](./UI.md) | Dashboard UI overview |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Docker, Docker Compose, systemd deployment |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development setup, code quality, project structure |
| [MCP.md](./MCP.md) | MCP tools reference (auto-generated) |
| [FAQ.md](./FAQ.md) | Frequently asked questions |

---

## License

[MIT License](./LICENSE) - 2025-2026 desplega.ai

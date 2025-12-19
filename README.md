# Agent Swarm MCP

<p align="center">
  <img src="assets/agent-swarm.png" alt="Agent Swarm" width="800">
</p>

> Agent orchestration layer MCP for Claude Code, Codex, Gemini CLI, and more!

## Overview

Agent Swarm MCP enables multi-agent coordination for AI coding assistants. It provides tools for agents to join a swarm, receive tasks, report progress, and coordinate with a lead agent.

## Quick Start

### Setup (Recommended)

Run the setup command in your project directory:

```bash
bunx @desplega.ai/agent-swarm@latest setup
```

This will:
- Create `.claude` directory and `settings.local.json` if needed
- Create `.mcp.json` if needed
- Add entries to `.gitignore`
- Configure permissions and hooks
- Prompt for your API token and Agent ID

Options:
- `--dry-run` - Preview changes without writing
- `--restore` - Restore files from `.bak` backups

### Manual Installation

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-swarm": {
      "type": "http",
      "url": "https://agent-swarm-mcp.desplega.sh/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>",
        "X-Agent-ID": "<your-agent-id>"
      }
    }
  }
}
```

or for Claude Code, use:

```bash
claude mcp add --transport http agent-swarm https://agent-swarm-mcp.desplega.sh/mcp --header "Authorization: Bearer <your-token>" --header "X-Agent-ID: <your-agent-id>"
```

Note: By default it will be installed locally (in ~/.claude.json) so add a `--scope project` to install in the current project's `.mcp.json` (recommended for better control).

For other tools, you can check this [generator page with most of commands](https://v0-mcp-commands.vercel.app/?type=http&name=agent-swarm&url=https%3A%2F%2Fagent-swarm-mcp.desplega.sh%2Fmcp&headers=Authorization%3DBearer+%3Ctoken%3E%2CX-Agent-ID%3D%3Cagent_uuid%3E).

## CLI Commands

```bash
# Run setup wizard
bunx @desplega.ai/agent-swarm setup

# Preview setup changes
bunx @desplega.ai/agent-swarm setup --dry-run

# Restore from backups
bunx @desplega.ai/agent-swarm setup --restore

# Start MCP HTTP server (for self-hosting)
bunx @desplega.ai/agent-swarm mcp
bunx @desplega.ai/agent-swarm mcp --port 8080 --key my-api-key

# Run Claude CLI with swarm integration
bunx @desplega.ai/agent-swarm claude
bunx @desplega.ai/agent-swarm claude --headless -m "Hello"

# Hook handler (called by Claude Code hooks)
bunx @desplega.ai/agent-swarm hook

# Show help
bunx @desplega.ai/agent-swarm help
```

## System Prompts

Customize Claude's behavior with system prompts for worker and lead agents. System prompts are appended to Claude's instructions using `--append-system-prompt`.

### CLI Usage

```bash
# Inline system prompt
bunx @desplega.ai/agent-swarm worker --system-prompt "You are a Python specialist. Focus on writing clean, typed code."

# System prompt from file
bunx @desplega.ai/agent-swarm worker --system-prompt-file ./prompts/python-specialist.txt

# Same options work for lead agent
bunx @desplega.ai/agent-swarm lead --system-prompt "You are a project coordinator. Break down tasks efficiently."
bunx @desplega.ai/agent-swarm lead --system-prompt-file ./prompts/coordinator.txt
```

### Docker Usage

```bash
# Using inline system prompt
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e WORKER_SYSTEM_PROMPT="You are a Python specialist. Focus on writing clean, typed code." \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# Using system prompt file (mount and reference)
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e WORKER_SYSTEM_PROMPT_FILE=/workspace/prompts/specialist.txt \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker
```

### Environment Variables

| Variable | Role | Description |
|----------|------|-------------|
| `WORKER_SYSTEM_PROMPT` | Worker | Custom system prompt text |
| `WORKER_SYSTEM_PROMPT_FILE` | Worker | Path to system prompt file |
| `LEAD_SYSTEM_PROMPT` | Lead | Custom system prompt text |
| `LEAD_SYSTEM_PROMPT_FILE` | Lead | Path to system prompt file |

**Priority:** CLI flags > Environment variables. If both are set, CLI flags take precedence.

**File vs Text:** If both `*_SYSTEM_PROMPT` and `*_SYSTEM_PROMPT_FILE` are set, inline text takes precedence.

## Docker Worker

Run Claude as a containerized worker agent in the swarm.

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
# Using pre-built image from GHCR
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -v ./logs:/logs \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# Or using locally built image
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -v ./logs:/logs \
  -v ./work:/workspace \
  agent-swarm-worker

# With custom system prompt
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e WORKER_SYSTEM_PROMPT="You are a Python specialist" \
  -v ./logs:/logs \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# With system prompt from file
docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN=your-token \
  -e API_KEY=your-api-key \
  -e WORKER_SYSTEM_PROMPT_FILE=/workspace/prompts/specialist.txt \
  -v ./logs:/logs \
  -v ./work:/workspace \
  ghcr.io/desplega-ai/agent-swarm-worker

# Using docker-compose
docker-compose -f docker-compose.worker.yml up

# Using npm script (requires .env.docker file)
bun run docker:run:worker
```

### Troubleshooting

**Permission denied when writing to /workspace**

If you see an error like:
```
/docker-entrypoint.sh: line 37: /workspace/.mcp.json: Permission denied
```

This happens when the container can't write to the mounted directory. Fix with one of these options:

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

### Environment Variables (Docker)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | OAuth token for Claude CLI |
| `API_KEY` | Yes | API key for MCP server |
| `AGENT_ID` | No | Agent UUID (assigned on join if not set) |
| `MCP_BASE_URL` | No | MCP server URL (default: `http://host.docker.internal:3013`) |
| `SESSION_ID` | No | Log folder name (auto-generated if not provided) |
| `WORKER_YOLO` | No | Continue on errors (default: `false`) |
| `WORKER_SYSTEM_PROMPT` | No | Custom system prompt text for worker |
| `WORKER_SYSTEM_PROMPT_FILE` | No | Path to system prompt file for worker |
| `STARTUP_SCRIPT_STRICT` | No | Exit on startup script failure (default: `true`) |

### Startup Scripts

Run custom initialization before the worker starts. Place a script at `/workspace/start-up.*` and it will execute automatically on container start.

**Supported formats** (priority order):
- `start-up.sh` / `start-up.bash` - Bash scripts
- `start-up.js` - Node.js scripts
- `start-up.ts` / `start-up.bun` - Bun/TypeScript scripts

**Interpreter detection:**
1. Shebang line (e.g., `#!/usr/bin/env bun`) - uses specified interpreter
2. File extension - infers interpreter (`.ts` → bun, `.js` → node, `.sh` → bash)

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

# Install additional tools
sudo apt-get update -qq
sudo apt-get install -y -qq ripgrep
```

**Example: TypeScript setup**
```typescript
#!/usr/bin/env bun
// /workspace/start-up.ts

console.log("Running startup...");
await Bun.$`bun install`;

// Verify environment
if (!process.env.API_KEY) {
  console.error("ERROR: API_KEY not set");
  process.exit(1);
}
```

### Architecture

The Docker worker image is built using a multi-stage build:

1. **Builder stage**: Compiles `src/cli.tsx` into a standalone binary using Bun
2. **Runtime stage**: Ubuntu 24.04 with full development environment

**Pre-installed tools:**
- **Languages**: Python 3, Node.js 22, Bun
- **Build tools**: gcc, g++, make, cmake
- **Utilities**: git, git-lfs, vim, nano, jq, curl, wget, ssh
- **Sudo access**: Worker can install packages with `sudo apt-get install`

**Volumes:**
- `/workspace` - Working directory for cloning repos (mount `./work:/workspace` for persistence)
- `/logs` - Session logs (mount `./logs:/logs` for persistence)

### Publishing (Maintainers)

```bash
# Requires gh CLI authenticated
bun deploy/docker-push.ts
```

This builds, tags with version from package.json + `latest`, and pushes to GHCR.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_BASE_URL` | Base URL for the MCP server | `https://agent-swarm-mcp.desplega.sh` |
| `PORT` | Port for self-hosted MCP server | `3013` |
| `API_KEY` | API key for server authentication | - |
| `WORKER_SYSTEM_PROMPT` | Custom system prompt for worker agents | - |
| `WORKER_SYSTEM_PROMPT_FILE` | Path to system prompt file for worker | - |
| `LEAD_SYSTEM_PROMPT` | Custom system prompt for lead agents | - |
| `LEAD_SYSTEM_PROMPT_FILE` | Path to system prompt file for lead | - |

## Server Deployment

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

After pulling new changes:

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

## Development

Install dependencies:

```bash
bun install
```

Run the STDIO server:

```bash
bun run start
```

Run the HTTP server:

```bash
bun run start:http
```

Run with hot reload:

```bash
bun run dev      # STDIO
bun run dev:http # HTTP
```

Run the MCP inspector:

```bash
bun run inspector      # STDIO
bun run inspector:http # HTTP
```

Run the CLI locally:

```bash
bun run cli setup
bun run cli setup --dry-run
bun run hook  # Hook handler
```

## MCP Tools

The server provides these tools for agent coordination:

- `join-swarm` - Register an agent in the swarm
- `poll-task` - Poll for assigned tasks (worker agents)
- `send-task` - Assign a task to an agent (lead agent)
- `get-swarm` - List all agents in the swarm
- `get-tasks` - List tasks filtered by status
- `get-task-details` - Get detailed info about a task
- `store-progress` - Update task progress or mark complete/failed
- `my-agent-info` - Get current agent's info

## License

MIT License, 2025-2026 (c) desplega.ai

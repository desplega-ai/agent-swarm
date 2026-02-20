# Agent Swarm MCP

Multi-agent orchestration layer for Claude Code, Codex, Gemini CLI. Enables task distribution, agent communication, and service discovery.

**Getting Started**: See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup. Run `bun run start:http` to start the server.

**Database**: Uses `bun:sqlite` (SQLite with WAL mode). DB file at `./agent-swarm-db.sqlite` (auto-created). Schema defined in `src/be/db.ts`.

## Quick Reference

```bash
bun install               # Install dependencies
bun run start:http        # Run MCP HTTP server (port 3013)
bun run dev:http          # Dev with hot reload
bun run lint:fix          # Lint & format with Biome
bun run tsc:check         # Type check

# PM2 (run API + UI + lead + worker together)
bun run pm2-start         # Start all (API :3013, UI :5274, lead :3201, worker :3202)
bun run pm2-stop          # Stop all services
bun run pm2-restart       # Restart all services
bun run pm2-logs          # View logs
bun run pm2-status        # Check status
# Note: lead/worker run in Docker. On code changes:
# bun run docker:build:worker && bun run pm2-restart
```

## Tech Stack

- **Runtime**: Bun (not Node.js) - see Bun rules below
- **Language**: TypeScript (strict mode)
- **Linter/Formatter**: Biome (2-space indent, double quotes, 100 line width)
- **MCP SDK**: @modelcontextprotocol/sdk
- **CLI**: Ink (React for terminal)
- **Slack**: @slack/bolt

## Project Structure

```
src/
  http.ts       # Main HTTP server + MCP endpoints
  stdio.ts      # Stdio MCP transport
  cli.tsx       # CLI entry point (Ink)
  tools/        # MCP tool definitions
  be/           # Backend utilities (DB, storage)
  github/       # GitHub webhook handlers
  slack/        # Slack integration
ui/             # Dashboard (separate React app)
```

## Code Style

- Run `bun run lint:fix` before committing (lint + format)
- Run `bun run format` for formatting only
- Use Bun APIs, not Node.js equivalents
- Prefer `Bun.$` over execa for shell commands

## Related

- [UI Dashboard](./ui/CLAUDE.md) - React monitoring dashboard
- [MCP.md](./MCP.md) - MCP tools reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Development setup

---

## Local Development

**Environment Files:**
- `.env` - Local dev config (API server, Slack, GitHub)
- `.env.docker` - Docker worker config

**Testing API locally:**
```bash
# API_KEY from .env (default: 123123)
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/agents

# With agent ID header for MCP tools
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: <uuid>" http://localhost:3013/mcp
```

**Key env vars:**
- `API_KEY` - Auth token for API requests
- `MCP_BASE_URL` - API server URL (default: http://localhost:3013)
- `SLACK_DISABLE=true` / `GITHUB_DISABLE=true` - Disable integrations locally

---

## E2E Testing

### Worktree Port Check

**Before running E2E tests in a worktree**, check `.env` for `PORT` and `MCP_BASE_URL`. Worktrees share the same host, so each worktree needs a unique port to avoid collisions with the main branch or other worktrees. Also update `.env.docker` `MCP_BASE_URL` to match (use `host.docker.internal:<port>`).

### MCP Tool Testing (Streamable HTTP)

To test MCP tools via curl, you need a proper session handshake:

```bash
# 1. Initialize session (capture session ID from response headers)
curl -s -D /tmp/mcp-headers.txt -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Agent-ID: <uuid>" \
  http://localhost:$PORT/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'

# 2. Extract session ID
SESSION_ID=$(grep -i 'mcp-session-id' /tmp/mcp-headers.txt | awk '{print $2}' | tr -d '\r\n')

# 3. Send initialized notification
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Agent-ID: <uuid>" \
  -H "mcp-session-id: $SESSION_ID" \
  http://localhost:$PORT/mcp \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 4. Call tools using the session
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Agent-ID: <uuid>" \
  -H "mcp-session-id: $SESSION_ID" \
  http://localhost:$PORT/mcp \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"join-swarm","arguments":{...}}}'
```

Key gotchas:
- `Accept` header MUST include both `application/json` and `text/event-stream`
- `X-Agent-ID` must be a valid UUID (use `uuidgen` to generate)
- Session must be initialized before calling tools

### Docker Worker Testing

```bash
# Build the image
bun run docker:build:worker

# Run a worker (uses .env.docker)
docker run --name test-worker \
  --env-file .env.docker \
  -e "ROLE=worker" \
  -e "AGENT_NAME=Test Worker" \
  agent-swarm-worker:latest

# Inspect files inside the running container
docker exec test-worker cat /workspace/SOUL.md
docker exec test-worker ls -la /workspace/

# Simulate hook sync from inside the container
docker exec test-worker curl -s -X PUT \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  http://host.docker.internal:$PORT/api/agents/$AGENT_ID/profile \
  -d '{"soulMd": "..."}'

# Clean up
docker stop test-worker && docker rm test-worker
```

Note: PostToolUse and Stop hooks only fire during a live Claude session (not testable via Docker exec alone). These validate naturally when a worker picks up a real task.

---

## Bun Rules

Use Bun instead of Node.js, npm, pnpm, or vite.

- `bun <file>` instead of `node` or `ts-node`
- `bun test` instead of jest/vitest
- `bun install` instead of npm/yarn/pnpm install
- `bun run <script>` instead of npm/yarn run
- Bun auto-loads .env - don't use dotenv

### Bun APIs

- `Bun.serve()` for HTTP/WebSocket. Don't use express/ws.
- `bun:sqlite` for SQLite. Don't use better-sqlite3.
- `Bun.file()` over node:fs for file I/O.
- `Bun.$` for shell commands. Don't use execa.

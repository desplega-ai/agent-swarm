# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Enables task distribution, agent communication, and service discovery.

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

## Testing

### Unit Tests

```bash
bun test src/tests/<test-file>.test.ts   # Run specific test
bun test                                  # Run all tests
```

- Tests use isolated SQLite DBs (e.g. `./test-<name>.sqlite`) with `initDb()`/`closeDb()` in `beforeAll`/`afterAll`
- Tests that need HTTP use a minimal `node:http` handler — NOT the full `src/http.ts` server
- Use unique test ports to avoid conflicts (e.g. 13022, 13023)
- Clean up DB files (including `-wal` and `-shm`) in `afterAll`

### E2E Testing with Docker

For full integration tests (session capture, `--resume`, hooks), use a Docker worker against a local API server.

**Worktree port check**: When working in a worktree, other worktrees may already be running the API server on port 3013. Always check `.env` for `PORT` and `MCP_BASE_URL` first:

```bash
lsof -i :3013    # Check if default port is in use
```

If occupied, set `PORT=<alt-port>` in `.env` and update `MCP_BASE_URL` to match. Also update `.env.docker` `MCP_BASE_URL` (use `host.docker.internal:<port>`):

```bash
# Start API on alternate port
PORT=3014 bun run start:http &

# Build image with current code changes
docker build -f Dockerfile.worker -t agent-swarm-worker:<tag> .

# Run worker pointing at alternate port, on alternate host port
docker run --rm -d \
  --name e2e-test-worker \
  --env-file .env.docker \
  -e MCP_BASE_URL=http://host.docker.internal:3014 \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3203:3000 \
  agent-swarm-worker:<tag>
```

**E2E flow**:
1. Start API server (check port first)
2. Rebuild Docker image: `bun run docker:build:worker` (or with custom tag)
3. Start worker container pointing at your API port
4. Create tasks via `curl` against the API
5. Poll `GET /api/tasks/:id` to verify status, `claudeSessionId`, etc.
6. Check worker logs: `docker logs <container-name>`
7. Clean up: `docker stop <container-name>` and kill the API process

**Task cancellation caveat**: Direct DB updates (`sqlite3 ... UPDATE`) bypass the hook-based cancellation flow. The Claude process inside Docker won't stop — you'll need to `docker restart` the container. Use the MCP `cancel-task` tool for proper cancellation when possible.

**Keep test tasks trivial**: Use simple tasks like "Say hi" for E2E tests. Complex tasks (web searches, research) waste time and API credits during testing.

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

### UI Testing

Use the `qa-use` tool (`/qa-use:test-run`, `/qa-use:verify`, `/qa-use:explore`) for browser-based UI testing of the dashboard.

**Worktree port check for UI**: The dashboard dev server defaults to port 5274 (see `APP_URL` in `.env`). Check before starting:

```bash
lsof -i :5274    # Check if UI port is in use
```

If occupied by another worktree, start on an alternate port and update `APP_URL`:

```bash
cd ui && pnpm run dev --port 5275
```

The UI connects to the API via `VITE_API_URL` (defaults to `http://localhost:3013`). When using alternate API ports, update accordingly in the UI `.env` or pass as env var.

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

# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Enables task distribution, agent communication, and service discovery.

**Getting Started**: See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup. Run `bun run start:http` to start the server.

**Database**: Uses `bun:sqlite` (SQLite with WAL mode). DB file at `./agent-swarm-db.sqlite` (auto-created). Schema defined in `src/be/migrations/` as numbered SQL files, run by `src/be/migrations/runner.ts`. Query functions in `src/be/db.ts`.

### Database Migrations

Schema changes use a file-based migration system (`src/be/migrations/`):

```bash
# Migration files: numbered SQL files executed in order
src/be/migrations/
  001_initial.sql    # Baseline: all tables, indexes, seed data
  runner.ts          # Migration runner (auto-runs on startup)
```

**Adding a new migration:**
1. Create `src/be/migrations/NNN_descriptive_name.sql` (next number after highest existing)
2. Write forward-only SQL (CREATE TABLE, ALTER TABLE, CREATE INDEX, etc.)
3. Test with both fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) and existing DB
4. The runner applies it automatically on next startup

**How it works:**
- `_migrations` table tracks which migrations have been applied (version, name, checksum)
- On startup, runner compares SQL files against `_migrations` and applies pending ones
- Each migration runs in a transaction — atomic success or rollback
- Checksums detect accidental edits to applied migrations (logged as warnings)
- Bootstrap is schema-aware for pre-migration DBs:
  - If baseline tables already exist, runner marks `001_initial` as applied without re-executing it
  - If schema is partial/incomplete, runner executes `001_initial` to reach baseline safely
- `initDb()` also runs compatibility guards after migrations for legacy DBs (for example, adding missing `agents` profile columns before seeding context versions)

**Rules:**
- Never modify an already-applied migration — create a new one instead
- No `down` migrations (SQLite limitations make rollbacks unreliable)
- Use `IF NOT EXISTS` for CREATE TABLE/INDEX in migrations for safety
- Keep the `AgentTaskSourceSchema` in `src/types.ts` in sync with CHECK constraints in SQL

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
    db.ts       # DB init + query functions
    migrations/ # SQL migration files + runner
  github/       # GitHub webhook handlers
  slack/        # Slack integration
new-ui/          # Dashboard (Next.js app)
templates/       # Template data (official + community)
  official/      # 9 official templates (lead, coder, researcher, reviewer, tester, fde, content-writer, content-reviewer, content-strategist)
  community/     # Community-contributed templates
  schema.ts      # Shared TypeScript types
templates-ui/    # Templates registry (Next.js app)
```

## Code Style

- Run `bun run lint:fix` before committing (lint + format)
- Run `bun run format` for formatting only
- Use Bun APIs, not Node.js equivalents
- Prefer `Bun.$` over execa for shell commands
- Use `google/gemini-3-flash-preview` as the default Gemini model in tests, workflows, and examples (not `gemini-2.0-flash-001`)

### CLI Commands & Help System

CLI help is plain `console.log` (not Ink), defined in `src/cli.tsx` via the `COMMAND_HELP` record and `printHelp()` function.

**When adding or modifying CLI commands:**
1. Add/update the command's entry in the `COMMAND_HELP` record (usage, description, options, examples)
2. Add the command to the `commands` array in `printHelp()` (general help listing)
3. Add routing in the `App` switch statement (UI commands) or the non-UI section before `render()` (simple commands like `docs`, `help`, `version`)
4. Run `bun run src/cli.tsx help` and `bun run src/cli.tsx <command> --help` to verify

**Command types:**
- **Non-UI commands** (handled before `render()`): `help`, `version`, `docs`, `hook`, `artifact` — use `console.log` + `process.exit(0)`
- **UI commands** (rendered by Ink): `onboard`, `connect`, `api`, `claude`, `worker`, `lead` — return JSX from the `App` switch

### Adding HTTP Endpoints

**Always use the `route()` factory** from `src/http/route-def.ts` when creating new REST endpoints. This auto-registers the route in the OpenAPI spec. Do NOT use raw `matchRoute` — it bypasses OpenAPI generation.

```typescript
// In src/http/my-feature.ts
import { route } from "./route-def";

const myRoute = route({
  method: "post",
  path: "/api/my-feature",
  pattern: ["api", "my-feature"],
  summary: "What this endpoint does",
  tags: ["MyTag"],
  body: z.object({ ... }),
  responses: { 200: { description: "Success" }, 400: { description: "Error" } },
  auth: { apiKey: true },
});

export async function handleMyFeature(req, res, pathSegments, queryParams): Promise<boolean> {
  if (!myRoute.match(req.method, pathSegments)) return false;
  const parsed = await myRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true; // parse() already sent 400
  // ... business logic using parsed.body, parsed.params, parsed.query
  json(res, result);
  return true;
}
```

After creating the handler:
1. Import and add to handler chain in `src/http/index.ts`
2. Add the import to `scripts/generate-openapi.ts` (for spec generation)
3. Run `bun run docs:openapi` to regenerate `openapi.json` and commit it

## Related

- [UI Dashboard](./new-ui/) - Next.js monitoring dashboard
- [Templates Registry](./templates-ui/) - Template gallery and compose builder
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
- `HARNESS_PROVIDER` - Provider selection: `claude` (default) or `pi` (pi-mono)
- `TEMPLATE_ID` - Template for initial worker profile (e.g., `official/coder`). Fetched from registry on first boot.
- `TEMPLATE_REGISTRY_URL` - Templates registry URL (default: https://templates.agent-swarm.dev)

**Portless (local dev):**
`bun run dev:http` uses [portless](https://port1355.dev/) → `https://api.swarm.localhost:1355`. Set `MCP_BASE_URL=https://api.swarm.localhost:1355` and `APP_URL=https://ui.swarm.localhost:1355` in `.env`. Update `.mcp.json` URL to match. Non-portless fallback: `bun run start:http`. Worktrees auto-get `<branch>.api.swarm.localhost:1355` subdomains.

**Local Docker Compose (builds from source):**
```bash
# Runs: API + Claude lead + Pi-mono worker
docker compose -f docker-compose.local.yml up --build

# Tear down
docker compose -f docker-compose.local.yml down
```
Requires `.env` with `API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`).

**Production Docker Compose (pulls from registry):** See `docker-compose.example.yml`.

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

**Quick E2E setup (clean DB + API + Docker lead/worker):**

```bash
# 1. Clean DB for fresh state
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# 2. Start API server (NOT pm2 — it starts extra services)
bun run start:http &

# 3. Build Docker image with current code
bun run docker:build:worker

# 4a. Start a LEAD container (uses .env.docker-lead)
docker run --rm -d \
  --name e2e-test-lead \
  --env-file .env.docker-lead \
  -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3201:3000 \
  agent-swarm-worker:latest

# 4b. Start a WORKER container (uses .env.docker)
docker run --rm -d \
  --name e2e-test-worker \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3203:3000 \
  agent-swarm-worker:latest

# 5. Verify registration
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.agents[] | {name, isLead, status}'

# 6. Cleanup
docker stop e2e-test-lead e2e-test-worker
kill $(lsof -ti :3013)
```

Key differences between lead and worker env files:
- `.env.docker-lead` — lead-specific `AGENT_ID`, no `OPENROUTER_API_KEY`
- `.env.docker` — worker-specific `AGENT_ID`, includes `OPENROUTER_API_KEY`
- `AGENT_ROLE=lead` must be passed explicitly (not in the env file)

### Entrypoint Integration Testing

When modifying `docker-entrypoint.sh` (e.g. adding new conditional bootstrap logic), validate beyond `bash -n` syntax checks with a full Docker round-trip:

1. **Validate API endpoints first**: Before Docker testing, verify the exact HTTP methods and paths used by `curl` calls in the entrypoint against the actual route definitions in `src/http/`. Common gotcha: config API uses `PUT /api/config` (not `POST`). Use `context-mode execute` for curl calls to avoid hook blocks.
2. **Test idempotency**: Start a container (first boot = registers), stop it, start another with the same env file (same `AGENT_ID`). Second boot should skip registration via the config check (e.g. `if [ -z "$SOME_KEY" ]`).
3. **Test failure mode**: Stop the external service, boot a container. The entrypoint should continue (via `|| true` guards) with a warning log.
4. **Test lead vs worker paths**: Use `.env.docker-lead` + `-e AGENT_ROLE=lead` for lead, `.env.docker` for worker. They have different `AGENT_ID` values and different bootstrap paths.
5. **Grep logs for your feature**: `docker logs <name> 2>&1 | grep -i "<feature>"` to verify the exact log lines.
6. **Verify persisted state**: After boot, check `GET /api/config?includeSecrets=true` to confirm secrets/config were stored correctly.

**Entrypoint E2E commands:**
```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Set any required global config (use PUT, not POST!)
curl -s -X PUT "http://localhost:3013/api/config" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"SOME_KEY","value":"some-value","isSecret":false}'

# 3. Build image with current code
bun run docker:build:worker

# 4. First boot (lead)
docker run --rm -d --name e2e-lead \
  --env-file .env.docker-lead -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:latest

# 5. First boot (worker)
docker run --rm -d --name e2e-worker \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest

# 6. Check logs (wait ~15s for boot)
docker logs e2e-lead 2>&1 | grep -i "<feature>"
docker logs e2e-worker 2>&1 | grep -i "<feature>"

# 7. Idempotency: stop and restart same worker (same AGENT_ID)
docker stop e2e-worker
docker run --rm -d --name e2e-worker-2 \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest
# Should see "Already registered" or equivalent skip message
docker logs e2e-worker-2 2>&1 | grep -i "<feature>"

# 8. Cleanup
docker stop e2e-lead e2e-worker-2 2>/dev/null
kill $(lsof -ti :3013) 2>/dev/null
```

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

## Pre-PR Checklist

Before pushing a PR, run the checks that CI will enforce. Which checks to run depends on what files you changed:

**Root project (src/, tools/, etc.):**
```bash
bun run lint:fix        # Biome lint + format
bun run tsc:check       # TypeScript type check
bun test                # Unit tests
```

**If you changed `plugin/commands/*.md`:** Rebuild pi-mono skills and commit the result:
```bash
bun run build:pi-skills  # Regenerate plugin/pi-skills/ from commands
```
CI enforces freshness — the merge gate will fail if generated pi-skills are out of date.

**new-ui/ (dashboard):**
```bash
cd new-ui
pnpm lint               # Biome check (lint + format)
pnpm exec tsc --noEmit  # TypeScript type check
```

**Both:** Run both sets if your changes span root and new-ui.

**Docker changes (Dockerfile, Dockerfile.worker):** CI does a build test — verify locally with `docker build -f <Dockerfile> .` if unsure.

All of these are enforced by the Merge Gate workflow (`.github/workflows/merge-gate.yml`). The gate job blocks merge if any check fails.

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

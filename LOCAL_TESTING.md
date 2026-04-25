# Local Testing

Reference doc for everything Claude (or any agent) needs to test Agent Swarm locally. Covers unit tests, E2E Docker, Docker entrypoint round-trips, MCP handshake, and UI verification.

Quick index:

- [Unit tests](#unit-tests)
- [E2E with Docker](#e2e-with-docker) — full flow lives in the `swarm-local-e2e` skill
- [Docker entrypoint changes](#docker-entrypoint-changes)
- [MCP tool testing over HTTP](#mcp-tool-testing-over-http)
- [Dashboard UI](#dashboard-ui)
- [Port-conflict resolution](#port-conflict-resolution)

## Unit tests

Runner: `bun test` (workspace root).

```bash
bun test                              # all unit tests
bun test src/tests/<file>.test.ts     # one file
bun test --watch src/tests/<file>.test.ts
```

Conventions:

- Each test file uses an **isolated SQLite DB**: `./test-<name>.sqlite`. Call `initDb()` in `beforeAll`, `closeDb()` in `afterAll`.
- Tests that need an HTTP surface use a **minimal `node:http` handler** — not the full `src/http.ts` server. Keeps startup cheap and isolates what's under test.
- Use **unique test ports** per file (e.g. `13022`, `13023`) so parallel tests don't collide.
- In `afterAll`, clean up the `.sqlite`, `-wal`, and `-shm` files — or the next run inherits stale state.

Memory-system tests have their own required suite (see `src/be/memory/` changes in the root `CLAUDE.md`).

## E2E with Docker

Use the **`swarm-local-e2e` skill** — it owns the full flow (start API, build image, start lead + worker, create tasks, verify registration, check session logs, cleanup). Invoke it when:

- You changed code in `src/commands/runner.ts`, `src/providers/`, task-lifecycle paths, or `docker-entrypoint.sh`.
- You need to verify log isolation between sequential tasks on the same agent.
- You want a visual round-trip through the dashboard.

Gotchas the skill covers but worth calling out here:

- **Check `.env` for `PORT`** before spawning anything — `lsof -i :3013` to verify. Worktrees can have different ports.
- **`.env.docker-lead`** has a lead-specific `AGENT_ID` and no `OPENROUTER_API_KEY`. `AGENT_ROLE=lead` must be passed via `docker run -e`, not the env file.
- **Keep test tasks trivial** ("Say hi"). E2E is a smoke test, not a workload test.
- **Task cancellation caveat**: direct DB updates bypass hook-based cancellation. Use the MCP `cancel-task` tool, or `docker restart <container>` to force-stop the inner Claude process.

### Minimal smoke-test (when the skill is overkill)

If you only need to verify the API boots and workers register — no tasks, no UI:

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Build worker image
bun run docker:build:worker

# 3. Start lead + worker (use branch-specific names to avoid worktree collisions)
SUFFIX=$(git branch --show-current | tr '/' '-')
docker run --rm -d --name e2e-lead-$SUFFIX --env-file .env.docker-lead \
  -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:latest
docker run --rm -d --name e2e-worker-$SUFFIX --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest

# 4. Verify registration (wait ~15s first)
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents \
  | jq '.agents[] | {name, isLead, status}'

# 5. Cleanup
docker stop e2e-lead-$SUFFIX e2e-worker-$SUFFIX
kill $(lsof -ti :3013)
```

## Docker entrypoint changes

`bash -n` is not sufficient validation for `docker-entrypoint.sh`. Run a full round-trip:

1. **Verify HTTP methods/paths** in entrypoint `curl` calls against route defs in `src/http/`. Common gotcha: config API is `PUT /api/config`, not `POST`.
2. **Test idempotency**: second boot with same `AGENT_ID` should skip re-registration (check via `GET /api/agents`).
3. **Test failure mode**: stop an external dependency (e.g. `curl` target), boot the container, verify it continues via `|| true` guards rather than crashing.
4. **Test lead and worker paths separately**:
   - Lead: `--env-file .env.docker-lead -e AGENT_ROLE=lead`
   - Worker: `--env-file .env.docker`
5. **Grep boot logs**: `docker logs <name> 2>&1 | grep -i "<feature>"` to confirm the codepath ran.
6. **Verify persisted state**: `GET /api/config?includeSecrets=true` should show anything the entrypoint wrote to config.

## MCP tool testing over HTTP

MCP tools over Streamable HTTP require a session handshake before any tool call. Skipping it returns a session error.

### Handshake sequence

```bash
SESSION_ID=$(uuidgen)
AGENT_ID=$(uuidgen)   # must be a valid UUID — not an arbitrary string

# 1. Initialize
curl -sN -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl","version":"1"},"capabilities":{}}}' \
  -D -   # dump headers — grab mcp-session-id from the response

# 2. Notify initialized (no response expected)
curl -s -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "mcp-session-id: <session-id-from-step-1>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Call a tool
curl -sN -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "mcp-session-id: <session-id>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<tool>","arguments":{}}}'
```

Required headers on every call:

- `Authorization: Bearer <API_KEY>`
- `X-Agent-ID: <uuid>` — validated as UUID; arbitrary strings rejected
- `Accept: application/json, text/event-stream` — **both** values required
- `mcp-session-id: <id>` — after step 1

## Dashboard UI

Defaults: UI on `APP_URL` (port 5274), API on `http://localhost:3013` (overridable via `VITE_API_URL`).

```bash
cd new-ui && pnpm run dev        # port 5274
cd new-ui && pnpm run dev --port 5275   # if 5274 is taken
```

### When you need to verify a UI change

Use the `qa-use` tool family:

- `/qa-use:explore <url>` — quick walkthrough, AI-powered element discovery
- `/qa-use:verify` — verify a defined feature
- `/qa-use:test-run` — run existing E2E tests

**PR requirement**: any PR touching `new-ui/`, `landing/`, or `templates-ui/` must include a `qa-use` session with screenshots of the change running locally. Merge-gate enforces this.

### Port-conflict resolution

```bash
lsof -i :5274          # what's on the UI port
lsof -i :3013          # what's on the API port
```

If another worktree holds the port, either stop it or pick alternates and update `APP_URL` / `VITE_API_URL` accordingly.

## Port-conflict resolution

Worktrees frequently race for ports. Standard resolution:

1. **API port (`PORT` in `.env`, default 3013)**: `lsof -i :3013`. If occupied, pick an alternate and update:
   - `PORT` in `.env`
   - `MCP_BASE_URL` in `.env` (match the new port)
   - `MCP_BASE_URL` in `.env.docker` and `.env.docker-lead` (use `http://host.docker.internal:<new-port>`)
2. **UI port (`APP_URL`, default 5274)**: `lsof -i :5274`, restart dev server with `--port <alt>`, update `APP_URL` in `.env` if UI is reachable from outside.
3. **Docker mapped ports (3201 lead, 3203 worker)**: if another worktree's containers are up, use unique `-p <host>:3000` values and branch-specific `--name` suffixes (see the `swarm-local-e2e` skill).

Always verify via `curl` before proceeding — mismatched `MCP_BASE_URL` between API and Docker env files is the #1 silent E2E failure.

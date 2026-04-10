# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Runtime: Bun + TypeScript. DB: bun:sqlite (WAL mode). Linter: Biome. CLI: Ink.

**Getting Started**: See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup. Run `bun run start:http` to start the server.

## Project map

```
src/
  http.ts       # Main HTTP server + MCP endpoints
  stdio.ts      # Stdio MCP transport
  cli.tsx       # CLI entry point (Ink)
  commands/
    codex-login.ts  # Codex ChatGPT OAuth login command
  tools/        # MCP tool definitions
  providers/
    codex-oauth/   # Codex OAuth PKCE flow + storage
    codex-adapter.ts # Codex provider adapter
  be/           # Backend (DB, storage)
    db.ts       # DB init + query functions
    migrations/ # SQL migration files + runner
  github/       # GitHub webhook handlers
  slack/        # Slack integration
new-ui/          # Dashboard (Next.js app)
templates/       # Template data (official + community)
  official/      # 9 official templates
  community/     # Community-contributed templates
  schema.ts      # Shared TypeScript types
templates-ui/    # Templates registry (Next.js app)
```

## Architecture invariants

The API server (`src/http.ts`, `src/server.ts`, `src/tools/`, `src/http/`) is the **sole owner** of the SQLite database. Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) must **never** import from `src/be/db` or `bun:sqlite`. Workers communicate with the API exclusively via HTTP using `API_KEY` and `X-Agent-ID` headers. Enforced by `scripts/check-db-boundary.sh` (pre-push hook + CI).

If worker-side code needs data from the DB (template resolution, config lookup), it must fetch via HTTP, not query SQLite directly. Shared pure logic goes in `src/prompts/` or `src/utils/`.

<important if="you need to run commands to build, test, lint, start the server, or generate code">

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install dependencies |
| `bun run start:http` | Run MCP HTTP server (port 3013) |
| `bun run dev:http` | Dev with hot reload (portless) |
| `bun run lint:fix` | Lint & format with Biome |
| `bun run tsc:check` | Type check |
| `bun test` | Run all unit tests |
| `bun test src/tests/<file>.test.ts` | Run specific test |
| `bun run pm2-start` | Start all (API :3013, UI :5274, lead :3201, worker :3202) |
| `bun run pm2-start` | Start all (API :3013, UI :5274, lead :3201, worker :3202) |
| `bun run pm2-stop` | Stop all services |
| `bun run pm2-restart` | Restart all services |
| `bun run pm2-logs` | View logs |
| `bun run pm2-status` | Check status |
| `bun run docker:build:worker` | Build Docker worker image |
| `bun run docs:openapi` | Regenerate `openapi.json` |
| `bun run docs:business-use` | Regenerate `BUSINESS_USE.md` (requires BU backend) |
| `bun run build:pi-skills` | Regenerate `plugin/pi-skills/` from `plugin/commands/*.md` |
| `docker compose -f docker-compose.local.yml up --build` | Local Docker Compose (API + lead + worker) |
| `docker compose -f docker-compose.local.yml down` | Tear down local Docker Compose |
| `uvx business-use-core@latest server dev` | Start BU backend on :13370 |
| `uvx business-use-core@latest flow eval <runId> <flow> -g -v` | Evaluate a BU flow run |
| `uvx business-use-core@latest flow graph <flow>` | Show BU flow graph |

PM2 note: lead/worker run in Docker. On code changes: `bun run docker:build:worker && bun run pm2-restart`.

</important>

<important if="you are choosing between Bun and Node.js APIs, selecting packages, or writing shell/file/HTTP/SQLite code">

## Bun rules

Use Bun instead of Node.js, npm, pnpm, or vite everywhere.

- `Bun.serve()` for HTTP/WebSocket (not express/ws)
- `bun:sqlite` for SQLite (not better-sqlite3)
- `Bun.file()` over `node:fs` for file I/O
- `Bun.$` for shell commands (not execa)
- Bun auto-loads `.env` — don't use dotenv

</important>

<important if="you are referencing Gemini models in tests, workflows, or examples">

Use `google/gemini-3-flash-preview` as the default Gemini model (not `gemini-2.0-flash-001`).

</important>

<important if="you are adding or modifying database schema or migrations">

## Database migrations

Schema changes use file-based migrations in `src/be/migrations/`. Runner auto-applies on startup.

**Adding a migration:**
1. Create `src/be/migrations/NNN_descriptive_name.sql` (next number after highest existing)
2. Write forward-only SQL (CREATE TABLE, ALTER TABLE, CREATE INDEX, etc.)
3. Test with both fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) and existing DB

**Rules:**
- Never modify an already-applied migration — create a new one instead
- No `down` migrations (SQLite limitations make rollbacks unreliable)
- Use `IF NOT EXISTS` for CREATE TABLE/INDEX for safety
- Keep `AgentTaskSourceSchema` in `src/types.ts` in sync with CHECK constraints in SQL

**How it works:** `_migrations` table tracks applied versions with checksums. Bootstrap is schema-aware — if baseline tables already exist, `001_initial` is marked applied without re-executing. `initDb()` runs compatibility guards after migrations for legacy DBs.

</important>

<important if="you are adding or modifying CLI commands or help text">

## CLI commands & help system

CLI help is plain `console.log` (not Ink), defined in `src/cli.tsx` via `COMMAND_HELP` record and `printHelp()`.

**When adding/modifying CLI commands:**
1. Add/update entry in `COMMAND_HELP` record (usage, description, options, examples)
2. Add command to `commands` array in `printHelp()`
3. Add routing in `App` switch (UI commands) or non-UI section before `render()` (simple commands)
4. Verify: `bun run src/cli.tsx help` and `bun run src/cli.tsx <command> --help`

**Command types:**
- **Non-UI** (before `render()`): `help`, `version`, `docs`, `hook`, `artifact` — `console.log` + `process.exit(0)`
- **UI** (Ink): `onboard`, `connect`, `api`, `claude`, `worker`, `lead` — return JSX from `App` switch

</important>

<important if="you are adding or modifying HTTP API endpoints or REST routes">

## Adding HTTP endpoints

Always use the `route()` factory from `src/http/route-def.ts` — it auto-registers in OpenAPI. Do NOT use raw `matchRoute` (bypasses OpenAPI generation). See existing handlers in `src/http/` for the pattern.

After creating the handler:
1. Import and add to handler chain in `src/http/index.ts`
2. Add the import to `scripts/generate-openapi.ts`
3. Run `bun run docs:openapi` to regenerate `openapi.json` and commit it

</important>

<important if="you are creating or modifying workflows, or using the create-workflow tool">

## Workflow authoring

Workflows are DAGs of nodes connected via `next`.

**Cross-node data access:** Upstream outputs are NOT available by default. Declare an `inputs` mapping to access them:
- Keys = local names for `{{interpolation}}`, values = context paths (usually a node ID)
- Agent-task output shape: `{ taskId, taskOutput }` — access via `localName.taskOutput.field`
- For trigger data: `{ "pr": "trigger.pullRequest" }` -> `{{pr.number}}`
- Without `inputs`, upstream references silently resolve to empty strings (check `diagnostics.unresolvedTokens`)

**Structured output:** Put your schema in `config.outputSchema` (not node-level `outputSchema`). The agent produces JSON matching it, validated by `store-progress`.

**Interpolation:** `{{path.to.value}}` in any string field inside `config`. Objects are JSON-stringified, nulls resolve to empty string.

**Agent-task config fields:** `template` (required), `outputSchema`, `agentId`, `tags`, `priority` (0-100, default 50), `offerMode`, `dir`, `vcsRepo`, `model`, `parentTaskId`.

</important>

<important if="you are adding business-use instrumentation or events">

## Business-use instrumentation

Uses `@desplega.ai/business-use` to track system invariants. See [BUSINESS_USE.md](./BUSINESS_USE.md) for flow diagrams.

**Flows:** `task` (runId = taskId), `agent` (runId = agentId), `api` (runId = per-boot ID).

**Guidelines:**
- Use `ensure()` (auto-determines act vs assert based on validator presence)
- Place calls AFTER successful state mutations, OUTSIDE transactions where possible
- Validators must be self-contained — only reference `data` and `ctx` params, never closure variables (they get serialized)
- Worker-side events use `depIds` pointing to server-side events in the same flow

**Env vars:** `BUSINESS_USE_API_KEY` and `BUSINESS_USE_URL` in `.env` and `.env.docker*`. SDK enters no-op mode if key missing.

</important>

<important if="you are setting up local development, configuring environment variables, or running the server locally">

## Local development

**Environment files:** `.env` (API server), `.env.docker` (Docker worker), `.env.docker-lead` (Docker lead).

**Key env vars:** `API_KEY` (auth, default: `123123`), `MCP_BASE_URL` (default: `http://localhost:3013`), `SLACK_DISABLE=true` / `GITHUB_DISABLE=true`, `HARNESS_PROVIDER` (`claude`, `pi`, or `codex` — codex requires `OPENAI_API_KEY` or `~/.codex/auth.json` or ChatGPT OAuth via `codex-login`), `TEMPLATE_ID` (e.g. `official/coder`), `TEMPLATE_REGISTRY_URL` (default: `https://templates.agent-swarm.dev`). ChatGPT OAuth is stored server-side as the global `codex_oauth` config entry; codex workers restore it into `~/.codex/auth.json` at boot.

**Testing API locally:**
```bash
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/agents
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: <uuid>" http://localhost:3013/mcp
```

**Codex ChatGPT OAuth:** Run `bun run src/cli.tsx codex-login` from your laptop or local terminal, not inside the worker container. The command prompts for the swarm API URL and uses masked API key input when the terminal supports raw mode. For a remote Docker Compose swarm, point `--api-url` at the public API URL (or an SSH tunnel), then restart codex workers so the entrypoint can restore `codex_oauth` from the config store.

**Portless:** `bun run dev:http` → `https://api.swarm.localhost:1355`. Set `MCP_BASE_URL` and `APP_URL` in `.env`. Worktrees auto-get `<branch>.api.swarm.localhost:1355` subdomains. Non-portless fallback: `bun run start:http`.

**Docker Compose:** Requires `.env` with `API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`). Codex workers can use `OPENAI_API_KEY` or ChatGPT OAuth (`codex-login` + `codex_oauth` in config store). See `docker-compose.example.yml` for production.

</important>

<important if="you are writing or running unit tests">

## Unit tests

- Tests use isolated SQLite DBs (`./test-<name>.sqlite`) with `initDb()`/`closeDb()` in `beforeAll`/`afterAll`
- Tests needing HTTP use a minimal `node:http` handler — NOT the full `src/http.ts` server
- Use unique test ports to avoid conflicts (e.g. 13022, 13023)
- Clean up DB files (including `-wal` and `-shm`) in `afterAll`

</important>

<important if="you are running E2E tests with Docker, or testing runtime behavior changes end-to-end">

## E2E testing with Docker

**Worktree port check:** Always check `.env` for `PORT` and `MCP_BASE_URL` first (`lsof -i :3013`). If occupied, set alternate port and update `MCP_BASE_URL` in both `.env` and `.env.docker` (use `host.docker.internal:<port>`).

**Quick E2E setup:**
```bash
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
bun run docker:build:worker
# Lead:
docker run --rm -d --name e2e-test-lead --env-file .env.docker-lead -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:latest
# Worker:
docker run --rm -d --name e2e-test-worker --env-file .env.docker -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest
# Verify:
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.agents[] | {name, isLead, status}'
# Cleanup:
docker stop e2e-test-lead e2e-test-worker; kill $(lsof -ti :3013)
```

**Env file differences:** `.env.docker-lead` has lead-specific `AGENT_ID`, no `OPENROUTER_API_KEY`. `AGENT_ROLE=lead` must be passed explicitly (not in the env file).

**Task cancellation caveat:** Direct DB updates bypass hook-based cancellation — use MCP `cancel-task` tool. Keep test tasks trivial ("Say hi").

**When changes touch runtime behavior** (API, runner, polling, task lifecycle, Docker entrypoint), use the `swarm-local-e2e` skill for full verification.

</important>

<important if="you are modifying docker-entrypoint.sh or Docker bootstrap logic">

## Entrypoint integration testing

Validate beyond `bash -n` syntax checks with a full Docker round-trip:

1. **Validate API endpoints first** — verify HTTP methods/paths in entrypoint `curl` calls against route definitions in `src/http/`. Common gotcha: config API uses `PUT /api/config` (not `POST`).
2. **Test idempotency** — first boot registers, second boot (same `AGENT_ID`) should skip via config check.
3. **Test failure mode** — stop external service, boot container, should continue via `|| true` guards.
4. **Test lead vs worker paths** — `.env.docker-lead` + `-e AGENT_ROLE=lead` for lead, `.env.docker` for worker.
5. **Grep logs:** `docker logs <name> 2>&1 | grep -i "<feature>"`
6. **Verify persisted state:** `GET /api/config?includeSecrets=true`

</important>

<important if="you are testing MCP tools via curl or Streamable HTTP">

## MCP tool testing

MCP tools require a session handshake: `POST /mcp` with `initialize` -> capture `mcp-session-id` header -> send `notifications/initialized` -> call tools with session ID.

Key gotchas:
- `Accept` header MUST include both `application/json` and `text/event-stream`
- `X-Agent-ID` must be a valid UUID (use `uuidgen`)
- Session must be initialized before calling tools

</important>

<important if="you are testing or modifying the dashboard UI (new-ui/)">

## UI testing

Use `qa-use` tool (`/qa-use:test-run`, `/qa-use:verify`, `/qa-use:explore`). Dashboard defaults to port 5274 (`APP_URL`). UI connects to API via `VITE_API_URL` (defaults to `http://localhost:3013`).

**Worktree port check:** `lsof -i :5274`. If occupied, `cd new-ui && pnpm run dev --port 5275` and update `APP_URL`.

**PR requirement:** Any PR changing frontend code (`new-ui/`, `landing/`, `templates-ui/`) must include a `qa-use` session with screenshots verifying the changes running locally.

</important>

<important if="you are preparing a commit, push, or pull request">

## Pre-PR checklist

**Root project (src/, tools/):**
```bash
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
```

**If you changed `plugin/commands/*.md`:** `bun run build:pi-skills` — CI enforces freshness.

**new-ui/:** `cd new-ui && pnpm lint && pnpm exec tsc --noEmit`

**Frontend changes (new-ui/, landing/, templates-ui/):** PRs must include a `qa-use` session with screenshots verifying the changes with the frontend running locally. Use `qa-use` to capture browser verification before creating or updating the PR.

**Docker changes:** `docker build -f <Dockerfile> .`

All enforced by `.github/workflows/merge-gate.yml`.

</important>

<important if="you are testing Slack integration manually or via E2E">

## Slack testing

**Dev channel:** `#swarm-dev-2` (ID: `C0AR967K0KZ`), **Bot:** `@dev-swarm` (member ID: `U0ALZGQCF96`).

**Via Slack MCP:** Use the `slack_send_message` tool to trigger bot interactions:
```
slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> hi")
```

This sends a message to `#swarm-dev-2` mentioning the bot, which triggers the Slack handler → task assignment flow.

</important>

## Related

- [BUSINESS_USE.md](./BUSINESS_USE.md) — Flow diagrams and instrumentation
- [MCP.md](./MCP.md) — MCP tools reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Production deployment
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Development setup
- [new-ui/](./new-ui/) — Dashboard (Next.js)
- [templates-ui/](./templates-ui/) — Templates registry (Next.js)

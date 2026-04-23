# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Bun + TypeScript, `bun:sqlite` (WAL), Biome, Ink CLI.

See [CONTRIBUTING.md](./CONTRIBUTING.md) to get set up. Start the server with `bun run start:http`.

## Project map

```
src/
  http.ts, server.ts   # API server + MCP endpoints
  stdio.ts             # Stdio MCP transport
  cli.tsx              # CLI entry (Ink)
  tools/               # MCP tool definitions
  http/                # REST route handlers (use route() factory)
  providers/           # Harness adapters (claude, pi, codex) + OAuth flows
  commands/            # Worker-side command implementations
  be/
    db.ts              # DB init + query functions (API-only)
    migrations/        # Forward-only SQL migrations
  prompts/             # System-prompt composition
  github/, slack/      # Integration handlers
new-ui/                # Dashboard (Next.js, port 5274)
templates-ui/          # Templates registry (Next.js)
templates/             # Official + community template data
docs-site/             # Fumadocs site (MDX)
```

## Architecture invariants

The API server (`src/http.ts`, `src/server.ts`, `src/tools/`, `src/http/`) is the **sole owner** of the SQLite database. Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) must **never** import from `src/be/db` or `bun:sqlite`. Workers talk to the API over HTTP using `API_KEY` and `X-Agent-ID` headers. Enforced by `scripts/check-db-boundary.sh` (pre-push hook + CI).

Shared pure logic belongs in `src/prompts/` or `src/utils/`.

<important if="you need to run commands to build, test, lint, start the server, or generate code">

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install dependencies |
| `bun run start:http` | Run MCP HTTP server (port 3013) |
| `bun run dev:http` | Dev with hot reload (portless: `https://api.swarm.localhost:1355`) |
| `bun run lint:fix` | Lint & format with Biome |
| `bun run tsc:check` | Type check |
| `bun test` | Run all unit tests |
| `bun test src/tests/<file>.test.ts` | Run a specific test |
| `bun run pm2-start` / `pm2-stop` / `pm2-restart` / `pm2-logs` / `pm2-status` | All services (API 3013, UI 5274, lead 3201, worker 3202) |
| `bun run docker:build:worker` | Build Docker worker image |
| `bun run docs:openapi` | Regenerate `openapi.json` |
| `bun run docs:business-use` | Regenerate `BUSINESS_USE.md` (requires BU backend) |
| `bun run build:pi-skills` | Regenerate `plugin/pi-skills/` from `plugin/commands/*.md` |
| `docker compose -f docker-compose.local.yml up --build` | Local compose (API + lead + worker) |
| `uvx business-use-core@latest server dev` | BU backend on :13370 |

PM2 note: lead/worker run in Docker. On code changes: `bun run docker:build:worker && bun run pm2-restart`.

</important>

<important if="you are choosing between Bun and Node.js APIs, or writing shell/file/HTTP/SQLite code">

Use Bun, not Node/npm/pnpm/vite:

- `Bun.serve()` for HTTP/WebSocket (not express/ws)
- `bun:sqlite` for SQLite (not better-sqlite3)
- `Bun.file()` for file I/O (not `node:fs`)
- `Bun.$` for shell (not execa)
- Bun auto-loads `.env` — don't use dotenv

</important>

<important if="you are referencing Gemini models in tests, workflows, or examples">

Default Gemini model: `google/gemini-3-flash-preview` (not `gemini-2.0-flash-001`).

</important>

<important if="you are adding or modifying database schema or migrations">

## Database migrations

File-based, forward-only in `src/be/migrations/`. Runner auto-applies on startup.

1. Create `src/be/migrations/NNN_descriptive_name.sql` (next number after highest existing).
2. Forward-only SQL. Use `IF NOT EXISTS` on CREATE TABLE/INDEX.
3. Test against fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) **and** an existing one.

Rules: never modify an already-applied migration — create a new one. No `down` migrations (SQLite rollbacks flake). Keep `AgentTaskSourceSchema` in `src/types.ts` in sync with SQL CHECK constraints.

</important>

<important if="you are adding or modifying CLI commands or CLI help text">

CLI help lives in `src/cli.tsx` — plain `console.log`, not Ink. To add/modify a command:

1. Update `COMMAND_HELP` record (usage, description, options, examples).
2. Add the command to the `commands` array in `printHelp()`.
3. Route it in `App` switch (UI commands) or before `render()` (non-UI).
4. Verify: `bun run src/cli.tsx help` and `bun run src/cli.tsx <command> --help`.

**Non-UI commands** (`help`, `version`, `docs`, `hook`, `artifact`) run before `render()` with `console.log` + `process.exit(0)`. **UI commands** (`onboard`, `connect`, `api`, `claude`, `worker`, `lead`) return JSX from the `App` switch.

</important>

<important if="you are adding or modifying HTTP API endpoints or REST routes">

Always use the `route()` factory from `src/http/route-def.ts` — it auto-registers in OpenAPI. Do **not** use raw `matchRoute`.

After adding a handler:

1. Import and add to the chain in `src/http/index.ts`.
2. Add the import to `scripts/generate-openapi.ts`.
3. `bun run docs:openapi` and commit `openapi.json`.

</important>

<important if="you are bumping the version in package.json">

`openapi.json` and `docs-site/content/docs/api-reference/**` embed the current `package.json` version. CI fails the `OpenAPI Spec Freshness Check` on any version bump without a regenerated spec.

Whenever you change `package.json`'s `version`: run `bun run docs:openapi` and commit the regenerated files alongside the bump.

</important>

<important if="you are creating or modifying workflows, or using the create-workflow tool">

Workflows are DAGs of nodes connected via `next`.

- **Cross-node data access:** upstream outputs are **not** available by default. Declare an `inputs` mapping — keys are local names for `{{interpolation}}`, values are context paths (usually a node ID). Agent-task output shape is `{ taskId, taskOutput }`, so access via `localName.taskOutput.field`. For trigger data: `{ "pr": "trigger.pullRequest" }` → `{{pr.number}}`. Without `inputs`, upstream references silently resolve to empty strings — check `diagnostics.unresolvedTokens`.
- **Structured output:** put the schema in `config.outputSchema` (not node-level). Agent produces JSON matching it; validated by `store-progress`.
- **Interpolation:** `{{path.to.value}}` in any string field inside `config`. Objects get JSON-stringified, nulls become empty strings.
- **Agent-task config fields:** `template` (required), `outputSchema`, `agentId`, `tags`, `priority` (0–100, default 50), `offerMode`, `dir`, `vcsRepo`, `model`, `parentTaskId`.

</important>

<important if="you are adding business-use instrumentation or events">

See [BUSINESS_USE.md](./BUSINESS_USE.md) for flow diagrams. Flows: `task` (runId = taskId), `agent` (runId = agentId), `api` (runId = per-boot ID).

- Use `ensure()` (auto-picks act vs assert based on whether a validator is present).
- Place calls **after** successful state mutations, **outside** transactions when possible.
- Validators must be self-contained — only reference `data` and `ctx` params, never closure variables (they get serialized).
- Worker-side events use `depIds` pointing at server-side events in the same flow.
- `BUSINESS_USE_API_KEY` / `BUSINESS_USE_URL` go in `.env` and `.env.docker*`. SDK no-ops if the key is missing.

</important>

<important if="you are writing code that logs, prints, stores, or transports sensitive values (secrets, tokens, OAuth creds, API keys, DB URLs, webhook payloads)">

## Secret scrubbing

Any path that emits to logs, stdout/stderr, the `session_logs` table, or `/workspace/logs/*.jsonl` MUST run through the centralized scrubber first. Never print raw env values, credential-pool entries, OAuth payloads, webhook bodies, or tool output that may embed tokens.

- Module: `src/utils/secret-scrubber.ts`.
- Use: `import { scrubSecrets } from "./utils/secret-scrubber"` and wrap at the **egress** point, not the source.
- After reloading `swarm_config` or rotating credential pools, call `refreshSecretScrubberCache()` so newly-added secrets get covered (`/internal/reload-config` and worker credential-selection already do this).
- Worker/API-neutral (reads only `process.env`) — safe to import from either side without violating the DB boundary.
- Covers env-sourced values (≥12 chars exact-match, plus comma-separated pool components) and structural patterns (GitHub PATs, Anthropic/OpenAI/OpenRouter `sk-*`, Slack `xox*`, JWTs, AWS access keys, Google API keys). New secret-shaped credential? Extend `SENSITIVE_KEY_EXACT` or `TOKEN_REGEXES` + add a regression test in `src/tests/secret-scrubber.test.ts`.

</important>

<important if="you are setting up local development, configuring environment variables, or running the server locally">

## Local development

**Env files:** `.env` (API server), `.env.docker` (Docker worker), `.env.docker-lead` (Docker lead).

**Key env vars:** `API_KEY` (auth, default `123123`), `MCP_BASE_URL` (default `http://localhost:3013`), `SLACK_DISABLE=true` / `GITHUB_DISABLE=true`, `HARNESS_PROVIDER` (`claude`, `pi`, or `codex` — codex needs `OPENAI_API_KEY` or `~/.codex/auth.json` or ChatGPT OAuth via `codex-login`), `TEMPLATE_ID` (e.g. `official/coder`), `TEMPLATE_REGISTRY_URL` (default `https://templates.agent-swarm.dev`). ChatGPT OAuth is stored server-side as the global `codex_oauth` config entry; codex workers restore it into `~/.codex/auth.json` at boot.

**Secrets encryption:** `swarm_config` secret rows are encrypted at rest with AES-256-GCM. Key resolution order, backup requirements, and plaintext-migration notes live in [docs-site/.../guides/secrets-encryption.mdx](./docs-site/content/docs/(documentation)/guides/secrets-encryption.mdx). `API_KEY` and `SECRETS_ENCRYPTION_KEY` are reserved and cannot be stored in `swarm_config`.

**Codex ChatGPT OAuth:** run `bun run src/cli.tsx codex-login` from your laptop, not inside the worker container. Point `--api-url` at the public API (or SSH tunnel) for a remote swarm, then restart codex workers.

**Portless dev:** `bun run dev:http` → `https://api.swarm.localhost:1355`. Set `MCP_BASE_URL` and `APP_URL` in `.env`. Worktrees auto-get `<branch>.api.swarm.localhost:1355` subdomains. Non-portless fallback: `bun run start:http`.

**Testing API locally:**

```bash
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/agents
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: <uuid>" http://localhost:3013/mcp
```

**Docker Compose:** requires `.env` with `API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`). See `docker-compose.example.yml`.

</important>

<important if="you are writing, running, or debugging any local tests (unit, E2E, entrypoint, MCP handshake, or UI)">

See [LOCAL_TESTING.md](./LOCAL_TESTING.md) — covers unit-test conventions, the minimal Docker smoke-test, entrypoint round-trip checklist, MCP handshake sequence, UI port handling, and port-conflict resolution across worktrees.

For the **full guided E2E flow** (tasks, session logs, UI verification), invoke the `swarm-local-e2e` skill.

</important>

<important if="you are creating a plan (plan mode, /desplega:create-plan, the planning skill, or the QA skill) that includes verification, manual E2E, or testing steps">

Read [LOCAL_TESTING.md](./LOCAL_TESTING.md) **before** drafting verification / E2E / QA steps — so the plan references real commands, ports, env files, and gotchas rather than invented ones. Copy the exact command form from the relevant section; don't paraphrase.

</important>

<important if="you are testing or modifying the dashboard UI (new-ui/)">

Use `qa-use` (`/qa-use:test-run`, `/qa-use:verify`, `/qa-use:explore`). Dashboard defaults to `APP_URL` (port 5274). UI reads `VITE_API_URL` (defaults to `http://localhost:3013`). See [LOCAL_TESTING.md § Dashboard UI](./LOCAL_TESTING.md#dashboard-ui) for port-conflict handling.

**PR requirement:** any PR touching `new-ui/`, `landing/`, or `templates-ui/` must include a `qa-use` session with screenshots of the changes running locally.

</important>

<important if="you are preparing a commit, push, or pull request">

## Pre-PR checklist

Root project:

```bash
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
```

- Changed `plugin/commands/*.md`? → `bun run build:pi-skills` (CI enforces freshness).
- Touched `new-ui/`? → `cd new-ui && pnpm lint && pnpm exec tsc --noEmit`.
- Frontend changes (`new-ui/`, `landing/`, `templates-ui/`)? → include a `qa-use` session with screenshots.
- Docker changes? → `docker build -f <Dockerfile> .`.

All enforced by `.github/workflows/merge-gate.yml`.

</important>

<important if="you are testing Slack integration manually or via E2E">

Dev channel `#swarm-dev-2` (`C0AR967K0KZ`), bot `@dev-swarm` (`U0ALZGQCF96`). Send `slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> hi")` via the Slack MCP tool to trigger the bot handler → task-assignment flow.

</important>

<important if="you are modifying memory system code (src/be/memory/, src/be/embedding.ts, src/tools/memory-*.ts, src/http/memory.ts, or src/tools/store-progress.ts memory sections)">

Provider abstractions (`EmbeddingProvider`, `MemoryStore`) in `src/be/memory/` with sqlite-vec for vector search and a reranker scoring `similarity × recency_decay × access_boost`.

Always run:

```bash
bun test src/tests/memory-reranker.test.ts
bun test src/tests/memory-store.test.ts
bun test src/tests/memory.test.ts
bun test src/tests/memory-e2e.test.ts
```

Key files: `src/be/memory/types.ts` (interfaces), `src/be/memory/providers/` (OpenAI embeddings, SQLite+sqlite-vec store), `src/be/memory/reranker.ts`, `src/be/memory/constants.ts` (env-overridable tuning), `src/be/memory/index.ts` (singletons).

</important>

<important if="you are modifying harness-provider code (src/providers/*, src/commands/runner.ts provider dispatch, src/prompts/*, docker-entrypoint.sh provider branches, or adding a new provider)">

Canonical reference: [docs-site/.../guides/harness-providers.mdx](./docs-site/content/docs/(documentation)/guides/harness-providers.mdx). Update that guide in the **same PR** as any observable change to the `ProviderAdapter` interface, the factory dispatch, adapter event-translation / log format / abort semantics, the runner's poll→spawn→events→finish flow, system-prompt composition, entrypoint credential restoration, or OAuth flows.

When adding a new provider, also extend the guide's "Reference implementations" table, "Files to touch" checklist, and `README.md`'s multi-provider bullet.

Verify before committing: `cd docs-site && pnpm exec next build` (or `pnpm dev` and visit `/docs/guides/harness-providers`) — MDX must compile.

</important>

## Related

- [LOCAL_TESTING.md](./LOCAL_TESTING.md) — unit / E2E / entrypoint / MCP / UI testing recipes
- [BUSINESS_USE.md](./BUSINESS_USE.md) — flow diagrams and instrumentation
- [MCP.md](./MCP.md) — MCP tools reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) — production deployment
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup
- [docs-site/.../guides/](./docs-site/content/docs/(documentation)/guides/) — secrets encryption, harness providers, integrations

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
  providers/           # Harness adapters (claude, pi, codex, devin) + OAuth flows
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
runbooks/              # Operational runbooks (local dev, etc.)
```

## Architecture invariants

The API server (`src/http.ts`, `src/server.ts`, `src/tools/`, `src/http/`) is the **sole owner** of the SQLite database. Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) must **never** import from `src/be/db` or `bun:sqlite`. Workers talk to the API over HTTP using `API_KEY` and `X-Agent-ID` headers. Enforced by `scripts/check-db-boundary.sh` (pre-push hook + CI).

<important if="you need to run commands to build, test, lint, start the server, or generate code">

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install deps |
| `bun run start:http` | MCP HTTP server (port 3013) |
| `bun run dev:http` | Hot reload, portless: `https://api.swarm.localhost:1355` |
| `bun run lint:fix` | Lint & format with Biome |
| `bun run tsc:check` | Type check |
| `bun test` | Run unit tests (`bun test src/tests/<file>.test.ts` for one) |
| `bun run pm2-{start,stop,restart,logs,status}` | All services (API 3013, UI 5274, lead 3201, worker 3202) |
| `bun run docker:build:worker` | Build Docker worker image |
| `bun run docs:openapi` | Regenerate `openapi.json` |
| `bun run docs:business-use` | Regenerate `BUSINESS_USE.md` (requires BU backend) |
| `bun run build:pi-skills` | Regenerate `plugin/pi-skills/` from `plugin/commands/*.md` |
| `docker compose -f docker-compose.local.yml up --build` | Local compose (API + lead + worker) |
| `uvx business-use-core@latest server dev` | BU backend on :13370 |

PM2: lead/worker run in Docker. On code changes: `bun run docker:build:worker && bun run pm2-restart`.

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

Default Gemini model: `google/gemini-3-flash-preview` (this is from OpenRouter).

</important>

<important if="you are adding or modifying database schema or migrations">

File-based, forward-only SQL in `src/be/migrations/NNN_descriptive_name.sql`. Runner auto-applies on startup.

Test against a fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) **and** an existing one. Never modify an applied migration — create a new one. No `down` migrations (SQLite rollbacks flake). Keep `AgentTaskSourceSchema` in `src/types.ts` in sync with SQL CHECK constraints.

</important>

<important if="you are adding or modifying CLI commands or CLI help text">

CLI help lives in `src/cli.tsx` — plain `console.log`, not Ink. To add/modify: update `COMMAND_HELP`, add to the `commands` array in `printHelp()`, then route in the `App` switch (UI commands) or before `render()` (non-UI). Verify with `bun run src/cli.tsx help` and `bun run src/cli.tsx <command> --help`.

</important>

<important if="you are adding or modifying HTTP API endpoints or REST routes">

Always use the `route()` factory from `src/http/route-def.ts` — auto-registers in OpenAPI. Do **not** use raw `matchRoute`.

After adding a handler: also add the import to `scripts/generate-openapi.ts`, then run `bun run docs:openapi` and commit `openapi.json`.

</important>

<important if="you are bumping the version in package.json">

`openapi.json` and `docs-site/content/docs/api-reference/**` embed `package.json`'s version. CI fails the `OpenAPI Spec Freshness Check` on any version bump without a regenerated spec.

On every version bump: run `bun run docs:openapi` and commit the regenerated files alongside the bump.

</important>

<important if="you are creating or modifying workflows, or using the create-workflow tool">

Workflows are DAGs of nodes connected via `next`. Common gotcha: upstream outputs are **not** available unless you declare an `inputs` mapping. Full reference — cross-node data, structured output, interpolation, agent-task config fields: see [runbooks/workflows.md](./runbooks/workflows.md).

</important>

<important if="you are adding business-use instrumentation or events">

See [BUSINESS_USE.md](./BUSINESS_USE.md) for flow diagrams. Flows: `task` (runId = taskId), `agent` (runId = agentId), `api` (runId = per-boot ID).

- Use `ensure()` (auto-picks act vs assert based on whether a validator is present).
- Place calls **after** successful state mutations, **outside** transactions when possible.
- Validators must be self-contained — only reference `data` and `ctx` params, never closure variables (they get serialized).
- Worker-side events use `depIds` pointing at server-side events in the same flow.
- SDK no-ops if `BUSINESS_USE_API_KEY` is missing.

</important>

<important if="you are writing code that logs, prints, stores, or transports sensitive values (secrets, tokens, OAuth creds, API keys, DB URLs, webhook payloads)">

Any path emitting to logs, stdout/stderr, the `session_logs` table, or `/workspace/logs/*.jsonl` MUST go through `scrubSecrets` from `src/utils/secret-scrubber.ts` at the **egress** point. Never print raw env values, credential-pool entries, OAuth payloads, webhook bodies, or tool output that may embed tokens.

Cache refresh, coverage rules, and how to add a new secret shape: see [runbooks/secret-scrubbing.md](./runbooks/secret-scrubbing.md).

</important>

<important if="you are setting up local development, configuring environment variables, or running the server locally">

Full setup — env files, env vars, OAuth flows (Linear/Jira/Codex), portless dev, secrets encryption, curl examples, Docker Compose: see [runbooks/local-development.md](./runbooks/local-development.md).

Quick reference:
- Auth: `Authorization: Bearer ${API_KEY}` (default `123123`).
- Server URL: `MCP_BASE_URL` (default `http://localhost:3013`).
- Provider: `HARNESS_PROVIDER=claude|pi|codex|devin|claude-managed`. `claude-managed` runs in Anthropic's cloud sandbox — requires `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, an HTTPS-public `MCP_BASE_URL`, and the one-time `bun run src/cli.tsx claude-managed-setup` step. The `new-ui/` integrations dashboard surfaces the same config (Phase 7). See [runbooks/local-development.md § Claude Managed Agents](./runbooks/local-development.md#claude-managed-agents).
- Disable integrations: `SLACK_DISABLE` / `GITHUB_DISABLE` / `JIRA_DISABLE` / `LINEAR_DISABLE=true`.

</important>

<important if="you are writing or running tests, drafting a plan with verification / E2E / QA steps, or preparing a frontend PR (new-ui/, landing/, templates-ui/)">

Hub: [runbooks/testing.md](./runbooks/testing.md) — routes to LOCAL_TESTING.md, qa-use, swarm-local-e2e skill, memory tests, Slack E2E.

Hard rules:
- Plan-mode verification steps MUST copy real commands from LOCAL_TESTING.md; don't paraphrase.
- Frontend PRs (`new-ui/`, `landing/`, `templates-ui/`) MUST include a `qa-use` session with screenshots — enforced by merge gate.

</important>

<important if="you are testing Slack integration manually or via E2E">

Dev channel `#swarm-dev-2` (`C0AR967K0KZ`), bot `@dev-swarm` (`U0ALZGQCF96`). Send `slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> hi")` via the Slack MCP tool to trigger the bot handler → task-assignment flow.

</important>

<important if="you are preparing a commit, push, or pull request — or CI just failed and you need to know why">

Mirror what `.github/workflows/merge-gate.yml` runs. Full job-by-job breakdown, drift checks, lockfile rules, and "why CI fails" list: [runbooks/ci.md](./runbooks/ci.md).

Quick checklist (run from repo root):

```bash
bun install --frozen-lockfile
bun run lint           # NOT lint:fix — CI runs `lint` (read-only)
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
```

Drift checks — run only if you touched the trigger files, MUST commit any regenerated output:

- Edited `plugin/commands/*.md`? → `bun run build:pi-skills`
- Edited an HTTP route OR bumped `package.json` `version`? → `bun run docs:openapi` (regenerates `openapi.json` AND `docs-site/content/docs/api-reference/**`)
- Touched `new-ui/`? → `cd new-ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b` (CI uses `tsc -b`, not `--noEmit`)
- Touched `Dockerfile` / `Dockerfile.worker` / files they COPY? → `docker build -f <Dockerfile> .`

Frontend (`new-ui/`, `landing/`, `templates-ui/`) PRs additionally require a `qa-use` session with screenshots.

</important>

<important if="you are modifying memory system code (src/be/memory/, src/be/embedding.ts, src/tools/memory-*.ts, src/http/memory.ts, or src/tools/store-progress.ts memory sections)">

Architecture, key files, and full test commands: see [runbooks/memory-system.md](./runbooks/memory-system.md). Always run all four memory test files after any change.

</important>

<important if="you are modifying harness-provider code (src/providers/*, src/commands/runner.ts provider dispatch, src/prompts/*, docker-entrypoint.sh provider branches, or adding a new provider)">

Same-PR doc-update rule + new-provider checklist: [runbooks/harness-providers.md](./runbooks/harness-providers.md). Canonical conceptual reference: [docs-site/.../guides/harness-providers.mdx](./docs-site/content/docs/(documentation)/guides/harness-providers.mdx).

</important>

## Related

- [runbooks/](./runbooks/) — ci, local-development, testing, workflows, memory-system, secret-scrubbing, harness-providers
- [LOCAL_TESTING.md](./LOCAL_TESTING.md) — unit / E2E / entrypoint / MCP / UI testing recipes
- [BUSINESS_USE.md](./BUSINESS_USE.md) — flow diagrams and instrumentation
- [MCP.md](./MCP.md) — MCP tools reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) — production deployment
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup
- [docs-site/.../guides/](./docs-site/content/docs/(documentation)/guides/) — secrets encryption, harness providers, integrations

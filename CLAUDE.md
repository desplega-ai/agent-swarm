# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Bun + TypeScript, `bun:sqlite` (WAL), Biome, Ink CLI.

See [CONTRIBUTING.md](./CONTRIBUTING.md) to get set up. Start the server with `bun run start:http`.

## Project map

```
apps/
  swarm/src/           # The swarm app (API server + CLI + workers) — the pre-monorepo src/
    http.ts, server.ts #   API server + MCP endpoints
    stdio.ts           #   Stdio MCP transport
    cli.tsx            #   CLI entry (Ink)
    tools/             #   MCP tool definitions
    http/              #   REST route handlers (use route() factory)
    providers/         #   Harness adapters (claude, pi, codex, devin) + OAuth flows
    commands/          #   Worker-side command implementations
    be/                #   DB init + query functions (API-only) + forward-only SQL migrations
    prompts/           #   System-prompt composition
    github/, slack/    #   Integration handlers
  ui/                  # Dashboard (Vite SPA, port 5274)
  templates-ui/        # Templates registry (Next.js)
  evals/               # Eval harness: scenario x harness-config matrix on E2B (own package; see apps/evals/README.md)
templates/             # Official + community template data
docs-site/             # Fumadocs site (MDX)
runbooks/              # Operational runbooks (local dev, etc.)
```

## Architecture invariants

The API server (`apps/swarm/src/http.ts`, `apps/swarm/src/server.ts`, `apps/swarm/src/tools/`, `apps/swarm/src/http/`) is the **sole owner** of the SQLite database. Worker-side code (`apps/swarm/src/commands/`, `apps/swarm/src/hooks/`, `apps/swarm/src/providers/`, `apps/swarm/src/prompts/`, `apps/swarm/src/cli.tsx`, `apps/swarm/src/claude.ts`) must **never** import from `apps/swarm/src/be/db` or `bun:sqlite`. Workers talk to the API over HTTP using the swarm API key + `X-Agent-ID` headers. Enforced by `scripts/check-db-boundary.sh` (CI).

The swarm API key MUST be read via `getApiKey()` from `apps/swarm/src/utils/api-key.ts` — never `process.env.API_KEY` / `process.env.AGENT_SWARM_API_KEY` directly. Precedence: `AGENT_SWARM_API_KEY` > `API_KEY`. Enforced by `scripts/check-api-key-boundary.sh` (CI).

System prompt and task prompt text MUST go through the prompt-template registry in `apps/swarm/src/prompts/`; do not hardcode new prompt sections with string concatenation in runners, hooks, or providers. Add or update a registered template, then resolve it from the call site.

<important if="you are adding, changing, or using task/schedule/workflow model selection">

Prefer portable `modelTier` (`smol` / `regular` / `smart` / `ultra`) for cross-harness task intent and reserve `model` for concrete provider-specific overrides. Tier defaults, env/JSON overrides, legacy alias normalization, and claim-time resolution are documented in [runbooks/model-tiers.md](./runbooks/model-tiers.md).

</important>

<important if="you are modifying scripts-runtime code (apps/swarm/src/scripts-runtime/*, apps/swarm/src/be/scripts/*, apps/swarm/src/tools/script-*.ts, apps/swarm/src/http/scripts.ts)">

Architecture: API server owns the `scripts` + `script_versions` tables. Workers + the runtime invoke via HTTP. The runtime evaluates user-supplied TS in a `Bun.spawn` subprocess wrapped in `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, 30s AbortController, 1 MB stdout cap.

Config injection: agent identity + bearer + mcpBaseUrl flow as a JSON `SwarmConfigPayload` over the subprocess **stdin** — NOT env vars. Bearer is wrapped in `Redacted<string>` inside the script; user code never unwraps. `process.env` carries only Node/Bun defaults. Loader reads the bearer via `getApiKey()` from `apps/swarm/src/utils/api-key.ts` (never raw env).

FS modes: `'none'` = per-run tmpdir (v1 only); `'workspace-rw'` returns 501 in v1 (worker dispatch is v2).

SDK surface: derived from MCP tool registry at build time via `scripts/bundle-script-types.ts`. Curated allowlist in `apps/swarm/src/scripts-runtime/sdk-allowlist.ts`.

Typecheck: `script_upsert` runs `tsc --noEmit` against the generated `.d.ts`; rejects on diagnostics. Inline `script_run` skips typecheck (scratch hot path).

Boundaries: `apps/swarm/src/scripts-runtime/` is on both `check-db-boundary.sh` (no `apps/swarm/src/be/db` imports) and `check-api-key-boundary.sh` (must use `getApiKey()`) allowlists.

Tests: `bun test apps/swarm/src/tests/scripts-*.test.ts`. Sandbox + timeout + abort + stdin-config + env-hygiene paths are the highest-risk surfaces — keep coverage tight.

New MCP tools: when adding a tool, register it in `SDK_TOOL_NAME_MAP` (`apps/swarm/src/scripts-runtime/sdk-allowlist.ts`) to expose it to scripts, or add it to `EXCLUDED_TOOLS` in `scripts/check-sdk-tool-registration.ts` with a reason. Enforced by CI.

</important>

<important if="you need to run commands to build, test, lint, start the server, or generate code">

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install deps |
| `bun run start:http` | MCP HTTP server (port 3013) |
| `bun run dev:http` | Hot reload, portless: `https://api.swarm.localhost:1355` |
| `bun run lint:fix` | Lint & format with Biome |
| `bun run tsc:check` | Type check |
| `bun test` | Run unit tests (`bun test apps/swarm/src/tests/<file>.test.ts` for one) |
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

<important if="you are searching the codebase for code by intent, a symbol/identifier, or how something works">

## Code Search

Use `semble search` to find code by describing what it does or naming a symbol/identifier, instead of grep:

```bash
semble search "authentication flow" ./my-project
semble search "save_pretrained" ./my-project
semble search "save model to disk" ./my-project --top-k 10
```

Use `semble find-related` to discover code similar to a known location (pass `file_path` and `line` from a prior search result):

```bash
semble find-related apps/swarm/src/auth.py 42 ./my-project
```

`path` defaults to the current directory when omitted; git URLs are accepted.

If `semble` is not on `$PATH`, use `uvx --from "semble[mcp]" semble` in its place.

If the `semble` MCP server is enabled, prefer its `search` / `find_related` tools over the CLI.

To keep search output out of the main context, offload it to the `semble-search` subagent (`.claude/agents/semble-search.md`) via the `Task` tool — it runs the search/find-related loop and returns only the relevant findings.

### Workflow

1. Start with `semble search` to find relevant chunks.
2. Inspect full files only when the returned chunk is not enough context.
3. Optionally use `semble find-related` with a promising result's `file_path` and `line` to discover related implementations.
4. Use grep only when you need exhaustive literal matches or quick confirmation of an exact string.

</important>

<important if="you are referencing Gemini models in tests, workflows, or examples">

Default Gemini model: `google/gemini-3-flash-preview` (this is from OpenRouter).

</important>

<important if="you are adding or modifying database schema or migrations">

File-based, forward-only SQL in `apps/swarm/src/be/migrations/NNN_descriptive_name.sql`. Runner auto-applies on startup.

Test against a fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) **and** an existing one. Never modify an applied migration — create a new one. No `down` migrations (SQLite rollbacks flake). Keep `AgentTaskSourceSchema` in `apps/swarm/src/types.ts` in sync with SQL CHECK constraints.

</important>

<important if="you are adding or modifying CLI commands or CLI help text">

CLI help lives in `apps/swarm/src/cli.tsx` — plain `console.log`, not Ink. To add/modify: update `COMMAND_HELP`, add to the `commands` array in `printHelp()`, then route in the `App` switch (UI commands) or before `render()` (non-UI). Verify with `bun run apps/swarm/src/cli.tsx help` and `bun run apps/swarm/src/cli.tsx <command> --help`.

</important>

<important if="you are adding or modifying HTTP API endpoints or REST routes">

Always use the `route()` factory from `apps/swarm/src/http/route-def.ts` — auto-registers in OpenAPI. Do **not** use raw `matchRoute`.

After adding a handler: also add the import to `scripts/generate-openapi.ts`, then run `bun run docs:openapi` and commit `openapi.json`.

</important>

<important if="you are bumping the version in package.json">

Two artifacts derive from `package.json`'s `version`: `openapi.json` + `docs-site/content/docs/api-reference/**` (embed it) and `charts/agent-swarm/Chart.yaml` (`version`/`appVersion` must match). CI fails the `OpenAPI Spec Freshness Check` and the chart-version sync check on a bump without regenerating them.

On every version bump: run `bun run prepare-release` (runs `sync-chart-version` + `docs:openapi`) and commit ALL regenerated files alongside the bump. Releasing itself is automated — merging the bump to `main` publishes Docker/npm/E2B/GitHub release. Full flow: [runbooks/release.md](./runbooks/release.md).

</important>

<important if="you are creating or modifying workflows, or using the create-workflow tool">

Workflows are DAGs of nodes connected via `next`. Common gotcha: upstream outputs are **not** available unless you declare an `inputs` mapping. The reusable scripts catalog is available through `swarm-script` nodes; keep it distinct from the existing inline `script` runner. Full reference — cross-node data, structured output, interpolation, agent-task config fields, `script` vs `swarm-script`: see [runbooks/workflows.md](./runbooks/workflows.md).

</important>

<important if="you are creating or modifying a workflow's triggerSchema, or writing tools/UI that author it">

See [runbooks/workflows.md § Trigger schema](./runbooks/workflows.md#trigger-schema) for the supported JSON-Schema subset and authoring paths. Validator subset is `type` / `required` / `properties` / `enum` / `const` / `items`; other keywords (`oneOf`, `anyOf`, `$ref`, `pattern`, `format`, `additionalProperties`, …) are silently ignored.

</important>

<important if="you are adding business-use instrumentation or events">

See [BUSINESS_USE.md](./BUSINESS_USE.md) for flow diagrams. Flows: `task` (runId = taskId), `agent` (runId = agentId), `api` (runId = per-boot ID).

- Use `ensure()` (auto-picks act vs assert based on whether a validator is present).
- Place calls **after** successful state mutations, **outside** transactions when possible.
- Validators must be self-contained — only reference `data` and `ctx` params, never closure variables (they get serialized).
- Worker-side events use `depIds` pointing at server-side events in the same flow.
- SDK no-ops if `BUSINESS_USE_API_KEY` is missing.

</important>

<important if="you are editing Dockerfile or Dockerfile.worker, adding/bumping a global dep in /opt/global-deps, or trying to reduce image size">

Rules + traps before you change anything: [runbooks/docker-images.md](./runbooks/docker-images.md).

Top rules — internalize these before editing:
- **Never `chown -R /home/worker` in its own layer** — it duplicates the full HOME (multi-GB layer). Either don't pollute HOME under `USER root`, or chown in the same RUN as the install.
- **`ENV HOME=/home/worker` survives `USER root`** — `npm install` / `playwright install` / curl-pipe-bash under root will dump caches into `/home/worker/.{npm,cache}`. Override `HOME=/root` and redirect caches (`NPM_CONFIG_CACHE=/tmp/...`, `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright`) inline, then clean in the same RUN.
- **`npm overrides` only apply at the install root** — monorepo root overrides do NOT travel with packages published to npm. To stub a transitive bloater (e.g. chromadb, onnxruntime variants) for a globally-installed dep, put the override in `/opt/global-deps/package.json` inside the Dockerfile, not in the source repo.
- Always measure: `docker history <img> --format "{{.Size}}\t{{.CreatedBy}}" | sort -h -r | head -10`.

</important>

<important if="you are writing code that logs, prints, stores, or transports sensitive values (secrets, tokens, OAuth creds, API keys, DB URLs, webhook payloads)">

Any path emitting to logs, stdout/stderr, the `session_logs` table, or `/workspace/logs/*.jsonl` MUST go through `scrubSecrets` from `apps/swarm/src/utils/secret-scrubber.ts` at the **egress** point. Never print raw env values, credential-pool entries, OAuth payloads, webhook bodies, or tool output that may embed tokens.

Cache refresh, coverage rules, and how to add a new secret shape: see [runbooks/secret-scrubbing.md](./runbooks/secret-scrubbing.md).

</important>

<important if="you are setting up local development, configuring environment variables, or running the server locally">

Full setup — env files, env vars, OAuth flows (Linear/Jira/Codex), portless dev, secrets encryption, curl examples, Docker Compose: see [runbooks/local-development.md](./runbooks/local-development.md).

Quick reference:
- Auth: `Authorization: Bearer ${AGENT_SWARM_API_KEY}` (preferred — falls back to legacy `API_KEY`; default `123123`). Read it in code via `getApiKey()` from `apps/swarm/src/utils/api-key.ts` — direct `process.env.API_KEY` access is rejected by `scripts/check-api-key-boundary.sh`.
- Server URL: `MCP_BASE_URL` (default `http://localhost:3013`).
- Provider: `HARNESS_PROVIDER=claude|pi|codex|devin|claude-managed`. `claude-managed` runs in Anthropic's cloud sandbox — requires `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, an HTTPS-public `MCP_BASE_URL`, and the one-time `bun run apps/swarm/src/cli.tsx claude-managed-setup` step. The `apps/ui/` integrations dashboard surfaces the same config (Phase 7). See [runbooks/local-development.md § Claude Managed Agents](./runbooks/local-development.md#claude-managed-agents).
- Disable integrations: `SLACK_DISABLE` / `GITHUB_DISABLE` / `JIRA_DISABLE` / `LINEAR_DISABLE=true`.

</important>

<important if="you are writing or running tests, drafting a plan with verification / E2E / QA steps, or preparing a frontend PR (apps/ui/, apps/templates-ui/)">

Hub: [runbooks/testing.md](./runbooks/testing.md) — routes to LOCAL_TESTING.md, qa-use, swarm-local-e2e skill, memory tests, Slack E2E.

Hard rules:
- Plan-mode verification steps MUST copy real commands from LOCAL_TESTING.md; don't paraphrase.
- Frontend PRs (`apps/ui/`, `apps/templates-ui/`) MUST include a `qa-use` session with screenshots — enforced by merge gate.

</important>

<important if="you are sending a task to the swarm, or testing Slack integration manually or via E2E">

**Reaching the swarm depends on the target:**

- **LOCAL / dev agent-swarm (Slack):** Dev channel `#swarm-dev-2` (`C0AR967K0KZ`), bot `@dev-swarm` (`U0ALZGQCF96`). Send `slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> hi")` via the Slack MCP tool to trigger the bot handler → task-assignment flow.
- **PRODUCTION / deployed swarm (MCP):** use the swarm-user MCP `mcp__agent-swarm-user__send-task` (creates an unassigned task in the production pool; read results with `mcp__agent-swarm-user__get-tasks`). Do **NOT** use the dev Slack channel for production swarm work. The MCP may not be enabled in every session — check for `mcp__agent-swarm-user__*` first.

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
bun run check:dep-graph
```

Drift checks — run only if you touched the trigger files, MUST commit any regenerated output:

- Edited `plugin/commands/*.md`? → `bun run build:pi-skills`
- Edited an HTTP route OR bumped `package.json` `version`? → `bun run docs:openapi` (regenerates `openapi.json` AND `docs-site/content/docs/api-reference/**`)
- Touched `apps/ui/` — or root `bun.lock`/`package.json`/`bunfig.toml` (ui deps resolve from the root lock)? → `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b` (CI uses `tsc -b`, not `--noEmit`)
- Touched `Dockerfile` / `Dockerfile.worker` / `apps/evals/Dockerfile` / files they COPY (incl. `bunfig.toml`, member `package.json`s, `.dockerignore`)? → `docker build -f <Dockerfile> .` — CI builds all three images

Frontend (`apps/ui/`, `apps/templates-ui/`) PRs additionally require a `qa-use` session with screenshots.

</important>

<important if="you are modifying memory system code (apps/swarm/src/be/memory/, apps/swarm/src/be/embedding.ts, apps/swarm/src/tools/memory-*.ts, apps/swarm/src/http/memory.ts, or apps/swarm/src/tools/store-progress.ts memory sections)">

Architecture, key files, and full test commands: see [runbooks/memory-system.md](./runbooks/memory-system.md). Always run all four memory test files after any change.

</important>

<important if="you are modifying harness-provider code (apps/swarm/src/providers/*, apps/swarm/src/commands/runner.ts provider dispatch, apps/swarm/src/prompts/*, docker-entrypoint.sh provider branches, or adding a new provider)">

Same-PR doc-update rule + new-provider checklist: [runbooks/harness-providers.md](./runbooks/harness-providers.md). Canonical conceptual reference: [docs-site/.../guides/harness-providers.mdx](./docs-site/content/docs/(documentation)/guides/harness-providers.mdx).

</important>

<important if="you are modifying cost or context tracking code (apps/swarm/src/providers/*-adapter.ts, apps/swarm/src/utils/context-window.ts, apps/swarm/src/be/seed-pricing.ts, apps/swarm/src/http/session-data.ts, apps/swarm/src/http/context.ts, or pricing/context columns in apps/swarm/src/be/migrations/)">

Adapter emits CostData + context_usage → API recomputes USD against the seeded `pricing` table → row tagged `costSource` ('harness' / 'pricing-table' / 'unpriced') → UI badge. Unified context formula is `input + cache_read + cache_create + output` (see `computeContextUsedUnified`).

Same-PR doc-update rule: update [docs-site/.../guides/cost-and-context-computation.mdx](./docs-site/content/docs/(documentation)/guides/cost-and-context-computation.mdx) AND [apps/swarm/src/providers/pricing-sources.md](./src/providers/pricing-sources.md) when the contract changes. The pricing-table comes from `apps/swarm/src/be/modelsdev-cache.json` (symlinked into `apps/ui/src/lib/modelsdev-cache.json` for the UI model picker); refresh via `bun run scripts/refresh-modelsdev-pricing.ts` and commit the snapshot.

</important>

<important if="you are creating or modifying eval scenarios, rubrics, or fixtures (apps/evals/scenarios/*, apps/evals/scenarios/fixtures/*)">

Full rulebook: [apps/evals/SCENARIO-AUTHORING.md](./apps/evals/SCENARIO-AUTHORING.md). Non-negotiables: **deterministic-first** (a judge is the last resort and never the tier discriminator); **never penalize MANDATORY behavior** (audit every negative check — can a correct run trip it?); **grade artifacts the MODEL controls** (child tasks, merged report — NOT config/timing-dependent system emissions); **de-risk pilot before building an axis** (prove discrimination on ONE dimension × TWO tiers, ~$4, read the dimension gap + whether its CI excludes 0). Validate with `cd apps/evals && bun apps/swarm/src/cli.ts registry` + a rubric unit test against a synthetic JudgeContext; the deployed swarm proposes (never runs E2B itself — it costs money).

</important>

<important if="you are modifying heartbeat, crash-recovery, or task-assignment/routing logic (apps/swarm/src/heartbeat/*, apps/swarm/src/tasks/worker-follow-up.ts resume/remediation, the pool/claim path in apps/swarm/src/http/poll.ts + apps/swarm/src/be/db.ts, or any stall/liveness/reaper threshold)">

[runbooks/heartbeat-crash-recovery.md](./runbooks/heartbeat-crash-recovery.md) is the canonical flow reference — the heartbeat sweep, the stalled-task classifier, and the crash-recovery routing heuristic, with mermaid diagrams + pseudocode. It stores **only the current behavior (no history)**. Update it in the **same PR** whenever you change any of this logic so the diagrams/pseudocode stay true.

</important>

## Related

- [runbooks/](./runbooks/) — ci, release, local-development, testing, workflows, memory-system, secret-scrubbing, harness-providers, seed-scripts, heartbeat-crash-recovery
- [LOCAL_TESTING.md](./LOCAL_TESTING.md) — unit / E2E / entrypoint / MCP / UI testing recipes
- [BUSINESS_USE.md](./BUSINESS_USE.md) — flow diagrams and instrumentation
- [MCP.md](./MCP.md) — MCP tools reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) — production deployment
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup
- [docs-site/.../guides/](./docs-site/content/docs/(documentation)/guides/) — secrets encryption, harness providers, integrations

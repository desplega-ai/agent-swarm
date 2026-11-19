# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Bun + TypeScript, `bun:sqlite` (WAL), Biome, Ink CLI.

Setup: [CONTRIBUTING.md](./CONTRIBUTING.md). Server: `bun run start:http`.

## Architecture invariants

- The API server (`src/http.ts`, `src/server.ts`, `src/tools/`, `src/http/`) is the sole owner of the SQLite database. Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) NEVER imports `src/be/db` or `bun:sqlite`: it calls the API over HTTP with the swarm API key and the `X-Agent-ID` header. CI: `scripts/check-db-boundary.sh`.
- Read the swarm API key with `getApiKey()` from `src/utils/api-key.ts` (precedence `AGENT_SWARM_API_KEY` > `API_KEY`), NEVER from `process.env`. CI: `scripts/check-api-key-boundary.sh`.
- System prompt and task prompt text goes through the prompt-template registry in `src/prompts/`. To add a prompt section, add or update a registered template and resolve it from the call site, instead of concatenating strings in runners, hooks or providers.
- Use Bun, not Node, npm, pnpm or vite: `Bun.serve()` for HTTP/WebSocket, `bun:sqlite` for SQLite (API server only), `Bun.file()` for file I/O, `Bun.$` for shell. Bun loads `.env` by itself.

## Pull requests

Every PR, from anyone, fills [.github/pull_request_template.md](./.github/pull_request_template.md): keep its `**Why:**` and `**Risk:**` lines and its `##` headings. `gh pr create --body` and `--fill` skip the template, so write the body to a file, check it, then pass the file:

```bash
bun scripts/check-pr-body.ts --title "<conventional title>" --body-file /tmp/pr-body.md
gh pr create --title "<conventional title>" --body-file /tmp/pr-body.md
```

A red **PR Body** check blocks the merge. Editing the description re-runs it, with no push. Section rules: the "writing a pull request description" block below.

## This file

Budget: 24,000 bytes (`bun run check:agents-md-size`), because Codex silently cuts agent files after 32,768 bytes. Keep the rule and a pointer here, and put the detail in a runbook.

<important if="you need to run commands to build, test, lint, start the server, or generate code">

| Command | What it does |
|---|---|
| `bun install` | Install deps |
| `bun run start:http` | MCP HTTP server (port 3013). Test or QA boot: prefix `DESPLEGA_TELEMETRY_ENV=test` |
| `bun run dev:http` | Hot reload, portless: `https://api.swarm.localhost:1355` |
| `bun run lint:fix` | Lint and format with Biome |
| `bun run lint:slop` | Anti-slop Oxlint rules (`oxlint.config.ts`) |
| `bun run check:local` | Check loop on your change: frozen install, Biome, `bun check`, drift, affected tests, scoped E2E (`--skip-e2e` skips it) |
| `bun run tsc:check` | Type check with `bun check` (`tsc:check:tsc` runs tsc 5, the CI authority) |
| `bun run test:root` | Root unit tests (`bun run test:root -- src/tests/<file>.test.ts` for one) |
| `bun run e2e:ui` | Playwright UI suite: builds `apps/ui` (`-- --grep @smoke`, `-- --no-build`) |
| `bun run docker:build:worker` | Worker image (full) |
| `bun run docker:build:worker:slim` | Slim worker image (`--target worker-slim`, for CI/E2E) |
| `bun run docker:build:api` | API server image |
| `bun run docker:build:ui` | Dashboard image (`Dockerfile.ui`, nginx) |
| `bun run docs:openapi` | Regenerate `openapi.json` |
| `bun run docs:business-use` | Regenerate `BUSINESS_USE.md` (needs the BU backend) |
| `bun run build:pi-skills` | Regenerate `plugin/pi-skills/` from `plugin/commands/*.md` |
| `bun run build:seed-skill-files` | Regenerate the bundled-file manifest from `templates/skills/*/files/` |
| `docker compose -f docker-compose.local.yml up --build` | Local compose (API + lead + worker, which run in Docker). Run again after a code change |
| `uvx business-use-core@latest server dev` | BU backend on :13370 |

</important>

<important if="you are writing or modifying API-server code that reads or writes the database (src/be, src/http, src/tools, src/apps, src/workflows, src/heartbeat, src/scheduler)">

All runtime DB access goes through the async seam: `getDbClient()` from `src/be/db.ts`. Use `await client.query<Row>(sql, params)` / `get<Row>` / `run`, and `await client.transaction(async (tx) => ...)`. Raw sync access (`getDb()`, `.prepare(`, `bun:sqlite` imports) is for the boot-path files listed in `scripts/check-async-db-seam.sh` only (CI).

- Client calls inside a transaction callback join that transaction. Nested `transaction` calls become SAVEPOINTs.
- `transaction` opens with `BEGIN IMMEDIATE`. Pass `{ readOnly: true }` only for SELECT-only callbacks. Boot-path code that still uses raw `db.transaction(fn)` invokes it as `.immediate(...)`: a deferred BEGIN that reads before it writes fails with `SQLITE_BUSY_SNAPSHOT` when a second process shares the file.
- Post-commit hooks use `getDbClient().afterCommit(fn)`. A `queueMicrotask` or a bare `.then()` runs before COMMIT under async callbacks, so it can publish uncommitted state.
- A missing `await` on an async DB call compiles clean and fails silently. Run `bun scripts/check-floating-promises.ts` and `bun scripts/check-promise-sinks.ts` before pushing (CI runs both).

</important>

<important if="you are writing or running tests, drafting a plan with verification / E2E / QA steps, or preparing a frontend PR (apps/ui/, apps/templates-ui/)">

Hub: [runbooks/testing.md](./runbooks/testing.md) (hard rules, recipes, UI verification, memory tests, Slack E2E). Read [DESIGN.md](./DESIGN.md) before UI work.

- Prove an API or CLI change with an e2e scenario in `scripts/e2e/scenarios/` (`bun run e2e --only <name>` before push; authoring: [scripts/e2e/README.md](./scripts/e2e/README.md)). New unit tests are for the paths in `scripts/unit-test-allowlist.txt` only (worker runtime, tooling, rule corpora, migrations, dashboard): `bun run check:unit-test-allowlist` checks the diff. Editing or deleting an existing unit test is fine.
- Copy plan verification steps from LOCAL_TESTING.md as written (`Black-box E2E`, `UI E2E`).
- Give E2E and test agents a UUID agent ID (`AGENT_ID=$(uuidgen)`). A slug ID fails MCP output validation after the write already landed, so a retry double-writes.
- Take test ports from `src/tests/test-net.ts`: `listenOnFreePort(server)`, `getFreePort()` + `waitForServer()`, or `port: 0` for `Bun.serve`. CI runs `bun test --parallel=4`, so two files with one literal port collide. A timing-sensitive test opts in with `{ retry: 2 }` plus a comment.
- Frontend PR: capture each visible change with `agent-browser` (`qa-use` only when asked) for `## Before / after`. Rules: the PR description block.

</important>

<important if="you are preparing a commit, push, or pull request, or CI just failed and you need to know why">

Run `bun run check:local` before every push. Jobs, drift list, lockfile rules and "why CI fails": [runbooks/ci.md](./runbooks/ci.md). Before you open the PR, mirror the rest of `.github/workflows/merge-gate.yml` from the repo root:

```bash
bun run check:local
bun run lint           # read-only, not lint:fix
bun run lint:slop
bun run tsc:check:tsc  # tsc 5, the CI authority
bun run test:root -- --parallel=4
bun run e2e
bun run e2e:ui         # needs Node 22+
bun run check:bun-version
bash scripts/check-db-boundary.sh
bash scripts/check-test-spawn-sync.sh # tests use runChild()
bash scripts/check-audit-columns.sh   # new tables: created_by/updated_by, or .non-audit-tables
bun run check:dep-graph
```

- Generated files: when you change a generator input (`plugin/commands/`, `templates/skills/`, docs-site frontmatter, the script typecheck or SDK allowlist, the logs parser, an HTTP route, the `package.json` version, `templates/extensions/`), run the generator and commit its output. Edit the source, not the generated file. Table: [runbooks/ci.md § Drift checks by trigger file](./runbooks/ci.md#drift-checks-by-trigger-file).
- Touched `apps/ui/`, or root `bun.lock` / `package.json` / `bunfig.toml`: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b` (CI uses `tsc -b`).
- Touched `Dockerfile`, `Dockerfile.worker`, `apps/evals/Dockerfile` or a file they COPY: `docker build -f <Dockerfile> .` (CI builds all three). For `Dockerfile.ui` or `apps/ui/nginx.conf`: `bun run docker:build:ui && bash scripts/smoke-ui-image.sh agent-swarm-ui:latest`.
- The pre-push hook runs only the nearest affected tests. CI is the authority: fix a CI-only failure on the PR and push again. Keep the hooks on. Set `PRE_PUSH_FULL=1` to reproduce a CI failure locally, or when you touch shared test infrastructure.
- `CHANGELOG.md` changes only in release PRs (`release: vX.Y.Z`). On a `CHANGELOG.md` conflict in any other PR, restore the merge-base version.

</important>

<important if="you are writing a pull request description or filing a GitHub issue on this repo">

The description carries the intent a reviewer checks the diff against. Write for a human who reads it in 60 seconds: short direct sentences, about 250 prose words (code blocks, mermaid, tables and `<details>` are free). Show the change, do not narrate it. The template comment gives the rule of each section.

- Conditional sections: a `fix:` title adds Repro, a desplega-bot body adds Swarm provenance, and a diff that touches the dashboard apps, `src/slack/` or `src/integrations/chat-sdk/` adds Before / after.
- **Why**: one sentence, paraphrased from the ask as it was given, not rewritten to match what you built. Link public sources only (Fixes #N, a public PR or issue). Customer names and private-chat quotes stay out.
- **Before / after** shows the surface the reviewer must verify: dashboard screenshots, Slack mock frames, or the line `No visual change: <reason>`.
- **Swarm provenance**: links to the swarm task and its tree, the Slack permalink of the ask, any workflow run, and the plan or research (agent-fs live app link). These auth-gated links belong in this section and nowhere else. Slack ids, ts values and private-chat quotes are blocked everywhere (`src/utils/pr-body-leaks.ts`).
- **Urgency**: copy it from the request. With none given, check "nice to have". "asap" requests a review from tarasyarema, "this week" from desplega-bot.
- **Media**: GitHub user attachments (`github-attach` skill), or `agent-fs signed-url --inline` for images only.

Issues use a form from `.github/ISSUE_TEMPLATE/` (bug, feature request, question). `gh issue create` skips forms: write each field label as a `### <label>` heading, fill the required fields, and apply the form's label.

</important>

<important if="you are changing what users see in Slack: message text, blocks, cards, reactions, footers or buttons (src/slack/*, the Slack path of src/integrations/chat-sdk/*, or a prompt template that shapes Slack replies)">

Ship the proof with the change:

- Add or extend a `scripts/e2e/scenarios/slack-*.ts` scenario that asserts the rendered text and blocks.
- Give it a visuals group (`groups: ["visuals-v2"]`, `"visuals-legacy"`, or both) and call `ctx.markThread(label, channel, ts)` for each thread a reviewer must see (one per flag state). The **Slack Visuals** PR comment renders only those. Chat SDK Slack runs on a second mock: mark through `flip.ctx.markThread`.
- Put before and after frames in `## Before / after`: run the scenario on `main` and on the branch with `--visuals <dir>`, then `bun run e2e:visuals <dir>`. Details: [LOCAL_TESTING.md § Black-box E2E](./LOCAL_TESTING.md#black-box-e2e-bun-run-e2e).

</important>

<important if="you are adding or modifying HTTP API endpoints or REST routes">

Use the `route()` factory from `src/http/route-def.ts` (it registers the route in OpenAPI), not raw `matchRoute`.

- Every non-GET route declares its RBAC posture on the def: `rbac: { permission: "<verb>" }` (the handler gates through `can()`) or `rbac: { ungated: "<reason>" }`. CI: `bun run check:rbac-coverage`. New verbs register in `src/rbac/permissions.ts` and `src/rbac/legacy-policy.ts`.
- Every 2xx response (except bodiless 204/205) declares `schema: <zod>`, sent through the typed `<route>.respond(res, 200, data)` and not `json()`, or `unstructured: "<reason>"` for non-JSON bodies (SSE, binary, redirects, proxied payloads). CI: `bun run check:openapi-response-coverage`. Reuse the entity schemas from `src/types.ts`.
- A new handler file also needs its import in `src/http/all-routes.ts`. Then run `bun run docs:openapi` and commit `openapi.json`.

</important>

<important if="you are adding or modifying MCP tools in src/tools/">

Full contract, the per-harness matrix and the validation gate: [runbooks/mcp-tool-results.md](./runbooks/mcp-tool-results.md).

- Return a `SwarmToolResult`: `toolOk(message, extras?)` / `toolErr(message, extras?)` from `src/tools/utils.ts`. Only the registrar (`createToolRegistrar`) builds `content`, `structuredContent` and `isError`.
- `message` states the outcome. `details` carries what the model needs to act on.
- Declare `outputSchema` with `swarmToolOutputSchema(dataShape?)`: loose, every data field optional, no format pins (`.uuid()`, `.email()`) on output fields. A strict output schema rejects an honest response after the side effect landed. Input schemas may stay strict.
- One-sentence conditional steers go in the `NUDGES` map in `src/tools/utils.ts`.
- Leave `details` whole and on both channels: the registrar spills overflow to `mcp:overflow:<agentId>` KV and puts the same pointer on both. `kv-get` is spill-exempt.
- Expose the tool to scripts in `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`), or add it to `EXCLUDED_TOOLS` in `scripts/check-sdk-tool-registration.ts` with a reason (CI).

</important>

<important if="you are adding or changing an HTTP route, an MCP tool, a workflow executor or a CLI command, or the merge-gate job 'E2E Contract' failed on coverage">

`bun run e2e --strict` (CI) fails when a route operation, MCP tool, workflow node type or CLI command (the list `agent-swarm help` prints) has no black-box scenario and no reasoned exclusion in `scripts/e2e/coverage-manifest.json`. Ship the scenario in `scripts/e2e/scenarios/` in the same PR. Authoring: [scripts/e2e/README.md](./scripts/e2e/README.md). Failure triage: [runbooks/e2e-blackbox.md](./runbooks/e2e-blackbox.md).

</important>

<important if="you are adding or modifying database schema or migrations">

File-based, forward-only SQL in `src/be/migrations/NNN_descriptive_name.sql`, applied on startup. NEVER modify an applied migration: create a new one. There are no `down` migrations.

- Test against a fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) and an existing one. Keep `AgentTaskSourceSchema` in `src/types.ts` in sync with the SQL CHECK constraints.
- Before you add one, check its ordinal against `main`'s tail and every open PR that adds a migration. `scripts/check-migration-conflicts.sh` (CI) requires a unique ordinal that sorts above the base branch's tail. The runner silently skips a duplicate ordinal.

</important>

<important if="you are writing code that logs, prints, stores, or transports sensitive values (secrets, tokens, OAuth creds, API keys, DB URLs, webhook payloads)">

Any path that emits to logs, stdout/stderr, the `session_logs` table, or `/workspace/logs/*.jsonl` MUST go through `scrubSecrets` from `src/utils/secret-scrubber.ts` at the egress point. That covers raw env values, credential-pool entries, OAuth payloads, webhook bodies, and tool output that may embed tokens. Cache refresh, coverage rules, and how to add a secret shape: [runbooks/secret-scrubbing.md](./runbooks/secret-scrubbing.md).

</important>

<important if="you are adding or modifying CLI commands or CLI help text">

CLI help lives in `src/cli.tsx` as plain `console.log`, not Ink. Update `COMMAND_HELP`, add the command to the `commands` array in `printHelp()`, then route it in the `App` switch (UI commands) or before `render()` (non-UI). Verify with `bun run src/cli.tsx help` and `bun run src/cli.tsx <command> --help`. Then add a CLI scenario (`runCli` in `scripts/e2e/cli.ts`) that checks exit code, output and written files, or a reasoned `cliCommands` exclusion in `scripts/e2e/coverage-manifest.json`.

</important>

<important if="you are adding a new operator-facing env var (feature flag, threshold, default), or modifying the dashboard /settings/configuration page">

The dashboard **Settings → Configuration** page reads the catalog in `apps/ui/src/lib/configuration-catalog.ts`.

- Register the var there: a group, a `kind` (`boolean` / `enum` / `number` / `string`), `defaultValue`, a description, a `docsUrl` when a docs page covers it, and `restartRequired: true` when the server reads it only at startup.
- Values persist as global-scope `swarm_config` rows (PUT `/api/config`) and win over the deployment env. Constrained values get a validator in `VALIDATED_KEYS` in `src/be/swarm-config-guard.ts`.
- NEVER add secrets, credentials or reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) to the catalog: they belong on the Secrets and Integrations pages.
- Update [docs-site/.../ui/configuration.mdx](./docs-site/content/docs/(documentation)/ui/configuration.mdx) in the same PR.

</important>

<important if="you are bumping the version in package.json">

Run `bun run prepare-release` (`sync-chart-version` + `docs:openapi`) and commit every regenerated file with the bump: `openapi.json`, `docs-site/content/docs/api-reference/**` and `charts/agent-swarm/Chart.yaml` embed the version, and CI fails on a mismatch. Merging the bump to `main` publishes Docker, npm, E2B and the GitHub release. Flow: [runbooks/release.md](./runbooks/release.md).

</important>

<important if="you are searching the codebase for code by intent, a symbol/identifier, or how something works">

Find code by intent or symbol with `semble search "<query>" [path] [--top-k N]`, and similar code with `semble find-related <file_path> <line> [path]`. Prefer the `semble` MCP tools when the server is enabled. Without `semble` on `$PATH`, use `uvx --from "semble[mcp]" semble`. The `semble-search` subagent keeps search output out of the main context. Use grep for exhaustive literal matches.

</important>

<important if="you are adding business-use instrumentation or events">

Flow diagrams: [BUSINESS_USE.md](./BUSINESS_USE.md). Flows: `task` (runId = taskId), `agent` (runId = agentId), `api` (runId = per-boot ID).

- Use `ensure()`, after successful state mutations and outside transactions when possible.
- Validators are serialized: reference only the `data` and `ctx` params, never closure variables.
- Worker-side events use `depIds` that point at server-side events in the same flow. The SDK no-ops without `BUSINESS_USE_API_KEY`.

</important>

<important if="you are changing model selection, extensions, workflows, the scripts runtime, agent skills, Docker images, memory, harness providers, cost tracking, heartbeat or task routing, runtime providers or eval scenarios, sending a task to the swarm, testing Slack by hand, or setting up local development">

Read the runbook first. The last column is the rule that causes damage when missed.

| Area | Read first | Do not miss |
|---|---|---|
| Model selection (task, schedule, workflow) | `runbooks/model-tiers.md` | Use the portable `modelTier` (`smol` / `regular` / `smart` / `ultra`); `model` is for provider-specific overrides. Default Gemini model in examples: `google/gemini-3-flash-preview` (OpenRouter). |
| Extensions (`src/extensions/*`, `src/be/extensions/*`), a pre/post event | `runbooks/extensions.md` | Dispatch pre hooks only at entry points outside transactions. A new event needs a contract in `src/extensions/contract.ts` and `bun run build:extension-types`. Run `bun run test:root -- src/tests/extensions-*.test.ts`. |
| Workflows, `triggerSchema` | `runbooks/workflows.md` | A node sees upstream outputs only through an `inputs` mapping. `triggerSchema` supports `type` / `required` / `properties` / `enum` / `const` / `items`, and ignores other keywords silently. |
| Scripts runtime (`src/scripts-runtime/*`, `src/be/scripts/*`, `src/tools/script-*.ts`, `src/http/scripts.ts`) | `runbooks/scripts-runtime.md` | Config reaches the subprocess as JSON on stdin, never as env vars. API-side callers use `runScriptWithRunCredential`. Keep the `ctx.fs` limits. New coverage goes in `scripts/e2e/scenarios/script-*.ts`. |
| Agent skills (`skills/`, `templates/skills/`, `src/be/seed-skills/`) | `runbooks/skills.md` | A skill name is seeded or baked, never both: the DB copy wins and prunes the baked files. Prefer `templates/skills/`. After an edit: `bun run build:skill-md && bun run build:seed-skill-files`, then `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`. |
| `Dockerfile`, `Dockerfile.worker`, `/opt/global-deps` | `runbooks/docker-images.md` | Keep the two leaf COPY blocks identical and `worker-full` last. `chown` in the install's RUN (a separate layer duplicates a multi-GB HOME). Under `USER root` set `HOME=/root`. The gate builds only `worker-slim`: build `worker-full` locally when you touch full-only stages. |
| Memory (`src/be/memory/`, `src/be/embedding.ts`, `src/tools/memory-*.ts`, `src/http/memory.ts`) | `runbooks/memory-system.md` | Run all four memory test files after any change. |
| Harness providers (`src/providers/*`, runner dispatch) | `runbooks/harness-providers.md` | Update the docs in the same PR. A new provider follows the checklist. |
| Cost and context tracking (`src/providers/*-adapter.ts`, `src/utils/context-window.ts`, `src/be/seed-pricing.ts`, `src/http/session-data.ts`) | [cost-and-context-computation.mdx](./docs-site/content/docs/(documentation)/guides/cost-and-context-computation.mdx) | When the contract changes, update that guide and `src/providers/pricing-sources.md` in the same PR. Refresh pricing with `bun run scripts/refresh-modelsdev-pricing.ts` and commit the snapshot. |
| Heartbeat, crash recovery, task routing (`src/heartbeat/*`, `src/tasks/worker-follow-up.ts`, the claim path in `src/http/poll.ts`) | `runbooks/heartbeat-crash-recovery.md` | Update the runbook in the same PR. It holds only the current behavior. |
| Runtime providers and pools | `runbooks/runtime-providers.md` | Adapter contract, owner isolation, same-PR documentation. |
| Eval scenarios, rubrics, fixtures (`apps/evals/scenarios/*`) | `apps/evals/SCENARIO-AUTHORING.md` | Deterministic checks first: a judge is the last resort. A correct run must not trip a negative check. The deployed swarm proposes evals and does not run E2B itself. |
| Sending a task to the swarm, manual Slack testing | `runbooks/testing.md` | Local dev swarm: Slack `#swarm-dev-2`, bot `@dev-swarm`. Production: `mcp__agent-swarm-user__send-task` (check that the session has the tool), not the dev Slack channel. |
| Local setup, env vars, running the server | `runbooks/local-development.md` | `Authorization: Bearer ${AGENT_SWARM_API_KEY}` (default `123123`), `MCP_BASE_URL` (default `http://localhost:3013`), `HARNESS_PROVIDER` picks the harness. `SLACK_DISABLE` / `GITHUB_DISABLE` / `JIRA_DISABLE` / `LINEAR_DISABLE=true` turn an integration off. |

</important>

## Related

[runbooks/](./runbooks/) (also `db-retention`, `k8s-test-cluster`, `seed-scripts`) · [LOCAL_TESTING.md](./LOCAL_TESTING.md) · [MCP.md](./MCP.md) · [DEPLOYMENT.md](./DEPLOYMENT.md) · [docs-site guides](./docs-site/content/docs/(documentation)/guides/)

# Agent Swarm

Multi-agent orchestration for Claude Code, Codex, Gemini CLI. Bun + TypeScript, `bun:sqlite` (WAL), Biome, Ink CLI.

Setup: [CONTRIBUTING.md](./CONTRIBUTING.md). Server: `bun run start:http`.

## Architecture invariants

- The API server (`src/http.ts`, `src/server.ts`, `src/tools/`, `src/http/`) is the sole owner of the SQLite database. Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) NEVER imports `src/be/db` or `bun:sqlite`: it calls the API over HTTP with the swarm API key and the `X-Agent-ID` header. CI: `scripts/check-db-boundary.sh`.
- Read the swarm API key with `getApiKey()` from `src/utils/api-key.ts` (precedence `AGENT_SWARM_API_KEY` > `API_KEY`), NEVER from `process.env`. CI: `scripts/check-api-key-boundary.sh`.
- System prompt and task prompt text goes through the prompt-template registry in `src/prompts/`. To add a prompt section, add or update a registered template and resolve it from the call site, instead of concatenating strings in runners, hooks or providers.
- Use Bun, not Node, npm, pnpm or vite: `Bun.serve()` for HTTP/WebSocket, `bun:sqlite` for SQLite (API server only), `Bun.file()` for file I/O, `Bun.$` for shell. Bun loads `.env` by itself.

## Pull requests

Every PR, from anyone, fills [.github/pull_request_template.md](./.github/pull_request_template.md): keep its `**Why:**`, `**Risk:**` and `**Urgency:**` lines and its `##` headings. `gh pr create --body` and `--fill` skip the template, so write the body to a file, check it, then pass the file:

```bash
bun scripts/check-pr-body.ts --title "<conventional title>" --body-file /tmp/pr-body.md
gh pr create --title "<conventional title>" --body-file /tmp/pr-body.md
```

A red **PR Body** check blocks the merge. Editing the description re-runs it, with no push. Section rules: the "writing a pull request description" block below.

## This file

Budget: 24,000 bytes (`bun run check:agents-md-size`). Codex loads 32,768 bytes of agent files and cuts the rest with only a startup warning. Keep the rule and a pointer here, and put the detail in a runbook.

Before any work under `apps/ui/`, read [apps/ui/CLAUDE.md](./apps/ui/CLAUDE.md) and the area docs it names. A session that starts at the repo root does not load that file.

<important if="you need to run commands to build, test, lint, start the server, or generate code">

Everyday commands. Every other script (Docker images, generators, the Playwright suite, the BU backend): [runbooks/commands.md](./runbooks/commands.md).

| Command | What it does |
|---|---|
| `bun install` | Install deps |
| `bun run start:http` | MCP HTTP server (port 3013). Test or QA boot: prefix `DESPLEGA_TELEMETRY_ENV=test` |
| `bun run dev:http` | Hot reload, portless: `https://api.swarm.localhost:1355` |
| `bun run lint:fix` | Lint and format with Biome |
| `bun run check:local` | Check loop on your change: frozen install, Biome, `bun check`, drift, affected tests, scoped E2E (`--skip-e2e` skips it) |
| `bun run tsc:check` | Type check with `bun check` (`tsc:check:tsc` runs tsc 5, the CI authority) |
| `bun run test:root` | Root unit tests (`bun run test:root -- src/tests/<file>.test.ts` for one) |
| `docker compose -f docker-compose.local.yml up --build` | Local compose (API + lead + worker, which run in Docker). Run again after a code change |

</important>

<important if="you are writing or modifying API-server code that reads or writes the database (src/be, src/http, src/tools, src/apps, src/workflows, src/heartbeat, src/scheduler)">

All runtime DB access goes through the async seam: `getDbClient()` from `src/be/db.ts`. Use `await client.query<Row>(sql, params)` / `get<Row>` / `run`, and `await client.transaction(async (tx) => ...)`. Raw sync access (`getDb()`, `.prepare(`, `bun:sqlite`) is only for the boot-path files in `scripts/check-async-db-seam.sh` (CI).

- Client calls inside a transaction callback join it. Nested `transaction` calls become SAVEPOINTs.
- `transaction` opens with `BEGIN IMMEDIATE`. Pass `{ readOnly: true }` only for SELECT-only callbacks. Boot-path code that still uses raw `db.transaction(fn)` invokes it as `.immediate(...)`: a deferred BEGIN that reads before it writes fails with `SQLITE_BUSY_SNAPSHOT` when a second process shares the file.
- Post-commit hooks use `getDbClient().afterCommit(fn)`. A `queueMicrotask` or a bare `.then()` runs before COMMIT and can publish uncommitted state.
- A missing `await` on an async DB call compiles clean and fails silently. Run `bun scripts/check-floating-promises.ts` and `bun scripts/check-promise-sinks.ts` before pushing (CI runs both).

</important>

<important if="you are writing or running tests, drafting a plan with verification / E2E / QA steps, or preparing a frontend PR (apps/ui/, apps/templates-ui/)">

Hub: [runbooks/testing.md](./runbooks/testing.md) (hard rules, recipes, UI verification, memory tests, Slack E2E). Read [DESIGN.md](./DESIGN.md) before UI work.

- Prove an API or CLI change with an e2e scenario in `scripts/e2e/scenarios/` (`bun run e2e --only <name>` before push; authoring: [scripts/e2e/README.md](./scripts/e2e/README.md)). New unit tests are for the paths in `scripts/unit-test-allowlist.txt` only (worker runtime, tooling, rule corpora, migrations, dashboard): `bun run check:unit-test-allowlist` checks the diff. Editing or deleting an existing unit test is fine.
- Copy plan verification steps from LOCAL_TESTING.md as written (`Black-box E2E`, `UI E2E`).
- Give E2E and test agents a UUID agent ID (`AGENT_ID=$(uuidgen)`). A slug ID fails MCP output validation after the write already landed, so a retry double-writes.
- Take test ports from `src/tests/test-net.ts`: `listenOnFreePort(server)`, `getFreePort()` + `waitForServer()`, or `port: 0` for `Bun.serve`. CI runs `bun test --parallel=4`, so two files with one literal port collide. There is no global test retry: a timing-sensitive test opts in with `{ retry: 2 }` plus a comment.
- Frontend PR: capture each visible change with `agent-browser` (`qa-use` only when asked) for `## Before / after`, and record a new or changed interaction or flow. Rules: the PR description block.

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
bash scripts/check-test-spawn-sync.sh
bash scripts/check-audit-columns.sh
bun run check:dep-graph
```

- Trigger files: when you change a generator input, `apps/ui/` or a root lockfile, or a Dockerfile or a file it copies, run the matching generator, UI check or image build and commit regenerated output. Edit the source, not the generated file. Table: [runbooks/ci.md § Drift checks by trigger file](./runbooks/ci.md#drift-checks-by-trigger-file).
- The pre-push hook runs only the nearest affected tests. CI is the authority: fix a CI-only failure on the PR and push again. Keep the hooks on. Set `PRE_PUSH_FULL=1` to reproduce a CI failure locally, or when you touch shared test infrastructure.
- `CHANGELOG.md` changes only in release PRs (`release: vX.Y.Z`). On a `CHANGELOG.md` conflict in any other PR, restore the merge-base version.

</important>

<important if="you are writing a pull request description or filing a GitHub issue on this repo">

The description carries the intent a reviewer checks the diff against. Write for a human who reads it in 60 seconds, in about 150 prose words. Show the change, do not narrate it. The check fails on a missing part, warns above a length target, and fails far above it (Why: 40 words, prose: 300). The template comment gives the rule of each section. What it cannot tell you:

- **Why**: say who sees what after the merge. Paraphrase the ask as it was given, not rewritten to match what you built. Link public sources only (Fixes #N). Customer names and private-chat quotes stay out.
- **Urgency**: copy it from the request. With none given, write "nice to have".
- **Before / after**: show what a user, an agent or an operator sees change, not the code that makes it. `No visible change: <reason>` is for a change that nobody can see (a refactor, a test fix, an internal hardening).
- **Swarm provenance** (required for desplega-bot): always link the task, as `[label](url)`. Auth-gated links (task, session, workflow run, agent-fs, Slack permalink) belong in this section and nowhere else. Slack ids, ts values and private-chat quotes are blocked everywhere (`src/utils/pr-body-leaks.ts`).

Issues use a form from `.github/ISSUE_TEMPLATE/` (bug, feature request, question). `gh issue create` skips forms: write each field label as a `### <label>` heading, fill the required fields, and apply the form's label.

</important>

<important if="you are changing what users see in Slack: message text, blocks, cards, reactions, footers or buttons (src/slack/*, the Slack path of src/integrations/chat-sdk/*, or a prompt template that shapes Slack replies)">

Ship the proof with the change: a `scripts/e2e/scenarios/slack-*.ts` scenario that asserts the rendered text and blocks, in a visuals group (`groups: ["visuals-v2"]`), with `ctx.markThread(label, channel, ts)` on each thread a reviewer must see (one per flag state, `flip.ctx.markThread` on the Chat SDK mock). The **Slack Visuals** PR comment renders only marked threads. Put the frame pair in `## Before / after`. Groups, labels, the before frame of a new scenario and the render commands: [LOCAL_TESTING.md § Black-box E2E](./LOCAL_TESTING.md#black-box-e2e-bun-run-e2e).

</important>

<important if="you are adding or modifying HTTP API endpoints or REST routes">

Use the `route()` factory from `src/http/route-def.ts` (it registers the route in OpenAPI), not raw `matchRoute`.

- Every non-GET route declares its RBAC posture on the def: `rbac: { permission: "<verb>" }` (the handler gates through `can()`) or `rbac: { ungated: "<reason>" }`. CI: `bun run check:rbac-coverage`. New verbs register in `src/rbac/permissions.ts` and `src/rbac/legacy-policy.ts`.
- Every 2xx response (except bodiless 204/205) declares `schema: <zod>`, sent through the typed `<route>.respond(res, 200, data)` and not `json()`, or `unstructured: "<reason>"` for non-JSON bodies (SSE, binary, redirects). CI: `bun run check:openapi-response-coverage`. Reuse the schemas in `src/types.ts`.
- A new handler file also needs its import in `src/http/all-routes.ts`. Then run `bun run docs:openapi` and commit `openapi.json`.

</important>

<important if="you are adding or modifying MCP tools in src/tools/">

Full contract, the per-harness matrix and the validation gate: [runbooks/mcp-tool-results.md](./runbooks/mcp-tool-results.md).

- Return a `SwarmToolResult`: `toolOk(message, extras?)` / `toolErr(message, extras?)` from `src/tools/utils.ts`. Only the registrar (`createToolRegistrar`) builds `content`, `structuredContent` and `isError`.
- `message` states the outcome. `details` carries what the model needs to act on.
- Declare `outputSchema` with `swarmToolOutputSchema(dataShape?)`: loose, every data field optional, no format pins (`.uuid()`, `.email()`) on output fields. A strict output schema rejects an honest response after the side effect landed. Input schemas may stay strict.
- One-sentence conditional steers go in the `NUDGES` map in `src/tools/utils.ts`.
- Leave `details` whole and on both channels. For an agent-facing call the registrar spills overflow to `mcp:overflow:<agentId>` KV and puts the same pointer on both. A call through `ctx.swarm.*` is script-internal and skips that ceiling (it has a 64 MiB guard). `kv-get` is spill-exempt. Steer big-value processing to scripts with a nudge, not to server-side chunking.
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

The dashboard **Settings → Configuration** page reads the catalog in `apps/ui/src/lib/configuration-catalog.ts`. Register the var there (group, `kind`, `defaultValue`, description, `docsUrl`, and `restartRequired: true` when the server reads it only at startup). Values persist as global-scope `swarm_config` rows and win over the deployment env. A constrained value gets a validator in `VALIDATED_KEYS` (`src/be/swarm-config-guard.ts`). NEVER add secrets, credentials or reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) to the catalog: they belong on the Secrets and Integrations pages. Update [docs-site/.../ui/configuration.mdx](./docs-site/content/docs/(documentation)/ui/configuration.mdx) in the same PR.

</important>

<important if="you are bumping the version in package.json">

Run `bun run prepare-release` (`sync-chart-version` + `docs:openapi`) and commit every regenerated file with the bump: `openapi.json`, `docs-site/content/docs/api-reference/**` and `charts/agent-swarm/Chart.yaml` embed the version, and CI fails on a mismatch. Merging the bump to `main` publishes Docker, npm, E2B and the GitHub release. Flow: [runbooks/release.md](./runbooks/release.md).

</important>

<important if="you are searching the codebase for code by intent, a symbol/identifier, or how something works">

Find code by intent or symbol with `semble search "<query>" [path]`, and similar code with `semble find-related <file_path> <line>`. Prefer the `semble` MCP tools or the `semble-search` subagent when they exist. Without `semble` on `$PATH`: `uvx --from "semble[mcp]" semble`. Use grep for exhaustive literal matches.

</important>

<important if="you are adding business-use instrumentation or events">

Flow diagrams: [BUSINESS_USE.md](./BUSINESS_USE.md). Flows: `task` (runId = taskId), `agent` (runId = agentId), `api` (runId = per-boot ID).

- Use `ensure()`, after successful state mutations and outside transactions when possible.
- Validators are serialized: reference only the `data` and `ctx` params, never closure variables.
- Worker-side events use `depIds` that point at server-side events in the same flow. The SDK no-ops without `BUSINESS_USE_API_KEY`.

</important>

<important if="you are changing model selection, extensions, workflows, the scripts runtime, agent skills, Docker images, memory, harness providers, cost tracking, heartbeat or task routing, runtime providers or eval scenarios, referencing a Gemini model, sending a task to the swarm, testing Slack by hand, or setting up local development">

Read the runbook first. The last column is the rule that causes damage when missed.

| Area | Read first | Do not miss |
|---|---|---|
| Model selection (task, schedule, workflow), a Gemini model in tests, workflows or examples | `runbooks/model-tiers.md` | Use the portable `modelTier` (`smol` / `regular` / `smart` / `ultra`); `model` is for provider-specific overrides. Default Gemini model: `google/gemini-3-flash-preview` (OpenRouter). |
| Extensions (`src/extensions/*`, `src/be/extensions/*`), a pre/post event | `runbooks/extensions.md` | A new event needs a contract in `src/extensions/contract.ts`, `bun run build:extension-types`, one `dispatchPre` or `dispatchPost` call at an entry point outside transactions, a fixture in `src/tests/fixtures/extensions/` and an operator guide row. Extension SDK calls use `callOrigin: "extension"`, which stops hook recursion. Run `bun run test:root -- src/tests/extensions-*.test.ts`. |
| Workflows, `triggerSchema` | `runbooks/workflows.md` | A node sees upstream outputs only through an `inputs` mapping. The scripts catalog runs through `swarm-script` nodes, not the inline `script` runner. `triggerSchema` supports `type` / `required` / `properties` / `enum` / `const` / `items` and ignores other keywords silently. |
| Scripts runtime (`src/scripts-runtime/*`, `src/be/scripts/*`, `src/tools/script-*.ts`, `src/http/scripts.ts`) | `runbooks/scripts-runtime.md` | Config reaches the subprocess as JSON on stdin, never as env vars. `/afs` mounts only with the invoking agent's own agent-scoped key. Preserve the sandbox limits, descendant cleanup (`bun --no-orphans`) and the host-side `ctx.fs` limits. API-side callers use `runScriptWithRunCredential`. New coverage goes in `scripts/e2e/scenarios/script-*.ts`. |
| Agent skills (`skills/`, `templates/skills/`, `src/be/seed-skills/`) | `runbooks/skills.md` | An agent skill is seeded (`templates/skills/`, preferred) or baked, never both under one name: the DB copy wins and prunes the baked files. A new seeded skill needs static imports in `BUILT_IN_SKILL_SOURCES` (`src/be/seed-skills/index.ts`). A public operator skill lives in `skills/<name>/SKILL.md` and is never seeded or baked (`bun run check:operator-skill`). After an edit: `bun run build:skill-md && bun run build:seed-skill-files`, then `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`. |
| `Dockerfile`, `Dockerfile.worker`, `/opt/global-deps` | `runbooks/docker-images.md` | Keep the two leaf COPY blocks identical and `worker-full` last. Heavy tools go in `worker-full-base`, with a `command -v` guard in `docker-entrypoint.sh`. Skills install through pinned `npx skills`, with their asserts. `chown` in the install's RUN (a separate layer duplicates a multi-GB HOME). Under `USER root` set `HOME=/root`. An npm override goes in the global install root (`/opt/global-deps*/package.json`). The gate builds only `worker-slim`: build `worker-full` locally when you touch full-only stages. |
| Memory (`src/be/memory/`, `src/be/embedding.ts`, `src/tools/memory-*.ts`, `src/http/memory.ts`, the memory parts of `src/tools/store-progress.ts`) | `runbooks/memory-system.md` | Run all four memory test files after any change. |
| Harness providers (`src/providers/*`, runner dispatch, `src/prompts/*`, `docker-entrypoint.sh` provider branches) | `runbooks/harness-providers.md` | Update the docs in the same PR. A new provider follows the checklist. |
| Cost and context tracking (`src/providers/*-adapter.ts`, `src/utils/context-window.ts`, `src/be/seed-pricing.ts`, `src/http/session-data.ts`, `src/http/context.ts`, pricing or context columns in migrations) | [cost-and-context-computation.mdx](./docs-site/content/docs/(documentation)/guides/cost-and-context-computation.mdx) | Context used is `input + cache_read + cache_create + output`. The API recomputes USD from the `pricing` table and tags `costSource`. When the contract changes, update that guide and `src/providers/pricing-sources.md` in the same PR. Refresh pricing with `bun run scripts/refresh-modelsdev-pricing.ts` and commit the snapshot. |
| Heartbeat, crash recovery, task routing (`src/heartbeat/*`, `src/tasks/worker-follow-up.ts`, the claim path in `src/http/poll.ts` and `src/be/db.ts`, any stall, liveness or reaper threshold) | `runbooks/heartbeat-crash-recovery.md` | Update the runbook in the same PR. It holds only the current behavior. |
| Runtime providers and pools (`src/runtime-providers/*`, `src/be/runtime-pools/*`) | `runbooks/runtime-providers.md` | Preserve owner isolation and the adapter contract. Update the runbook in the same PR. |
| Eval scenarios, rubrics, fixtures (`apps/evals/scenarios/*`) | `apps/evals/SCENARIO-AUTHORING.md` | Deterministic checks first: a judge is the last resort. A correct run must not trip a negative check. Grade artifacts the model controls, not system emissions. Pilot one dimension on two tiers before you build an axis. The deployed swarm proposes evals and does not run E2B itself. |
| Sending a task to the swarm, manual Slack testing | `runbooks/testing.md` | Local dev swarm: Slack `#swarm-dev-2`, bot `@dev-swarm`. Production: `mcp__agent-swarm-user__send-task` (check that the session has the tool), not the dev Slack channel. |
| Local setup, env vars, running the server | `runbooks/local-development.md` | `Authorization: Bearer ${AGENT_SWARM_API_KEY}` (default `123123`), `MCP_BASE_URL` (default `http://localhost:3013`), `HARNESS_PROVIDER` picks the harness. `SLACK_DISABLE` / `GITHUB_DISABLE` / `JIRA_DISABLE` / `LINEAR_DISABLE=true` turn an integration off. |

</important>

## Related

[runbooks/](./runbooks/) (also `db-retention`, `k8s-test-cluster`, `seed-scripts`) · [LOCAL_TESTING.md](./LOCAL_TESTING.md) · [MCP.md](./MCP.md) · [DEPLOYMENT.md](./DEPLOYMENT.md) · [docs-site guides](./docs-site/content/docs/(documentation)/guides/)

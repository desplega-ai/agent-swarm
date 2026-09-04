---
date: 2026-09-04
author: taras
topic: "UI E2E P1: Playwright suite in packages/ui-e2e against a fresh seeded API"
tags: [plan, e2e, ui, playwright, ci]
status: ready
autonomy: critical
commit_per_phase: true
brainstorm: thoughts/taras/brainstorms/2026-09-04-ui-e2e-swarm-driven-testing.md
---

# UI E2E P1: Playwright suite in `packages/ui-e2e` Implementation Plan

## Overview

Add a deterministic Playwright suite for `apps/ui` that boots a fresh, seeded API per Playwright worker, runs a route smoke plus three core flows, and reports informationally on PRs and main. This is phase 1 of the UI E2E brainstorm. It is the shared core that the tracker (P2), the swarm exploratory runner (P3), and `pw.ai` (P4, `DES-782`) build on.

- **Motivation**: there is no browser-driven UI test today. Frontend PRs rely on a reviewer convention (agent-browser screenshots). The black-box `bun run e2e` suite never starts the UI.
- **Related**: `thoughts/taras/brainstorms/2026-09-04-ui-e2e-swarm-driven-testing.md` (decisions, resolved facts, environments), `scripts/e2e/` (SUT boot, contract suite), `.github/workflows/slack-visuals.yml` (informational workflow + sticky comment pattern), `thoughts/taras/plans/2026-09-04-slack-visual-e2e.md`.

## Current State Analysis

**Workspace and tooling**

- `packages/` does not exist. Root `package.json:35-39` already declares `workspaces: ["apps/ui", "apps/templates-ui", "apps/evals", "packages/*"]`, so `packages/ui-e2e` becomes the first live member. `bunfig.toml` uses the hoisted linker; one root `bun.lock`.
- Root `tsconfig.json:30-42` excludes `apps`, `scripts`, `src/tests`, and others but **not** `packages`. `bun run tsc:check` is plain `bun tsc --noEmit`, so package files would be swept into the root typecheck unless `packages` is excluded there and the package gets its own tsconfig + script.
- Root `lint` is `biome check src apps/evals` (`package.json:150`); `packages/` is not linted today. `check:dep-graph` scans `src` and `plugin/opencode-plugins` only.
- Boundary scripts: `scripts/check-e2e-boundary.sh` only inspects `scripts/e2e/` (blocks imports reaching `src|apps|packages` and `bun:sqlite` outside `db.ts`). `check-db-boundary.sh`, `check-async-db-seam.sh`, `check-api-key-boundary.sh` scan `src/` (+ listed worker paths) only. A `bun:sqlite` import under `packages/ui-e2e/boot/` is not flagged by any of them. A boot file importing `scripts/e2e/sut.ts` needs three `../` (`../../../scripts/e2e/sut.ts` from `packages/ui-e2e/boot/`).
- Node: no root script uses `node`/`npx`; `@types/node` is not a root devDependency (only in `apps/evals` `^24.10.1`); TypeScript resolves to 5.9.3. `Dockerfile.worker` uses Node 22 via nodesource.
- `merge-gate.yml` has no job touching `packages/`. Path filtering is a hand-rolled `detect-changes` job with regex `match()` per domain (UI regex at `merge-gate.yml:121`: `^(apps/ui/|bun\.lock|package\.json$|bunfig\.toml$)`). `ui-lint` (`:959-1061`) runs `check:tokens`, Biome, `bunx tsc -b` from `apps/ui`. `e2e-contract` (`:513-552`) runs `check-e2e-boundary.sh`, `e2e:tsc`, `bun run e2e --json e2e-results.json --summary-md e2e-summary.md`, uploads `e2e-contract-results`. No top-level `concurrency` or `permissions` in merge-gate; each job declares its own.

**Existing E2E runner**

- `scripts/e2e/run.ts` flags (`report.ts:46-119`): `--harness`, `--only`, `--skip`, `--list`, `--json path`, `--summary-md path`, `--sut-env KEY=VALUE`, `--visuals dir`, `--keep`, `--min-route-coverage`, `--min-tool-coverage`. `writeReports` (`report.ts:217-224`) writes JSON and an optional markdown summary.
- `startSut(keep, slackEnv, extraEnv)` (`scripts/e2e/sut.ts:56-142`) spawns `bun run src/http.ts` with `PORT`, `API_KEY` + `AGENT_SWARM_API_KEY`, `DATABASE_PATH`, `NODE_ENV=test`, `AGENT_FS_LOCAL_DIR`, `SECRETS_ENCRYPTION_KEY_FILE`, all `*_DISABLE` flags, `ANONYMIZED_TELEMETRY=false`, then `extraEnv`. Health poll 250 ms up to 60 s. `stopSut` SIGTERM, SIGKILL after 5 s, deletes DB/WAL/SHM/log/temp dirs unless `keep`. Bun-only (`Bun.spawn`, `Bun.$`, `Bun.file`). `db.ts` opens `bun:sqlite` read-only.

**API facts that shape the suite**

- CORS (`src/http/utils.ts:6-37`, called from `src/http/index.ts:297`): echoes `Origin`, `Allow-Credentials: true`, echoes `Access-Control-Request-Headers` (fallback `Authorization, Content-Type, X-Agent-ID, X-Requested-With`), all methods; OPTIONS answered 204 in `src/http/core.ts:358-361`. A UI origin on one port calling the API on another with a bearer works. No allowlist, no env var.
- UI connection resolution: build-time `VITE_API_URL` + `VITE_API_KEY` (both or neither, `apps/ui/src/lib/deployment-config.ts:1-47`), then runtime `?apiUrl=&apiKey=` (`apps/ui/src/hooks/use-config.ts:71-140`) and `localStorage["agent-swarm-connections"]` (`apps/ui/src/lib/config.ts:5, 24-27, 234-265`). No login page. `getBaseUrl()` relative branch is DEV-only (`apps/ui/src/api/client.ts:234`).
- Seeding endpoints and DB-only states: see the brainstorm "Resolved facts". `POST /api/tasks` with omitted `agentId` routes to the lead (`src/http/tasks.ts:799-803`). Claims only through `GET /api/poll` with `X-Agent-ID`. Stalled tasks, agent liveness, `costSource`, backdated `createdAt`, and embeddings need direct DB writes.

**CI pattern to copy (`slack-visuals.yml`)**

- Triggers: `pull_request` with `paths`, plus `workflow_dispatch` (`:8-17`). Concurrency `slack-visuals-${{ pr number || ref }}` with `cancel-in-progress: true` (`:19-21`). Job `if:` skips forks and other repos (`:24-27`). `permissions: contents: write, pull-requests: write` (`:28-30`). Pinned action SHAs: checkout `3d3c42e5aac…`, setup-bun `0c5077e514…`, upload-artifact `043fb46d1a9…`.
- Run steps use `continue-on-error: true` with ids, a render step `if: always()`, `actions/upload-artifact` with `if-no-files-found: warn`, then the sticky comment: `gh api --paginate "repos/$R/issues/$PR/comments?per_page=100" --jq '.[] | select(.body | startswith("<!-- slack-visuals -->")) | .id' | head -n 1`, PATCH if found else POST (`:91-114`). A final `if: always()` step fails the job when a run step failed (`:116-122`).
- Lessons from `thoughts/taras/plans/2026-09-04-slack-visual-e2e.md`: keep comment bodies under 60,000 characters and degrade by dropping sections; fork PRs get artifacts only; pin action SHAs to the ones merge-gate uses; no dependency caching exists in any workflow (only `actions/cache` for `.bun-test-timings`).
- `nightly-e2e.yml` runs in `ghcr.io/desplega-ai/agent-swarm-worker:slim` with a shell `||` retry. Not used by P1.

**Docs that mention the frontend convention**

- `CLAUDE.md:281, 325`, `LOCAL_TESTING.md:219` ("### When you need to verify a UI change", under `## Dashboard UI` at `:209`), `runbooks/testing.md:12, 20`, `apps/ui/CLAUDE.md:291-293`. The worktree still carries the old `qa-use` wording; the main checkout was updated during the brainstorm to the agent-browser + agent-fs convention. P1 docs edits must be made against main's wording after a rebase.
- `LOCAL_TESTING.md` sections: `## Unit tests` (15), `## Black-box E2E (bun run e2e)` (48), `## E2E with Docker` (104), `## Docker entrypoint changes` (149), `## MCP tool testing over HTTP` (164), `## Dashboard UI` (209), `## Port-conflict resolution` (239). `runbooks/ci.md` has `## What CI runs` (5) with the jobs table and `### When apps/ui/ changed…` (34).

**UI facts for the specs** (`apps/ui/src`)

- Connection injection: `?apiUrl=&apiKey=` is stripped immediately and held only as React state (`pendingConnection`, `use-config.ts:140, 164-166`). It survives client-side navigation but **a full reload loses it**. Persisting requires the name-connection modal. So specs must pre-write `localStorage["agent-swarm-connections"]` before load, shape `{ "connections": [{ "id": "conn_x", "name": "...", "apiUrl": "...", "apiKey": "..." }], "activeId": "conn_x" }` (`config.ts:22-25, 56-62, 90`). Storage key is a fixed constant; no per-server namespacing.
- No WebSocket or SSE client anywhere. Live data is react-query polling (`providers.tsx:15` every 10 s, session logs every 5 s, `use-tasks.ts:78-83`). No global error toast; pages render their own `Alert`. `ErrorBoundary` (`components/shared/error-boundary.tsx:38-49`) logs `console.error` and shows "Something went wrong". No known console noise in a production build. `VITE_DEMO_MODE` only adds a ribbon.
- Flow A tasks: list at `pages/tasks/page.tsx` via `components/shared/tasks-table.tsx` (description cell `task.title?.trim() || task.task`, `:189-203`; status badge uppercase like `IN_PROGRESS`). Detail `pages/tasks/[id]/page.tsx` tabs: "Details", "Outcome", "Session Logs" (`:1152-1154`). Session logs: `GET /api/tasks/{id}/session-logs` (`api/client.ts:518-522`) rendered by `SessionLogViewer`. Needs at least one session-log row to be non-empty.
- Flow B configuration: `pages/settings/configuration-page.tsx` reads `GET /api/config?scope=global`; save goes through `hooks/use-swarm-config.ts:83-104` to `PUT /api/config?includeSecrets=true` with `{ scope: "global", scopeId: null, key, value, isSecret: false, description }`; success toast `Saved <key>`. Safe key: `STEERING_ENABLED` (boolean, default `"false"`, no `restartRequired`, `lib/configuration-catalog.ts:69-77`).
- Flow C pages: **there is no create-page UI.** Pages come from the agent `create_page` tool or `POST /api/pages`. List `pages/pages/page.tsx` (columns Title, Description, Agent, Auth, Slug, Views, Updated; empty state "No pages yet"). Detail `pages/pages/[id]/page.tsx` builds the share URL as `${apiUrl}/p/${id}` (`:73, 362, 504`), keyed by id not slug. Public route `src/http/pages-public.ts` `handlePagesPublic` (`:468`) serves `/p/:id` and `/p/:id.json`; `authed`/`password` pages answer 401 with `WWW-Authenticate: Basic` or accept `?key=` (`:517-548`).
- Selectors: `data-testid` exists only on Apps runtime, Apps settings drawer, json-render components, and the Workflows editor (34 total). Tasks, Pages, and Settings have none. Sidebar link texts (`components/layout/app-sidebar.tsx:106-188`): WORK = Home, Tasks, Sessions, Pages, Apps, Approvals; SWARM = Agents, People, Workflows, Scripts, Schedules; RESOURCES = Skills, MCP Servers, Connections, Memory, Templates; footer flyouts Settings = Connections, Appearance, Secrets, API Keys, Integrations, Configuration, Repos, Debug; Usage = Usage, Budgets, Metrics.

**Playwright facts** (Context7 `/microsoft/playwright`, 1.61 docs, current stable 1.62)

- Worker fixtures: `test.extend<TestArgs, WorkerArgs>` with `[fn, { scope: 'worker' }]`, `test.info().parallelIndex` for slot naming, teardown after `await use()`. Spawning a child process inside is plain async code. `baseURL` can be overridden per fixture; `page.goto('/x')` resolves against it.
- Pre-writing localStorage: `browser.newContext({ storageState })` with `{ cookies: [], origins: [{ origin, localStorage: [{ name, value }] }] }` applies before any page loads. `context.addInitScript` is the alternative.
- Sharding: `--shard=i/n`, `reporter: 'blob'` writes one zip per shard, `npx playwright merge-reports --reporter html ./all-blob-reports`, GitHub matrix + `upload-artifact` per shard + `download-artifact` with `pattern: blob-report-*` and `merge-multiple: true`. Use the same Playwright version to merge.
- Custom reporter: `onBegin`, `onTestEnd(test, result)`, `onEnd`; `TestResult.status | duration | retry | errors | attachments[{ name, path, contentType }]`; `TestCase.title | titlePath() | location | tags`. Register with `reporter: [['list'], ['./reporter/summary.ts']]`.
- Tags: `test('name', { tag: '@local' }, fn)`, filter with `--grep-invert @local`; runtime `test.skip(condition, reason)`.
- Options: `screenshot: 'on'`, `trace: 'on-first-retry'`, `video`, `retries`, `workers`, `fullyParallel`; `page.on('console')`, `page.on('response')`, `waitForLoadState('networkidle')`.
- `webServer` accepts an array and any shell command, polls `url`. Env set in `globalSetup` is visible to workers, which allows a free-port static server without a fixed port.
- Install: `npx playwright install --with-deps chromium`; cache dir `~/.cache/ms-playwright` or `PLAYWRIGHT_BROWSERS_PATH`. Node 22.x, 24.x, or 26.x required. CI `ubuntu-latest` has Node preinstalled; `actions/setup-node@…` with `node-version: 22` pins it.

**PR comment images: GitHub and agent-fs facts** (web research, 2026-09-04)

- `gh` CLI 2.99.0 (2026-09-01) added a repeatable `--attach PATH#alt` flag to `gh pr comment`, `gh issue comment`, `gh pr create`, `gh issue create`. It uploads to the same `user-attachments/assets` store as drag-and-drop (permanent, GitHub-hosted, no proxy expiry). Limits: 50 files per command, 10 MB per image. The underlying endpoint (`POST https://uploads.github.com/user-attachments/assets`) is undocumented; whether `GITHUB_TOKEN` in Actions is accepted is not documented. Sources: GitHub changelog 2026-09-01 "GitHub CLI: media in issues, pull requests, and comments", docs "Attaching files with GitHub CLI", `cli/cli` 2.99.0 release.
- No public REST or GraphQL attachment API exists (community discussions #28219, #46951).
- Camo proxies external images with long query strings (S3 presigned URLs work) as long as the response is `image/*`. agent-fs raw and presigned responses set the right content type but add `Content-Disposition: attachment`; camo behavior with that header is unconfirmed. Presigned URLs expire in at most 7 days, so images would break after that.
- `raw.githubusercontent.com` renders inline only for public repos with about 5 minutes of cache. Checks API `output.images` renders only in the Checks tab. `actions/upload-artifact` has no per-file URL, and `GITHUB_STEP_SUMMARY` breaks external images.

**agent-fs CLI facts** (sibling repo `../agent-fs`, `packages/cli`)

- Package `@desplega.ai/agent-fs@0.13.5`, bin `agent-fs`, `engines.bun >= 1.4.0`. Install in CI with `npm i -g @desplega.ai/agent-fs@0.13.5`. Local Mac has 0.13.4; `Dockerfile.worker:223,315` pins 0.13.3.
- Auth and target: env `AGENT_FS_API_URL`, `AGENT_FS_API_KEY` (`packages/cli/src/api-client.ts:10,14`), `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID` (`index.ts:49,74,90`), or `--org` / `--drive` flags on every ops command. Precedence flags, env, `~/.agent-fs/config.json`. `agent-fs auth whoami` verifies (`commands/auth.ts:74-102`).
- `write <path> --file <local> -m "<msg>"`: raw bytes, 50 MB cap, new version per write, no directory creation needed (`commands/ops.ts:38`, `core/src/ops/write.ts:15-119`).
- `signed-url <path> --json --expires-in <seconds>`: 60 to 604800 seconds, JSON `{ url, path, expiresIn, expiresAt, kind: "presigned" | "app" }` (`core/src/ops/signed-url.ts:13-83`).
- `ls <path>` lists a prefix; `rm <path>` deletes one exact key. No batch delete, so pruning loops.

**Seed payload facts** (public API, bearer = `AGENT_SWARM_API_KEY`)

- `POST /api/agents` (`src/http/agents.ts:120-142`): `name` required, `isLead?`, `description?`, `role?`, `capabilities?`, `maxTasks?` (default 1), `provider?`, `harness_provider?`. Bearer only. Response `id` is the agent id (server-generated unless `X-Agent-ID` is sent). `status` is `idle` at creation and the Agents page renders that column directly (`apps/ui/src/pages/agents/page.tsx:127-130`), so no heartbeat is needed. `PUT /api/agents/{id}/activity` only bumps `lastActivityAt`.
- `POST /api/tasks` (`src/http/tasks.ts:213-236`): `task` required; `agentId?: string` (not nullable, `null` is a 400); `offeredTo?`, `draft?`, `taskType?`, `tags?`, `priority?`, `parentTaskId?`, `key?`, `source?`. **Omitted `agentId` defaults to the lead if one exists** (`tasks.ts:793-798`). Status derivation (`src/be/db.ts:4805-4814`): `draft` > `offered` (offeredTo) > `pending` (agentId) > `unassigned`. So the seed creates `unassigned` tasks **before** registering the lead.
- Claim: `GET /api/poll` with `X-Agent-ID` (`src/http/poll.ts:160-172`) claims at most one task per call (offered first, then one pending), gated by `maxTasks` capacity, and flips it to `in_progress` (`poll.ts:398`). `POST /api/tasks/{id}/finish` with `X-Agent-ID` (`tasks.ts:482-505`, body `status: completed|failed`, `output?`, `failureReason?`) only mutates `in_progress` tasks owned by that agent (`tasks.ts:1341-1350`); otherwise it returns `alreadyFinished`. `POST /api/tasks/{id}/progress` is bearer-only, body `{ progress }`.
- Task title in the UI: `task.title?.trim() || task.task` collapsed to one line. `title` is set through `updateTaskTitle` (`src/be/db.ts:2113-2126`), not the create body.
- `POST /api/session-logs` (`src/http/session-data.ts:99-113`): `{ sessionId, iteration >= 1, lines: string[], taskId?, cli? }`. `lines[]` are raw JSONL strings; `cli` defaults to `claude`, so lines should look like Claude Code events: `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}`. UI reads `GET /api/tasks/{id}/session-logs` (`session-data.ts:120-135`).
- `POST /api/session-costs` (`session-data.ts:144-193`): `sessionId`, `agentId`, `totalCostUsd` required; `createdAt` is epoch ms; `costSource` is not accepted.
- `PUT /api/config` (`src/http/config.ts:219-238`): `{ scope, scopeId?, key, value, isSecret?, envPath?, description? }`. `GET /api/config` returns `{ configs }`, secrets masked as `********`.
- `POST /api/pages` (`src/http/pages.ts:90-113`) **requires `X-Agent-ID`**: `title`, `contentType`, `body` required; `slug?`, `authMode` default `authed`, `password?`. Response 201 `{ id, key, version, api_url, app_url }` with `api_url = ${apiBase}/p/${id}`. Public routes `GET /p/{id}` and `/p/{id}.json` are `auth: { apiKey: false }` (`src/http/pages-public.ts:51-83`); `authed` pages answer 401 unless a `page_session` cookie is present.
- `POST /api/memory/index` (`src/http/memory.ts:50-70`): `{ content, name, scope, source, agentId?, tags? }`, 202. The row is written synchronously; embedding is fire-and-forget. `/memory` lists via `POST /api/memory/list` by recency with no embedding filter.
- Escape hatch columns (all ISO-8601 text): `agent_tasks.createdAt`, `agent_tasks.lastUpdatedAt` (stalled threshold 30 min), `agents.lastActivityAt`, `session_costs.createdAt`; `session_costs.costSource` CHECK `harness|pricing-table|unpriced` (migrations 047, 063).

## Desired End State

- `packages/ui-e2e/` exists as a workspace member: `package.json` (Node engine, `@playwright/test`), `playwright.config.ts`, `fixtures/`, `specs/`, `boot/` (Bun), `reporter/`.
- `bun run e2e:ui` from the repo root builds `apps/ui` once with no deployment config, then runs `playwright test`. Each Playwright worker gets its own fresh API (free port, temp SQLite, seeded) and injects that connection into every browser context. Exit code is non-zero on failure.
- Specs: one data-driven route smoke (every sidebar route renders with zero console errors, zero failed `/api` responses, one screenshot per route) plus three flows: task list to task detail to session logs, settings configuration round-trip, create a page and open its share URL.
- Remote mode: `E2E_API_URL` + `E2E_API_KEY` (+ optional `E2E_UI_URL`) skip the boot and target an existing API. Seeding remotely requires `E2E_REMOTE_SEED=1`. `@local` specs skip remotely. The prod API host is refused.
- `.github/workflows/ui-e2e.yml` runs on PRs touching the UI or API paths and on pushes to main, 2 shards, informational, merges shard reports, uploads the HTML report and traces as GitHub artifacts, and upserts one sticky PR comment with per-spec results and screenshot links.
- Docs updated: `LOCAL_TESTING.md`, `runbooks/testing.md`, `runbooks/ci.md`, `CLAUDE.md` pointer.

Verification: `bun run e2e:ui` green locally on macOS, the workflow green on a PR from this branch, and the sticky comment visible on that PR.

## What We're NOT Doing

- No ingest to the tracker, no agent-fs upload (P2, waits on PR #1349 rework).
- No swarm exploratory runner, no fork sandbox, no green loop (P3).
- No `pw.ai` fixture (P4, `DES-782`). Only the fixture slot name `ai` is reserved.
- No merge-gate integration. The workflow is informational.
- No visual diffing. Screenshots are evidence, not assertions.
- No UI unit-test runner (the memory note about skipping UI unit-test infra still holds).
- No changes to `scripts/e2e/` contract scenarios beyond what the boot needs.

## Implementation Approach

- Reuse `scripts/e2e/sut.ts` for the API boot. The Node worker fixture spawns a Bun boot script that starts the SUT, seeds it, prints one JSON handle line, and tears down when stdin closes.
- Seed through the public API by default, with a `bun:sqlite` escape hatch inside the Bun boot process for states the API cannot express.
- Build the UI once per run with empty `VITE_API_URL` and `VITE_API_KEY`, serve `dist/` once with a static server, and inject the per-worker API through `?apiUrl=&apiKey=` (or `addInitScript` writing `agent-swarm-connections`).
- Playwright under Node, chromium only, `retries: CI ? 2 : 1`, `trace: on-first-retry`, `screenshot: on`, `blob` reporter in CI merged with `playwright merge-reports`.
- Informational workflow modeled on `slack-visuals.yml`, with a new sticky-comment generator and marker `<!-- ui-e2e -->`.
- Sequencing: package + boot + smoke first (proves the harness), then seed + flows, then remote mode, then CI, then docs.

Decisions from check-in 1 (2026-09-04):

- **Flow C** = seeded pages. The seed creates one `public` and one `authed` page through `POST /api/pages`. The spec opens Pages, clicks the public page, reads the share URL from the detail view, opens it in a fresh context with no storage and asserts the body, then asserts the authed page's `/p/{id}` answers 401.
- **CI wiring** = extend `ui-lint` and the UI regex in `detect-changes` (`merge-gate.yml:121`) with `packages/ui-e2e/`; two extra steps run Biome and `tsc --noEmit` from the package. Root `tsconfig.json` excludes `packages`; root `lint` script adds `packages/ui-e2e`.
- **PR comment images** (check-in 2): agent-fs presigned URLs. CI uploads failure screenshots first, then route screenshots, to agent-fs under `e2e/agent-swarm/<pr-N|main>/<sha>/<shard>/`, mints 7-day presigned URLs, and embeds them in the sticky comment. Fork PRs and runs without the agent-fs secrets post the text table only. Known limits: images expire after 7 days (the comment is re-posted on every push, so open PRs stay fresh), and camo rendering with the `Content-Disposition: attachment` header is unconfirmed. Phase 5 QA checks inline rendering; if camo refuses, the fallback is `gh pr comment --attach` (gh >= 2.99.0).
- **Plan shape** (check-in 2): one plan, six phases.

Runtime design (settled by research, no decision needed):

- **UI origin**: `globalSetup` builds nothing (the root script builds before Playwright starts), starts one Node static server for `apps/ui/dist` on a free port with SPA fallback, and exports `process.env.E2E_UI_URL` to workers. In remote mode with `E2E_UI_URL` set, it starts nothing.
- **Per-worker API**: a worker-scoped fixture spawns `bun packages/ui-e2e/boot/sut.ts`, reads one JSON line `{ apiUrl, apiKey, dbPath }`, and kills it after `use()`. The boot script imports `startSut` from `../../../scripts/e2e/sut.ts`, runs the seed against itself, writes the seed manifest next to the DB, then blocks on stdin. In remote mode the fixture returns `{ apiUrl: E2E_API_URL, apiKey: E2E_API_KEY }` and runs the seed only when `E2E_REMOTE_SEED=1`.
- **Connection injection**: a test-scoped `context` override builds `storageState` with `origins: [{ origin: E2E_UI_URL, localStorage: [{ name: "agent-swarm-connections", value: JSON.stringify({ connections: [{ id: "conn_e2e", name: "e2e", apiUrl, apiKey }], activeId: "conn_e2e" }) }] }]`. Reloads keep it.
- **Seed order** (API first): register two worker agents, create the `unassigned` pool tasks, register the lead, create `pending` tasks for the lead and a worker, poll as the worker to claim one into `in_progress`, post session logs and a cost row for it, poll and finish another as `completed` and one as `failed`, set `STEERING_ENABLED` to `false`, create the two pages with the lead's `X-Agent-ID`, index one memory. Then the escape hatch backdates one `in_progress` task's `lastUpdatedAt` by 45 minutes (stalled) and one agent's `lastActivityAt` by a day. The manifest records names, ids, and page ids.
- **Smoke data source**: a static route list in `specs/routes.ts` with `{ path, needs?: "agent" | "task" | "page" | ... }`; id routes resolve ids from the manifest. Each route asserts no `console.error`, no `/api` response with status >= 400, a visible `main` landmark, and takes a full-page screenshot named after the route.

## Quick Verification Reference

- `bun run e2e:ui` (root script, to be added)
- `cd packages/ui-e2e && npx playwright test --project=chromium`
- `bun run lint` and `bun run tsc:check` at the root, plus the package's own `tsc --noEmit`
- `bun run e2e` (contract suite must stay green)
- `bun run check:dep-graph`, `bash scripts/check-db-boundary.sh`, `bash scripts/check-e2e-boundary.sh`

---

## Phase Outline (confirmed at check-in 2)

| Phase | Deliverable | Proves |
|---|---|---|
| 1 | `packages/ui-e2e` scaffold: `package.json`, `tsconfig.json`, `playwright.config.ts`, `global-setup.ts` (static UI server), `fixtures/index.ts` (worker API fixture + storageState context), `boot/sut.ts`, one smoke spec on `/`; root scripts `e2e:ui`, `e2e:ui:tsc`; root tsconfig/lint wiring | `bun run e2e:ui` is green locally with a fresh API per worker |
| 2 | `boot/seed.ts` (API-driven + escape hatch) writing `seed-manifest.json`; `specs/routes.ts`; data-driven `specs/smoke.spec.ts` over every sidebar route with screenshots | Seeded world renders everywhere with zero console errors and zero failed API calls |
| 3 | `specs/tasks.spec.ts`, `specs/configuration.spec.ts`, `specs/pages.spec.ts` | The three flows |
| 4 | Remote mode: `E2E_API_URL` / `E2E_API_KEY` / `E2E_UI_URL`, `E2E_REMOTE_SEED`, `@local` tags auto-excluded, prod host denylist | Same suite against a running API without boot |
| 5 | `.github/workflows/ui-e2e.yml` (2 shards, blob + merge, artifacts), `reporter/summary.ts` (JSON), `reporter/comment.ts` (sticky comment), `ui-lint` + UI regex extension | Informational run and comment on this branch's PR |
| 6 | Docs: `LOCAL_TESTING.md` new `## UI E2E (bun run e2e:ui)` section, `runbooks/testing.md`, `runbooks/ci.md`, `CLAUDE.md` pointer, `apps/ui/CLAUDE.md` (after rebasing onto main's updated wording) | Contributors can run and extend the suite |

## Phase 1: Package scaffold, boot handshake, first smoke

### Overview

`packages/ui-e2e` exists, `bun run e2e:ui` builds the UI, boots one fresh API per Playwright worker through a Bun child, injects the connection, and runs one smoke spec on `/` green on macOS.

### Changes Required:

#### 1. Package manifest and TypeScript configs
**File**: `packages/ui-e2e/package.json`
**Changes**: `"name": "@agent-swarm/ui-e2e"`, `"private": true`, `"type": "module"`, `"engines": { "node": ">=22" }`, `devDependencies`: `@playwright/test` pinned to the current 1.62.x, `@types/node` `^22`. Scripts: `"test": "playwright test"`, `"tsc": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.boot.json"`.

**File**: `packages/ui-e2e/tsconfig.json` (Node side)
**Changes**: `"compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM"], "types": ["node"], "strict": true, "noEmit": true, "skipLibCheck": true }`, `"include": ["specs", "fixtures", "reporter", "global-setup.ts", "playwright.config.ts"]`, `"exclude": ["boot"]`.

**File**: `packages/ui-e2e/tsconfig.boot.json` (Bun side)
**Changes**: `"extends": "../../tsconfig.json"`, `"compilerOptions": { "noEmit": true }`, `"include": ["boot/**/*.ts", "../../scripts/e2e/sut.ts", "../../scripts/e2e/db.ts"]`.

**File**: `tsconfig.json` (root)
**Changes**: add `"packages"` to `exclude` so `bun run tsc:check` does not sweep the package.

**File**: `package.json` (root)
**Changes**: scripts `"e2e:ui": "bun packages/ui-e2e/boot/run.ts"`, `"e2e:ui:tsc": "bun tsc --noEmit -p packages/ui-e2e/tsconfig.json && bun tsc --noEmit -p packages/ui-e2e/tsconfig.boot.json"`; `"lint": "biome check src apps/evals packages/ui-e2e"` (and `lint:fix` likewise). Run `bun install` to add the package to `bun.lock`.

**File**: `.gitignore`
**Changes**: `packages/ui-e2e/test-results/`, `packages/ui-e2e/playwright-report/`, `packages/ui-e2e/blob-report/`.

#### 2. Playwright config and global setup
**File**: `packages/ui-e2e/playwright.config.ts`
**Changes**: `testDir: "./specs"`, `fullyParallel: false`, `workers: process.env.CI ? 2 : 3`, `retries: process.env.CI ? 2 : 1`, `timeout: 60_000`, `globalSetup: "./global-setup.ts"`, `reporter: process.env.CI ? [["blob"], ["./reporter/summary.ts"]] : [["list"], ["html", { open: "never" }], ["./reporter/summary.ts"]]` (the summary reporter arrives in Phase 5; until then omit it), `use: { trace: "on-first-retry", screenshot: "on", video: "off", viewport: { width: 1440, height: 900 } }`, one `chromium` project. No `webServer`, no `baseURL` here (the fixture sets it).

**File**: `packages/ui-e2e/global-setup.ts`
**Changes**: if `process.env.E2E_UI_URL` is set, return. Otherwise resolve `apps/ui/dist/index.html` (throw with "run `bun run e2e:ui` or build apps/ui first" when missing), start a Node `http` server on `127.0.0.1:0` that serves files from `dist` with correct content types and falls back to `index.html` for unknown paths, and set `process.env.E2E_UI_URL = http://127.0.0.1:<port>`. Return a teardown that closes the server.

#### 3. Bun boot child and orchestrator
**File**: `packages/ui-e2e/boot/sut.ts`
**Changes**: `import { startSut, stopSut } from "../../../scripts/e2e/sut.ts"`. Parse `--sut-env KEY=VALUE` (repeatable). `const sut = await startSut(false, {}, extraEnv)`. Print exactly one line `JSON.stringify({ apiUrl: sut.baseUrl, apiKey: sut.apiKey, dbPath: sut.dbPath })` to stdout. Then `for await (const _ of Bun.stdin.stream()) {}` and on stdin end, SIGTERM, or SIGINT call `stopSut(sut, false)` and exit. Seeding is added in Phase 2.

**File**: `packages/ui-e2e/boot/run.ts`
**Changes**: the root entry. Flags: `--no-build`, everything after `--` is passed to Playwright. Unless `--no-build` or `E2E_UI_URL` is set: run `bun run build` in `apps/ui` with `VITE_API_URL=""`, `VITE_API_KEY=""`, `VITE_DEMO_MODE=""` in the env. Then `Bun.spawn(["npx", "playwright", "test", ...passthrough], { cwd: "packages/ui-e2e", stdio: "inherit" })` and exit with its code.

#### 4. Fixtures and the first spec
**File**: `packages/ui-e2e/fixtures/index.ts`
**Changes**: `export const test = base.extend<TestFixtures, WorkerFixtures>({...})`.
- Worker fixture `swarm` (`{ scope: "worker" }`): `spawn("bun", ["boot/sut.ts"], { cwd: packageRoot })`, read stdout until the first newline (90 s timeout, surface stderr on failure), parse the handle. Teardown: `child.stdin.end()`, wait for exit up to 5 s, then `SIGKILL`.
- `baseURL`: `async ({}, use) => use(process.env.E2E_UI_URL)`.
- `storageState`: `async ({ swarm }, use) => use({ cookies: [], origins: [{ origin: process.env.E2E_UI_URL, localStorage: [{ name: "agent-swarm-connections", value: JSON.stringify({ connections: [{ id: "conn_e2e", name: "e2e", apiUrl: swarm.apiUrl, apiKey: swarm.apiKey }], activeId: "conn_e2e" }) }] }] })`.
- `clean` (test-scoped, auto): attaches `page.on("console")` collecting `error` messages and `page.on("response")` collecting `/api` responses with status >= 400; exposes `assertClean()` which fails with both lists.
- `api`: a small typed `fetch` wrapper bound to `swarm.apiUrl` + bearer for specs that need to read state.
Export `expect` from `@playwright/test`.

**File**: `packages/ui-e2e/specs/home.spec.ts`
**Changes**: `test("home renders", async ({ page, clean }) => { await page.goto("/"); await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible(); await clean.assertClean(); })`.

### Success Criteria:

#### Automated Verification:
- [ ] Install and lock: `bun install` then `bun install --frozen-lockfile`
- [ ] Suite is green: `bun run e2e:ui`
- [ ] Package typechecks: `bun run e2e:ui:tsc`
- [ ] Root gates still pass: `bun run lint && bun run tsc:check`
- [ ] Contract suite unaffected: `bun run e2e`
- [ ] Boundaries: `bash scripts/check-e2e-boundary.sh && bash scripts/check-db-boundary.sh && bun run check:dep-graph`

#### Automated QA:
- [ ] Run `bun run e2e:ui -- --workers=3` twice back to back; both green, three distinct API ports in the boot logs, no port collision.
- [ ] Start a run, `kill -9` the `playwright` process mid-run, then `pgrep -f "bun run src/http.ts"` returns nothing within 10 s (stdin close tears the SUT down).
- [ ] `bun run e2e:ui -- --reporter=list` output shows the spec ran under the worker's injected connection (assert the `/api/tasks` request went to the worker's port, via the `clean` collector debug output).

#### Manual Verification:
- [ ] Open `packages/ui-e2e/playwright-report/index.html` and confirm the home screenshot shows the dashboard, not a connection modal.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] ui-e2e package scaffold and boot handshake`.

---

## Phase 2: Seed, manifest, and the route smoke

### Overview

Every Playwright worker boots a seeded world and a data-driven smoke spec renders every sidebar route with zero console errors and zero failed API calls, one screenshot per route.

### Changes Required:

#### 1. Seed script
**File**: `packages/ui-e2e/boot/seed.ts`
**Changes**: `export async function seed(opts: { apiUrl, apiKey, db?: Database }): Promise<SeedManifest>`. All names carry an `e2e-` prefix and creation is skipped when the entity already exists (idempotent for remote reuse). Order:
1. `POST /api/agents` for `e2e-worker-a` and `e2e-worker-b` (`isLead: false`, `maxTasks: 2`). Keep the returned ids.
2. `POST /api/tasks` twice with no `agentId` (pool tasks, `tags: ["e2e"]`, `key: "shared/e2e/pool-<n>"`). These land `unassigned` because no lead exists yet.
3. `POST /api/agents` for `e2e-lead` (`isLead: true`).
4. `POST /api/tasks` with `agentId: <worker-a>` three times (titles "e2e in-progress task", "e2e completed task", "e2e failed task") and once with `agentId: <lead>` ("e2e pending lead task"), plus one with `offeredTo: <worker-b>` ("e2e offered task") and one with `draft: true`.
5. `GET /api/poll` with `X-Agent-ID: <worker-a>` three times, each claim moving one task to `in_progress`. For the "completed" and "failed" ones call `POST /api/tasks/{id}/finish` with `X-Agent-ID: <worker-a>` and `status: completed` / `failed` (`failureReason: "e2e seeded failure"`).
6. `POST /api/tasks/{id}/progress` on the in-progress task, then `POST /api/session-logs` with `sessionId: "e2e-session-1"`, `iteration: 1`, `taskId`, `lines` of three Claude-shaped JSONL strings (assistant text "Hello from the e2e seed", a `tool_use`, a `tool_result`), then `POST /api/session-costs` for that session (`agentId: <worker-a>`, `totalCostUsd: 0.0123`, `model: "claude-sonnet-5"`).
7. `PUT /api/config` `{ scope: "global", key: "STEERING_ENABLED", value: "false", isSecret: false }`.
8. `POST /api/pages` with `X-Agent-ID: <lead>` twice: `authMode: "public"` ("e2e public page", body `<h1>e2e public page</h1>`) and `authMode: "authed"` ("e2e authed page"). Keep `id` and `api_url`.
9. `POST /api/memory/index` (`name: "e2e memory"`, `scope: "swarm"` or the first valid scope enum value, `source` first valid value).
10. Escape hatch, only when `db` is given: `UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?` backdating the in-progress task 45 minutes; `UPDATE agents SET lastActivityAt = ? WHERE id = ?` backdating `e2e-worker-b` one day.
Return `{ agents: { lead, workerA, workerB }, tasks: { pool: [], inProgress, completed, failed, pendingLead, offered, draft }, pages: { public: { id, apiUrl }, authed: { id, apiUrl } }, session: { id }, memory: { name } }`.

**File**: `packages/ui-e2e/boot/sut.ts`
**Changes**: after `startSut`, open `new Database(sut.dbPath)` (read-write) from `bun:sqlite`, call `seed({ apiUrl, apiKey, db })`, write the manifest to `${sut.dbPath}.seed.json`, close the DB, and add `manifestPath` to the printed handle.

#### 2. Fixtures
**File**: `packages/ui-e2e/fixtures/index.ts`
**Changes**: add `seed` (test-scoped) that reads `swarm.manifestPath` once per worker and returns the manifest.

#### 3. Route list and smoke spec
**File**: `packages/ui-e2e/specs/routes.ts`
**Changes**: `export const routes: Route[]` with `{ path, name, needs?: keyof ManifestIds, tag?: "@local" }`. Id-free: `/`, `/agents`, `/tasks`, `/sessions`, `/chat`, `/services`, `/schedules`, `/workflows`, `/connections`, `/scripts`, `/approval-requests`, `/usage`, `/usage/budgets`, `/usage/metrics`, `/settings/connections`, `/settings/appearance`, `/settings/secrets`, `/settings/api-keys`, `/settings/integrations`, `/settings/configuration`, `/settings/repos`, `/settings/debug`, `/templates`, `/mcp-servers`, `/skills`, `/people`, `/people/unmapped`, `/memory`, `/pages`, `/apps`. Id routes from the manifest: `/agents/:id` (worker-a), `/tasks/:id` (in-progress), `/sessions/:rootTaskId` (in-progress), `/pages/:id` (public page). Routes whose entity the seed does not create (workflow, schedule, script, app, skill, mcp server, repo, person, template, integration, approval request) are listed with `skip: "no seed entity yet"` so the list is complete and the gap is visible.

**File**: `packages/ui-e2e/specs/smoke.spec.ts`
**Changes**: `for (const route of routes) test(\`smoke ${route.path}\`, { tag: ["@smoke", ...(route.tag ? [route.tag] : [])] }, async ({ page, seed, clean }, testInfo) => { test.skip(Boolean(route.skip), route.skip); const path = resolve(route, seed); await page.goto(path); await page.waitForLoadState("networkidle"); await expect(page.locator("main").first()).toBeVisible(); const shot = testInfo.outputPath(\`${route.name}.png\`); await page.screenshot({ path: shot, fullPage: true }); await testInfo.attach(route.name, { path: shot, contentType: "image/png" }); await clean.assertClean(); })`.

### Success Criteria:

#### Automated Verification:
- [ ] Smoke is green: `bun run e2e:ui -- --grep @smoke`
- [ ] Package typechecks: `bun run e2e:ui:tsc`
- [ ] Root gates: `bun run lint && bun run tsc:check`
- [ ] Manifest written: `bun run e2e:ui -- --grep "smoke /tasks" --reporter=list` then `ls /tmp/e2e-*.sqlite.seed.json` shows one file per worker (use `E2E_KEEP=1` support added to `boot/sut.ts` to skip cleanup for this check)

#### Automated QA:
- [ ] With `E2E_KEEP=1`, query the kept DB: `bun -e 'const {Database}=await import("bun:sqlite"); const db=new Database(process.argv[1],{readonly:true}); console.log(db.query("select status,count(*) c from agent_tasks group by status").all())' /tmp/e2e-<stamp>.sqlite` shows `unassigned 2`, `pending 1`, `in_progress 1`, `completed 1`, `failed 1`, `offered 1`, `draft 1`.
- [ ] Same DB: the in-progress task's `lastUpdatedAt` is older than 40 minutes and `e2e-worker-b.lastActivityAt` is older than 23 hours.
- [ ] The smoke report lists every route in `routes.ts`, with the no-seed-entity ones marked skipped, none marked failed.

#### Manual Verification:
- [ ] Flip through the route screenshots in the HTML report. Each shows real seeded data (agents, tasks, the page), not empty states, except where the route has no seed entity.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] seeded world and route smoke`.

---

## Phase 3: The three flows

### Overview

Three specs cover task list to detail to session logs, the configuration round-trip, and the pages list to detail to public share URL.

### Changes Required:

#### 1. Tasks flow
**File**: `packages/ui-e2e/specs/tasks.spec.ts`
**Changes**: goto `/tasks`; `page.getByRole("row", { name: /e2e in-progress task/ })` (fallback `getByText`) visible with badge text `IN_PROGRESS`; click; expect URL `/tasks/<id>` from the manifest; expect heading contains the task title; click tab `getByRole("tab", { name: "Session Logs" })`; expect `getByText("Hello from the e2e seed")` visible; `assertClean()`.

#### 2. Configuration flow
**File**: `packages/ui-e2e/specs/configuration.spec.ts`
**Changes**: goto `/settings/configuration`; locate the "Enable steering" control (switch or select by label); flip it to on; expect toast `getByText("Saved STEERING_ENABLED")`; `page.reload()`; expect the control shows on; verify through the `api` fixture that `GET /api/config?scope=global` contains `STEERING_ENABLED` = `"true"`; flip back to off and expect the toast again; `assertClean()`.

#### 3. Pages flow
**File**: `packages/ui-e2e/specs/pages.spec.ts`
**Changes**: goto `/pages`; click `getByRole("link", { name: "e2e public page" })`; on the detail read the share URL (the external link or the displayed `${apiUrl}/p/<id>` text) and assert it equals `seed.pages.public.apiUrl`; `const ctx = await browser.newContext()` (no storage); `const p = await ctx.newPage(); await p.goto(shareUrl)`; expect `getByRole("heading", { name: "e2e public page" })`; `await ctx.close()`; then `const res = await p2.request.get(seed.pages.authed.apiUrl)` from a storage-less context and expect `res.status()` to be 401; `assertClean()`.

### Success Criteria:

#### Automated Verification:
- [ ] Flows are green: `bun run e2e:ui -- specs/tasks.spec.ts specs/configuration.spec.ts specs/pages.spec.ts`
- [ ] Whole suite is green: `bun run e2e:ui`
- [ ] Package typechecks: `bun run e2e:ui:tsc`
- [ ] Root gates: `bun run lint && bun run tsc:check`

#### Automated QA:
- [ ] Run the suite with `--repeat-each=3`; zero flakes reported in the HTML report.
- [ ] Inspect the configuration spec trace (`--trace on`) and confirm the `PUT /api/config?includeSecrets=true` request body has `key: "STEERING_ENABLED"`.

#### Manual Verification:
- [ ] Watch `bun run e2e:ui -- --headed specs/pages.spec.ts` once and confirm the public page opens in a second window without the dashboard chrome.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] tasks, configuration, pages flows`.

---

## Phase 4: Remote mode

### Overview

The same suite runs against an already-running API selected by env, with seeding opt-in, local-only specs skipped, and the prod host refused.

### Changes Required:

#### 1. Policy and target resolution
**File**: `packages/ui-e2e/boot/policy.ts`
**Changes**: `export const PROD_API_HOSTS = ["api.desplega.agent-swarm.dev", "cloud.agent-swarm.dev"]` and `assertAllowedTarget(url)` that throws `refusing to run E2E against a production host` when the hostname matches. `export function readTarget(env)` returns `{ mode: "local" } | { mode: "remote", apiUrl, apiKey, uiUrl?, seed: boolean }` from `E2E_API_URL`, `E2E_API_KEY`, `E2E_UI_URL`, `E2E_REMOTE_SEED`. Missing `E2E_API_KEY` with `E2E_API_URL` set is an error.

#### 2. Global setup and fixtures
**File**: `packages/ui-e2e/global-setup.ts`
**Changes**: call `readTarget` and `assertAllowedTarget`. In remote mode with `seed: true`, run the seed once for the whole run: `spawnSync("bun", ["boot/seed-cli.ts", apiUrl, apiKey, manifestPath])` (no DB escape hatch), and export `E2E_REMOTE_MANIFEST`. Static UI server logic unchanged (skipped when `E2E_UI_URL` is set).

**File**: `packages/ui-e2e/boot/seed-cli.ts`
**Changes**: thin CLI over `seed()` writing the manifest to the given path.

**File**: `packages/ui-e2e/fixtures/index.ts`
**Changes**: the `swarm` worker fixture returns `{ apiUrl, apiKey, manifestPath: E2E_REMOTE_MANIFEST }` in remote mode without spawning. When remote and no manifest exists, `seed` resolves to `null` and specs that need it call `test.skip(!seed, "remote run without seed")`.

**File**: `packages/ui-e2e/playwright.config.ts`
**Changes**: `grepInvert: process.env.E2E_API_URL ? /@local/ : undefined`. Tag the smoke routes that depend on escape-hatch state with `@local` (none today; the tag exists for future specs asserting stalled or backdated views).

#### 3. Root orchestrator
**File**: `packages/ui-e2e/boot/run.ts`
**Changes**: skip the UI build when `E2E_UI_URL` is set; print the resolved target (mode, apiUrl host, seed flag) before starting Playwright.

### Success Criteria:

#### Automated Verification:
- [ ] Local mode unchanged: `bun run e2e:ui`
- [ ] Remote against a second local API: in one shell `PORT=3999 DATABASE_PATH=/tmp/e2e-remote.sqlite AGENT_SWARM_API_KEY=remotekey NODE_ENV=test GITHUB_DISABLE=true LINEAR_DISABLE=true JIRA_DISABLE=true SLACK_DISABLE=true bun run src/http.ts`; in another `E2E_API_URL=http://127.0.0.1:3999 E2E_API_KEY=remotekey E2E_REMOTE_SEED=1 bun run e2e:ui` is green.
- [ ] Remote without seed: `E2E_API_URL=http://127.0.0.1:3999 E2E_API_KEY=remotekey bun run e2e:ui` passes with the flow specs and id routes reported as skipped.
- [ ] Prod refused: `E2E_API_URL=https://api.desplega.agent-swarm.dev E2E_API_KEY=x bun run e2e:ui; test $? -ne 0`
- [ ] Package typechecks and root gates: `bun run e2e:ui:tsc && bun run lint && bun run tsc:check`

#### Automated QA:
- [ ] Run the remote seeded command twice; the second run creates no duplicate `e2e-*` agents or tasks (`curl -s -H "Authorization: Bearer remotekey" http://127.0.0.1:3999/api/agents | jq '[.agents[] | select(.name | startswith("e2e-"))] | length'` is 3).

#### Manual Verification:
- [ ] None.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] remote target mode`.

---

## Phase 5: CI workflow, reporters, and the sticky comment

### Overview

`.github/workflows/ui-e2e.yml` runs the suite in 2 shards on PRs and main, merges the reports, uploads screenshots to agent-fs with 7-day presigned links, and upserts one sticky PR comment. `merge-gate.yml` lints and typechecks the package.

### Changes Required:

#### 1. Reporters
**File**: `packages/ui-e2e/reporter/summary.ts`
**Changes**: a Playwright `Reporter` that on `onTestEnd` records `{ specId: test.titlePath().join(" > "), title, file, status: result.status, durationMs, retries: result.retry, error: result.errors[0]?.message, screenshots: result.attachments.filter(a => a.contentType === "image/png").map(a => a.path) }` and on `onEnd` writes `test-results/summary.json` with `{ shard: { index, total }, startedAt, finishedAt, results[] }`. Registered in `playwright.config.ts` for both CI and local.

**File**: `packages/ui-e2e/reporter/comment.ts`
**Changes**: Node script `node --experimental-strip-types reporter/comment.ts --summaries <dir> --images images.json --run-url <url> --report-artifact <name> --out comment.md`. Merges all `summary.json` files, prints a header line with totals per status, a table `spec | status | duration | retries`, failure messages in `<details>`, an "Images" section with `![name](url)` for each entry in `images.json` (failures first), links to the run and the HTML report artifact, and the marker `<!-- ui-e2e -->` as the first line. Caps the body at 60,000 characters by dropping the images section first, then the passed rows.

**File**: `packages/ui-e2e/reporter/publish-images.sh`
**Changes**: bash. Inputs: results dir, agent-fs prefix, cap (default 24). Picks failure screenshots first, then route screenshots in `routes.ts` order. Auth comes from env only: `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID` (CLI precedence is flags, then env, then `~/.agent-fs/config.json`). Verify with `agent-fs auth whoami`. For each file: `agent-fs write "<prefix>/<name>.png" --file <path> -m "ui-e2e <sha>"` (raw bytes, 50 MB cap, nested paths need no mkdir), then `agent-fs signed-url "<prefix>/<name>.png" --json --expires-in 604800` (7 days is the schema maximum) and append `{ name, url: .url, expiresAt: .expiresAt }` to `images.json`, skipping entries whose `kind` is not `presigned`. Exits 0 and writes an empty `images.json` when the env is missing or any command fails, and logs why. CLI install in the workflow: `npm i -g @desplega.ai/agent-fs@0.13.5` (bin `agent-fs`; `Dockerfile.worker:223,315` pin 0.13.3 for the worker image, which does not matter here).

#### 2. Workflow
**File**: `.github/workflows/ui-e2e.yml`
**Changes**:
- `on: pull_request: paths: [apps/ui/**, packages/ui-e2e/**, scripts/e2e/**, src/http/**, src/be/**, bun.lock, .github/workflows/ui-e2e.yml]`, `push: branches: [main]`, `workflow_dispatch`. `concurrency: { group: ui-e2e-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`.
- Job `test` (`if: github.repository == 'desplega-ai/agent-swarm'`, `permissions: contents: read`, `timeout-minutes: 25`, `strategy: { fail-fast: false, matrix: { shard: [1, 2] } }`): checkout and setup-bun at the SHAs merge-gate uses; `actions/setup-node` with `node-version: 22`; `bun install --frozen-lockfile`; `actions/cache` on `~/.cache/ms-playwright` keyed by the `@playwright/test` version from `packages/ui-e2e/package.json`; `npx playwright install --with-deps chromium` from `packages/ui-e2e`; `bun run e2e:ui -- --shard=${{ matrix.shard }}/2` with `id: run` and `continue-on-error: true`; upload `ui-e2e-blob-${{ matrix.shard }}` (`packages/ui-e2e/blob-report`) and `ui-e2e-results-${{ matrix.shard }}` (`packages/ui-e2e/test-results`) with `if: always()`.
- Job `report` (`needs: test`, `if: always()`, `permissions: { contents: read, pull-requests: write }`): checkout, setup-bun, setup-node, `bun install --frozen-lockfile`; download `ui-e2e-blob-*` with `merge-multiple: true` into `all-blob-reports` and `ui-e2e-results-*` into `all-results` (keep shard subdirs); `npx playwright merge-reports --reporter html,json all-blob-reports` from `packages/ui-e2e`; upload `ui-e2e-html-report`; if `github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository`: install the agent-fs CLI, run `publish-images.sh all-results e2e/agent-swarm/pr-${{ github.event.pull_request.number }}/${{ github.event.pull_request.head.sha }}` with `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_ORG_ID`, `AGENT_FS_DRIVE_ID` from `secrets.E2E_AGENT_FS_*`; build `comment.md`; find the existing comment by marker with the same `gh api --paginate ... --jq` pattern as `slack-visuals.yml:108-113`, PATCH or POST; append `comment.md` to `$GITHUB_STEP_SUMMARY` on every event; final step `if: always()` fails the job when any `test` shard result was not `success` (informational because the workflow is not in the required checks).

**File**: `.github/workflows/merge-gate.yml`
**Changes**: `detect-changes` UI regex at `:121` becomes `^(apps/ui/|packages/ui-e2e/|bun\.lock|package\.json$|bunfig\.toml$)`. `ui-lint` gains two steps after the existing `tsc -b`: `bun run lint` is already root-wide after the Phase 1 script change, so add `bun run e2e:ui:tsc` from the repo root, and `bunx biome check packages/ui-e2e`.

#### 3. Secrets (Taras, one-time)
Create a dedicated agent-fs user for CI (editor on the e2e drive) and add repository secrets `E2E_AGENT_FS_API_URL`, `E2E_AGENT_FS_API_KEY`, `E2E_AGENT_FS_ORG_ID`, `E2E_AGENT_FS_DRIVE_ID`.

### Success Criteria:

#### Automated Verification:
- [ ] Reporter unit check: `bun run e2e:ui -- --grep "smoke /"` then `test -s packages/ui-e2e/test-results/summary.json && jq '.results | length' packages/ui-e2e/test-results/summary.json`
- [ ] Comment builder: `node --experimental-strip-types packages/ui-e2e/reporter/comment.ts --summaries packages/ui-e2e/test-results --images /dev/null --run-url https://example --report-artifact x --out /tmp/c.md && head -1 /tmp/c.md | grep -q 'ui-e2e'`
- [ ] Workflow syntax: `bunx actionlint .github/workflows/ui-e2e.yml .github/workflows/merge-gate.yml` (skip if actionlint is unavailable; then rely on the PR run)
- [ ] Package typechecks and root gates: `bun run e2e:ui:tsc && bun run lint && bun run tsc:check`
- [ ] Push the branch, open the PR, and both `ui-e2e` jobs and `ui-lint` complete: `gh run list --workflow ui-e2e.yml --branch <branch> --limit 1` shows `completed`

#### Automated QA:
- [ ] `gh pr view <n> --json comments --jq '.comments[] | select(.body | startswith("<!-- ui-e2e -->")) | .id'` returns exactly one id after two pushes.
- [ ] `gh run download <run-id> -n ui-e2e-html-report -D /tmp/rep && test -f /tmp/rep/index.html`
- [ ] With `agent-browser`, open the PR comment and screenshot it; the image count in the comment matches `images.json` from the run log.

#### Manual Verification:
- [ ] The screenshots render inline in the PR comment (camo plus the agent-fs attachment disposition is the unconfirmed part). If they show as broken images, switch `publish-images.sh` to `gh pr comment --attach` and record the outcome in the plan Appendix.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] ui-e2e workflow, reporters, sticky comment`.

---

## Phase 6: Docs

### Overview

Contributors can find, run, extend, and read results from the suite from the same docs that cover the other test layers.

### Changes Required:

#### 0. Rebase
Rebase the branch onto `main` first. The frontend convention wording in `CLAUDE.md`, `LOCAL_TESTING.md`, `runbooks/testing.md`, and `apps/ui/CLAUDE.md` changed on main during the brainstorm (agent-browser + agent-fs, no CI enforcement).

#### 1. Files
**File**: `LOCAL_TESTING.md`
**Changes**: new section `## UI E2E (bun run e2e:ui)` after `## Black-box E2E (bun run e2e)`: what it boots, the commands (`bun run e2e:ui`, `-- --grep @smoke`, `-- --headed specs/x.spec.ts`, `-- --ui`), remote mode env table, `@local`, where reports and screenshots land, how to add a route or a spec, and that the workflow is informational. In `## Dashboard UI`, one line pointing at the new section.

**File**: `runbooks/testing.md`
**Changes**: routing row "Changing apps/ui behavior" pointing at the UI E2E section; hard rule stays about screenshots, plus one sentence that `ui-e2e.yml` is informational.

**File**: `runbooks/ci.md`
**Changes**: jobs table row for `ui-e2e.yml` (PR paths + main, informational, 2 shards, sticky comment); under `### When apps/ui/ changed…` add the two `ui-lint` steps and note `packages/ui-e2e/` triggers it.

**File**: `CLAUDE.md`
**Changes**: in the testing `<important>` block add `bun run e2e:ui` next to the black-box runner sentence; in the commands table add `bun run e2e:ui`.

**File**: `apps/ui/CLAUDE.md`
**Changes**: short section "UI E2E" pointing at `packages/ui-e2e/README.md` and the selector conventions (roles and link text, no `data-testid` unless added deliberately).

**File**: `packages/ui-e2e/README.md`
**Changes**: layout of the package, the boot handshake, fixtures, seed manifest fields, remote mode, CI flow, and the P2 to P4 hooks (`ai` fixture slot, summary.json as the future ingest payload source).

### Success Criteria:

#### Automated Verification:
- [ ] Rebased and clean: `git fetch origin && git rebase origin/main && bun install --frozen-lockfile`
- [ ] Docs link check for the new section anchor: `grep -n "## UI E2E (bun run e2e:ui)" LOCAL_TESTING.md && grep -n "e2e:ui" CLAUDE.md runbooks/ci.md runbooks/testing.md apps/ui/CLAUDE.md`
- [ ] Full local gate after rebase: `bun run lint && bun run tsc:check && bun run e2e:ui:tsc && bun run e2e && bun run e2e:ui`

#### Automated QA:
- [ ] Follow the new `LOCAL_TESTING.md` section literally in a clean shell and confirm every command runs as written.

#### Manual Verification:
- [ ] Read the diff of the four docs once for tone and for the STE rules (short sentences, no em dashes).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 6] ui-e2e docs`.

---

## Manual E2E

Run from the repo root on the branch after Phase 6.

```bash
# 1. Local, full suite, fresh build
bun run e2e:ui

# 2. Local, headed pages flow
bun run e2e:ui -- --headed specs/pages.spec.ts

# 3. Remote mode against a second local API (seeded)
PORT=3999 DATABASE_PATH=/tmp/e2e-remote.sqlite AGENT_SWARM_API_KEY=remotekey NODE_ENV=test \
  GITHUB_DISABLE=true LINEAR_DISABLE=true JIRA_DISABLE=true SLACK_DISABLE=true bun run src/http.ts &
E2E_API_URL=http://127.0.0.1:3999 E2E_API_KEY=remotekey E2E_REMOTE_SEED=1 bun run e2e:ui

# 4. Prod refusal
E2E_API_URL=https://api.desplega.agent-swarm.dev E2E_API_KEY=x bun run e2e:ui; echo "exit=$?"

# 5. CI
git push -u origin <branch> && gh pr create --fill
gh run watch --workflow ui-e2e.yml
gh pr view --json comments --jq '.comments[] | select(.body | startswith("<!-- ui-e2e -->")) | .body' | head -40
```

---

## Appendix

- **Follow-up plans**: P2 tracker wiring, P3 swarm exploratory runner + green loop, P4 `pw.ai` (`DES-782`).
- **Derail notes**: the artifacts skill claims agent-fs viewer links are public (`templates/skills/artifacts/content.md:114`). They are not. Fix in P2.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-09-04-ui-e2e-swarm-driven-testing.md`
  - Prod swarm task `065bfdb9-fdf7-4a24-8acd-90f0cccb0f4d`, PR #1349 (tracker, changes requested)
  - Linear `DES-782` (pw.ai)

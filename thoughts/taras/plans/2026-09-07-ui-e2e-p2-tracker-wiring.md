---
date: 2026-09-07
author: taras
topic: "UI E2E P2: tracker wiring. agent-fs artifacts, ingest to the swarm script endpoint, tracker install"
tags: [plan, e2e, ui, playwright, ci, tracker, agent-fs, scripts]
status: completed
autonomy: autopilot
commit_per_phase: true
brainstorm: thoughts/taras/brainstorms/2026-09-04-ui-e2e-swarm-driven-testing.md
previous_plan: thoughts/taras/plans/2026-09-04-ui-e2e-p1-playwright-suite.md
---

# UI E2E P2: Tracker Wiring Implementation Plan

## Overview

Wire the P1 Playwright suite into the UI E2E tracker: every CI run uploads its artifacts to agent-fs under the tracker's path convention, the report job posts one v1 payload per shard to the swarm's `ui-e2e-ingest` script endpoint with a CI bearer, and the tracker template gets installed into the production swarm by the lead. This is phase 2 of the UI E2E brainstorm.

- **Motivation**: P1 (PR #1364, merged 2026-09-07) posts a sticky PR comment and nothing else. Main runs leave no record, failures open no incidents, screenshots expire with their signed URLs after seven days, and nothing prunes the uploads. The tracker template exists in `agent-work` but was never installed because the install task died in a deploy restart.
- **Related**: brainstorm (decisions 12 to 14, R5 to R7), P1 plan Appendix, `packages/ui-e2e/README.md` "Hooks for the next phases", `desplega-ai/agent-work` `workflows/ui-e2e-tracker/` (README install recipe, RUNBOOK contract, `schema/ui-e2e-ingest.v1.schema.json`), memory note `project_ui_e2e_p1_implementation.md`.

## Current State Analysis

**What P1 left in the repo (main `05c28f97`)**

- `packages/ui-e2e/reporter/summary.ts:33-53`: `onTestEnd` fires per attempt and pushes `{ specId: titlePath().slice(1).join(" > "), title, file, line, project, status, expectedStatus, durationMs, retry, error, tags, screenshots[{name, path}] }`. `onEnd` (`:55-71`) writes `test-results/summary.json` as `{ shard: { current, total } | null, startedAt, finishedAt, status, results[] }`. `specId` therefore looks like `chromium > specs/smoke.spec.ts > smoke /tasks @smoke`, and the same spec appears once per retry. Only `image/png` attachments are recorded; trace zips are dropped.
- `packages/ui-e2e/reporter/comment.ts:123-146`: `finalResults()` keeps the last attempt per `specId`, the max `retry`, and shows `flaky` for a pass after retries. `:236-241` renders the run link and the artifact name. Images come from `images.json` entries `{ name, url }`. Its `parseArgs` (`:44-79`) is a strict five-flag parser.
- `packages/ui-e2e/reporter/publish-images.sh`: bash plus `jq` plus the agent-fs CLI. Env `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID`. Uploads failure screenshots first, then smoke route screenshots, cap 24, to `<prefix>/<slug>-<n>.png`, mints 7-day presigned URLs, writes `images.json`. Exits 0 on any missing env or CLI failure. It does not upload traces, does not record agent-fs paths, and runs only for same-repo pull requests. Screenshot paths in `summary.json` are absolute runner paths; the script resolves them by the suffix after `/test-results/` inside the downloaded shard directory.
- `.github/workflows/ui-e2e.yml`: `test` job per shard uploads `ui-e2e-blob-N` and `ui-e2e-results-N`. `report` job downloads results into `all-results/ui-e2e-results-N/` (`:130-135`), merges the HTML report (`:137-139`), uploads `ui-e2e-html-report` (`:141-147`, no step id, so its `artifact-url` output is unused), gates both agent-fs steps to same-repo PRs (`:151`, `:167`), builds and upserts the sticky comment (`:179-203`), and fails last when a shard failed (`:205-211`). Triggers are PR paths, push to `main`, and `workflow_dispatch`. No `schedule`. `actions/upload-artifact` v7 exposes `artifact-id` and `artifact-url` outputs.
- `packages/ui-e2e/playwright.config.ts:7-17`: `retries: CI ? 2 : 1`, `trace: on-first-retry`, `screenshot: on`, `video: off`, CI reporters `blob` plus `summary`. So traces exist only for retried attempts (attachment name `trace`, `application/zip`), screenshots for every attempt (attachment name `screenshot`, plus the smoke spec's own route attachment).
- Repository secrets present: `E2E_AGENT_FS_API_URL`, `E2E_AGENT_FS_API_KEY`, `E2E_AGENT_FS_ORG_ID`, `E2E_AGENT_FS_DRIVE_ID`. No `UI_E2E_INGEST_*` secret and no repository variables.
- agent-fs CI identity (memory note): user `github@desplega.sh` (`a1301f5e-…`), org `t` `c5c27280-f28a-48e6-b1b4-1ae23bef7844`, default drive `a8dc7a37-9fab-4ab6-9e55-67a5d5e74d35`, API `https://agent-fs-taras.fly.dev`. Verified today with `agent-fs --org … --drive … tree e2e/agent-swarm`: PR #1364 uploads exist at `e2e/agent-swarm/pr-1364/<sha>/smoke-*.png`.
- Lint and typecheck: root `lint` is `biome check src apps/evals packages/ui-e2e`; `bun run e2e:ui:tsc` covers `reporter/`. `bunfig.toml:29` excludes `packages/ui-e2e/**` from Bun's test globber, so tests for Node-side reporter code either run under `node --test` or live in `src/tests/` and import the module.
- `templates/skills/artifacts/content.md:114` still says agent-fs links are "public, no auth required". No `SKILL.md` sits beside it, so `build:skill-md` is not involved. `templates/**` is a deploy trigger (`.github/workflows/docker-and-deploy.yml:3-27`), `packages/**` and `.github/workflows/ui-e2e.yml` are not.

**Tracker template (`desplega-ai/agent-work` main `65ef6aba`, `workflows/ui-e2e-tracker/`, local copy `/tmp/ui-e2e-p2/tracker`)**

- README install recipe steps 1 to 6: three `script_upsert` from `bundled/`, one bearer endpoint owned by the lead, two schedules, one synthetic ingest, verification, report. The bearer is stored as global secret config `UI_E2E_INGEST_BEARER` (README `:75-77`). That matches the brainstorm. The RUNBOOK's curl example uses `SWARM_E2E_INGEST_URL` and `SWARM_E2E_INGEST_TOKEN` (`RUNBOOK.md:34-40`) as placeholder env names only.
- Payload contract `schema/ui-e2e-ingest.v1.schema.json`, `additionalProperties: false` everywhere: `schemaVersion: 1`; `run { repo, ref, sha (7 to 40 hex), prNumber | null, isFork, trigger: pr | main | nightly | manual, runner: ci | swarm-worker | sandbox, shardIndex, shardTotal, startedAt, finishedAt, ciUrl? }`; `results[{ specId, title, status: passed | failed | skipped | flaky, durationMs, retries, error? }]`; `artifacts[{ kind: screenshot | trace | video | report | log, storage: agent-fs | github, path?, url?, orgId?, driveId?, specId?, sizeBytes? }]`; `findings[]`, `cost?`, `regeneratePage?`, `mode?`, `annotate?`.
- `specId` contract: `'<spec file path>:<full test title>'`, half of the incident fingerprint, must not vary between runs. Playwright statuses `timedOut` and `interrupted` are not in the enum.
- Run identity: `targetFor(prNumber)` is `pr-<N>` or `main` (`scripts/ui-e2e-core.ts:103-105`). Artifact prefix `artifactPathPrefix()` is `e2e/<repo with "/" replaced by "__">/<target>/<sha>/<shardIndex>/` (`:771-777`), so for this repo `e2e/desplega-ai__agent-swarm/pr-1364/<sha>/1/`. The current CI prefix `e2e/agent-swarm/pr-<n>/<sha>/` does not match.
- Prune (`scripts/ui-e2e-prune.ts:84-100`) derives stale prefixes from `runGroups` rows through `artifactPathPrefix()`, then calls `POST {base}/orgs/{orgId}/ops` with `{ op: "rm", path: "/<prefix>", recursive: true }` (`:145-150`). agent-fs `rm` accepts `{ path, expectedVersion? }` and deletes one key (`../agent-fs/packages/core/src/ops/types.ts:60-63`, `ops/rm.ts`). No recursive mode exists, and the call sends no `driveId`, so the ops route falls back to the token user's default drive (`../agent-fs/packages/server/src/routes/ops.ts:22-26`). The prune as written deletes nothing on agent-fs. `glob` supports `**` (`ops/glob.ts:9`, params `{ pattern, path? }`, `types.ts:410-413`), which gives a listing to delete file by file. **Decision (Taras, 2026-09-07): install as-is, fix the prune later.**
- Viewer links: `scripts/ui-e2e-ingest.ts:657` reads swarm config `AGENT_FS_LIVE_URL`, default `https://live.agent-fs.dev` (`core.ts:768`), form `/file/~/{orgId}/{driveId}/{path}`. agent-fs builds the same form from its server-side `AGENT_FS_APP_URL` (`../agent-fs/packages/core/src/config.ts:259`, `ops/urls.ts:1-9`). Whether `live.agent-fs.dev` renders files stored on `agent-fs-taras.fly.dev` is not verified. The install task asks the lead to check one link.
- Runtime facts the template already encodes: non-lead workers cannot read secrets, so only CI uses the bearer; apps upsert list-then-patch on `*Key` columns; `fnv1a64` fingerprint; page `authMode: authed`, slug `ui-e2e`; per-artifact `orgId` and `driveId` with config fallbacks `UI_E2E_AGENT_FS_ORG_ID` and `UI_E2E_AGENT_FS_DRIVE_ID`.

**Script endpoint in this repo**

- `src/http/x.ts:71-105`: `POST /api/x/script/{endpointId}`, `Authorization: Bearer <token>`, 401 on a bad bearer, 404 on an unknown or disabled endpoint, otherwise HTTP 200 with `{ ok, result, error, durationMs }` even when the script fails (`ok: false`). Body cap 1 MB (`:52`). Default wall clock 60 s, `X-Swarm-Timeout-Ms` up to 300000 (`:126-133`). Args are validated against the stored `argsJsonSchema` before the run (`:213-233`).
- Local install is possible for an end-to-end check: `POST /api/scripts/upsert` needs the lead's `X-Agent-ID` for `scope: global` (`src/http/scripts.ts:628-650`); `POST /api/scripts/{id}/apis` with `{ authMode: "bearer", label, agentId }` returns the plaintext bearer once (`:404-433`); `POST /api/scripts/run` `{ name, scope, args }` runs the synthetic ingest (`:70-82`); `POST /api/schedules` takes `targetType`, `scriptName`, `cronExpression` (`src/http/schedules.ts:90-108`); `GET /api/pages/resolve?slug=` resolves the page (`src/http/pages.ts:140-143`); `GET /api/apps/{id}/models/{model}/rows` reads rows (`src/http/apps.ts:458`). The sandbox wrapper handles macOS (`src/utils/sandboxed-process.ts` special-cases only win32).
- `src/workflows/json-schema-validator.ts` honours `type`, `required`, `properties`, `enum`, `const`, `items` only. `pattern`, `format`, `minimum`, `additionalProperties` are ignored. The Zod parse inside the script is the real gate.

**Why the production swarm tasks died early**

- Install task `a63a1c3d` (2026-09-04): claimed 20:10:42Z by a `pi` worker on `openrouter/deepseek/deepseek-v4-pro`, swarm `1.138.0`, progress "Reading" at 20:10:48Z, failed 20:13:17Z with `Auto-failed by reboot sweep: worker session not found after server restart`. PR #1351 merged to `main` at 20:01:46Z; `docker-and-deploy.yml` deploys on every push to `main` that touches `src/**` (and other paths). The deploy restarted the API about ten minutes later and the reboot sweep (`runbooks/heartbeat-crash-recovery.md` §1) failed every `in_progress` task whose session heartbeat predated the boot. `1.138.0` created no retry child. Nothing was installed.
- Invite task `1f2fc861` (2026-09-07): honest failure. The codex worker proved it is not an admin of agent-fs org `swarm` and stopped. Not a swarm defect.
- The same restart pattern repeated today: #1364 merged 11:04:06Z, the ACP task `9fa6a996` was auto-failed at 11:17:04Z, and `1.141.0` immediately created retry child `2a4749f9` tagged `reboot-retry`, `reboot-retry-pin`. So on the current version a deploy mid-task yields a pinned retry instead of a silent death. It still costs the run and its context. A new install task should be sent in a quiet `main` window, and the P2 PR (which touches `templates/**`) should merge only after the install task has finished.

## Desired End State

- `summary.json` carries what the tracker needs: a stable `titlePath`, every attachment with a path (screenshots and traces), the shard, and timestamps.
- `packages/ui-e2e/reporter/publish-artifacts.ts` replaces `publish-images.sh`. It uploads every screenshot, every trace, and each shard's `summary.json` to agent-fs under `e2e/desplega-ai__agent-swarm/<pr-N|main>/<sha>/<shard>/`, writes `artifacts.json` (agent-fs paths, kinds, spec ids, sizes) and `images.json` (7-day presigned URLs, failures first, cap 24) for the comment.
- `packages/ui-e2e/reporter/ingest.ts` builds one v1 payload per shard from the summaries and `artifacts.json`, writes them to disk, and posts each to `UI_E2E_INGEST_URL` with `UI_E2E_INGEST_BEARER`. Missing secrets skip with a notice. A configured endpoint that answers anything but `200 { ok: true }` fails the report job.
- `.github/workflows/ui-e2e.yml` runs on PRs, pushes to `main`, a nightly cron, and dispatch. Trigger map: `pull_request` to `pr`, `push` to `main`, `schedule` to `nightly`, `workflow_dispatch` to `manual` (with the PR number resolved when the branch has an open PR). Uploads and ingest run for every same-repo event. The HTML report artifact URL rides along as a `storage: github` artifact. The sticky comment links the tracker page when the repository variable `UI_E2E_TRACKER_URL` is set.
- The tracker is installed in the production swarm by the lead (three scripts, one bearer endpoint, two schedules, app, workflows, page). The bearer sits in the swarm's secret config `UI_E2E_INGEST_BEARER` and in the GitHub secret of the same name. `UI_E2E_INGEST_URL` is a GitHub secret. A dispatch of the workflow shows up as a run group on the tracker page.
- Docs updated: `LOCAL_TESTING.md`, `runbooks/ci.md`, `packages/ui-e2e/README.md`, the artifacts skill line.

Verification: `bun run e2e:ui` still green; unit tests for the payload builder and the upload plan pass; a local API with the template installed accepts the real payload (`ok: true`, rows in `uiE2eTracker`, page regenerated); the PR's workflow run publishes artifacts and, once the secrets exist, ingests with `ok: true`; the tracker page lists the run.

## What We're NOT Doing

- No fix of the template's agent-fs prune (`rm` is single-key, no `driveId`). Decision: install as-is, fix later. Captured in the Appendix and as a follow-up for the tracker.
- No `workflow_run` publisher for fork PRs. Fork runs still upload GitHub artifacts only and ingest nothing (`isFork` is never `true` in P2 payloads).
- No swarm exploratory runner, no `findings`, no `cost` block (P3).
- No `pw.ai` (P4, `DES-782`).
- No changes to the tracker's models, incidents, or page rendering. The template is consumed as published at `65ef6aba`.
- No merge-gate integration. The workflow stays informational.
- No new dependencies. The agent-fs CLI is still installed with `npm i -g @desplega.ai/agent-fs@0.13.5` in the report job.

## Implementation Approach

- Keep the reporter contract in three Node scripts with one shared flag parser: `summary.ts` (Playwright side), `publish-artifacts.ts` (agent-fs side), `ingest.ts` (tracker side). `comment.ts` stays and gains one optional flag.
- Pure functions first: `ingest-payload.ts` (summaries plus artifacts to payloads) and `publish-plan.ts` (summaries to an ordered upload list and the image pick) are side-effect free and unit-tested under `bun test` from `src/tests/`, with the vendored v1 JSON schema as the oracle plus explicit assertions for the keywords the repo validator ignores.
- Artifact paths follow the template's convention exactly so the prune, once fixed, finds them: `e2e/desplega-ai__agent-swarm/<target>/<sha>/<shardIndex>/<file>`.
- Tracker `specId` is `<file>:<titlePath joined by " > ">`, derived from `summary.json`, never from the human comment label.
- Status map: Playwright `passed` with retries becomes `flaky`; `timedOut` and `interrupted` become `failed` with the error text; `skipped` stays `skipped`.
- The workflow computes run context once (`same_repo`, `trigger`, `target`, `sha`, `ref`, `pr`) in a single step and every later step reads those outputs.
- Ingest posture: skip silently when the secrets are absent, fail loud when they are present and the endpoint rejects. The payloads are always uploaded as a GitHub artifact for inspection.
- Prove the payload against the real script before touching production: install the template into a local API with a small Bun script, run the suite, publish in dry-run, ingest for real, read the rows and the page. The same script, pointed at production, is the fallback if the lead's install task fails.
- Sequencing: reporter contract, then publisher plus workflow, then the local end-to-end plus PR, then docs, then the production install and the live verification. The PR merges only after the install task has finished (its merge deploys, and a deploy restarts the swarm).

Decisions from the design check-in (2026-09-07):

- **Triggers**: PR, main, manual, and a nightly cron (`0 3 * * *` UTC) on `main` mapped to `nightly`.
- **Uploads**: replace `publish-images.sh` with `reporter/publish-artifacts.ts` (Node, shells out to the agent-fs CLI). The HTML report stays a GitHub artifact linked by URL.
- **Prune**: install the template as-is; fix the agent-fs prune later.
- **Install**: the lead installs through a task sent by Taras (`!` prefix, quiet `main` window). Fallback: a direct-API Bun script run by Taras with the prod key. The bearer is never printed.

## Quick Verification Reference

- `bun run test:root -- src/tests/ui-e2e-ingest-payload.test.ts src/tests/ui-e2e-publish-plan.test.ts`
- `bun run e2e:ui -- --no-build --grep "^home"` (fast harness check) and `bun run e2e:ui` (full)
- `bun run e2e:ui:tsc && bun run lint && bun run tsc:check`
- `node --experimental-strip-types packages/ui-e2e/reporter/ingest.ts --summaries <dir> --artifacts <file> --out <dir> --dry-run`
- `node --experimental-strip-types packages/ui-e2e/reporter/publish-artifacts.ts --results <dir> --prefix <prefix> --artifacts-out <file> --images-out <file> --dry-run`
- `bunx actionlint .github/workflows/ui-e2e.yml`
- `bun run check:dep-graph && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh`

---

## Phase Outline

| Phase | Deliverable | Proves |
|---|---|---|
| 1 | `summary.ts` v2 fields, `reporter/cli.ts` flag parser, `reporter/ingest-payload.ts` + vendored schema, `reporter/ingest.ts` CLI, unit test | A shard summary becomes a schema-valid v1 payload and reaches an endpoint |
| 2 | `reporter/publish-plan.ts` + `reporter/publish-artifacts.ts` (replaces the bash script), `comment.ts` tracker link, `ui-e2e.yml` rewrite of the report job (context step, nightly cron, uploads for every same-repo event, ingest step, payload artifact) | Artifacts land under the template prefix and the workflow is wired end to end |
| 3 | Local end-to-end: `/tmp/ui-e2e-p2/install-tracker.ts` installs the template into a local API; real ingest of a real run; rows and page verified; branch pushed, PR opened, CI run inspected | The payload passes the script's Zod gate and the tracker renders it |
| 4 | Docs: `LOCAL_TESTING.md`, `runbooks/ci.md`, `packages/ui-e2e/README.md`, artifacts skill fix | Contributors can run, debug, and configure the ingest |
| 5 | Production install: install task text + send script for Taras, wait, secrets set by Taras, dispatch run, tracker page verified; fallback script ready | The production tracker receives CI runs |

## Phase 1: Reporter contract and the ingest CLI

### Overview

`summary.json` records `titlePath` and every attachment, and `reporter/ingest.ts` turns a directory of shard summaries plus an `artifacts.json` into schema-valid v1 payloads and posts them.

### Changes Required:

#### 1. Summary reporter fields
**File**: `packages/ui-e2e/reporter/summary.ts`
**Changes**: add `titlePath: string[]` (`test.titlePath().slice(3)`: drop root, project, and file, so `["smoke /tasks @smoke"]` or `["below the lg breakpoint", "session logs open from the Session Logs tab"]`) and `attachments: Array<{ name, contentType, path }>` (every attachment with a `path`). Keep `screenshots` for `comment.ts` and the old shape. Keep `specId` unchanged.

#### 2. Shared flag parser
**File**: `packages/ui-e2e/reporter/cli.ts`
**Changes**: `parseFlags(argv, { required: string[], optional?: string[], booleans?: string[] })` returning `Map<string, string | true>`; throws on unknown, duplicate, or missing flags. `comment.ts` switches to it (behaviour unchanged) and gains optional `--tracker-url`.

#### 3. Payload builder (pure)
**File**: `packages/ui-e2e/reporter/ingest-payload.ts`
**Changes**: exported types `IngestPayload`, `RunContext { repo, ref, sha, prNumber: number | null, trigger, runner: "ci", ciUrl? }`, `ArtifactRecord { kind, path, orgId, driveId, specId: string | null, sizeBytes, shardIndex }`. `buildShardPayload(summary, artifacts, run, reportArtifactUrl?)`:
- `run.shardIndex`/`shardTotal` from `summary.shard` (`{ current, total }`) or `1/1`; `startedAt`/`finishedAt` from the summary.
- One result per tracker `specId = ${file}:${titlePath.join(" > ")}` (fallback to `specId` minus the project prefix when `titlePath` is absent). Final attempt wins, `retries = max(retry)`. Status map: `passed` with `retries > 0` to `flaky`; `timedOut`/`interrupted` to `failed`; `error` from the final attempt, or `"<status> without error text"` when a failed result has none.
- `artifacts`: records whose `shardIndex` matches, as `{ kind, storage: "agent-fs", path, orgId, driveId, specId, sizeBytes }`; plus `{ kind: "report", storage: "github", url: reportArtifactUrl }` when given.
- `schemaVersion: 1`, `isFork: false`. Throws on a `sha` that is not 7 to 40 hex chars, a `repo` without a slash, or an unknown trigger.
`triggerFor(eventName)`: `pull_request` to `pr`, `push` to `main`, `schedule` to `nightly`, anything else to `manual`.

**File**: `packages/ui-e2e/reporter/ui-e2e-ingest.v1.schema.json`
**Changes**: verbatim copy of `/tmp/ui-e2e-p2/tracker/schema/ui-e2e-ingest.v1.schema.json` (agent-work `65ef6aba`). The README notes the source and that v1 is frozen.

#### 4. Ingest CLI
**File**: `packages/ui-e2e/reporter/ingest.ts`
**Changes**: `node --experimental-strip-types reporter/ingest.ts --summaries <dir> --artifacts <artifacts.json> --out <dir> [--report-url <url>] [--dry-run]`. Run context from env: `GITHUB_REPOSITORY`, `UI_E2E_TRIGGER`, `UI_E2E_SHA`, `UI_E2E_REF`, `UI_E2E_PR_NUMBER` (empty means `null`), `GITHUB_SERVER_URL` + `GITHUB_RUN_ID` for `ciUrl`. For each `summary.json` under `--summaries` build the payload and write `<out>/shard-<index>.json`. Then, unless `--dry-run`: when `UI_E2E_INGEST_URL` or `UI_E2E_INGEST_BEARER` is empty print `ingest skipped: UI_E2E_INGEST_URL or UI_E2E_INGEST_BEARER is not set` and exit 0; otherwise POST each payload with `Authorization: Bearer`, `Content-Type: application/json`, `X-Swarm-Timeout-Ms: 180000`, print `shard N: HTTP <status> ok=<bool> durationMs=<n>` plus a compact `result` summary (never the bearer, never the URL's path beyond the host), and exit 1 if any response is not HTTP 200 with `ok: true`. `--artifacts` may point at a missing file (treated as empty) so a run without agent-fs secrets still ingests results.

#### 5. Unit test
**File**: `src/tests/ui-e2e-ingest-payload.test.ts`
**Changes**: Bun test importing `../../packages/ui-e2e/reporter/ingest-payload.ts` and `validateJsonSchema` from `../workflows/json-schema-validator`. Fixture summaries built inline: a two-attempt failed-then-passed spec (flaky), a `timedOut` spec, a skipped spec, a nested describe title. Assertions: schema validation returns no errors; top-level keys and `run`/`results[]`/`artifacts[]` keys are exactly the schema's properties (covers the ignored `additionalProperties`); `sha` regex; `specId` equals `specs/tasks.spec.ts:below the lg breakpoint > session logs open from the Session Logs tab`; `retries` and status map; the GitHub report artifact appears once; a shard mismatch drops the artifact; `triggerFor` map.

### Success Criteria:

#### Automated Verification:
- [x] Unit test green: `bun run test:root -- src/tests/ui-e2e-ingest-payload.test.ts`
- [x] Package typechecks: `bun run e2e:ui:tsc`
- [x] Root gates: `bun run lint && bun run tsc:check`
- [x] Promise and boundary checks: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh && bun run check:dep-graph`
- [x] Summary v2 written: `bun run e2e:ui -- --no-build --grep "^home"` then `jq '.results[0] | has("titlePath") and has("attachments")' packages/ui-e2e/test-results/summary.json` prints `true`
- [x] Dry run produces a payload: `node --experimental-strip-types packages/ui-e2e/reporter/ingest.ts --summaries packages/ui-e2e/test-results --artifacts /nonexistent.json --out /tmp/ui-e2e-p2/payloads --dry-run` with `GITHUB_REPOSITORY=desplega-ai/agent-swarm UI_E2E_TRIGGER=manual UI_E2E_SHA=$(git rev-parse HEAD) UI_E2E_REF=ui-e2e-p2`, then `jq '.run.trigger, (.results | length)' /tmp/ui-e2e-p2/payloads/shard-1.json`
- [x] Skip path: same command without `--dry-run` and without `UI_E2E_INGEST_URL` exits 0 and prints the skip notice
- [x] Comment builder unchanged: `node --experimental-strip-types packages/ui-e2e/reporter/comment.ts --summaries packages/ui-e2e/test-results --images /dev/null --run-url https://example --report-artifact x --out /tmp/ui-e2e-p2/c.md && head -1 /tmp/ui-e2e-p2/c.md | grep -q 'ui-e2e'`; with `--tracker-url https://example/p/x` the last lines contain `Tracker`

#### Automated QA:
- [x] Reject path: start a throwaway `node -e` HTTP server on a free port that answers `200 {"ok":false,"error":{"type":"args_validation","message":"x"}}`; run `ingest.ts` against it with a dummy bearer; exit code is 1 and the output contains `ok=false` and never the bearer string.
- [x] Full-suite summary: `bun run e2e:ui -- --no-build` then the dry-run payload has one result per spec in `packages/ui-e2e/specs/` (`jq '.results | length'` equals the number of `test(` calls across the specs, 40 with the current routes) (actual: 55 results, the route list has more entries than estimated), every `specId` starts with `specs/`, and no status outside `passed|failed|skipped|flaky`.

#### Manual Verification:
- [x] None.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] ui-e2e ingest payload and CLI`.

---

## Phase 2: Artifact publisher and the workflow

### Overview

`reporter/publish-artifacts.ts` replaces the bash script and the report job uploads, comments, and ingests for every same-repo event, including the new nightly cron.

### Changes Required:

#### 1. Upload plan (pure)
**File**: `packages/ui-e2e/reporter/publish-plan.ts`
**Changes**: `buildUploadPlan(summaries: Array<{ dir, summary }>, basePrefix)` returns `UploadItem[]`: for every attempt of every result, each attachment with a path becomes `{ localPath (resolved by the suffix after "/test-results/" inside dir, or the absolute path when it exists), remotePath: ${basePrefix}/${shardIndex}/${slug(specId)}[-r${retry}]-${attachmentName}.${ext}, kind: png to "screenshot" | zip named trace to "trace" | else skip, specId (tracker form), shardIndex }`. The automatic `screenshot` attachment is skipped when the same attempt has another PNG (the smoke route shot). Each `summary.json` is added as `{ kind: "log", remotePath: ${basePrefix}/${shardIndex}/summary.json }`. `pickImages(plan, results, cap)` returns the comment images in the P1 order: failures first (final attempt), then smoke route screenshots by file order, cap 24, `name` as P1 formatted it.

#### 2. Publisher CLI
**File**: `packages/ui-e2e/reporter/publish-artifacts.ts`
**Changes**: `node --experimental-strip-types reporter/publish-artifacts.ts --results <dir> --prefix <basePrefix> --artifacts-out <file> --images-out <file> [--image-cap 24] [--concurrency 4] [--dry-run]`. Env `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID`, `GITHUB_SHA`. Writes `[]` to both outputs first. Without `--dry-run`: if any env is missing, `agent-fs` is not on PATH, or `agent-fs auth whoami` fails, print why and exit 0. Otherwise run the plan with a pool of `--concurrency` `spawnSync`-free async spawns (`child_process.spawn` wrapped in a promise) of `agent-fs write <remote> --file <local> -m "ui-e2e <sha>"`; a failed upload is logged and skipped. Each success appends `{ kind, path, orgId, driveId, specId, sizeBytes (statSync), shardIndex }` to `artifacts.json`. Then mint `agent-fs signed-url <remote> --json --expires-in 604800` for the picked images and write `images.json` `[{ name, url, expiresAt }]`, skipping non-`presigned` kinds. Print `Published N artifacts, M images.` `--dry-run` writes the full plan into `artifacts.json` with `dryRun: true` entries and the image pick into `images.json` with `url: ""`, no network.

**File**: `packages/ui-e2e/reporter/publish-images.sh`
**Changes**: deleted.

#### 3. Workflow
**File**: `.github/workflows/ui-e2e.yml`
**Changes**:
- `on.schedule: [{ cron: "0 3 * * *" }]`. Concurrency group unchanged.
- `report` job, new first step after checkout `Resolve run context` (`id: context`, `env.GH_TOKEN: ${{ github.token }}`): outputs `same_repo` (`true` unless `pull_request` from another repo), `trigger` (`pr` | `main` | `nightly` | `manual` from `github.event_name`), `sha` (`github.event.pull_request.head.sha` for PRs, else `GITHUB_SHA`), `ref` (`github.head_ref` for PRs, else `github.ref_name`), `pr` (PR number for PRs; for `workflow_dispatch` the first open PR whose head is the ref via `gh pr list --head "$GITHUB_REF_NAME" --state open --json number --jq '.[0].number // empty'`; empty otherwise), `target` (`pr-<n>` when `pr` is set, else `main`).
- HTML report upload step gets `id: html-report`.
- `Check agent-fs secrets` and `Publish artifacts to agent-fs` conditions become `steps.context.outputs.same_repo == 'true'` (plus the secrets output for the publish step). Publish runs `reporter/publish-artifacts.ts --results all-results --prefix "e2e/desplega-ai__agent-swarm/${{ steps.context.outputs.target }}/${{ steps.context.outputs.sha }}" --artifacts-out artifacts.json --images-out images.json`.
- Comment step adds `--tracker-url "${{ vars.UI_E2E_TRACKER_URL }}"` (the parser accepts an empty value and omits the line).
- New step `Ingest into the UI E2E tracker` (`if: steps.context.outputs.same_repo == 'true'`, `working-directory: packages/ui-e2e`), env `UI_E2E_INGEST_URL`, `UI_E2E_INGEST_BEARER` from secrets, `UI_E2E_TRIGGER`, `UI_E2E_SHA`, `UI_E2E_REF`, `UI_E2E_PR_NUMBER` from the context outputs, runs `reporter/ingest.ts --summaries all-results --artifacts artifacts.json --out ingest-payloads --report-url "${{ steps.html-report.outputs.artifact-url }}"` and appends its stdout to `$GITHUB_STEP_SUMMARY`. No `continue-on-error`.
- New step `Upload ingest payloads` (`if: always()`, artifact `ui-e2e-ingest-payloads`, paths `packages/ui-e2e/ingest-payloads` and `packages/ui-e2e/artifacts.json`, `if-no-files-found: ignore`).
- `.gitignore` gains `packages/ui-e2e/ingest-payloads/`, `packages/ui-e2e/artifacts.json`, `packages/ui-e2e/images.json`.

#### 4. Unit test
**File**: `src/tests/ui-e2e-publish-plan.test.ts`
**Changes**: fixtures with two shard summaries (absolute runner paths) laid out under a temp `all-results/ui-e2e-results-N/` tree with empty placeholder files; assert remote paths use the template prefix and shard subdirectory, the automatic `screenshot` is skipped for a passed smoke attempt but kept for a failed one, a `trace` zip maps to `kind: "trace"`, `summary.json` becomes `kind: "log"`, unresolvable local paths are dropped with a warning entry, and `pickImages` returns failures first then smoke routes, capped.

### Success Criteria:

#### Automated Verification:
- [x] Unit tests green: `bun run test:root -- src/tests/ui-e2e-publish-plan.test.ts src/tests/ui-e2e-ingest-payload.test.ts`
- [x] Package typechecks and root gates: `bun run e2e:ui:tsc && bun run lint && bun run tsc:check`
- [x] Workflow syntax: `bunx actionlint .github/workflows/ui-e2e.yml`
- [x] Bash script gone and no references remain: `test ! -f packages/ui-e2e/reporter/publish-images.sh && ! grep -rn "publish-images" .github packages/ui-e2e LOCAL_TESTING.md runbooks`
- [x] Dry-run plan from a real run: `bun run e2e:ui -- --no-build --shard=1/2` then copy `packages/ui-e2e/test-results` to `/tmp/ui-e2e-p2/all-results/ui-e2e-results-1`, run `publish-artifacts.ts --results /tmp/ui-e2e-p2/all-results --prefix e2e/desplega-ai__agent-swarm/local/$(git rev-parse HEAD) --artifacts-out /tmp/ui-e2e-p2/artifacts.json --images-out /tmp/ui-e2e-p2/images.json --dry-run` and `jq '[.[] | .path] | all(startswith("e2e/desplega-ai__agent-swarm/local/"))' /tmp/ui-e2e-p2/artifacts.json` prints `true`, `jq 'map(select(.kind=="log")) | length' /tmp/ui-e2e-p2/artifacts.json` prints `1`
- [x] Missing env exits 0: `env -u AGENT_FS_API_KEY node --experimental-strip-types packages/ui-e2e/reporter/publish-artifacts.ts --results /tmp/ui-e2e-p2/all-results --prefix x --artifacts-out /tmp/ui-e2e-p2/a.json --images-out /tmp/ui-e2e-p2/i.json; test $? -eq 0 && test "$(cat /tmp/ui-e2e-p2/a.json)" = "[]"`

#### Automated QA:
- [x] Chain dry-run publisher into the ingest builder: `ingest.ts --summaries /tmp/ui-e2e-p2/all-results --artifacts /tmp/ui-e2e-p2/artifacts.json --out /tmp/ui-e2e-p2/payloads --dry-run` yields `shard-1.json` whose `artifacts` count equals the dry-run plan entries for shard 1 and whose `run.shardTotal` is 2.
- [x] (Codex and the Opus review ran the extracted script: schedule gives `trigger=nightly target=main`, fork PR gives `same_repo=false target=pr-7`) Context step logic exercised locally: extract the `Resolve run context` script into a temp file and run it with `GITHUB_EVENT_NAME=schedule GITHUB_SHA=<sha> GITHUB_REF_NAME=main` and with `GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF_NAME=ui-e2e-p2` (after the PR exists in Phase 3, re-run to see `pr` resolved); outputs match the map.

#### Manual Verification:
- [x] None.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] agent-fs artifact publisher and tracker ingest in ui-e2e.yml`.

Review deltas applied before the commit (2026-09-07): shard-directory containment in `localPathFor` plus a unit test; pool tasks wrapped in try/catch and the publisher exits 1 when every upload fails; `concurrency.group` now includes the event name so the nightly run and a push to `main` no longer cancel each other; context outputs, the tracker variable, and the report URL reach `run:` blocks through `env:`; `SummaryFile` alias and the unused `screenshots` field removed; README layout rows updated early so the Phase 2 grep gate holds.

---

## Phase 3: Local end-to-end against the installed template, then the PR

### Overview

The template is installed into a local API with a reusable Bun script, a real run is ingested through the real endpoint, the app rows and the page prove the contract, and the branch goes up as a PR whose CI run publishes artifacts and skips ingest cleanly.

### Changes Required:

#### 1. Install script (outside the repo, reused as the production fallback)
**File**: `/tmp/ui-e2e-p2/install-tracker.ts`
**Changes**: Bun script. Env `SWARM_API_URL`, `SWARM_API_KEY`, `LEAD_AGENT_ID`, `TEMPLATE_DIR` (default `/tmp/ui-e2e-p2/tracker`), `BEARER_OUT` (file path, written `0600`), optional `STORE_BEARER_CONFIG=1`. Steps mirror the README recipe: `POST /api/scripts/upsert` for the three `bundled/*.ts` with `scope: global`, `X-Agent-ID: LEAD_AGENT_ID`, the README descriptions and intents with ` [ui-e2e-tracker template v1]`; `GET /api/scripts/{id}/apis` and create `POST /api/scripts/{id}/apis { authMode: "bearer", label: "ui-e2e ingest", agentId }` only when no enabled endpoint exists (write the bearer to `BEARER_OUT`, print only the endpoint id; with `STORE_BEARER_CONFIG=1` also `PUT /api/config { scope: "global", key: "UI_E2E_INGEST_BEARER", value, isSecret: true }`); `POST /api/schedules` for `ui-e2e-sweep` (`*/15 * * * *`) and `ui-e2e-prune` (`0 4 * * *`) with `targetType: "script"` unless a schedule of that name exists; `PUT /api/config` for `UI_E2E_AGENT_FS_ORG_ID` and `UI_E2E_AGENT_FS_DRIVE_ID` from env when given; `POST /api/scripts/run { name: "ui-e2e-ingest", scope: "global", args: <README step-4 payload> }` with the lead's `X-Agent-ID`; verification prints: script names and versions, endpoint id, schedule ids, app id and model count, workflow names, page id and `authMode`. Exit 1 on any non-2xx. Never prints the bearer or the API key.

#### 2. Local proof
**Steps** (recorded in the plan's Manual E2E and executed here):
1. Boot a local API on a free port with a temp DB: `PORT=$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop()')` then `PORT=$PORT MCP_BASE_URL=http://127.0.0.1:$PORT DATABASE_PATH=/tmp/ui-e2e-p2/tracker.sqlite AGENT_SWARM_API_KEY=localkey API_KEY=localkey GITHUB_DISABLE=true LINEAR_DISABLE=true JIRA_DISABLE=true SLACK_DISABLE=true HEARTBEAT_DISABLE=true bun --no-env-file run src/http.ts` (background, log to `/tmp/ui-e2e-p2/api.log`). `MCP_BASE_URL` must point at the same port: the scripts runtime calls back into the API through it and defaults to `localhost:3013`. `--no-env-file` keeps a repo `.env` from overriding the port.
2. Create the lead: `POST /api/agents { name: "p2-lead", isLead: true }`.
3. Run `install-tracker.ts` with `STORE_BEARER_CONFIG=1`, `UI_E2E_AGENT_FS_ORG_ID=c5c27280-…`, `UI_E2E_AGENT_FS_DRIVE_ID=a8dc7a37-…`.
4. Produce two shard summaries: `bun run e2e:ui -- --no-build --shard=1/2` and `--shard=2/2`, copying `test-results` into `/tmp/ui-e2e-p2/all-results/ui-e2e-results-{1,2}` between runs.
5. Dry-run publish for the plan, then ingest for real: `UI_E2E_INGEST_URL=http://127.0.0.1:$PORT/api/x/script/<endpointId> UI_E2E_INGEST_BEARER=$(cat /tmp/ui-e2e-p2/bearer) GITHUB_REPOSITORY=desplega-ai/agent-swarm UI_E2E_TRIGGER=pr UI_E2E_PR_NUMBER=<pr or 9999> UI_E2E_SHA=$(git rev-parse HEAD) UI_E2E_REF=ui-e2e-p2 node --experimental-strip-types packages/ui-e2e/reporter/ingest.ts --summaries /tmp/ui-e2e-p2/all-results --artifacts /tmp/ui-e2e-p2/artifacts.json --out /tmp/ui-e2e-p2/payloads --report-url https://github.com/desplega-ai/agent-swarm/actions/runs/0/artifacts/0`.
6. Read back: `GET /api/apps` (find `uiE2eTracker`), `GET /api/apps/{id}/models/runGroups/rows` (one group, `status: passed`, `target: pr-<n>`), `.../runs/rows` (two shards), `.../results/rows` (count equals total results), `.../artifacts/rows` (agent-fs rows plus one github report row per shard), `GET /api/pages/resolve?slug=ui-e2e` (`authMode: authed`, version bumped).
7. Incident path: post a hand-edited copy of `shard-1.json` with `run.trigger: "main"`, `run.prNumber: null`, a new `sha`, and one result flipped to `failed` with an error; expect one `incidents` row (`status: open`) and a workflow run or task created by the triage dispatch; then post the same sha with all passed and `shardTotal: 1` to see it close.
8. Retry idempotency: post `shard-1.json` twice; `runs` rows stay at two, `attempt` is 2.
9. Screenshot the tracker page through the dashboard preview with `agent-browser` (`/pages/<id>`), save `/tmp/ui-e2e-p2/tracker-page.png`.
10. Stop the API, keep `/tmp/ui-e2e-p2/tracker.sqlite` for inspection.

#### 3. PR
Push with `ANTHROPIC_API_KEY= git push -u origin ui-e2e-p2`, open the PR with the local proof summary and the screenshot uploaded to agent-fs (`agent-fs write qa/agent-swarm/2026-09-07-ui-e2e-p2/tracker-page.png --file … && agent-fs signed-url … --json`), and watch `ui-e2e.yml`.

### Success Criteria:

#### Automated Verification:
- [x] (verified 2026-09-07 with `/tmp/ui-e2e-p2/verify-install.sh`: two runs, same endpoint id, three scripts, one endpoint, two schedules) Install script idempotent: run `install-tracker.ts` twice against the local API; second run prints the same ids, `GET /api/scripts?scope=global` shows exactly three `ui-e2e-*` scripts, `GET /api/scripts/{id}/apis` shows one endpoint, `GET /api/schedules` shows one `ui-e2e-sweep` and one `ui-e2e-prune`
- [x] (shard 1: HTTP 200 ok=true 292 ms, shard 2: HTTP 200 ok=true 79 ms, shardTotal 2) Real ingest accepted: both POSTs print `HTTP 200 ok=true`; `jq '.run.shardTotal' /tmp/ui-e2e-p2/payloads/shard-2.json` is `2`
- [x] (runGroups pr-9999: status passed, shardsReported 2, 38 pass / 17 skip; runs 2; results 55 = 53 + 2; artifacts 59 = 57 plan entries + 2 github report rows) Rows match: `runGroups` 1 row with `status == "passed"`, `runs` 2 rows, `results` row count equals `jq '[.results|length]|add' shard-1.json shard-2.json`, `artifacts` rows equal the plan entries plus 2
- [x] (one incident, open with occurrences 1 and triageStatus dispatched, `ui-e2e-incident-triage` created once, a workflow run plus an unassigned task dispatched; closed after the all-passed post) Incident opened and closed by the two follow-up posts (`incidents` rows: 1, `status` goes `open` then `closed`, `occurrences` 1)
- [x] (runs stayed at 2, shard 1 attempt 2, results and artifacts counts unchanged) Retry keeps two `runs` rows and `attempt == 2` on shard 1
- [x] Page resolved: `GET /api/pages/resolve?slug=ui-e2e` returns `authMode: "authed"` (that route carries no `version`; `GET /api/pages/{id}/versions` showed 2 snapshots, so the page was regenerated)
- [x] Root gates before push: `bun run lint && bun run tsc:check && bun run e2e:ui:tsc && bun run test:root -- src/tests/ui-e2e-ingest-payload.test.ts src/tests/ui-e2e-publish-plan.test.ts && bun run e2e`
- [x] (PR #1373, run 34144525684: test (1), test (2), report all success) PR open and workflow complete: `gh pr create` then `gh run list --workflow ui-e2e.yml --branch ui-e2e-p2 --limit 1` shows `completed`

#### Automated QA:
- [x] (`Published 57 artifacts, 24 images.`; tree shows `pr-1373/78d4ad89…/1/` with 54 files and `/2/` with 3 files, `summary.json` in each) CI publish step log shows `Published N artifacts` with N > 0 and `agent-fs --org c5c27280-f28a-48e6-b1b4-1ae23bef7844 --drive a8dc7a37-9fab-4ab6-9e55-67a5d5e74d35 tree e2e/desplega-ai__agent-swarm/pr-<n>/<sha> --json` lists `1/` and `2/` with `summary.json` in each
- [x] (`ingest skipped: UI_E2E_INGEST_URL or UI_E2E_INGEST_BEARER is not set`, job green; payloads: shard 1 trigger pr, prNumber 1373, 53 results, 55 artifacts; shard 2 2 results, 4 artifacts. Found and fixed: `run.ciUrl` lacked the repository segment) CI ingest step log shows the skip notice (secrets absent) and the job stays green; `gh run download <id> -n ui-e2e-ingest-payloads` yields `shard-1.json` and `shard-2.json` with `run.trigger == "pr"` and `run.prNumber == <n>`
- [x] (one marker comment, 24 image links) Sticky comment still renders images (`gh pr view <n> --json comments --jq '.comments[] | select(.body | startswith("<!-- ui-e2e -->")) | .body' | grep -c '!\['` > 0)
- [x] `agent-browser` screenshot of the tracker page shows the `pr-<n>` section with two shard rows and the incident section from step 7 (actual rendering: one row per run group with a `2/2` shards cell, `/tmp/ui-e2e-p2/e2e/tracker-page.png`; the incident is visible in `/tmp/ui-e2e-p2/e2e/tracker-page-incident.png`, captured with the incident re-opened because step 7 closes it before step 9; `authed` pages accept only the `page_session` cookie from `POST /api/pages/{id}/launch`)

#### Manual Verification:
- [x] None.

Findings from the proof (2026-09-07): the dry-run publisher wrote `orgId: ""` when the agent-fs env was unset, which defeated the template's `??` config fallback and rendered every viewer link as `none`; `orgId` and `driveId` are now optional and omitted when empty (fixed in this phase, unit-tested). The two CI shards are imbalanced (shard 1 holds the 53-route smoke file, shard 2 two tests) because Playwright shards by file with `fullyParallel: false`; left as a derail note. The template renders the GitHub report link once per shard until a re-ingest dedups it (cosmetic, agent-work side).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] local tracker install script and E2E evidence` (the commit holds only repo changes made during the proof, such as fixture tweaks; the install script stays in `/tmp` and is quoted in the PR body).

---

## Phase 4: Docs and the artifacts skill fix

### Overview

The docs describe the ingest, the artifact convention, the secrets, and the tracker, and the artifacts skill stops claiming agent-fs links are public.

### Changes Required:

#### 1. Files
**File**: `LOCAL_TESTING.md`
**Changes**: under `## UI E2E (bun run e2e:ui)` add `### Tracker ingest and artifacts`: the three reporter commands with `--dry-run`, the env table (`UI_E2E_INGEST_URL`, `UI_E2E_INGEST_BEARER`, `UI_E2E_TRIGGER`, `UI_E2E_SHA`, `UI_E2E_REF`, `UI_E2E_PR_NUMBER`, agent-fs vars), the prefix convention, where `ingest-payloads` and `artifacts.json` land, the skip-versus-fail posture, and the local install recipe pointer (`agent-work` README plus the Phase 3 steps in this plan).

**File**: `runbooks/ci.md`
**Changes**: `ui-e2e.yml` row mentions the nightly cron, agent-fs uploads for every same-repo event, and tracker ingest; a short `### ui-e2e.yml secrets and variables` list: `E2E_AGENT_FS_API_URL`, `E2E_AGENT_FS_API_KEY`, `E2E_AGENT_FS_ORG_ID`, `E2E_AGENT_FS_DRIVE_ID`, `UI_E2E_INGEST_URL`, `UI_E2E_INGEST_BEARER`, variable `UI_E2E_TRACKER_URL`, with who owns each and what happens when it is absent.

**File**: `packages/ui-e2e/README.md`
**Changes**: layout table rows for `cli.ts`, `ingest-payload.ts`, `ingest.ts`, `publish-plan.ts`, `publish-artifacts.ts`, `ui-e2e-ingest.v1.schema.json`; `summary.json` field list with `titlePath` and `attachments`; CI section rewritten for the report job flow; "Hooks for the next phases" updated (P2 done, P3 reuses `ingest.ts` payload shape with `runner: swarm-worker`).

**File**: `runbooks/testing.md`
**Changes**: one sentence in the hard rules: `ui-e2e.yml` reports to the UI E2E tracker; failures on `main` or nightly open incidents there.

**File**: `templates/skills/artifacts/content.md`
**Changes**: line 114 becomes "link the agent-fs URL (team members only, the live viewer needs a login; use a signed URL for anyone else)". Run `bun run check:skill-sources`.

### Success Criteria:

#### Automated Verification:
- [x] Anchors exist: `grep -n "### Tracker ingest and artifacts" LOCAL_TESTING.md && grep -n "UI_E2E_INGEST_BEARER" runbooks/ci.md packages/ui-e2e/README.md LOCAL_TESTING.md`
- [x] Skill sources still valid: `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`
- [x] No stale reference: `! grep -rn "public, no auth required" templates/skills/artifacts/`
- [x] Root gates: `bun run lint && bun run tsc:check`

#### Automated QA:
- [x] Follow `### Tracker ingest and artifacts` literally in a clean shell against the Phase 3 `all-results` directory; every command runs as written.

#### Manual Verification:
- [x] Read the docs diff once for the STE rules (short sentences, no em dashes). (autopilot: Claude read the diff, a Sonnet accuracy review checked every flag, env name, path, and claim against the code; two wording fixes applied: `UI_E2E_PR_NUMBER` is also resolved for `manual` runs, `titlePath` includes the test title)

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] ui-e2e tracker docs and artifacts skill fix`.

---

## Phase 5: Production install and live verification

### Overview

The lead installs the tracker into the production swarm, Taras sets the two GitHub secrets and the tracker variable, and a dispatched workflow run shows up on the tracker page.

### Changes Required:

#### 1. Install task for the lead
**File**: `/tmp/ui-e2e-p2/install-task.md`
**Changes**: the a63a1c3d text updated: agent-work `main` at `65ef6aba` or newer, README steps 1 to 6, `UI_E2E_INGEST_BEARER` as global secret config, set `UI_E2E_AGENT_FS_ORG_ID=c5c27280-f28a-48e6-b1b4-1ae23bef7844` and `UI_E2E_AGENT_FS_DRIVE_ID=a8dc7a37-9fab-4ab6-9e55-67a5d5e74d35`, check that one live-viewer link built from `AGENT_FS_LIVE_URL` (default `https://live.agent-fs.dev`) opens a file from `e2e/desplega-ai__agent-swarm/` on `https://agent-fs-taras.fly.dev` and report the working host if it differs, do not set `UI_E2E_AGENT_FS_TOKEN` (prune fix pending), report endpoint id (never the bearer), app id, workflow ids, schedule ids, page URL. Note that a deploy restart during the task now yields a `reboot-retry` child and the recipe is idempotent, so a retry may simply continue.

**File**: `/tmp/ui-e2e-p2/send-install-task.ts`
**Changes**: `mcp-call.ts` wrapper that sends `install-task.md` with `taskType: "feature"`, `tags: ["e2e", "ui-e2e", "tracker", "install"]`, `modelTier: "smart"`, `priority: 60`, and prints the task id. Taras runs `! bun /tmp/ui-e2e-p2/send-install-task.ts` in a quiet `main` window (no PR about to merge).

#### 2. Wait and verify
Poll with `bun /tmp/ui-e2e-p2/mcp-call.ts get-task-details '{"taskId":"<id>"}'` every two minutes until `completed` or `failed` (also watch for a `reboot-retry` child through `get-tasks`). On `failed` for a swarm reason, hand Taras the fallback: `! SWARM_API_URL=https://api.desplega.agent-swarm.dev SWARM_API_KEY=<prod key> LEAD_AGENT_ID=<lead id> STORE_BEARER_CONFIG=1 UI_E2E_AGENT_FS_ORG_ID=… UI_E2E_AGENT_FS_DRIVE_ID=… BEARER_OUT=/tmp/ui-e2e-p2/prod-bearer bun /tmp/ui-e2e-p2/install-tracker.ts`.

#### 3. Secrets and variable (Taras, `!` prefix)
```bash
gh secret set UI_E2E_INGEST_URL --body "https://api.desplega.agent-swarm.dev/api/x/script/<endpointId>"
gh secret set UI_E2E_INGEST_BEARER   # paste from Settings → Secrets (UI_E2E_INGEST_BEARER) or /tmp/ui-e2e-p2/prod-bearer
gh variable set UI_E2E_TRACKER_URL --body "<page URL from the task result>"
```

#### 4. Live run
`gh workflow run ui-e2e.yml --ref ui-e2e-p2` (trigger `manual`, PR number resolved from the open PR), `gh run watch`, then read the tracker.

### Success Criteria:

#### Automated Verification:
- [x] (task `1bf3f10f-8378-4890-b0fc-026d6be6b355` completed 2026-09-07 17:47Z by worker Researcher; the lead review `15a76fb8` set the two agent-fs config keys and verified the bearer; output read from the prod DB read-only with Taras's OK because the user MCP truncates at 10 KB. IDs: scripts ui-e2e-ingest `eb6c5ee2-da51-490a-a4b6-cf82d0b87cdc`, sweep `0588d86d-…`, prune `ddc34a45-…`; endpoint `qinkEEMIwgjt`; app `19e29541-b3c5-45d9-bf8f-20d2f4752313`; workflows triage `5afa9deb-…`, promote `7f723fa1-…`; schedules `beab000c-…`, `e8fd31da-…`; page `6590ed7ec7644b3b9e7ef9a6eac3eadf` authed. Correction from the worker: the 2026-09-04 reboot-retry `b5355563` had already installed steps 1 to 3 and 5) Install task reached `completed`: `bun /tmp/ui-e2e-p2/mcp-call.ts get-task-details '{"taskId":"<id>"}' | grep -c '"status": "completed"'` is 1, and the result names the endpoint id, app id, two workflow ids, two schedule ids, and the page URL, and contains no bearer
- [x] (`401 {"type":"unauthorized"}`; with the bearer and an empty body: `200 ok=false runtime_error argsSchema validation failed`, so auth passes) Endpoint answers 401 without a bearer: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.desplega.agent-swarm.dev/api/x/script/<endpointId> -H 'Content-Type: application/json' -d '{}'` prints `401`
- [x] (both secrets set 2026-09-07 20:08Z by Claude with Taras's permission, bearer revealed through `GET /api/scripts/{id}/apis/{endpointId}/secret` into a 0600 temp file and deleted after `gh secret set`; the variable follows the first ingest) Secrets present: `gh secret list | grep -c "UI_E2E_INGEST_"` is 2 and `gh variable list | grep -c UI_E2E_TRACKER_URL` is 1
- [x] (run 34158288118: both shards and the report job green; `Published 57 artifacts, 24 images.`; ingest `shard 1: HTTP 200 ok=true`, `shard 2: HTTP 200 ok=true`; tracker rows: group pr-1373 sha 95e72298 status passed 2/2 38 pass, 59 artifacts with viewer URLs, 0 incidents) Dispatched run green and ingested: `gh run list --workflow ui-e2e.yml --branch ui-e2e-p2 --limit 1` completed; the report job's ingest step log shows `HTTP 200 ok=true` for both shards
- [x] Sticky comment on the PR carries the `Tracker:` line (set after the first ingest: variable `UI_E2E_TRACKER_URL` = `https://app.agent-swarm.dev/pages/511732ca1589407fa6e9de78bf679ccd`, the Lead's page created by that ingest; the next PR run renders the line)

#### Automated QA:
- [x] (production page `511732ca1589407fa6e9de78bf679ccd`, owner Lead, screenshot `/tmp/ui-e2e-p2/e2e/prod-tracker.png` via a `page_session` cookie from `POST /api/pages/{id}/launch`) Tracker page (dashboard preview of the page, `agent-browser` with Taras's dashboard connection or the shared viewer) shows target `pr-<n>` with the dispatched run, two shard rows, and artifact links; screenshot to `/tmp/ui-e2e-p2/prod-tracker.png` and upload to agent-fs for the PR body
- [x] (59 artifact rows carry `live.agent-fs.dev/file/~/c5c27280…/a8dc7a37…/e2e/desplega-ai__agent-swarm/pr-1373/…` viewer URLs; the install worker verified the live viewer resolves them only in a browser whose viewer holds credentials for `agent-fs-taras.fly.dev`, and there is no host-scoped live URL) One agent-fs viewer link from the page opens the screenshot when logged in (or the task result reports the working `AGENT_FS_LIVE_URL`)
- [ ] (Taras's call at merge time; the install task is finished, so the remaining risk is any unrelated in-progress task) Merge-window check before the PR merge: `bun /tmp/ui-e2e-p2/mcp-call.ts get-tasks '{"status":"in_progress","limit":10}'` shows no in-progress task that the P2 deploy would kill, or Taras accepts the retry

#### Manual Verification:
- [ ] Taras confirms the tracker page renders the run and the viewer links work for a logged-in team member.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] production tracker install evidence` (PR body and README pointer updates only, if any). Merge is Taras's call after the install task has finished.

---

## Manual E2E

Run from the repo root on the branch after Phase 4 (Phase 5 items need Taras).

```bash
# 1. Unit tests and gates
bun run test:root -- src/tests/ui-e2e-ingest-payload.test.ts src/tests/ui-e2e-publish-plan.test.ts
bun run lint && bun run tsc:check && bun run e2e:ui:tsc && bunx actionlint .github/workflows/ui-e2e.yml

# 2. Two shard summaries from a real run
bun run e2e:ui -- --shard=1/2 && mkdir -p /tmp/ui-e2e-p2/all-results && rm -rf /tmp/ui-e2e-p2/all-results/ui-e2e-results-1 && cp -R packages/ui-e2e/test-results /tmp/ui-e2e-p2/all-results/ui-e2e-results-1
bun run e2e:ui -- --no-build --shard=2/2 && rm -rf /tmp/ui-e2e-p2/all-results/ui-e2e-results-2 && cp -R packages/ui-e2e/test-results /tmp/ui-e2e-p2/all-results/ui-e2e-results-2

# 3. Publish plan (dry run) and payloads (dry run)
node --experimental-strip-types packages/ui-e2e/reporter/publish-artifacts.ts --results /tmp/ui-e2e-p2/all-results --prefix "e2e/desplega-ai__agent-swarm/local/$(git rev-parse HEAD)" --artifacts-out /tmp/ui-e2e-p2/artifacts.json --images-out /tmp/ui-e2e-p2/images.json --dry-run
GITHUB_REPOSITORY=desplega-ai/agent-swarm UI_E2E_TRIGGER=manual UI_E2E_SHA=$(git rev-parse HEAD) UI_E2E_REF=ui-e2e-p2 \
  node --experimental-strip-types packages/ui-e2e/reporter/ingest.ts --summaries /tmp/ui-e2e-p2/all-results --artifacts /tmp/ui-e2e-p2/artifacts.json --out /tmp/ui-e2e-p2/payloads --dry-run
jq '.run, (.results | length), (.artifacts | length)' /tmp/ui-e2e-p2/payloads/shard-1.json

# 4. Local API with the template installed, real ingest
PORT=3998 MCP_BASE_URL=http://127.0.0.1:3998 DATABASE_PATH=/tmp/ui-e2e-p2/tracker.sqlite AGENT_SWARM_API_KEY=localkey API_KEY=localkey \
  GITHUB_DISABLE=true LINEAR_DISABLE=true JIRA_DISABLE=true SLACK_DISABLE=true HEARTBEAT_DISABLE=true \
  bun --no-env-file run src/http.ts > /tmp/ui-e2e-p2/api.log 2>&1 &
LEAD=$(curl -s -X POST http://127.0.0.1:3998/api/agents -H 'Authorization: Bearer localkey' -H 'Content-Type: application/json' -d '{"name":"p2-lead","isLead":true}' | jq -r .id)
SWARM_API_URL=http://127.0.0.1:3998 SWARM_API_KEY=localkey LEAD_AGENT_ID=$LEAD STORE_BEARER_CONFIG=1 BEARER_OUT=/tmp/ui-e2e-p2/bearer \
  UI_E2E_AGENT_FS_ORG_ID=c5c27280-f28a-48e6-b1b4-1ae23bef7844 UI_E2E_AGENT_FS_DRIVE_ID=a8dc7a37-9fab-4ab6-9e55-67a5d5e74d35 \
  bun /tmp/ui-e2e-p2/install-tracker.ts
ENDPOINT=<endpoint id printed above>
UI_E2E_INGEST_URL=http://127.0.0.1:3998/api/x/script/$ENDPOINT UI_E2E_INGEST_BEARER=$(cat /tmp/ui-e2e-p2/bearer) \
  GITHUB_REPOSITORY=desplega-ai/agent-swarm UI_E2E_TRIGGER=pr UI_E2E_PR_NUMBER=9999 UI_E2E_SHA=$(git rev-parse HEAD) UI_E2E_REF=ui-e2e-p2 \
  node --experimental-strip-types packages/ui-e2e/reporter/ingest.ts --summaries /tmp/ui-e2e-p2/all-results --artifacts /tmp/ui-e2e-p2/artifacts.json --out /tmp/ui-e2e-p2/payloads --report-url https://github.com/desplega-ai/agent-swarm/actions/runs/0/artifacts/0
APP=$(curl -s http://127.0.0.1:3998/api/apps -H 'Authorization: Bearer localkey' | jq -r '.apps[] | select(.name=="uiE2eTracker") | .id')
curl -s "http://127.0.0.1:3998/api/apps/$APP/models/runGroups/rows" -H 'Authorization: Bearer localkey' | jq '.rows[] | {target, sha, status, shardTotal}'
curl -s "http://127.0.0.1:3998/api/pages/resolve?slug=ui-e2e" -H 'Authorization: Bearer localkey' | jq '{id, authMode, version}'

# 5. CI (after push)
ANTHROPIC_API_KEY= git push -u origin ui-e2e-p2 && gh pr create --fill
gh run watch --workflow ui-e2e.yml
gh run download <run-id> -n ui-e2e-ingest-payloads -D /tmp/ui-e2e-p2/ci-payloads && jq '.run' /tmp/ui-e2e-p2/ci-payloads/shard-1.json

# 6. Production (Taras)
! bun /tmp/ui-e2e-p2/send-install-task.ts
! gh secret set UI_E2E_INGEST_URL --body "https://api.desplega.agent-swarm.dev/api/x/script/<endpointId>"
! gh secret set UI_E2E_INGEST_BEARER
! gh variable set UI_E2E_TRACKER_URL --body "<page URL>"
gh workflow run ui-e2e.yml --ref ui-e2e-p2 && gh run watch
```

---

## Appendix

- **Follow-up plans**: P3 swarm exploratory runner + green loop (adds `runner: swarm-worker`, `findings`, `cost`, fork `workflow_run` publisher, nightly exploratory trigger), P4 `pw.ai` (`DES-782`).
- **Derail notes**:
  - Tracker prune is a no-op on agent-fs: `rm` deletes one key, has no `recursive`, and the call omits `driveId`. Fix in `agent-work` `scripts/ui-e2e-prune.ts`: `glob` (`pattern: "**"`, `path: prefix`, `driveId`) then `rm` per file with `driveId`, or derive paths from `artifacts` rows instead of `artifactPathPrefix()`. Needs `UI_E2E_AGENT_FS_TOKEN` (an editor key on org t's default drive) set as a swarm secret by Taras. Decision 2026-09-07: install as-is, fix later.
  - `install-tracker.ts` lives in `/tmp`; it belongs next to the template in `agent-work` (`workflows/ui-e2e-tracker/install.ts`) as the scripted install path. Open a PR there after P2.
  - The template's `AGENT_FS_LIVE_URL` default (`https://live.agent-fs.dev`) may not serve files from `agent-fs-taras.fly.dev`. The install task asks the lead to check one link; the working host becomes the swarm config value.
  - Deploys on `main` restart the swarm; `1.141.0` retries reboot-killed tasks but still loses their context. A "deploy window" note belongs in `runbooks/heartbeat-crash-recovery.md` or the release runbook.
  - Old uploads under `e2e/agent-swarm/pr-1364/` (P1 prefix) will never match the template prune. Delete by hand once the prune works.
  - CI shard balance: `specs/smoke.spec.ts` holds 53 of 55 tests and Playwright shards by file while `fullyParallel` is false, so shard 2 runs two tests. Consider `fullyParallel: true` (each worker already owns a seeded API) or splitting the smoke file.
  - Tracker page shows the GitHub report link once per shard until a re-ingest dedups it (template cosmetic).
  - Template config layer was dead until `agent-work` PR #58 (found by the install worker): `config_get` returns `{ configs: [...] }`, so every `UI_E2E_*` read fell back to its default. After #58 merges, re-upsert the three scripts (the install recipe is the upgrade path).
  - Pages are unique per `(agentId, slug)`, so each identity that ingests owns its own `ui-e2e` page: CI (endpoint, runs as Lead) creates the page that stays fresh; the 2026-09-04 page belongs to Content Writer and goes stale. The sweep and prune schedules were created by Content Writer (non-lead), so the prune's secret reads stay masked; recreate both schedules under Lead.
  - `live.agent-fs.dev` is instance-agnostic: a viewer link resolves only in a browser whose live viewer holds credentials for `agent-fs-taras.fly.dev`. There is no host-scoped live URL for that instance.
  - Template README step 5 overstates the install result: the bundled ingest creates `ui-e2e-incident-triage` on the first authoritative failure and `ui-e2e-promote-finding` on the first finding (`scripts/ui-e2e-ingest.ts:740-745, 816-821`), so a passed synthetic ingest creates neither. The install check is "no duplicates", not "exactly one each". Fix the README in `agent-work`.
  - Local install verification (2026-09-07, `/tmp/ui-e2e-p2/verify-install.sh`): two runs idempotent, endpoint 401 without bearer and 200 `ok: true` with it, `UI_E2E_INGEST_BEARER` stored masked. The scripts runtime needs `MCP_BASE_URL` on the API's own port.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-09-04-ui-e2e-swarm-driven-testing.md`
  - P1 plan: `thoughts/taras/plans/2026-09-04-ui-e2e-p1-playwright-suite.md`
  - Tracker template: `desplega-ai/agent-work` `workflows/ui-e2e-tracker/` (main, `65ef6aba`), local copy `/tmp/ui-e2e-p2/tracker`
  - Prod tasks: `a63a1c3d-50dd-4c8c-997d-fcf8a7e0fb4a` (install, reboot-killed), `1f2fc861-7bfc-4a01-a59e-ff2fa084a628` (agent-fs invite, honest failure), `065bfdb9-fdf7-4a24-8acd-90f0cccb0f4d` (contract)
  - MCP helper: `/tmp/ui-e2e-p2/mcp-call.ts` (fresh MCP HTTP session, reads `~/.claude.json`)

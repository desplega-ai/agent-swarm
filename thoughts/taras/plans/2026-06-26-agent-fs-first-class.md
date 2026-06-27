---
date: 2026-06-26T00:00:00Z
author: Taras
topic: "First-class agent-fs support (issue #813) — v1 (tasks-only)"
tags: [plan, agent-fs, attachments, filesystem, provider-interface, provisioning, http-routes, ui]
status: draft
autonomy: critical
last_updated: 2026-06-26
last_updated_by: Claude
---

# First-class agent-fs Support (issue #813) — v1 Implementation Plan

## Overview

Make agent-fs a first-class citizen of the swarm: a pluggable, two-tier **file-storage
provider interface** (Files-SDK-style core blob ops + optional capability mixins), a
server-side **`/api/fs/*`** REST surface backed by it, a **provider-agnostic
`task_attachments`** table with a delete/replace path, **deterministic boot
provisioning** (TS seeder, not an LLM task), agent-side provisioning so agents keep using
agent-fs's **native CLI**, and a **task-view upload/list/preview/download UI**.

**v1 scope = tasks-only.** Files belong to a task; humans attach inputs, agents attach
outputs. Org/agent/shared scopes are deferred.

- **Motivation**: [GitHub issue #813](https://github.com/desplega-ai/agent-swarm/issues/813) — "Have a way so that agent-fs is a first-class citizen in the swarm. It will enable attachments, etc." Today the integration is a **pointer-and-link layer only** — the swarm server never opens a socket to agent-fs (`src/tools/store-progress.ts:158-165` records an `(org, drive, path)` pointer; renderers rebuild a `live.agent-fs.dev` URL via `buildAgentFsLiveUrl`, `src/utils/constants.ts:114`).
- **Related**:
  - Research: `thoughts/taras/research/2026-06-25-agent-fs-first-class.md`
  - Brainstorm: `thoughts/taras/brainstorms/2026-06-25-agent-fs-first-class.md`
  - Live agent-fs source (**v0.9.0**): `/Users/taras/Documents/code/agent-fs` — the canonical surface. ⚠️ NOT the `~/.claude` plugin marketplace cache (stale at v0.1.5) and NOT agent-fs's own `docs/openapi.json` (only documents 4 paths, schemas don't match handlers). Build against the live handlers.

### Confirmed design decisions (this planning session)

| Decision | Choice |
|---|---|
| `task_attachments` evolution | **Provider-agnostic columns** — add `provider_id` + `provider_key` (+ capability metadata); keep `agent_fs_org_id/drive_id` for back-compat, backfill `provider_id='agent-fs'`. |
| Boot provisioning location | **Hybrid (review-revised):** a server-side TS `Seeder` provisions the **shared org + drive + admin key** (backs `/api/fs/*`); **per-worker agent-fs user registration is retained** (distinct email per worker, lead = admin, shared org/drive, worker = editor). Only the shared-provisioning portion moves off `docker-entrypoint.sh`. Auto-invite swarm users who have a primary email. |
| Agent-write → attachment reconcile | **`store-progress` pointer only (status quo)** — no path-convention sweep in v1. |
| Commits | **Per-phase**, after manual verification passes: `[phase N] <description>`. |

## Current State Analysis

All references below were re-verified on branch `refactor/interpolate-to-utils` (the
`ba5768b5` interpolate refactor moved nothing material to this plan).

**Integration is pointer-only — no server-side agent-fs client.**
- `task_attachments` schema: `src/be/migrations/072_task_attachments.sql:21` (`kind CHECK IN ('agent-fs','url','shared-fs','page')`), `073_task_attachments_agent_fs_ids.sql:14-15` (`agent_fs_org_id`/`agent_fs_drive_id`), `082_user_audit_fields.sql:97-98` (`created_by`/`updated_by`, **always NULL via this path** — absent from TS types & INSERT). The agent-fs file is referenced by the generic **`path`** column.
- DB access: `rowToTaskAttachment` (`src/be/db.ts:2634`), `insertTaskAttachment` (`:2684`, **append-only**, dedup on `(task_id, sha256)` then tuple), `getTaskAttachments` (`:2773`). **No UPDATE/DELETE exists** — cleanup only via task `ON DELETE CASCADE`.
- TS types: `TaskAttachmentKindSchema` (`src/types.ts:274`), `AttachmentInputSchema` (`:290`), `TaskAttachmentSchema` (`:328`). `kind` lives in **three places that must stay in sync** (SQL CHECK + two Zod defs).
- Readers of `getTaskAttachments`: HTTP `src/http/tasks.ts`, MCP `src/tools/get-task-details.ts`, Slack `src/slack/blocks.ts:164-169`, `src/tasks/worker-follow-up.ts:121`, `src/commands/context-preamble.ts:87-88`.

**Provisioning already runs deterministically — in shell, not TS.** `docker-entrypoint.sh:405-483`: gate on `AGENT_FS_API_URL`; if no key, worker self-registers `POST /auth/register` (`:428`), stores the key as an **agent-scoped secret** via `PUT /api/config` (`:437`); lead creates the shared org `POST /orgs` (`:462`). The brainstorm's "no deterministic provisioning exists" assumption was wrong — it exists, just in shell. Decision: lift it to a TS seeder.

**Agent write path = agent-fs CLI, not MCP.** The `system.agent.agent_fs` template (`src/prompts/session-templates.ts:288`) teaches `agent-fs write/cat/fts/search/ls`; gated on `hasLocalEnv && AGENT_FS_API_URL` (`src/prompts/base-prompt.ts:248-253`). **There is no `agent_fs_write` MCP tool** — only a dangling `ctx.swarm.agent_fs_write` in `src/be/seed-scripts/catalog/memory-eval.ts:518` (try/catch-swallowed) to clean up.

**Env plumbing.** `fetchResolvedEnv` (`src/commands/runner.ts:356`) overlays `/api/config/resolved?includeSecrets=true` onto worker env; `AGENT_FS_SHARED_ORG_ID` is copied to `process.env` for the prompt builder (`:2636-2637`). `AGENT_FS_API_KEY` is currently **only in the scrubber** (`src/utils/secret-scrubber.ts:43`) — never read by swarm TS. The "configured" gate today is `AGENT_FS_API_URL` alone (`src/http/status.ts:576`).

**Route layer.** `route()` factory (`src/http/route-def.ts:148`, `RouteDef` `:14`); central Bearer + `X-Agent-ID` auth in `handleCore` (`src/http/core.ts:197`); `parseBody` is **JSON-only** (`src/http/utils.ts:83`), `enforceContentLengthCap` (`:110`). Model module: `src/http/kv.ts` (`handleKv` dispatcher `:378`). Dispatchers wired in `src/http/index.ts` (boot: `loadGlobalConfigsIntoEnv:441`, `runAllSeeders:467`). New route modules need an `import "../src/http/<mod>"` in `scripts/generate-openapi.ts`. **No `route()` endpoint reads binary/multipart today** — a `/api/fs/*` upload would be the first. DB-boundary script (`scripts/check-db-boundary.sh`) does **not** restrict `src/http/` or a new `src/fs/` — so API-side provider/route code may import `src/be/db`. API-key boundary scans all of `src/` → must use `getApiKey()`.

**Co-deployment.** Helm chart ships a complete agent-fs co-deployment gated `agentFs.enabled` (`charts/agent-swarm/templates/agent-fs-deployment.yaml`), **pinned to `0.7.2`** (live is 0.9.0) and sets **no** `AGENT_FS_API_KEY`/embedding env (values `charts/agent-swarm/values.yaml:224-252`). **docker-compose has no agent-fs/MinIO service** (`docker-compose.local.yml`, `docker-compose.example.yml`). UI renderer already exists (`ui/src/components/shared/task-attachments-section.tsx`, display-only) + home indicator (`ui/src/pages/home/page.tsx`).

**Live agent-fs v0.9.0 surface (the binding target):**
- Provisioning: `POST /auth/register {email}` → `{apiKey, userId, orgId}`; `GET /auth/me` → `{userId, email, defaultOrgId, defaultDriveId}`; `POST /orgs {name}`; `POST /orgs/:orgId/drives {name}` (org-admin). Key is **per-user**, shape `af_<hex>`, `Authorization: Bearer`.
- Bytes: `PUT /orgs/:org/drives/:drive/files/:path/raw` — **binary body, 50 MB cap, rejects `application/json`**, editor+ RBAC, auto mime + version + embed via `writeRaw`; conditional `If-None-Match: *` / `If-Match: <n>`; returns `version`/`ETag`/content-hash/`deduped`. `GET .../raw` streams bytes. `signed-url` op → presigned **GET only** (24h default; **no signed upload URL**).
- Ops: `POST /orgs/:org/ops` — 29 ops (content/nav/filemgmt/vcs/search incl. `vec-search`+`sql`/comments). `write` content is a **string, 10 MB cap** → binary must use `/raw`.
- S3 key layout: `<orgId>/drives/<driveId>/<path>` (deterministic).

## Desired End State

- A **fresh swarm with no agent-fs envs** uses the **local-fs core provider**: upload/list/preview/download on the task view works out of the box (lightest footprint).
- Setting **`AGENT_FS_API_URL` + `AGENT_FS_API_KEY`** auto-upgrades the active provider to the **agent-fs rich provider** (core + search/comments/versioning capabilities), with org/drive/key **provisioned deterministically at boot** and persisted (drive id → `swarm_config`, key → encrypted secrets).
- All human/server file ops go through **`/api/fs/*`**, provider-agnostic, with **`task_attachments` as the metadata source of truth** (now provider-agnostic, with a working **delete/replace** path).
- Agents continue to use agent-fs's **native CLI** (provisioned drive injected into worker env); their writes surface in the task UI via the existing `store-progress` pointer flow.
- `openapi.json` + API-reference docs regenerated; co-deployment documented for both Helm and a new docker-compose recipe; Helm bumped to agent-fs `0.9.x`.

**Verification of end state:** `bun run tsc:check && bun run lint && bun test` green; `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh` pass; with a local agent-fs backend on `:7433`, a round-trip upload→list→download→delete through `/api/fs/*` succeeds and a row appears/disappears in `task_attachments`; with no agent-fs envs the same round-trip succeeds against local-fs.

## What We're NOT Doing

- **No typed TS SDK client** — generate it from OpenAPI in a later release (`bun run docs:openapi` already exists).
- **No swarm MCP "FS tool"** — agents use the agent-fs CLI directly. `agent_fs_write` is not reintroduced (the lone dangling reference is removed).
- **No org/agent/shared scopes** — tasks-only in v1. The provider contract stays general; only the swarm-side ownership column is constrained.
- **No reconcile sweep / path-convention auto-discovery** — `store-progress` pointer recording only (status quo). Server-side uploads still organize under a `/tasks/{taskId}/` path prefix on the single drive, but the swarm does not scan the drive to auto-register agent writes.
- **No streaming / >50 MB uploads** — v1 ceiling is agent-fs's 50 MB Hono limit; buffered proxy only.
- **No upload-time virus/secret scanning of binaries** — scrub **text** at egress only; binaries are opaque (served via download/signed-URL, never logged).
- **No UI surfacing of search/comments/versioning** — capability tier is wired in the provider but the v1 UI is core-only (upload/list/preview/download), capability-aware degraded.
- **No per-org drives** — one agent-fs org+drive per swarm; revisit if multi-tenant isolation becomes a need.

## Implementation Approach

- **The provider interface is the critical-path contract** (Phase 1). Routes, provisioning, and UI all sit on it, so it lands first and is unit-tested against the local-fs adapter before anything depends on it.
- **Bind agent-fs as one "rich provider"** over its HTTP API (proxy bytes to `PUT .../raw`; read via `GET .../raw`/`signed-url`; ops for capabilities). The swarm does **no** direct S3 or mime routing — agent-fs owns S3 + mime + versioning + embedding.
- **Keep it Bun-native and dependency-light**: define the swarm's own `FileStorageProvider` interface modeled on Files-SDK's 10 methods + capability mixins; local-fs impl over `Bun.file`; agent-fs impl over `fetch`. (Literal `files-sdk.dev` dependency is a future drop-in, not v1.)
- **Env-driven selection, no feature flag**: `AGENT_FS_API_URL` + `AGENT_FS_API_KEY` both present → agent-fs rich provider; else → local-fs core.
- **Sequencing**: contract → schema → routes → provisioning → UI → co-deployment. Phases 1–4 are the server foundation (one implementation session); Phases 5–6 (UI + ops) are a natural second session. Commit-per-phase gives the checkpoints. See Appendix for the suggested split.
- **First binary route is contained**: the upload handler reads the raw body **outside** `route().parse()` (guarded by `enforceContentLengthCap`), rather than generalizing the JSON-only factory in v1.

## Quick Verification Reference

```bash
bun run tsc:check                       # type check
bun run lint                            # Biome (read-only, as CI runs it)
bun test                                # all unit tests
bun test src/tests/<file>.test.ts       # one file
bash scripts/check-db-boundary.sh       # DB-owner invariant
bash scripts/check-api-key-boundary.sh  # getApiKey() invariant
bun run docs:openapi                    # regenerate openapi.json + api-reference (after route changes)
cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b   # UI checks (CI uses tsc -b)
```

**Local agent-fs backend** (for E2E of the rich-provider path): run agent-fs from the sibling repo on `:7433` (its repo ships a `docker-compose.yml` = `minio` + `agent-fs`), then export `AGENT_FS_API_URL=http://localhost:7433` + `AGENT_FS_API_KEY=<af_…>`. **Minimal swarm smoke-test** (API boots + workers register): see `LOCAL_TESTING.md:48-74`. **Full E2E** (tasks, logs, dashboard): the `swarm-local-e2e` skill (`LOCAL_TESTING.md:33-46`).

---

## Phase 1: Provider interface + local-fs & agent-fs providers

### Overview

A new `src/fs/` module defining the `FileStorageProvider` contract (core blob tier +
capability mixins), two concrete providers (local-fs core-only, agent-fs rich), and an
env-driven selector. Pure storage logic, no DB, no routes — unit-tested against local-fs
and a stubbed agent-fs.

### Changes Required:

#### 1. Provider contract + capability model
**File**: `src/fs/provider.ts` (new), `src/fs/capabilities.ts` (new)
**Changes**: Define `FileStorageProvider` with the **core tier** (Files-SDK 10 methods: `upload`, `download`, `head`, `exists`, `delete`, `copy`, `move`, `list`/`listAll`, `url`, `signedUploadUrl`) operating on a `{ taskId, name }` scope that maps to a `/tasks/{taskId}/{name}` path. Define optional **capability mixins** (`Searchable`, `Commentable`, `Versioned`) and a queryable `capabilities: ProviderCapabilities` (`{ signedUrl:{supported,maxExpiresIn?}, search, comments, versioning, … }`). Normalize errors into a `FilesError` union (`NotFound`/`Unauthorized`/`Conflict`/`ReadOnly`/`Provider`).

#### 2. local-fs provider (default, core-only)
**File**: `src/fs/local-fs-provider.ts` (new)
**Changes**: Implement the 10 core methods over `Bun.file` against a configured data dir (e.g. `AGENT_FS_LOCAL_DIR`, default under the API data volume). `capabilities.signedUrl.supported = false` (downloads stream through the authed route); `search`/`comments`/`versioning` absent. **Persistence:** the API is single-replica by design (StatefulSet pinned `replicas: 1` for SQLite, `charts/agent-swarm/templates/api-statefulset.yaml:5-18`), so there is no cross-replica visibility issue — but `AGENT_FS_LOCAL_DIR` MUST live on a persistent volume or bytes are lost on restart.

#### 3. agent-fs provider (rich)
**File**: `src/fs/agent-fs-provider.ts` (new)
**Changes**: Implement core via `fetch` to agent-fs v0.9.0: `upload` → `PUT .../files/{path}/raw` (binary, conditional headers, returns version/hash/deduped); `download` → `GET .../raw`; `url` → `signed-url` op (GET-only, 24h default); `signedUploadUrl` → unsupported (throws `ReadOnly`/`Provider` — agent-fs has no signed upload). Implement capability mixins via `POST /orgs/:org/ops` (`search`/`fts`/`vec-search`, `comment-*`, `log`/`diff`/`revert`). Read `AGENT_FS_API_KEY` from `process.env` (materialized from the encrypted **global** secret at boot — see Phase 4 for the storage/materialization path); swarm key via `getApiKey()`. **Scope note:** v1 has no consumer for the capability mixins (the UI is core-only), so implement them as thin pass-throughs or defer their bodies until consumed — don't let capability work balloon Phase 1.

#### 4. Env-driven provider selection
**File**: `src/fs/registry.ts` (new)
**Changes**: `selectProvider()` returns the agent-fs provider iff `AGENT_FS_API_URL` **and** `AGENT_FS_API_KEY` are both present (resolved), else local-fs. Single memoized accessor consumed by routes/provisioning.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] DB-boundary holds (no `src/be/db` import from providers): `bash scripts/check-db-boundary.sh`
- [ ] API-key boundary holds: `bash scripts/check-api-key-boundary.sh`
- [ ] New provider tests pass: `bun test src/tests/fs-provider.test.ts`

#### Automated QA:
- [ ] `fs-provider.test.ts` round-trips upload→head→download→list→delete against the **local-fs** provider in a tmp dir, asserts bytes + metadata match, and asserts `signedUploadUrl` throws the normalized `ReadOnly`/`Provider` error.
- [ ] `fs-provider.test.ts` exercises the **agent-fs** provider against a stub `fetch` (or the local agent-fs on `:7433` when `AGENT_FS_API_URL` is set), asserting `PUT .../raw` is called with a binary body + conditional headers and capability ops dispatch to `POST /orgs/:org/ops`.
- [ ] `selectProvider()` returns local-fs with no envs and agent-fs when both envs are set (asserted in-test by toggling resolved config).

#### Manual Verification:
- [ ] Skim the capability model with Taras — confirm the mixin set (`Searchable`/`Commentable`/`Versioned`) matches what later UI work will feature-detect.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 1] fs provider interface + local-fs/agent-fs providers` once verification passes.

---

## Phase 2: Provider-agnostic `task_attachments` + delete/replace

### Overview

A forward-only migration generalizing `task_attachments` to provider-agnostic metadata
(`provider_id` + `provider_key` + capability metadata), backfilled from existing rows,
plus the **net-new delete/replace** DB mutations and synced TS types. No HTTP yet.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/098_task_attachments_provider_agnostic.sql` (new — next sequential after `097`)
**Changes**: `ADD COLUMN provider_id TEXT`, `ADD COLUMN provider_key TEXT`, `ADD COLUMN capabilities TEXT` (JSON: version/hash/searchable flags). Backfill `provider_id` from `kind` (`'agent-fs'→'agent-fs'`, `'url'→'url'`, `'page'→'page'`, `'shared-fs'→'agent-fs'`); `provider_key` backfill is **per-kind** (`agent-fs`/`shared-fs`→`path`, `url`→`url`, `page`→`page_id`). Keep `agent_fs_org_id`/`agent_fs_drive_id` (back-compat for live-URL building). Keep the `kind` CHECK unchanged (no new kind value). Add index `(task_id, provider_id, provider_key)`. **Dedup unchanged:** retain the existing `(task_id, sha256)` + tuple dedup in `insertTaskAttachment`; the new index is for lookup / replace / delete-by-key, not a new uniqueness constraint.

#### 2. DB functions
**File**: `src/be/db.ts`
**Changes**: Update `rowToTaskAttachment` (`:2634`) + `insertTaskAttachment` (`:2684`) to read/write the new columns. Add **`deleteTaskAttachment(id)`** and **`replaceTaskAttachment(id, input)`** (the first mutation surface beyond `ON DELETE CASCADE`). Delete is row-only here; provider byte deletion is orchestrated by the route handler (Phase 3).

#### 3. TS types (keep three-way `kind` sync)
**File**: `src/types.ts`
**Changes**: Extend `TaskAttachmentSchema` (`:328`) + `AttachmentInputSchema` (`:290`) with `providerId`/`providerKey`/`capabilities`. `kind` enum (`:274`) unchanged. Surface `created_by`/`updated_by` in the type + INSERT while here (currently always NULL).

#### 4. store-progress write branch
**File**: `src/tools/store-progress.ts`
**Changes**: In the `kind==='agent-fs'` write branch (`:158-165`) also set `provider_id='agent-fs'` + `provider_key=path` so status-quo reconcile populates the new columns.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Migration applies on a **fresh** DB: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http` boots clean (then stop it)
- [ ] Existing attachment tests pass: `bun test src/tests/store-progress-attachments.test.ts src/tests/store-progress-attachments-handler.test.ts`
- [ ] New schema test passes: `bun test src/tests/task-attachments-schema.test.ts`

#### Automated QA:
- [ ] `task-attachments-schema.test.ts` inserts a legacy-shaped agent-fs attachment, runs the migration path (fresh `initDb`), and asserts `provider_id='agent-fs'` + `provider_key` backfilled.
- [ ] Test asserts `deleteTaskAttachment` removes the row and `replaceTaskAttachment` swaps metadata while preserving `task_id`.
- [ ] Migration applies cleanly on an **existing** populated DB (copy a seeded `agent-swarm-db.sqlite`, boot, assert no error + columns present via `getTaskAttachments`).

#### Manual Verification:
- [ ] Confirm with Taras that hard-delete (row + bytes) is acceptable for v1 vs. soft-delete (a `deleted_at` tombstone) — plan assumes hard-delete.

**Implementation Note**: Never modify an applied migration — `098` is forward-only. Pause for confirmation; commit `[phase 2] provider-agnostic task_attachments + delete/replace`.

---

## Phase 3: `/api/fs/*` REST surface (first binary route)

### Overview

A new `src/http/fs.ts` route module exposing task-scoped file ops backed by the Phase-1
provider, with `task_attachments` as the metadata source of truth — including the swarm's
**first binary upload endpoint**. OpenAPI regenerated.

### Changes Required:

#### 1. Route module + dispatcher (model after `src/http/kv.ts`)
**File**: `src/http/fs.ts` (new)
**Changes**: `route()` defs + a `handleFs` dispatcher (`.match()` most-specific-first, like `handleKv` `src/http/kv.ts:378`):
- `POST /api/fs/tasks/:taskId/files` — **upload** (binary). Reads the raw body **outside `route().parse()`** (the JSON-only `parseBody` `src/http/utils.ts:83` can't), guarded by `enforceContentLengthCap` (`:110`) at a **50 MB** cap. Proxies bytes to `provider.upload({taskId,name}, …)` → records via `insertTaskAttachment` → returns metadata. v1 accepts **all types up to 50 MB** (no blocklist). **Ordering/compensation:** upload bytes first, then `insertTaskAttachment`; if the insert fails, best-effort `provider.delete` to avoid an orphan blob; log any half-completed state.
- `GET /api/fs/tasks/:taskId/files` — **list** (from `getTaskAttachments`). Reconcile with the existing `getTaskAttachments` surface in `src/http/tasks.ts` + MCP `src/tools/get-task-details.ts` — both now return the provider columns; this endpoint is the canonical UI source.
- `GET /api/fs/tasks/:taskId/files/:attachmentId` — **metadata/head**.
- `GET /api/fs/tasks/:taskId/files/:attachmentId/raw` — **download** (streams raw bytes via `provider.download`, served **unscrubbed** — it is the user's file; scrubbing would corrupt it). `scrubSecrets` does **not** apply to the download stream; it applies to the UI text **preview** (Phase 5) and any log line that echoes file content/paths.
- `GET /api/fs/tasks/:taskId/files/:attachmentId/signed-url` — **presigned GET** (agent-fs `signed-url`; local-fs → `501`/falls back to authed raw URL per `capabilities.signedUrl.supported`). **v1 expiry cap = 1h** for task-artifact links — tighter than agent-fs's 24h default, since a presigned GET is an unauthenticated public link.
- `DELETE /api/fs/tasks/:taskId/files/:attachmentId` — **delete** (`provider.delete` then `deleteTaskAttachment`; tolerate re-deletes / already-gone bytes — idempotent; if the row-delete fails after the blob is gone, log for cleanup).
- `GET /api/fs/capabilities` — advertise the **active provider's** capabilities for UI feature-detection.

#### 2. Wire dispatcher + auth
**File**: `src/http/index.ts`
**Changes**: Register `handleFs` in the handler block (order matters, first match wins). Auth stays central in `handleCore` (`src/http/core.ts:197`) — Bearer swarm key + `X-Agent-ID`. **Authorization:** `/api/fs/tasks/:taskId/*` must reuse the existing task-access checks — confirm whether the dashboard authenticates with the swarm key or an `aswt_` user token, and gate upload/delete to the task (don't let any caller mutate any task's files): reads = viewer; upload/delete = task owner/assignee.

#### 3. OpenAPI registration
**File**: `scripts/generate-openapi.ts`
**Changes**: Add `import "../src/http/fs";`, then `bun run docs:openapi` and commit `openapi.json` + `docs-site/content/docs/api-reference/**`.

#### 4. Status surfacing
**File**: `src/http/status.ts`
**Changes**: Extend the `agent_fs.configured` field (`:576`) to report the **active provider id + capabilities** (keep the existing boolean for back-compat).

#### 5. Provider-agnostic attachment renderers
**File**: `src/slack/blocks.ts:164-169`, `src/commands/context-preamble.ts:87-88`, `src/tasks/worker-follow-up.ts:72-73`
**Changes**: These render attachment links from the agent-fs columns only (via `buildAgentFsLiveUrl`, `src/utils/constants.ts:114`). Make them **provider-aware**: `provider_id='agent-fs'` → live URL (existing); local-fs/other → a swarm `/api/fs/tasks/:taskId/files/:id/raw` (or `signed-url`) link. **Without this, local-fs attachments render no/broken links in Slack + the agent preamble** — a real regression once local-fs is the default.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Route tests pass: `bun test src/tests/fs-routes.test.ts`
- [ ] OpenAPI is fresh (no diff after regen): `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [ ] Boundaries pass: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [ ] `fs-routes.test.ts` (minimal `node:http` handler, isolated DB, unique port per `LOCAL_TESTING.md:24-29`) round-trips **upload (binary body) → list → download → delete** against local-fs and asserts a `task_attachments` row appears then disappears.
- [ ] Upload >50 MB returns **413**; upload to a missing task returns **404**; unauthenticated request returns **401** (missing Bearer/`X-Agent-ID`).
- [ ] With the local agent-fs backend on `:7433` + envs set, the same upload/download round-trip succeeds end-to-end (curl walkthrough; `GET /raw` returns the bytes, `signed-url` returns a presigned GET).
- [ ] Renderer check: a **local-fs** attachment produces a swarm `/api/fs/...` link (not a broken agent-fs live URL) from the Slack block + preamble builders; an **agent-fs** attachment still produces its live URL.

#### Manual Verification:
- [ ] Review the binary-body handling approach (outside `parse()`) with Taras — confirm it's the right v1 cut vs. generalizing the `route()` factory.

**Implementation Note**: Pause for confirmation; commit `[phase 3] /api/fs/* routes + first binary upload + openapi`.

---

## Phase 4: Deterministic boot provisioning (TS seeder) + agent wiring

### Overview

A server-side `Seeder` provisions the swarm's **single shared agent-fs org + drive + admin
key** (the key backs the API-side `/api/fs/*` provider), idempotently at boot, persisting
ids → `swarm_config` and key → encrypted secrets. **Per-worker agent-fs identities are
retained** (each worker registers its own user with a distinct email; lead = org admin;
org/drive shared; worker = editor), plus auto-invite of swarm users who have a primary
email, and the small cleanups (drive injection, dangling-tool removal).

### Changes Required:

#### 1. Shared org + drive + admin key (TS seeder, API-side, once)
**File**: `src/be/seed/agent-fs-provision.ts` (new), registered in `src/be/seed/registry.ts:14`
**Changes**: New `Seeder` (contract `src/be/seed/types.ts:43`). `apply()`: gate on `AGENT_FS_API_URL`; reuse the stored admin key if present, else `POST /auth/register` (the admin / "lead" user) and store the key in the **encrypted secrets store** (global). Ensure the swarm's **single shared org + shared drive** (`GET /auth/me` → `POST /orgs` / `POST /orgs/{org}/drives` as needed), owned by the admin user. Persist `AGENT_FS_DEFAULT_ORG_ID` + `AGENT_FS_DEFAULT_DRIVE_ID` to **`swarm_config` global** via `upsertSwarmConfig`. This admin key backs the API-side `/api/fs/*` provider. Idempotent via `seed_state` (`src/be/seed/runner.ts`) + key reuse. Runs in `runAllSeeders` (`src/http/index.ts:467`). **Register email:** source from config (`AGENT_FS_REGISTER_EMAIL`) or derive from the install id — don't hardcode. **Boot resilience:** non-fatal if agent-fs is unreachable at boot (co-deployed service may lag the API) — log + skip, retried next boot (mirrors the shell's `|| true`); never crash API boot.

#### 2. Per-worker agent-fs identities (retained, per-worker) — _from Taras's review_
**File**: `docker-entrypoint.sh` (worker branch) or lifted into worker boot TS
**Changes**: **Each worker registers its own agent-fs user with a distinct email** (e.g. `worker-<agentId>@<swarmEmailDomain>`) → its own key for the agent's native CLI. The **lead's user is org admin**; the **org + drive are the same (shared) for all** workers. After a worker registers, the admin (seeder/lead) grants it **editor** on the shared org+drive (`POST /orgs/:orgId/members/invite` / member-add, `agent-fs orgs.ts:103-181`). This is inherently per-worker, so it is **not** absorbed into the API seeder — only the shared org/drive + admin key (#1) move off the shell.

#### 3. Auto-invite swarm users with a primary email — _from Taras's review_
**File**: `src/be/seed/agent-fs-provision.ts` (or a follow-up reconcile pass)
**Changes**: When a swarm **user** has a primary email set, the admin invites that email to the shared org + drive (`POST /orgs/:orgId/members/invite {email, role}`) so that when they self-register in agent-fs they are **already a member** of the org and drive. Default role = viewer (editor for operators). ⚠️ **Access-control caveat:** the single shared drive holds **all** tasks' files, so any invited member can see every task's artifacts — acceptable for v1's trust model, but note it before widening invites; per-task isolation is a deferred (post-v1) concern.

#### 4. Provider reads the provisioned key
**File**: `src/fs/agent-fs-provider.ts`, `src/fs/registry.ts`
**Changes**: Store the admin key as a **global** `swarm_config` secret (NOT agent-scoped as the shell did — global is what the API process reads; `API_KEY`/`SECRETS_ENCRYPTION_KEY` are the only keys barred from global injection, `src/be/db.ts:5972`). **Confirmed during review:** `getInjectableGlobalConfigs` (`src/be/db.ts:5972`) returns **decrypted** global configs, so `loadGlobalConfigsIntoEnv(false)` (`src/http/core.ts:33`, called at `src/http/index.ts:441`) materializes `AGENT_FS_API_KEY` into `process.env` on every boot — but *before* `runAllSeeders` (`:467`). So on the **first** boot the seeder must also set `process.env.AGENT_FS_API_KEY` directly (materialization only kicks in next boot); thereafter the boot-time load covers it. The provider reads `process.env.AGENT_FS_API_KEY`.

#### 5. Trim shell provisioning (revised — keep per-worker register)
**File**: `docker-entrypoint.sh`
**Changes**: Move **shared org/drive creation + admin key** to the seeder (#1); **retain** the per-worker self-register (#2). Confirm the worker still receives `AGENT_FS_DEFAULT_DRIVE_ID` via the config-resolved overlay (`src/commands/runner.ts:356`, `:2636-2637`). (Revises the earlier "retire the whole block" framing — only the shared-provisioning portion is lifted.)

#### 6. Cleanups
**File**: `src/be/seed-scripts/catalog/memory-eval.ts`
**Changes**: Remove the dangling `ctx.swarm.agent_fs_write` call (`:518`).

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Seeder test passes: `bun test src/tests/agent-fs-provision-seeder.test.ts`
- [ ] `bash -n docker-entrypoint.sh` parses; boundaries pass: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [ ] `agent-fs-provision-seeder.test.ts`: against the local agent-fs on `:7433` (or stubbed `fetch`), `apply()` provisions the shared org/drive + admin key and persists ids to `swarm_config` + key to secrets; a **second** `apply()` is a no-op (idempotent, reuses the stored key).
- [ ] **Per-worker identity:** two workers register with **distinct emails** and both appear as **editor** members of the **shared** org+drive; the lead/admin user owns the org (`GET /orgs/:orgId/members`).
- [ ] **Auto-invite:** a swarm user with a primary email shows as an invited member of the shared org+drive after the invite pass.
- [ ] Boot with `AGENT_FS_API_URL`/`AGENT_FS_API_KEY` unset → seeder skips, no error (local-fs path), per `LOCAL_TESTING.md:48-74` smoke-test.
- [ ] Docker round-trip per `LOCAL_TESTING.md:76-87`: boot the worker image, grep boot logs for the seeder running, and `GET /api/config?includeSecrets=true` shows the persisted drive id (and the key as a secret).

#### Manual Verification:
- [ ] Confirm the encrypted-secrets path for `AGENT_FS_API_KEY` end-to-end with Taras (the provider can actually read what the seeder wrote on a real boot).

**Implementation Note**: This phase touches `docker-entrypoint.sh` + provider dispatch → full Docker round-trip required (not just `bash -n`). Pause for confirmation; commit `[phase 4] agent-fs shared provisioning seeder + per-worker identity wiring`.

---

## Phase 5: Dashboard UI — upload / list / preview / download

### Overview

Upgrade the task-view attachment section from display-only to interactive (upload, list,
preview, download, delete), wired to `/api/fs/*` and capability-aware (core-only in v1).

### Changes Required:

#### 1. Attachment section + hooks
**File**: `ui/src/components/shared/task-attachments-section.tsx`, new `ui/src/api/fs.ts` + hooks (`useTaskAttachments`, `useUploadAttachment`, `useDeleteAttachment`)
**Changes**: File-input upload (drag-drop optional) → `POST /api/fs/tasks/:taskId/files`; list from `GET …/files`; **preview** (text + image inline, others → download link; text previews pass `scrubSecrets` before rendering — the raw download stays unscrubbed); download via `…/raw` or `signed-url`; delete via `DELETE …`. Feature-detect via `GET /api/fs/capabilities` and **hide** search/comments/versioning in v1.

#### 2. Types + indicator
**File**: `ui/src/api/types.ts`, `ui/src/pages/home/page.tsx`
**Changes**: Add `providerId`/`providerKey`/`capabilities` + the capabilities response type. Update the home indicator to show the **active provider** (local-fs vs agent-fs) instead of only "AGENT_FS_API_URL set".

#### 3. Input-file uploads before a task exists (sessions UI) — _from Taras's review_
**File**: the session-compose UI flow + `src/http/fs.ts`
**Changes**: In the **sessions UI** a human may attach **input files before a task is created** — there is no `taskId` yet, but `task_attachments.task_id` is a NOT-NULL FK (tasks-only ownership). **Resolved:** the existing **`backlog`** task status (`src/types.ts:6` — "in backlog, not yet ready for pool") is the draft mechanism — create the task in `backlog` on first upload, attach inputs to it, then transition to `unassigned`/pool when the human submits. **No schema change** (rejects option (b)'s nullable owner). Mark these as **inputs** (reuse the existing `intent`/`is_primary` columns) so the agent preamble surfaces them as task inputs. Edge case to handle: an abandoned `backlog` task with orphaned input blobs (sweep/expire later — note, don't build in v1).

### Success Criteria:

#### Automated Verification:
- [ ] UI type check + lint pass: `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b`
- [ ] API type check passes: `bun run tsc:check`

#### Automated QA:
- [ ] With API (`:3013`) + UI (`cd ui && pnpm run dev`, `:5274`) + a test task, drive the dashboard with **browser-use** (agent-browser, local URL) through upload → see it listed → preview a text + an image file → download → delete, capturing screenshots at each step.
- [ ] Capability degradation: with **no** agent-fs envs (local-fs), confirm no search/comments/versioning UI renders and the indicator shows "local-fs".
- [ ] **Input-file flow:** from the sessions compose flow, attach an input file **before** the task is created; confirm it ends up associated with the created task and is surfaced to the agent as an input (per the resolved approach in change #3).

#### Manual Verification:
- [ ] **Taras manual-QAs the SPA** with screenshots (project convention — no qa-use YAML in this repo). ⚠️ The `ui/` merge-gate nominally requires a `qa-use` session with screenshots; confirm with Taras whether to satisfy the gate or waive it for this PR.
- [ ] Visual review of preview rendering (text wrapping, image sizing, large-file fallback).

**Implementation Note**: Frontend phase — `ui/` PR gate applies. Pause for confirmation; commit `[phase 5] task-view attachment upload/list/preview/download UI`.

### QA Spec (optional):

Cross-cutting, evidence-heavy UI walkthrough → generate `thoughts/taras/qa/2026-06-26-agent-fs-attachments-ui.md` via `desplega:qa` before handoff (scenarios live in the doc).

---

## Phase 6: Co-deployment — Helm bump, docker-compose recipe, docs

### Overview

Bring co-deployment up to v0.9.x and make local co-deployment one command: bump the Helm
image + add key/embedding config, add an agent-fs + MinIO docker-compose recipe, and write
the co-deployment docs (incl. the default-shift migration messaging).

### Changes Required:

#### 1. Helm
**File**: `charts/agent-swarm/templates/agent-fs-deployment.yaml`, `charts/agent-swarm/values.yaml:224-252`, `charts/agent-swarm/templates/agent-fs-secret.yaml`
**Changes**: Bump image `0.7.2 → 0.9.x`; add `AGENT_FS_API_KEY` (provisioned/existingSecret) + `EMBEDDING_*` (default local model, zero-config) env; expose new `agentFs.*` values keys.

#### 2. docker-compose recipe
**File**: `docker-compose.local.yml`, `docker-compose.example.yml`
**Changes**: Add `minio` (9000/9001, `minioadmin`) + `agent-fs` (7433, `AGENT_FS_HOME=/data`, `depends_on: minio`) services, injecting `AGENT_FS_API_URL`/`AGENT_FS_API_KEY` into api/worker (recipe modeled on the agent-fs repo's own compose).

#### 3. Docs
**File**: `docs-site/content/docs/(documentation)/guides/agent-fs-co-deployment.mdx` (new) + a `runbooks/` pointer
**Changes**: Document both paths (Helm `agentFs.enabled`, compose), the `AGENT_FS_API_URL`+`_API_KEY` → auto-enable-capabilities story, the v1 limits (1h signed-URL expiry, all types ≤ 50 MB), and the **migration messaging**: the no-config default is now **local-fs** (was implicit hosted `live.agent-fs.dev`) — set the envs to keep agent-fs.

### Success Criteria:

#### Automated Verification:
- [ ] Helm chart lints/templates: `helm lint charts/agent-swarm && helm template charts/agent-swarm --set agentFs.enabled=true >/dev/null`
- [ ] Compose configs are valid: `docker compose -f docker-compose.local.yml config -q`

#### Automated QA:
- [ ] `docker compose -f docker-compose.local.yml up --build` brings up minio + agent-fs; `curl http://localhost:7433/health` is healthy; with the swarm pointed at it, a `/api/fs/*` upload round-trips against the agent-fs provider (re-run the Phase-3 curl walkthrough).
- [ ] `helm template … --set agentFs.enabled=true` output shows image `0.9.x` and the `AGENT_FS_API_KEY`/`EMBEDDING_*` env present in the agent-fs Deployment.

#### Manual Verification:
- [ ] Taras reviews the co-deployment docs for accuracy and the migration-messaging wording (default shift to local-fs).

**Implementation Note**: Pause for confirmation; commit `[phase 6] agent-fs co-deployment: helm 0.9.x + compose recipe + docs`.

---

## Appendix

- **Suggested implementation split** (rule of thumb — this is large for one session):
  - **Session A — server foundation**: Phases 1–4 (provider interface → schema → routes → provisioning). Self-contained and fully testable with a local agent-fs backend; ends with `/api/fs/*` working and provisioning automated.
  - **Session B — surfaces**: Phases 5–6 (UI + co-deployment). Depend only on the Phase-3 routes.
- **Derail notes (out of scope, captured so they're not lost)**:
  - Typed TS SDK generated from OpenAPI (deferred deliverable #4 from the brainstorm).
  - Search/comments/versioning **UI** surfacing (provider already exposes them).
  - Reconcile sweep / `/tasks/{taskId}/` auto-discovery of agent CLI writes (chose status-quo `store-progress` for v1).
  - Soft-delete tombstones for `task_attachments` (v1 is hard-delete).
  - `signedUploadUrl` for agent-fs (it has no signed upload URL — would need a swarm-proxied upload or direct-S3 presign that bypasses version/embed).
  - **Abandoned `backlog` tasks with orphaned input blobs** (Phase 5 #3) — a sweep/expiry for `backlog` tasks that never get submitted; deferred (don't build in v1).
  - **Per-task file isolation** — the single shared drive means every org/drive member sees all task files (Phase 4 #3 caveat); per-task RBAC is post-v1.
- **Known traps**:
  - **First binary route** — `route().parse()` is JSON-only (`src/http/utils.ts:83`); upload must read the raw body outside it.
  - **`kind` enum three-way sync** (SQL CHECK + two Zod defs) — v1 adds no new `kind` value, but keep the invariant if that changes.
  - **OpenAPI freshness** — any route change requires `import` in `scripts/generate-openapi.ts` + `bun run docs:openapi` committed, or CI fails.
  - **agent-fs OpenAPI/cache are unreliable** — build against the live v0.9.0 handlers in `/Users/taras/Documents/code/agent-fs`.
  - **Helm chart pinned 0.7.2 with no key/embedding env** — semantic search/auth may be unconfigured until Phase 6.
- **References**:
  - Research: `thoughts/taras/research/2026-06-25-agent-fs-first-class.md`
  - Brainstorm: `thoughts/taras/brainstorms/2026-06-25-agent-fs-first-class.md`
  - Issue: https://github.com/desplega-ai/agent-swarm/issues/813
  - Live agent-fs v0.9.0: `/Users/taras/Documents/code/agent-fs`
  - Testing: `LOCAL_TESTING.md`, `swarm-local-e2e` skill, `runbooks/testing.md`

## Review Errata

_Reviewed: 2026-06-26 by Claude (desplega:reviewing, auto-apply mode). No Critical findings — all applied directly. Two claims were code-verified during review (see below)._

### Applied (Important)

- [x] **Provider key resolution made concrete** (Phase 1, Phase 4) — was a "confirm during implementation" hand-wave. Verified `getInjectableGlobalConfigs` (`src/be/db.ts:5972`) returns *decrypted* globals, so `loadGlobalConfigsIntoEnv(false)` materializes a **global** `AGENT_FS_API_KEY` secret into `process.env`; specified the seeder stores it global (not agent-scoped) and also sets `process.env` on first boot (materialization is next-boot).
- [x] **Provider-agnostic renderers added as a change-set** (Phase 3 #5) — `src/slack/blocks.ts`, `src/commands/context-preamble.ts`, `src/tasks/worker-follow-up.ts` only build agent-fs live URLs today; local-fs attachments would render broken links once local-fs is the default. Now an explicit task + QA check.
- [x] **Upload/delete consistency + ordering** (Phase 3) — bytes-first then DB row; best-effort blob cleanup on insert failure; idempotent delete. Closes the orphan-blob / dangling-row gap.
- [x] **Authorization model stated** (Phase 3 #2) — `/api/fs/tasks/:taskId/*` reuses task-access checks (reads = viewer, upload/delete = owner/assignee); confirm dashboard auth (swarm key vs `aswt_` token).
- [x] **Egress-scrub placement corrected** (Phase 3, Phase 5) — the raw download serves **unscrubbed** bytes (it's the user's file); `scrubSecrets` applies to the UI text preview + log lines, not the download stream.
- [x] **Boot resilience + register email** (Phase 4) — seeder is non-fatal if agent-fs is unreachable at boot (retried, mirrors shell `|| true`); register email sourced from config/install-id, not hardcoded.
- [x] **Signed-URL expiry policy decided** (Phase 3, Phase 6) — v1 caps presigned GETs at **1h** (tighter than agent-fs's 24h default; it's a public link). File-type policy: allow-all ≤ 50 MB.
- [x] **Dedup interaction clarified** (Phase 2) — existing `(task_id, sha256)` dedup retained; new `(task_id, provider_id, provider_key)` index is for lookup/replace/delete, not a uniqueness constraint; per-kind `provider_key` backfill spelled out.
- [x] **`/api/fs` ↔ existing readers reconciled** (Phase 3) — relationship with `src/http/tasks.ts` + MCP `get-task-details.ts` stated; `/api/fs/.../files` is the canonical UI source, all return provider columns.

### Applied (Minor)

- [x] **local-fs persistence note** (Phase 1) — verified API is single-replica (`api-statefulset.yaml:5-18` pins `replicas: 1`), so no cross-replica issue; `AGENT_FS_LOCAL_DIR` just needs a persistent volume.
- [x] **Phase 1 capability-mixin scope note** — v1 has no consumer; implement as thin pass-throughs or defer bodies to avoid Phase 1 scope creep.

### Not applied (by design)

- Frontmatter uses `author:` rather than the template's `planner:` — kept for consistency with the sibling research/brainstorm docs.

### From file-review (Taras's inline comments, 2026-06-26)

- [x] **Auto-invite swarm users with a primary email** → Phase 4 #3 (invite their email to the shared org/drive so they're pre-added on self-register; access-control caveat noted).
- [x] **Per-worker identity model** → Phase 4 #2 + #5 + decisions table: each worker registers with a **distinct email**, **lead = admin**, **shared org/drive for all**, worker = editor. This **revises** the earlier "retire the whole `docker-entrypoint.sh` block" decision — per-worker registration is retained; only shared org/drive + admin key move to the seeder.
- [x] **Pre-task input uploads** → Phase 5 #3: the sessions UI may upload input files before a task exists (`task_id` is NOT NULL). **Resolved** during processing — reuse the existing **`backlog`** task status (`src/types.ts:6`) as the draft holder (create-in-`backlog` → attach → submit to pool); no schema change needed.

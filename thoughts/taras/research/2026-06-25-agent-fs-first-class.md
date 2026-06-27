---
date: 2026-06-25T00:00:00Z
researcher: Taras
git_commit: 060c891107765dbb31704b81d2a21f539b35b55d
branch: main
repository: agent-swarm
topic: "First-class External Filesystem support — agent-fs (issue #813)"
tags: [research, codebase, agent-fs, attachments, filesystem, provider-interface, provisioning, helm, http-routes]
status: complete
autonomy: autopilot
last_updated: 2026-06-25
last_updated_by: Taras
---

# Research: First-class External Filesystem support — agent-fs (issue #813)

**Date**: 2026-06-25
**Researcher**: Taras
**Git Commit**: 060c8911 (main)
**Branch**: main

## Research Question

Lock the implementation facts needed to make agent-fs a first-class citizen of the swarm
(GitHub issue #813), grounded in the completed brainstorm
(`thoughts/taras/brainstorms/2026-06-25-agent-fs-first-class.md`). Six areas: (1) live
agent-fs v0.9.0 HTTP + CLI surface; (2) `task_attachments` schema evolution; (3) the
two-tier provider interface + env-driven detection; (4) agent-side provisioning + reconcile;
(5) deterministic boot provisioning; (6) co-deployment. Plus a full `AGENT_FS_*` call-site
map and the `/api/fs/*` route surface to add.

> **Source note:** the live agent-fs source is the sibling repo
> `/Users/taras/Documents/code/agent-fs` (**v0.9.0**). The `~/.claude` plugin marketplace
> cache is stale at v0.1.5 and gives wrong answers — all agent-fs findings below are from
> the live repo.

## Summary

The swarm's agent-fs integration today is a **pointer-and-link layer, not a server-side
filesystem client**: the swarm server never opens a socket to agent-fs. The agent writes
files itself via the **agent-fs CLI** (taught at length in the `system.agent.agent_fs`
prompt template), then `store-progress` records an `(org, drive, path)` pointer into the
`task_attachments` table, and renderers (Slack, child-task preamble, UI) reconstruct a
`https://live.agent-fs.dev/file/~/<org>/<drive>/<path>` link. There is **no `/api/fs/*`
route surface, no server-side agent-fs client, and no `agent_fs_write` MCP tool** (the lone
`ctx.swarm.agent_fs_write` call in a seed script is dangling and swallowed by try/catch).

Several pieces the brainstorm assumed were "net-new" already partially exist: **(a)
deterministic provisioning runs today in `docker-entrypoint.sh:404-483`** (each worker
self-registers via `POST /auth/register` if it lacks a key and stores it as an
agent-scoped *secret* via `PUT /api/config`; the lead creates the shared org via
`POST /orgs`) — so provider creds already flow through the encrypted config store, not raw
env; **(b) a full Helm co-deployment** (`agentFs.enabled` → Deployment + PVC + Service +
Ingress + S3 secret, injecting `AGENT_FS_API_URL` into API and worker pods) already ships,
pinned to agent-fs `0.7.2`; and **(c) a UI attachment renderer**
(`ui/src/components/shared/task-attachments-section.tsx`) plus a home-page
configured/not-configured indicator already exist. The genuine gaps are: a server-side
provider client behind `/api/fs/*`, a binary upload path (no `route()` endpoint parses
binary/multipart today — this would be the first), provider-agnostic metadata + a
delete/replace path on the append-only `task_attachments` table, moving provisioning from
per-worker shell into deterministic server-side TS, and a docker-compose recipe (the Helm
path exists; compose has no agent-fs/MinIO service).

agent-fs v0.9.0 exposes everything needed for a "rich provider" binding over HTTP: binary
upload `PUT .../files/{path}/raw` (50 MB, auto mime + version + embed via `writeRaw`),
download `GET .../raw` + the `signed-url` op (presigned GET, 24h default, **no signed
*upload* URL**), a 29-op dispatch API (`POST /orgs/{org}/ops`, including search/comments/
vcs/`sql`), and full REST provisioning (`/auth/register`, `/auth/me`, `POST /orgs`,
`POST /orgs/{org}/drives`). The API key is **per-user** but one key can own many orgs/drives.

## Detailed Findings

### 1. agent-fs v0.9.0 HTTP + CLI surface

**Auth / provisioning** (all in `agent-fs` repo `packages/server/src/routes/`):
- `POST /auth/register` (`auth.ts:9`) — body `{ email }`; returns **`{ apiKey, userId, orgId }`**
  (orgId = the user's auto-created personal org); 409 on dup. Only public write route
  (`middleware/auth.ts:6` `PUBLIC_PATHS = ["/auth/register","/health"]`).
- `GET /auth/me` (`auth.ts:39`) — returns **`{ userId, email, defaultOrgId, defaultDriveId }`**
  (nulls on resolution failure).
- `POST /orgs` (`orgs.ts:68`) — body `{ name }` → org, 201.
- `POST /orgs/:orgId/drives` (`orgs.ts:92`) — body `{ name }`, requires **org admin**, → drive, 201.
- Members/invite: `POST /orgs/:orgId/members/invite {email,role}`, `GET/PATCH/DELETE
  /orgs/:orgId/members[/:userId]`, drive-level equivalents (`orgs.ts:103-181`).
- **API key is per-USER** (`identity/users.ts:33`), key shape **`af_<hex>`**, sha256-hashed
  to `users.apiKeyHash`; auth = `Authorization: Bearer <key>` → `getUserByApiKey`. One key
  can own many orgs/drives. Default drive resolution: explicit `driveId` > org's default >
  personal org's default (`core/src/identity/context.ts:14`). Cross-tenant probes → 404.

**Upload / download** (`packages/server/src/routes/files.ts`):
- `PUT /orgs/:orgId/drives/:driveId/files/:path{.+}/raw` (`files.ts:99`) — **binary body**
  (rejects `application/json` 415), editor+ RBAC, **50 MB** cap (`app.ts:30` Hono bodyLimit +
  `core/src/ops/write.ts:18` `MAX_RAW_FILE_SIZE`). Conditional `If-None-Match: *` (create-only)
  / `If-Match: <n>` + `X-Agent-FS-Message`. Calls `writeRaw` → versioning + FTS + embedding
  pipeline (auto mime-routed). Returns `{version, path, ...}` + `ETag`/`X-Agent-FS-Version`/
  `-Content-Hash`/`-Deduped`.
- `GET .../raw` (`files.ts:24`) — viewer-accessible, streams bytes + version/etag/hash headers.
- `signed-url` op (`core/src/ops/signed-url.ts:19`) — `{path, expiresIn?}`, default **86400s
  (24h)**, bounds 60–604800; **presigned GET only — NO signed upload URL**; HEAD-checks
  existence first.

**Ops API** `POST /orgs/:orgId/ops` (`ops.ts:9`) — **29 ops** (`core/src/ops/index.ts:43-302`):
content (`write`/`cat`/`edit`/`append`), nav (`ls`/`stat`/`tail`/`tree`/`glob`), filemgmt
(`rm`/`mv`/`cp`), vcs (`log`/`diff`/`revert`/`recent`), search (`grep`/`fts`/`search`/
`vec-search`/`sql`), comments (6× `comment-*`), maintenance (`reindex` admin-only,
`signed-url`). `write` content is a **string**, **10 MB** cap (`ops/write.ts:14-15`); `sql`
op (sandboxed DuckDB over csv/parquet/xlsx/sqlite) reads up to `AGENT_FS_SQL_MAX_FILE_BYTES`
(default 256 MB). RBAC `viewer<editor<admin`, `OP_ROLES` map (`core/src/identity/rbac.ts:15-46`),
unknown ops default to admin.

**CLI** (`packages/cli/`) — env-driven (`api-client.ts:7-22`: `AGENT_FS_API_URL` →
`config.apiUrl` → `127.0.0.1:7433`; `AGENT_FS_API_KEY` → config; `Authorization: Bearer`).
Ops flattened to top-level verbs (`registerOpCommands`, `index.ts:79`): `agent-fs write
<path> --content|--file <localpath> -m <msg>`, `cat`/`search`/`fts`/`ls`/`stat`/…,
`download`, `signed-url --expires-in`, and `drive`/`org`/`member` management.

**S3 key layout** `getS3Key(orgId, driveId, path)` = **`<orgId>/drives/<driveId>/<path>`**
(`core/src/ops/versioning.ts:11`). Config defaults: bucket `agentfs`, provider `minio`,
port 7433, embedding provider `local`.

> ⚠️ **OpenAPI is unreliable:** `agent-fs` `docs/openapi.json` (v0.9.0) documents only 4
> paths and its `/auth/register` + `/auth/me` response schemas **do not match the live
> handlers**; `/raw`, drive, and member routes are undocumented. Build against the handlers,
> not the spec.

### 2. `task_attachments` schema + evolution surface

**Schema** (`src/be/migrations/072_task_attachments.sql:16-38`, `073…:14-15`, `082…:97-98`):
`id` PK, `task_id` FK→`agent_tasks` ON DELETE CASCADE, `agent_id`, `name`, `kind` CHECK
`('agent-fs','url','shared-fs','page')`, `url`, `path`, `page_id`, `mime_type`, `size_bytes`,
`sha256`, `intent`, `description`, `is_primary`, `created_at`; +073 `agent_fs_org_id`,
`agent_fs_drive_id`; +082 `created_by`/`updated_by` (FK `users`, **but absent from TS types
& INSERT — always NULL via this path**). Indexes: `(task_id)`, partial `(sha256)`. The
agent-fs file is referenced by the generic **`path`** column; org/drive columns only feed
live-URL building.

**Write** — `insertTaskAttachment` (`src/be/db.ts:2684-2771`): **append-only**, dedup on
`(task_id, sha256)` then tuple `(task_id, kind, path, url, page_id, name)`. **No UPDATE/DELETE
exists anywhere in `src/`** — only `ON DELETE CASCADE`. So a v1 delete/replace UI needs a
**net-new** mutation path.

**Read** — `getTaskAttachments(taskId)` (`db.ts:2773`) is the lone reader; surfaced via HTTP
`src/http/tasks.ts:549`, MCP `src/tools/get-task-details.ts:60`, Slack
`src/slack/blocks.ts:184` + `responses.ts`/`watcher.ts`, `src/tasks/worker-follow-up.ts:121`,
`src/commands/context-preamble.ts:84`.

**TS types** — `TaskAttachmentSchema` (`src/types.ts:328-347`), `AttachmentInputSchema`
discriminated union (`types.ts:290-326`), `TaskAttachmentKindSchema` enum (`types.ts:274`).
`kind` lives in **three places that must stay in sync** (SQL CHECK + two Zod defs), per the
`AgentTaskSourceSchema` convention.

**Provider-agnostic generalization touch-list** (what is agent-fs-specific today): the two
SQL columns (073) + `kind='agent-fs'` (072:21); three Zod defs (`types.ts:274,292-308,338-339`);
`db.ts` insert/row/input (`2644-2645,2664-2667,2743`); the `store-progress.ts:159-176` write
branch; and three renderers' agent-fs branches (`blocks.ts:163-170`,
`context-preamble.ts:87-93`, `worker-follow-up.ts:72-73`) + the `buildAgentFsLiveUrl` helper.

### 3. Provider interface (two-tier) + env-driven detection

**Core tier — Files SDK** (`files-sdk.dev`): one `Files` class, 10 methods (`upload`,
`download`, `head`, `exists`, `delete`, `copy`, `move`, `list`/`listAll`, `url`,
`signedUploadUrl`), 40+ adapters incl. local `fs` for tests, normalized `FilesError`, typed
`.raw` escape hatch. **Capability model** is a queryable `files.capabilities`:
`{rangeRead, uploadProgress, delimiter, metadata, cacheControl, multipart, serverSideCopy,
signedUrl:{supported, maxExpiresIn?}}`. It **deliberately has no flags for versioning /
checksums / conditional writes** (those are `.raw` territory) — which is exactly why
agent-fs's **search / comments / versioning belong in a swarm-side capability tier above
the Files-SDK core**, not in Files SDK's own capability surface.

**Env-driven detection (today's gate):** `AGENT_FS_API_URL` is the de-facto "configured"
signal — it drives `/status` (`src/http/status.ts:576`) and gates the agent-fs prompt section
(`src/prompts/base-prompt.ts:253`). `AGENT_FS_API_KEY` is currently **only in the scrubber**
(`src/utils/secret-scrubber.ts:43`), never read by swarm TS. A real server-side client needs
both `AGENT_FS_API_URL` + `AGENT_FS_API_KEY` → that pair is the capability auto-enable trigger.

### 4. Agent-side provisioning + reconcile (what exists today)

**Provisioning lives in shell** — `docker-entrypoint.sh:404-483`: gate on `AGENT_FS_API_URL`;
if `AGENT_FS_API_KEY` absent, worker self-registers `POST ${AGENT_FS_API_URL}/auth/register`
(`:428`), stores the returned key as an **agent-scoped secret** via `PUT /api/config`
(`isSecret:true`, `:437`), and exports it; lead-only creates the shared org `POST /orgs`
(`:462`), stores it as **global** config, exports `AGENT_FS_SHARED_ORG_ID`. Idempotent on
restart (key reloaded from resolved config).

**Env plumbing** — `fetchResolvedEnv` (`src/commands/runner.ts:356-415`) builds the worker
env: `process.env` + overlay of `/api/config/resolved?includeSecrets=true` (`:380-383`),
handed to the harness subprocess via `config.env = freshEnv` (`:2691`). So the agent-fs CLI
reads `AGENT_FS_API_URL`/`AGENT_FS_API_KEY` from inherited env; the key rides the **generic
config-secret overlay** (no dedicated TS line; only `AGENT_FS_SHARED_ORG_ID` is copied to
`process.env` for the prompt builder, `:2636-2637`).

**Agent write path = CLI, not MCP** — the `system.agent.agent_fs` template
(`src/prompts/session-templates.ts:287-367`) teaches `agent-fs write/cat/fts/search/ls/docs/
comment`, personal vs shared drives (`--org {{sharedOrgId}}`), and building human share URLs
from `agent-fs stat <path> --json`. Gated on `hasLocalEnv && AGENT_FS_API_URL`
(`base-prompt.ts:248-259`). **There is no `agent_fs_write` MCP tool** — not in `src/tools/`,
not in `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`); the only reference is a
dangling `ctx.swarm.agent_fs_write` in `src/be/seed-scripts/catalog/memory-eval.ts:518`
(try/catch-swallowed). Nothing to delete — only that seed call to clean up.

**Reconcile today** — `store-progress.ts:137-185`: `resolveAgentFsDefaults` (`:146-156`) reads
config `AGENT_FS_DEFAULT_ORG_ID`/`_DRIVE_ID`; per-row org/drive used for `kind==='agent-fs'`;
`insertTaskAttachment` records the pointer. The agent must explicitly pass attachments to
`store-progress` — there is no automatic sweep of what the CLI wrote.

### 5. Deterministic boot provisioning (where net-new TS attaches)

**Boot sequence** (`src/http/index.ts`): pre-listen — `loadGlobalConfigsIntoEnv(false)`
(`:441`, materializes global `swarm_config` → env, first DB touch), `seedPricingFromModelsDev`
(`:452`), **`runAllSeeders` (`:467`)**, `initOtel` (`:476`); `initDb` (`src/be/db.ts:155-361`)
runs migrations + template seed + crypto key-bootstrap; post-listen — integrations, scheduler,
`startHeartbeat` (`:546`), background backfills `runBootReembed`/`runBootReembedScripts`/
`runBootScrubLogs` (`:567-585`).

**Seeder extension point** — add a `Seeder` to `SEEDERS` (`src/be/seed/registry.ts:14`);
contract `kind`/`items()`/`upstreamHash()`/`apply()` (`src/be/seed/types.ts:43-55`); idempotent
via `seed_state` table (`src/be/seed/runner.ts:17-86`). A "provision agent-fs drive" seeder
(e.g. `kind: "agent-fs-drive"`) would call `/auth/register`→`/auth/me`→`POST /orgs/{org}/drives`
and persist the drive id to **`swarm_config` global** via `upsertSwarmConfig` (the install-id
path, `src/http/index.ts:504`). Reserved keys that can't be stored there: only `API_KEY` /
`SECRETS_ENCRYPTION_KEY` (`src/be/swarm-config-guard.ts:16`) — `AGENT_FS_DEFAULT_DRIVE_ID` is
fine. **No agent-fs provisioning exists in `src/` today** (only the shell entrypoint, §4); the
boot-triage LLM task (`src/heartbeat/heartbeat.ts:1150`, T+90s) does no agent-fs work.

### 6. Co-deployment (exists in Helm; compose gap)

**Helm chart ships a complete agent-fs co-deployment**, gated `agentFs.enabled` (default false):
`agent-fs-deployment.yaml` (image `ghcr.io/desplega-ai/agent-fs:0.7.2`, port 7433,
`envFrom` S3 secret, `Recreate` strategy), `agent-fs-pvc.yaml` (RWO 10Gi, `resource-policy:
keep`), `agent-fs-service.yaml` (ClusterIP), `ingress.yaml:33-67`, `agent-fs-secret.yaml`
(S3_ACCESS_KEY_ID/SECRET/ENDPOINT/REGION; `existingSecret` override). API **and worker pods**
get `AGENT_FS_API_URL` injected (`api-statefulset.yaml:68-71`, `_helpers.tpl:120-123`). Values
at `values.yaml:224-252`. ⚠️ pinned to **0.7.2** (live is 0.9.0); sets **no** `AGENT_FS_API_KEY`
or embedding config (semantic search/auth may be unconfigured as-is).

**docker-compose gap:** swarm `docker-compose.local.yml` (api/lead/pi-worker/codex-worker) and
`docker-compose.example.yml` (9 services) have **no agent-fs/MinIO service**. Reference recipe
from the agent-fs repo: `docker-compose.yml` = `minio` (9000/9001, minioadmin) +
`agent-fs` (7433, `AGENT_FS_HOME=/data`, depends_on minio); `docker-compose.hosted.yml` =
single agent-fs service with external S3.

### 7. The `/api/fs/*` route surface to add

`route()` factory (`src/http/route-def.ts:148-206`): `RouteDef` (`method`, `path`, `pattern`,
zod `params`/`query`/`body`, `responses`, `auth:{apiKey?,agentId?}`); registers at import time;
**model after `src/http/kv.ts`** (per-variant `route()` + a `handleKv` dispatcher trying
`.match()` most-specific-first). Register the dispatcher in `src/http/index.ts:275-320` (order
matters, first match wins) and **add `import "../src/http/fs";` to `scripts/generate-openapi.ts`**
then `bun run docs:openapi`. Auth is central in `handleCore` (`src/http/core.ts:239-260`):
Bearer swarm key (or `aswt_` user token) + `X-Agent-ID`; opt-out via `auth:{apiKey:false}`.

⚠️ **Binary bodies are unprecedented:** `route().parse()` → `parseBody` JSON-parses
(`src/http/utils.ts:83-89`); **no `route()` endpoint reads multipart/`arrayBuffer` today**.
Size is guarded by `enforceContentLengthCap` (413, `utils.ts:110-126`). A `/api/fs/*` upload
endpoint would be the **first binary route** — either extend the factory or handle the body
outside `parse()`.

**UI touchpoints already present:** `ui/src/components/shared/task-attachments-section.tsx`
(renderer mirroring `constants.ts`, builds live URLs, reads `VITE_AGENT_FS_*`),
`ui/src/api/types.ts` (`TaskAttachmentKind`, `StatusAgentFs`), `ui/src/pages/home/page.tsx`
(configured/not-configured indicator + "Set AGENT_FS_API_URL…" hint).

## Code References

| File | Line | Description |
|------|------|-------------|
| `agent-fs/packages/server/src/routes/auth.ts` | 9, 39 | `POST /auth/register` → `{apiKey,userId,orgId}`; `GET /auth/me` → `{userId,email,defaultOrgId,defaultDriveId}` |
| `agent-fs/packages/server/src/routes/orgs.ts` | 68, 92 | `POST /orgs`, `POST /orgs/:orgId/drives` (org-admin) |
| `agent-fs/packages/server/src/routes/files.ts` | 24, 99 | `GET`/`PUT .../files/:path/raw` (binary upload, 50 MB, conditional) |
| `agent-fs/packages/core/src/ops/index.ts` | 43-302 | 29-op registry (write/search/vec-search/sql/comment-*/signed-url) |
| `agent-fs/packages/core/src/ops/signed-url.ts` | 19 | presigned GET op (24h default, GET-only) |
| `agent-fs/packages/core/src/ops/versioning.ts` | 11 | `getS3Key` = `<org>/drives/<drive>/<path>` |
| `agent-fs/packages/core/src/identity/rbac.ts` | 15-46 | `OP_ROLES` viewer/editor/admin map |
| `src/be/migrations/072_task_attachments.sql` | 16-38 | base `task_attachments` schema + `kind` CHECK |
| `src/be/migrations/073_task_attachments_agent_fs_ids.sql` | 14-15 | `agent_fs_org_id`/`agent_fs_drive_id` |
| `src/be/db.ts` | 2684, 2773 | `insertTaskAttachment` (append-only dedup), `getTaskAttachments` |
| `src/types.ts` | 274, 290-347 | `TaskAttachmentKindSchema`, `AttachmentInputSchema`, `TaskAttachmentSchema` |
| `docker-entrypoint.sh` | 404-483 | existing shell provisioning (register/secret-store/org-create) |
| `src/commands/runner.ts` | 356-415, 2691 | `fetchResolvedEnv` worker-env composition → `config.env` |
| `src/prompts/session-templates.ts` | 287-367 | `system.agent.agent_fs` CLI-teaching template |
| `src/tools/store-progress.ts` | 137-185 | attachment reconcile + `resolveAgentFsDefaults` |
| `src/be/seed/registry.ts` | 14 | `SEEDERS` array — provisioning seeder extension point |
| `src/http/index.ts` | 441, 467, 275-320 | boot config-load + seeders; handler registration |
| `src/http/route-def.ts` | 148-206 | `route()` factory + `RouteDef` |
| `src/http/kv.ts` | 91-500 | model route module (route defs + dispatcher) |
| `src/http/core.ts` | 239-260 | central Bearer + `X-Agent-ID` auth gate |
| `src/http/utils.ts` | 83-89, 110-126 | `parseBody` (JSON-only), `enforceContentLengthCap` |
| `charts/agent-swarm/templates/agent-fs-deployment.yaml` | — | Helm agent-fs Deployment (image 0.7.2) |
| `charts/agent-swarm/values.yaml` | 224-252 | `agentFs.*` values keys |
| `ui/src/components/shared/task-attachments-section.tsx` | 13-128 | existing attachment link renderer |

## Open Questions

- **Binary upload mechanism for `/api/fs/*`:** extend the `route()` factory to parse
  binary/multipart, or handle the body outside `parse()` (first-of-its-kind in the route layer).
  And: swarm proxies bytes to agent-fs `PUT .../raw` (50 MB) vs. a swarm-issued presigned PUT
  (agent-fs has **no** signed upload URL, so direct-S3 presign would bypass version/embed).
- **Provisioning: shell → TS?** Provisioning works today in `docker-entrypoint.sh` (per-worker).
  Whether to lift it into a deterministic server-side `Seeder` (swarm-level drive, persisted to
  `swarm_config`) or keep the shell path is a design decision for planning.
- **`task_attachments` generalization:** `provider_id` + provider-native key vs. keep
  `agent_fs_*` columns + a provider discriminator; plus the net-new delete/replace mutation
  (table is append-only today). Keep the `kind` enum synced across SQL + two Zod defs.
- **Drive scoping mechanics:** brainstorm decided one swarm drive + path scoping
  (`/tasks/{taskId}/…`); confirm whether scoping is enforced server-side (path prefix on every
  op) and how it coexists with the existing per-agent personal/shared-org CLI convention.
- **Helm drift:** chart pins agent-fs `0.7.2` and sets no `AGENT_FS_API_KEY`/embedding env —
  bump to 0.9.x + decide whether the chart provisions the key or relies on the entrypoint
  self-register.
- **Capability surfacing:** v1 UI is core-only (upload/list/preview/download); how/whether to
  expose search/comments/versioning later, and how the swarm advertises capabilities.
- **`memory-eval.ts` dangling `agent_fs_write`:** repoint to the CLI or remove.

## Appendix

- **Architecture notes:** API server is the sole DB owner; the `/api/fs/*` surface + provider
  client live API-side (workers reach files over HTTP / via the agent-fs CLI). Routes use the
  `route()` factory (auto-OpenAPI; requires `generate-openapi.ts` import + `docs:openapi`
  regen). Swarm API key via `getApiKey()`; agent-fs creds already flow through the
  encrypted config-secret store (`PUT /api/config isSecret:true`), not raw env. Prompt text
  goes through `src/prompts/` registry. Frontend PRs need a `qa-use` session. agent-fs S3 key
  layout `<org>/drives/<drive>/<path>` is deterministic; binary upload auto mime-routes +
  versions + embeds via `writeRaw`.
- **Historical context (from thoughts/):**
  - `thoughts/taras/brainstorms/2026-06-25-agent-fs-first-class.md` — the brainstorm this
    research grounds. Decisions: swarm-owns-metadata (issue option 4), two-tier pluggable
    provider (Files-SDK core + agent-fs capability add-ons), bind agent-fs as one rich HTTP
    provider, default=local-fs / recommended=co-deployed agent-fs, v1=tasks-only + one drive +
    path scoping, agent-native (CLI) access not an MCP tool, deterministic provisioning.
    **Corrections this research makes to the brainstorm:** provisioning already exists (shell
    entrypoint, not net-new); creds already in the secret store (not raw env); Helm
    co-deployment already complete (pinned 0.7.2); no `agent_fs_write` MCP tool to delete; a UI
    attachment renderer already exists; binary upload would be the first non-JSON `route()`.
- **Related research:** none prior on this topic; issue #813 is the origin.

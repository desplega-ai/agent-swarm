---
date: 2026-06-25T00:00:00Z
author: Taras
topic: "First-class External Filesystem support — agent-fs"
tags: [brainstorm, agent-fs, attachments, filesystem, mcp, ui]
status: complete
exploration_type: idea
last_updated: 2026-06-25
last_updated_by: Taras
---

# First-class External Filesystem support — agent-fs — Brainstorm

## Context

**Source:** [GitHub issue #813](https://github.com/desplega-ai/agent-swarm/issues/813)

**Problem / motivation (from issue):** Have a way so that agent-fs is a first-class
citizen in the swarm. It will enable attachments, etc.

**Proposed solution (from issue):** `/api/fs/...` with MCP tool, SDK and UI components
and hooks.

### What agent-fs is
agent-fs is an agent-first filesystem backed by S3 (MinIO locally / any S3-compatible in
prod), with a SQLite metadata store. "Files for agents, the way agentmail is email for
agents." Surfaces:
- Single HTTP dispatch endpoint `POST /orgs/{orgId}/ops` with 26 ops across Content
  (`write`/`cat`/`edit`/`append`/`tail`), Navigation (`ls`/`stat`/`tree`/`glob`),
  File mgmt (`rm`/`mv`/`cp`), VCS (`log`/`diff`/`revert`), Search (`grep`/`fts`/`search`
  — incl. semantic via OpenAI embeddings), Maintenance (`recent`/`reindex`), and
  Comments (Google-Docs-style annotations).
- Native MCP endpoint (`ALL /mcp`, Streamable HTTP) + stdio proxy (`agent-fs mcp`).
- Auth: Bearer token per user; entities are user → org → drive.
- npm: `@desplega.ai/agent-fs`; env: `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`,
  `AGENT_FS_HOME`. Bun-only runtime.

### Current state in agent-swarm (already partially integrated)
- Migration `072_task_attachments.sql` — a `task_attachments` concept exists.
- Migration `073_task_attachments_agent_fs_ids.sql` — attachments already carry
  agent-fs IDs, so there is an existing (partial) coupling between task attachments and
  agent-fs.
- `src/tools/store-progress.ts` and `src/tasks/worker-follow-up.ts` reference agent-fs /
  attachments.
- Tests: `store-progress-attachments.test.ts`,
  `store-progress-attachments-handler.test.ts`.
- No `src/http/fs.ts` route surface yet; agent-fs is not exposed as its own first-class
  API/MCP/UI domain.

**Framing tension:** This is an *upgrade* from a narrow attachment-ID coupling to a
first-class FS domain — so a key question is scope: how much of agent-fs's surface does
the swarm expose, and through which boundary (proxy vs. re-implement vs. embed)?

## Exploration

### Q: What's the primary driver for making agent-fs first-class right now?
Human-facing attachments (option 1) is the **easy win** and immediate value. But the
deeper motivation is having **storage "closer"** — co-locating/owning it makes everything
cleaner. Today agent-fs is opt-in: "it's up to the agent to use agent-fs when configured,"
so there's no first-class plumbing and integration is ad-hoc per agent.

**Insights:**
- Two-layered goal: ship the UI attachment win quickly, but the architectural prize is a
  managed, first-class storage layer rather than an optional remote service each agent
  dials into.
- "Storage closer" hints at co-location/ownership (swarm-managed agent-fs) over a
  pure remote-proxy model — needs confirmation.
- Implies the swarm should handle the agent-fs wiring (provisioning, auth, scoping) so
  agents get it "for free" when enabled, instead of opting in manually.

### Q: How tightly should the swarm couple to agent-fs? ("storage closer")
**Option 4 — swarm owns metadata, agent-fs = backend.** Plus three amendments:
1. **Better docs on co-deployment** are needed.
2. agent-fs should be **more of a first-class citizen** of the swarm (not just an opt-in
   remote the agent dials).
3. Expose it via an **interface** so people could **plug other providers** (agent-fs is
   the reference implementation; raw S3 / others pluggable behind the same contract).

**Insights:**
- The swarm DB stays the source of truth for file/attachment *metadata*; the provider
  contract handles bytes + (optionally) richer ops.
- "Pluggable provider interface" is the load-bearing abstraction — consistent with Taras's
  general preference for reusable abstractions over one-offs.
- This is a **migration from today's model**, not greenfield: the swarm currently proxies
  an external *live* agent-fs (`DEFAULT_AGENT_FS_LIVE_URL = https://live.agent-fs.dev`,
  `AGENT_FS_LIVE_URL` override), stores `agent_fs_org_id` / `agent_fs_drive_id` (`db.ts`),
  resolves drive defaults (`store-progress.ts: resolveAgentFsDefaults`), has an
  `agent_fs_write` tool, agent-fs path linking (`link-resolver.ts`), and scrubs
  `AGENT_FS_API_KEY`. So "first-class" = formalize + generalize what's already glued in.

### Q (side note from Taras): Boot-time swarm registration should be deterministic
Observation: at boot there is an **automatic agent task to register the swarm** (with
agent-fs / provisioning org+drive+key). This is non-deterministic LLM work for something
mechanical — it **could be a deterministic code path** (call the provider's register/
provision endpoint directly in boot code, persist the returned org/drive/key).

**Insights:**
- Registration/provisioning of the FS backend belongs in deterministic boot/seed code,
  not an agent task — cheaper, reliable, idempotent.
- Generalizes: when the provider interface lands, "provision a drive for this swarm/org"
  is a provider method the boot path calls, not a prompt. (Exact current task to be
  confirmed in research — `boot-triage` seed + `join-swarm` are the candidates.)

### Q: How much of agent-fs's rich surface belongs in the pluggable interface?
**Two-tier (core + capabilities)**, anchored on a **Files SDK** (`files-sdk.dev`)-style
core so connecting S3/etc. is trivial. **Search and comments are add-ons**, not core.

**Grounding — what Files SDK is:** a unified TS storage API over 40+ providers (S3, R2,
GCS, Azure, Supabase, MinIO, Backblaze, Hetzner, DO Spaces, Dropbox/Drive/OneDrive,
UploadThing/Cloudinary, Appwrite/PocketBase/Firebase, + local `fs` for tests). Surface is
**10 methods**: `upload`, `download`, `head`, `exists`, `delete`, `copy`, `move`,
`list`/`listAll`, `url`, `signedUploadUrl`. Normalized `FilesError` (`NotFound`/
`Unauthorized`/`Conflict`/`ReadOnly`/`Provider`), typed escape hatch `files.raw`, and a
built-in CLI + **MCP server**.

**Insights:**
- The two tiers map exactly: **core tier = Files SDK's 10 blob methods** (any S3-ish
  provider implements it for free); **capability tier = agent-fs extras** (FTS + semantic
  search, Google-Docs comments, VCS log/diff/revert) surfaced only when the backend
  advertises them. UI/MCP feature-detect and degrade.
- agent-fs is itself S3-backed, so it can slot in two ways (to resolve later): (a) reach
  its **blobs via an S3/Files-SDK adapter** + call its **ops API only for capabilities**,
  or (b) treat the whole agent-fs ops API as one "rich provider" implementation. Affects
  how much of agent-fs we depend on.
- Files SDK ships its own MCP server, but the **swarm's** fs MCP tool should sit on the
  swarm's provider interface (scoped to swarm orgs/tasks, provider-agnostic) — not expose
  Files SDK's MCP directly. Keeps agents provider-agnostic and swarm-scoped.
- Net stack: **swarm metadata (source of truth) → provider interface { core: Files-SDK
  blob ops; capabilities: search/comments/versions } → backend (agent-fs reference impl,
  or bare S3/R2/...)**.

### Q: What can files be scoped to / owned by?
**Tasks only (v1).** Files belong to a task; extend the existing `task_attachments`.
Humans attach inputs, agents attach outputs. Shared / agent-level / multi-scope FS is
explicitly deferred.

**Insights:**
- Keeps the easy win tight and avoids the access-control surface that org/agent/shared
  scopes would force open. The provider interface is still general; only the *swarm-side
  ownership model* is constrained to tasks for v1.
- Existing `task_attachments` (+ `agent_fs_*_id` columns) becomes the canonical metadata
  table; the migration is "formalize this," not "new table."
- Forward path is clean: a later release can add scopes (agent scratch, org/shared drive)
  without changing the provider contract — only the metadata ownership column(s).

### Q: Which of the four named deliverables are actually in v1?
**In v1:** (1) `/api/fs/*` routes + provider interface, (2) task-scoped agent MCP tool,
(3) UI upload/list/preview/download. **Deferred:** the typed TS SDK client.

**Insights:**
- The SDK can be **generated from OpenAPI** once the routes exist (the swarm already does
  `bun run docs:openapi`), so hand-building it in v1 is wasted effort — good cut.
- All three v1 items sit on the provider interface, so the interface contract is the
  critical-path dependency; routes + MCP tool + UI can then be built against it in
  parallel.
- "First-class for agents" is satisfied by the task-scoped MCP tool (generalizing
  `agent_fs_write` into read+write, provider-agnostic, scoped to the agent's task).

### Q: What should a fresh swarm use for storage by default?
**Default = local `fs` adapter (option 2); recommended = co-deployed agent-fs + MinIO
(option 1), either in compose or as a separate deployment.** Plus the key mechanism:

> **The capability tier auto-enables when the agent-fs envs are present in the API.**

No explicit feature flag — the API **detects the agent-fs env vars** (`AGENT_FS_API_URL` /
`AGENT_FS_API_KEY` / drive defaults) and automatically upgrades the active provider from
the local-fs core tier to the **agent-fs rich provider** (core + search/comments/VCS).

**Insights:**
- This makes the two-tier model self-configuring: **no envs → local fs, core ops only**
  (the attachment win still works out of the box, lightest footprint); **envs present →
  agent-fs, capabilities light up automatically.** Provider selection + capability
  advertisement are both env-driven.
- Aligns the default with self-host simplicity while the *recommended* path (co-deployed
  agent-fs) is what the "better co-deployment docs" should walk operators through.
- **Migration nuance (open):** today the implicit default is hosted `live.agent-fs.dev`.
  Switching the no-config default to local-fs means existing deployments that relied on
  the *implicit hosted* default (without setting envs) would silently move to local-fs;
  those that set `AGENT_FS_API_KEY` keep agent-fs. Need to confirm the exact detection
  trigger (likely `AGENT_FS_API_KEY` present, since the URL already has a default const).

### Q: v1 stance on secret-scrubbing / content safety for file bytes?
**Scrub text at egress only.** Text-file content rendered into UI/logs passes through
`scrubSecrets`; binaries are opaque (served via signed-URL/download, never logged);
paths/filenames/metadata always scrubbed. No upload-time scanning in v1.

**Insights:**
- Matches the repo's egress-scrubbing rule (`runbooks/secret-scrubbing.md`) without a
  binary-scanning pipeline. The scrub point is wherever text bytes hit a log line or a
  rendered UI string, not the storage layer.

### Research findings (two background agents)

**A. Existing integration is pointer-only — there is NO server-side agent-fs client.**
- `task_attachments` (migration `072`): `id, task_id, agent_id, name, kind CHECK IN
  ('agent-fs','url','shared-fs','page'), url, path, page_id, mime_type, size_bytes,
  sha256, intent, description, is_primary, created_at`. For `kind='agent-fs'` the
  reference lives in **`path`**; identity is the **`(org_id, drive_id, path)` triple** —
  there is **no blob-key / agent-fs-native-id column**. Migration `073` adds nullable
  `agent_fs_org_id`, `agent_fs_drive_id`.
- `db.ts`: `insertTaskAttachment` (`:2684`), `rowToTaskAttachment` (`:2634`).
  **Append-only + dedup** by `(task_id, sha256)` then `(kind, path|url|page_id, name)`;
  **no update/delete surface**, cleanup only via task `ON DELETE CASCADE`.
- `store-progress.ts` writes **pointers, not bytes** — the agent already wrote the file
  via the `agent_fs_write` MCP tool; the swarm just records `(org, drive, path)`.
  `resolveAgentFsDefaults` reads swarm-config KV `AGENT_FS_DEFAULT_ORG_ID/DRIVE_ID`.
- `constants.ts` `buildAgentFsLiveUrl` is **display-only** URL construction;
  `link-resolver.ts` is text scanning. **No swarm→agent-fs socket anywhere in `src/`.**
- **Config gate today = `AGENT_FS_API_URL`** (drives `status.ts` `agent_fs.configured` and
  the `base-prompt.ts:253` system-prompt injection, local/Docker only). **`AGENT_FS_API_KEY`
  is only in the scrubber — never read by swarm-core** (consumed agent-side). Creds live in
  **raw worker env**, not the encrypted secrets store.
- **No boot-time agent-fs provisioning task exists today.** The boot-triage task
  (`heartbeat.ts:1150`, T+90s, lead) is LLM routing on top of an *already-deterministic*
  seeded script; agent self-registration is the deterministic `POST /agents`. So the
  "register the swarm" step Taras flagged is **net-new** for agent-fs — and should be
  deterministic from day one (no agent task).

**B. agent-fs API surface (binding shape).**
- Ops API `POST /orgs/{orgId}/ops` = single dispatch, **28 op variants** (docs undercount
  at 26; missing `vec-search` + `signed-url`). **Content is always JSON strings, never
  raw bytes / multipart;** `write` is capped at **10 MB** string content. → **binary /
  large attachments cannot round-trip the ops `write`.**
- **Reads don't need the ops API:** `signed-url` op = no-auth presigned S3 GET (24h), and
  `GET /{orgId}/drives/{driveId}/files/*/raw` is an authed raw byte route.
- **S3 key layout is deterministic & documented:** `${orgId}/drives/${driveId}/${path}`
  (`core/.../versioning.ts:8-12`), MinIO bucket `agentfs`, path-style. → an external
  S3/Files-SDK client that knows org+drive can read/write blobs **directly**.
- **Caveat:** version history, MIME, FTS index, and embeddings live in agent-fs SQLite —
  **direct S3 writes bypass all capability bookkeeping.** Capabilities only attach to blobs
  written **through the `write` op**.
- Auth: `POST /auth/register {email}` → `{apiKey, userId, orgId}` (no driveId — get it via
  `GET /auth/me`). **Key is per-USER but can own many orgs/drives** via `POST /orgs/` +
  `POST /orgs/{orgId}/drives` (REST surface undocumented in api-reference). Deterministic
  provisioning is fully API-driven.
- Capabilities cost: **search degrades to keyword-only with zero config**; semantic
  embeddings default to a **local model (embeddinggemma-300M, ~329MB, no OpenAI key)**;
  comments are pure SQLite; VCS needs S3 bucket versioning enabled. So the capability tier
  is mostly **free to turn on**.
- **Recommended binding = hybrid:** **read/download/url/list/head bind to S3 directly**
  (cheap, binary-safe, no 10 MB cap); **writes that need capabilities route through the
  ops `write`**. Pure-S3 only covers the read path.

### Q: How should the swarm write uploaded attachment bytes? → check live agent-fs
Taras redirected: "there should be a way to upload any type of data and it should auto
embed / route based on mime type." **Correct — confirmed against the live repo.**

### CORRECTION — live agent-fs is v0.9.0 (background agent read a stale v0.1.5 cache)
The live source at **`/Users/taras/Documents/code/agent-fs` (v0.9.0,** HEAD `028667b`,
adds FUSE mount + Monaco `live` editor**)** supersedes Agent B's findings:
- **Binary upload exists:** `PUT /orgs/:orgId/drives/:driveId/files/:path/raw`
  (`packages/server/src/routes/files.ts:99-193`) accepts a **raw binary body of any type**,
  buffered to **~50 MB** (Hono body limit; no streaming in v1), rejects
  `application/json` (steers to ops `write`). It calls **`writeRaw`**, which "drives
  versioning, FTS5 indexing and embedding scheduling through the existing pipeline"
  (files.ts:94-97) with **editor+ RBAC**.
- **Mime-aware auto-routing/embedding:** `ops/mime.ts` `detectMimeType` +
  `decodeIndexableText`; `search-index.ts` `indexBytesForSearch(path, bytes, contentType)`
  decodes only text-like content → **binaries are stored but not embedded; text is
  auto-indexed/embedded**, all from one write. Exactly the "upload anything, auto-route by
  mime" behavior Taras described.
- **Download:** `GET .../raw` streams bytes + `ETag`/`X-Agent-FS-Version`/content-hash
  headers (viewer-accessible); `signed-url` op gives a no-auth presigned GET.
- **Concurrency/dedup:** `If-Match: <v>` / `If-None-Match: *` → optimistic version /
  create-only; response carries `version`, `contentHash`, `deduped`.

**Resolved implications:**
- The swarm does **not** need direct S3 access or its own mime routing — **proxy the bytes
  to agent-fs's `PUT .../raw`** and it owns S3 + mime + versioning + embedding. → **binding
  shape = (b): agent-fs's HTTP API is one "rich provider."** (Agent B's (a) recommendation
  was an artifact of the stale 10 MB / JSON-only cache.)
- **Core vs capability tiers still hold across providers:** agent-fs implements both
  (upload/download/list + search/comments/versions); a bare-S3/Files-SDK provider
  implements only the core blob tier (no auto-embed). Capability auto-enables when agent-fs
  envs are present (per earlier decision).
- **Non-functional:** v1 upload ceiling ≈ **50 MB** (agent-fs Hono limit); larger/streaming
  is post-v1.
- **The whole live HTTP surface must be re-confirmed during research** (don't trust the
  0.1.5 docs cache): exact `/orgs` + `/drives` provisioning routes, `/auth` shape,
  `signed-url` params, and the op list as of v0.9.0.

### Q (Taras): quick bg check on the agent-fs envs that are set & used
**Env surface (live repos):**

_Swarm-side (what the swarm reads today — all `process.env`, no secrets store):_
| Env | Where | Role |
|---|---|---|
| `AGENT_FS_API_URL` | `status.ts:576`, `base-prompt.ts:253` | **The "configured" gate.** Chart sets it to the in-cluster agent-fs svc. |
| `AGENT_FS_API_KEY` | `secret-scrubber.ts:43` (+1 read) | Scrubbed; **not meaningfully read server-side yet** — a real client needs it. |
| `AGENT_FS_LIVE_URL` | `constants.ts:83`, `context-preamble.ts:88` | Display host for link rendering (default `live.agent-fs.dev`). |
| `AGENT_FS_DEFAULT_ORG_ID` / `_DRIVE_ID` | `constants.ts:94/102`, `store-progress.ts` (also swarm-config KV) | Default org/drive for attachment pointers. |
| `AGENT_FS_SHARED_ORG_ID` | `base-prompt.ts:254`, propagated to workers `runner.ts:2637` | Shared org id injected into the agent prompt. |
| `EMBEDDING_*` (`MODEL`/`DIMENSIONS`/`API_KEY`/`API_BASE_URL`) | swarm memory | **Swarm's own memory embeddings — NOT agent-fs.** Don't conflate. |

_agent-fs-side (what the agent-fs server needs — `packages/core/src/config.ts`):_
- **Core:** `AGENT_FS_HOME` (data dir), `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`,
  `AGENT_FS_APP_URL`; server defaults port **7433**, host 127.0.0.1, `AGENT_FS_RATE_LIMIT`
  (1200/min).
- **S3:** `S3_PROVIDER` (default `minio`), `S3_BUCKET` (`agentfs`), `S3_REGION`,
  `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`;
  **`AWS_*` take precedence over `S3_*`** (Tigris); local `MINIO_ROOT_USER/PASSWORD`,
  `MINIO_ENDPOINT/BUCKET`, `MINIO_AVAILABLE`.
- **Embedding:** `EMBEDDING_PROVIDER` (`local`|`openai`|`gemini`, default **local**, zero
  config), `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `OPENAI_API_KEY`/`GEMINI_API_KEY`.
- **Other:** `AGENT_FS_FUSE_BIN`, SQL guards `AGENT_FS_SQL_MAX_FILE_BYTES`/`_TIMEOUT_MS`/
  `_MEMORY_LIMIT`.

**Co-deployment scaffolding already exists in the Helm chart (not docker-compose):**
- `charts/agent-swarm/templates/agent-fs-deployment.yaml` runs agent-fs as a Deployment;
  `agentFs.enabled: true` opt-in (README: "Cross-agent searchable filesystem service").
- `agent-fs-secret.yaml` holds `S3_ACCESS_KEY_ID/SECRET/ENDPOINT/REGION`; `ingress.yaml`
  exposes it; `api-statefulset.yaml:68-70` injects `AGENT_FS_API_URL` into the API pod.

**Insights:**
- **Minimal "point swarm at agent-fs" env = `AGENT_FS_API_URL` + `AGENT_FS_API_KEY`**
  (+ default org/drive). The chart already provides the URL; the gap is a server-side
  client that *reads the key* and the deterministic provisioning of org/drive.
- **Capability auto-enable trigger = both `AGENT_FS_API_URL` and `AGENT_FS_API_KEY`
  present.** (Refines the earlier "envs present" decision.)
- Co-deployment is a **Helm-first** story today; the "better co-deployment docs" should
  cover both the existing chart path and a new **docker-compose** recipe (local/dev), since
  the swarm's compose has no agent-fs service yet.
- Provider creds (`AGENT_FS_API_KEY`, S3 secrets) currently ride **raw env / chart
  secrets**; moving the swarm→agent-fs client API-side means routing the key through the
  swarm's **encrypted secrets store** (CLAUDE.md mandate).

### Q (Taras): how do agents actually use agent-fs? → NOT via the MCP tool
**Correction:** agents generally use agent-fs's **own API / CLI directly** (env-provisioned),
**not** a swarm MCP tool — the existing `agent_fs_write` MCP tool **may be deleted**.

**Insights — this reshapes the agent-side of v1:**
- **Two distinct access paths, by audience:**
  1. **Agent side → agent-fs native (API/CLI), provider-bound.** The swarm's job is to
     **provision + scope + inject** (set `AGENT_FS_API_URL`/`AGENT_FS_API_KEY` + the
     task-scoped drive/path into the agent env) so the agent's CLI/API "just works," then
     **reconcile** what it wrote into task metadata. No swarm MCP FS abstraction.
  2. **Human/server side → swarm `/api/fs/*` + provider interface + UI**, provider-agnostic,
     `task_attachments` as source of truth (uploads, list, preview, download/serve).
- This **matches the existing pattern**: agent writes via agent-fs directly → records the
  `(org, drive, path)` pointer via `store-progress`. Formalize that loop rather than
  introduce a new tool. **Drop "task-scoped agent MCP tool" from v1 deliverables.**
- The **provider interface is for the swarm-server/human path only.** Agents are
  deliberately bound to the concrete backend (agent-fs) via its native client — pluggability
  is a server-side concern, not an agent-facing one.
- **New open question:** the **reconcile/association mechanism** — how files an agent wrote
  via the agent-fs CLI become task attachments. Options: (a) keep `store-progress` pointer
  recording, (b) path convention (`/tasks/{taskId}/…`) + a swarm reconcile/list sweep,
  (c) a thin swarm "register attachment" endpoint the agent (or a hook) calls. Likely (a)+(b).
- **Implication for the abstraction:** if the backend is bare-S3 (no agent-fs CLI in the
  worker), agents lose native FS access — so **agent-side FS is effectively an
  agent-fs-present feature**, gated on the same env trigger as the capability tier.

## Synthesis

### Key Decisions
- **Coupling model = "swarm owns metadata, provider = backend" (issue option 4).** Swarm
  DB (`task_attachments`) is the source of truth for file metadata; the backend supplies
  bytes (+ optional rich ops). Formalizes/generalizes today's ad-hoc agent-fs gluing.
- **Pluggable provider interface, two-tier.** Core tier modeled on **Files SDK**
  (`files-sdk.dev`) — 10 blob methods (`upload`/`download`/`head`/`exists`/`delete`/
  `copy`/`move`/`list`/`url`/`signedUploadUrl`), any S3-ish backend implements it.
  Capability tier (add-ons) = **search (FTS+semantic), comments, versioning**, provided by
  agent-fs.
- **agent-fs is the reference rich provider; bare S3/R2/local are valid core-only
  providers.** Others can plug in behind the same contract.
- **Capability detection is env-driven.** agent-fs envs present in the API → agent-fs
  provider + capabilities auto-enabled; absent → local-fs core tier. No separate flag.
- **Default backend = local `fs` adapter; recommended = co-deployed agent-fs + MinIO**
  (compose or separate deployment), with first-class **co-deployment docs**. The Helm
  chart **already has the co-deployment scaffolding** (`agentFs.enabled`,
  `agent-fs-deployment.yaml`, secret, ingress, injects `AGENT_FS_API_URL`); the gap is a
  **docker-compose recipe** for local + the server-side client that consumes it.
- **Capability auto-enable trigger = `AGENT_FS_API_URL` + `AGENT_FS_API_KEY` both set**
  (refined from "envs present"). `AGENT_FS_API_URL` alone is today's display/prompt gate;
  a real client also needs the key. Provider creds move to the swarm's **encrypted secrets
  store**, not raw env.
- **v1 ownership scope = tasks only.** Extend `task_attachments`; humans attach inputs,
  agents attach outputs. Org/agent/shared scopes deferred.
- **v1 deliverables:** (1) `/api/fs/*` routes + provider interface (human/server path),
  (2) **UI** upload/list/preview/download on the task view, (3) **agent-side provisioning**
  — inject `AGENT_FS_*` env + task-scoped drive/path so the agent uses agent-fs's native
  CLI/API, plus a **reconcile** path so its writes land in `task_attachments`.
  **Dropped:** swarm "agent MCP FS tool" (agents use agent-fs directly; `agent_fs_write`
  MCP tool is a deletion candidate). **Deferred:** typed TS SDK (generate from OpenAPI).
- **Binding to agent-fs = (b) treat its HTTP API as one "rich provider."** Proxy bytes to
  `PUT .../files/{path}/raw` (binary, ~50 MB, auto mime + version + embed); read via
  `GET .../raw` or the `signed-url` op; use ops for capabilities. No swarm-side S3/mime
  handling. Bare-S3/Files-SDK providers implement the **core blob tier only**.
- **Upload path is provider-driven, not hand-routed.** agent-fs auto-routes by mime
  internally, so the swarm doesn't split binary-vs-text writes itself — it hands bytes to
  the provider. (Corrected from the stale-cache "hybrid" plan.)
- **Provisioning is net-new and must be deterministic from day one.** There is **no**
  existing boot-time agent-fs registration task to replace — the swarm has never had a
  server-side agent-fs client. Add a deterministic boot/seed path: `register` (or reuse
  configured key) → `GET /auth/me` for the default drive → `POST /orgs/{org}/drives` as
  needed → persist org/drive/key. Never an LLM agent task.
- **First-class = net-new server-side client.** Today's integration is pointer-only
  (`store-progress` records `(org,drive,path)`; no socket to agent-fs). v1 introduces a
  real server-side provider client behind `/api/fs/*`.

### Open Questions
_Resolved during this session:_
- ~~binding shape~~ → **(b)** rich-provider HTTP. ~~upload routing~~ → provider-driven
  (agent-fs auto-mime). ~~which boot task~~ → none exists; provisioning is net-new
  deterministic. ~~content scrubbing~~ → scrub text at egress only. ~~env trigger~~ →
  `AGENT_FS_API_URL` is today's gate (a real client also needs the key); no-env
  deployments fall back to local-fs.

_Still open:_
- ~~Drive scoping~~ → **DECIDED: one agent-fs org+drive per swarm, task scoping by path
  prefix** (`/tasks/{taskId}/…`). Single boot provision; `task_attachments` keeps
  `(drive, path)`; revisit per-org drives only if multi-tenant isolation becomes a need.
- **Credential storage:** route `AGENT_FS_API_KEY` (+ provisioned drive creds) through the
  **encrypted secrets store** vs raw worker env (today it's raw env, key never read
  server-side). A server-side client changes this — creds now live API-side.
- **Schema reconcile shape:** generalize `task_attachments` to **provider-agnostic**
  (`provider_id` + provider-native `key`/`path` + capability metadata) vs keep the
  `agent_fs_*` columns and add a provider discriminator. Also: the table is currently
  **append-only with no update/delete surface** — v1 UI delete/replace needs a new path.
- **Reconcile/association mechanism (agent writes → attachments):** keep `store-progress`
  pointer recording vs path convention (`/tasks/{taskId}/…`) + a swarm reconcile sweep vs a
  thin "register attachment" endpoint/hook. Likely a combination. Determines how agent-fs
  CLI writes surface in the task UI.
- **Drop/keep `agent_fs_write` MCP tool** — confirm deletion vs deprecation, and what (if
  anything) replaces it for scripts (`memory-eval.ts` is the lone caller).
- **Migration messaging:** existing deployments relying on the implicit hosted
  `live.agent-fs.dev` *display* default — communicate the default → local-fs shift and the
  "set agent-fs envs to keep it" path.
- **Allowed/blocked file types** and signed-URL expiry policy (agent-fs default 24h) for
  the v1 attachment UI.

### Constraints Identified
- **DB-boundary invariant:** the API server is the sole DB owner; provider interface +
  `/api/fs/*` live API-side. Worker/agent reaches files over HTTP via the MCP tool — must
  not import `src/be/db`. (Option 4 fits this cleanly; an in-process embed would not.)
- **Routes via `route()` factory** (auto-OpenAPI) → then `bun run docs:openapi` + commit.
- **API-key boundary:** read swarm key via `getApiKey()`; agent-fs creds via the encrypted
  secrets store, never raw env at call sites; `AGENT_FS_API_KEY` already in the scrubber.
- **Prompt-template registry:** any new agent-facing prompt text (MCP tool guidance) goes
  through `src/prompts/`, not string concatenation.
- **Frontend PR gate:** the attachment UI needs a `qa-use` session with screenshots
  (`ui/` merge gate).
- **Bun-native** I/O / SDK choices; forward-only migration to evolve `task_attachments`.

### Core Requirements (lightweight PRD)
1. **Provider interface** (`FileStorageProvider`) — required core = Files-SDK 10-method
   blob surface; optional capability mixins (`Searchable`, `Commentable`, `Versioned`)
   advertised per provider. Local-fs + agent-fs reference impls.
2. **Provider selection + capability detection** driven by env presence (no agent-fs env →
   local-fs core; agent-fs env → agent-fs core+capabilities).
3. **`/api/fs/*` REST surface** via `route()` for task-scoped file ops (upload, list,
   get/download, signed-URL, delete) backed by the provider; metadata in `task_attachments`.
4. **Agent-side provisioning + reconcile** — inject `AGENT_FS_*` env + the task-scoped
   drive/path so the agent uses agent-fs's **native CLI/API directly**; reconcile its
   writes into `task_attachments` (path convention + `store-progress` pointer). No swarm
   MCP FS tool. (`agent_fs_write` MCP tool → deletion candidate.)
5. **Dashboard UI + hooks** on the task view — upload input file, list + preview + download
   agent artifacts; degrade gracefully without the capability tier.
6. **Deterministic boot provisioning** of the FS backend (no agent task), idempotent.
7. **Co-deployment docs** for the recommended agent-fs + MinIO setup.
8. **Secret scrubbing** at file-content egress; size/type limits; signed-URL expiry.

## Next Steps

**Handoff decided → `/research`** (then `/create-plan`). Research brief:
1. **Re-confirm the live v0.9.0 agent-fs HTTP + CLI surface** against
   `/Users/taras/Documents/code/agent-fs` (⚠️ NOT the plugin marketplace cache, which is
   stale at v0.1.5) — exact upload (`PUT .../raw`) / download (`signed-url`, `/raw`) /
   provisioning (`/auth/register`, `/auth/me`, `POST /orgs`, `POST /orgs/{org}/drives`)
   contracts + auth + the op list.
2. **`task_attachments` evolution** — provider-agnostic schema (`provider_id` + key vs
   keep `agent_fs_*` + discriminator), and a **delete/replace** path (table is
   append-only today).
3. **Provider interface** shape (Files-SDK core + capability mixins) + **env-driven
   selection/detection** (`AGENT_FS_API_URL` + `_API_KEY`).
4. **Agent-side provisioning + reconcile** — env injection, task-scoped drive/path, and how
   agent-fs CLI writes become attachments (`store-progress` + path convention).
5. **Deterministic boot provisioning** code path (no LLM task; net-new).
6. **Co-deployment** — extend the existing Helm `agentFs.enabled` scaffolding + add a
   docker-compose recipe; write the co-deployment docs.

**Inputs:** this brainstorm + GitHub issue #813. **Live agent-fs source:**
`/Users/taras/Documents/code/agent-fs` (v0.9.0).

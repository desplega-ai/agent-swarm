---
date: 2026-05-16
planner: Claude (on behalf of Taras)
git_commit: 79eb5690e2a8a4f9e39f417903cb19265af31d26
branch: main
repository: agent-swarm
topic: "Reusable scripts runtime (code-mode for agent-swarm) — v1 foundation"
tags: [plan, scripts, code-mode, runtime, sandbox, embeddings, workflow-node]
status: draft
last_updated: 2026-05-16
---

# Reusable Scripts Runtime — Implementation Plan

## Overview

Ship a **typed, agent-authored, agent-invoked TypeScript scripts catalog** for agent-swarm, modeled after `desplega-ai/code-mode` but specialized to the swarm's primitives (`swarm.*` SDK, agent identity, two-tier scope). Agents call `script_search` to find scripts, `script_run` to execute them, and identical primitives plug into workflows as deterministic non-LLM nodes.

- **Motivation**: Agents repeatedly burn tokens re-deriving the same multi-step transforms (parse Linear JSON, group GitHub PR comments, fan out memory queries). A scripts catalog lets them cache those flows as fast, deterministic, typed functions — cutting cost and latency on hot paths. Same primitives unlock deterministic workflow DAG steps.
- **Related**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-05-15-agent-reusable-scripts.md`
  - Open-question research: `thoughts/taras/research/2026-05-15-agent-reusable-scripts.md` (Addendum II: just-bash rejected, falling back to `Bun.spawn + ulimit`)
  - just-bash integration spike: `thoughts/taras/research/2026-05-15-just-bash-integration-shape.md` (basis for rejection; revisit in v2)
  - Reference: `https://github.com/desplega-ai/code-mode` (separate package; we share *patterns* not storage)
  - In-repo precedents: `src/artifact-sdk/server.ts` (Pages SDK auth proxy), `src/be/migrations/014_prompt_templates.sql` (versioning shape), `src/be/embedding.ts` + `src/be/memory/providers/openai-embedding.ts` (embedding reuse)

## Current State Analysis

**What exists today** (verified via sub-agent file:line refs):

- **No `scripts` table.** Storage is greenfield. Highest current migration is `062_pages_view_count.sql`; new migrations claim `063_scripts.sql` and `064_script_embeddings.sql`.
- **A `script` workflow node already exists** at `src/workflows/executors/script.ts:1-128` (node-type string `"script"` at `script.ts:29`), registered at `src/workflows/executors/registry.ts:9,70`. It is an **inline `bash|ts|python` source runner** — totally different concept from the reusable-scripts catalog. The new node type must use a distinct name: **`swarm-script`**.
- **Versioning template — `prompt_templates`:**
  - Live + history tables at `src/be/migrations/014_prompt_templates.sql:5-29`.
  - Zod schemas at `src/types.ts:1249-1274` (`PromptTemplateSchema`, `PromptTemplateHistorySchema`).
  - DB helpers: `upsertPromptTemplate` (`src/be/db.ts:6606`), `getPromptTemplateHistory` (`src/be/db.ts:6794`), `resetPromptTemplateToDefault` (line 6752), `checkoutPromptTemplate` (line 6895). Reuse pattern verbatim.
- **Content hashing:** `computeContentHash` at `src/be/db.ts:365-369` using `new Bun.CryptoHasher("sha256")`. Reuse directly.
- **Auth + identity model:**
  - Global bearer check at `src/http/core.ts:241-252` (single `apiKey` against `Authorization: Bearer …`).
  - `X-Agent-ID` extraction pattern at `src/http/core.ts:270-276,315,365,407`.
  - Agent row → `isLead` boolean: `getAgentById` at `src/be/db.ts:678` via `rowToAgent` at line 578-582 (`isLead: row.isLead === 1`). `isLead` is the **only** elevated-role flag in the repo — gate `scope: 'global'` writes on it.
- **Pages SDK auth-injection pattern** (the template to mirror for `ctx.swarm.*`):
  - `src/artifact-sdk/server.ts:42-69` injects `Authorization: Bearer ${apiKey}` + `X-Agent-ID: ${agentId}` on every internal fetch.
  - SDK shape source of truth: `src/artifact-sdk/browser-sdk.ts:22-125`. **8 domains** with methods:
    1. `tasks` — create, list, get, storeProgress
    2. `agents` — list, get
    3. `events` — create, list, batch, counts
    4. `memory` — search, list, get, rate
    5. `repos` — list, get, create, update, delete
    6. `schedules` — list, get, create, update, delete, run
    7. `approvalRequests` — list, get, create, respond
    8. `kv` — get, set, del, incr, list
- **HTTP route factory** at `src/http/route-def.ts:84-90` — `route({ method, path, pattern, summary, tags, body, params, query, ...handler })`. Concrete usage example: `src/http/tasks.ts:63-76` (POST with body Zod validation). All new HTTP handler files MUST be added as side-effect imports to `scripts/generate-openapi.ts` (currently 28 such imports).
- **MCP tool registration:**
  - All tools registered in `createServer()` at `src/server.ts:165-249` (single `McpServer` instance at line 151).
  - Tool-definition pattern: `createToolRegistrar(server)("name", { title, inputSchema, outputSchema }, handler)`. Reference: `src/tools/memory-search.ts:1-80`.
  - Agent ID access inside a tool: `getRequestInfo(req).agentId` from `src/tools/utils.ts:24-46` (reads `x-agent-id` header).
  - `MCP.md` is **auto-generated** by `bun run docs:mcp` — don't hand-edit.
- **Embedding pipeline (reuse, do not duplicate):**
  - Serialization helpers at `src/be/embedding.ts:5,30,37` (`cosineSimilarity`, `serializeEmbedding`, `deserializeEmbedding`).
  - Provider: `OpenAIEmbeddingProvider` at `src/be/memory/providers/openai-embedding.ts:11` (`embed(text)` at line 44-66, `embedBatch(texts)` at line 68-105).
  - Interface: `src/be/memory/types.ts:7-12` (`EmbeddingProvider { name, dimensions, embed, embedBatch }`).
  - Storage precedent: `agent_memory.embedding BLOB` in `001_initial.sql`. Copy the side-table approach (`script_embeddings(scriptId PK, embedding BLOB, embeddingModel, embeddedText, embeddedAt)`).
- **Workflow executor registry** at `src/workflows/executors/registry.ts:21-80`:
  - `ExecutorRegistry` class with `register/get/has/types/describe`.
  - `createExecutorRegistry(deps)` at lines 62-80 explicitly registers all 10 current executors (`property-match`, `code-match`, `notify`, `raw-llm`, `script`, `vcs`, `validate`, `agent-task`, `human-in-the-loop`, `wait`). Append `swarm-script` here.
  - **Async/worker dispatch pattern** (used by `agent-task`): `src/workflows/executors/agent-task.ts:100-108` returns `{ status: "success", async: true, waitFor: "task.completed", correlationId: task.id }`. Engine pauses and resumes on event correlation. For `swarm-script` with `fsMode: 'workspace-rw'`, mirror this pattern (dispatch a task to the worker, wait on completion event).
- **Trigger-schema validator subset** (from `runbooks/workflows.md:37-54`): only `type`, `required`, `properties`, `enum`, `const`, `items` are honored. `oneOf/anyOf/$ref/pattern/format/additionalProperties` are silently ignored. Honor this when defining `swarm-script` node input schemas.
- **Secret scrubber constraint** at `src/utils/secret-scrubber.ts:197`: signature is `scrubSecrets(text: string | null | undefined): string`. **Only strings.** To scrub a JSON object, `JSON.parse(scrubSecrets(JSON.stringify(obj)))` — or extend the scrubber with an object overload as a one-time helper. Covers: env values ≥12 chars (exact + comma-pool members), GitHub PATs, OpenAI/Anthropic `sk-*`, Slack `xox*`, JWTs, AWS access keys, Google API keys (per `runbooks/secret-scrubbing.md`).
- **DB-boundary check** at `scripts/check-db-boundary.sh:18-26` worker-safe list: `src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`, `plugin/opencode-plugins/`. **`src/scripts-runtime/` must be ADDED to this list** in Phase 2, since the runtime runs worker-side (pulled in via MCP tool path) and must not import `src/be/db` or `bun:sqlite`.
- **session_logs** (egress sink for script output) at `001_initial.sql`: columns `id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt`. Any script stdout that lands here MUST go through `scrubSecrets`.

**What's missing:** every file under `src/scripts-runtime/`, `src/be/scripts/`, `src/http/scripts.ts`, `src/tools/script-*.ts`, `src/workflows/executors/swarm-script.ts`, two migrations, and the entries in `scripts/generate-openapi.ts` / `scripts/check-db-boundary.sh` / `src/server.ts` / `src/workflows/executors/registry.ts`.

**Constraints (from CLAUDE.md + runbooks):**
- API server is the sole DB owner. Runtime + workers consume `/api/scripts/*` over HTTP.
- All new HTTP handlers use `route()` factory; OpenAPI regenerated + committed in same PR.
- `MCP.md` regenerated via `bun run docs:mcp`.
- Migrations are forward-only; never modify an applied migration.
- Bun-only runtime (no Node/npm); `bun:sqlite`, `Bun.spawn`, `Bun.file`, `Bun.CryptoHasher`, `Bun.Glob`.

## Desired End State

A swarm operator (or agent) can:

1. **Author a script** by calling `script_upsert` from the MCP tool surface with TypeScript source, name, description, intent. The script is content-hashed, signature-extracted, embedded, and stored under the caller's `agent` scope (or `global` if the caller has `isLead = 1`).
2. **Discover a script** via `script_search("parse Linear issue JSON")` — semantic search over `description + intent + signature`, returning name + signature + description + score for the top N candidates.
3. **Run a named script** via `script_run({ name, args, intent })` — runtime fetches source, evaluates in a sandboxed `Bun.spawn` subprocess with `ulimit` memory/CPU caps and a 30s wall-clock cap, injects `ctx.swarm.*` + `ctx.stdlib.*` with auth pre-baked, returns the typed result.
4. **Run an inline script** via `script_run({ source, args, intent })` — same flow as named, but **auto-saves on success** to a scratch slug derived from `intent` (content-hash dedup, agent-scoped). Failures do NOT auto-save.
5. **Promote** a scratch script to a named scope='agent' script via `script_upsert`; promote scope='agent' → 'global' is gated on `isLead`.
6. **Reference a script from a workflow** as a `swarm-script` node type — engine resolves by `(name, scope)` + optional `pinHash`, runs server-side (for non-workspace scripts) or dispatches to the assigned worker (for workspace scripts), output flows to downstream nodes via the standard `inputs` mapping.

Verification: a single E2E walks `upsert → search → run` from a worker; a second E2E runs a `swarm-script` node end-to-end in a workflow.

## What We're NOT Doing

- **No just-bash / QuickJS sandbox in v1.** The integration shape research found `js-exec` broken on Bun via an idle upstream PR. Revisit as a v2 hardening path.
- **No real read-only FS sandbox in v1.** `fs: 'workspace-rw'` (cwd = worker's `/workspace`) and `fs: 'none'` (cwd = per-run tmpdir) are convention, not enforcement. No `workspace-ro` until we have a real sandbox.
- **No network egress allow-list in v1.** Scripts inherit the host's outbound posture (unrestricted). v2 hardening can wrap `ctx.stdlib.fetch` with a per-script policy.
- **No permission manifest** (`requires: ['memory.write']`). Scripts inherit the caller agent's full `swarm.*` permissions. v3+ if abuse signals appear.
- **No CLI subcommand** (`bun run src/cli.tsx scripts run …`). Defer per research §7. HTTP `curl` is sufficient for ad-hoc debugging.
- **No code-mode importer.** Coexist; document the distinction. Different storage models (FS vs API SQLite), different SDKs.
- **No `fuzzy-match`, `filter`, `flatten` stdlib helpers.** v1 ships only `fetch`, `grep`, `glob`, `table`.
- **No new `agent_definitions` table.** Use the existing `(scope, scopeId)` pattern from `prompt_templates` with `scopeId = agentId` for per-agent scope.

## Implementation Approach

- **Sequence: storage → runtime → HTTP API → MCP tools → embeddings → workflow node.** Each phase ships a verifiable deliverable. Phases 1-4 yield "agents can author and run scripts." Phase 5 yields semantic discovery. Phase 6 yields workflow integration.
- **Reuse, don't invent.** `prompt_templates` + `prompt_template_history` is the versioning template. `src/artifact-sdk/server.ts` is the auth-injection template. `src/be/embedding.ts` + `OpenAIEmbeddingProvider` is the embedding template. `src/workflows/executors/*` is the node-registration template.
- **DB ownership invariant.** All storage + embedding writes go through `src/be/db.ts` + new `src/be/scripts/*` helpers (API-only). Workers + runtime invoke via HTTP through new `/api/scripts/*` routes. `scripts/check-db-boundary.sh` enforces.
- **Auth injection via subprocess env, not script source.** The loader subprocess receives `API_KEY` + `X-Agent-ID` via env vars; the runtime constructs `ctx.swarm.*` to inject those into every internal fetch. Script source bodies never see credentials.
- **Distinct name from existing `script` workflow executor.** `src/workflows/executors/script.ts` already exists as an inline `bash | ts | python` runner. The new node type is **`swarm-script`** (resolves by name from the catalog).

## Quick Verification Reference

- `bun run lint` — Biome read-only (matches CI's `lint` job)
- `bun run tsc:check` — TypeScript check
- `bun test src/tests/scripts-*.test.ts` — unit tests scoped to this feature
- `bash scripts/check-db-boundary.sh` — DB-ownership invariant
- `bun run docs:openapi` — regenerate `openapi.json` (REQUIRED after any HTTP route change)
- `rm agent-swarm-db.sqlite && bun run start:http` — fresh-DB migration sanity check
- `curl -s -X POST http://localhost:3013/api/scripts/upsert -H "Authorization: Bearer ${API_KEY}" -H "X-Agent-ID: agent-test" -H "Content-Type: application/json" -d @/tmp/sample-script.json | jq` — E2E smoke

---

*(Phases below. Each phase is sized to be implementable in a single session and ships a concrete deliverable.)*

## Phase 1: Storage layer — `scripts` + `script_versions` tables

### Overview

Add forward-only migration creating `scripts` (live, mutable-by-name within a scope) and `script_versions` (immutable audit history). Mirrors the `prompt_templates` + `prompt_template_history` shape (`src/be/migrations/014_prompt_templates.sql:5-29`). Add `src/be/scripts/db.ts` query helpers. Verify against fresh + existing DB. **No runtime behavior yet.**

### Changes Required:

#### 1. SQL migration
**File**: `src/be/migrations/063_scripts.sql`
**Changes**: Create two tables:

```sql
CREATE TABLE scripts (
  id TEXT PRIMARY KEY,                       -- nanoid
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('global', 'agent')),
  scopeId TEXT,                              -- agentId when scope='agent', NULL when 'global'
  source TEXT NOT NULL,                      -- TS source
  description TEXT NOT NULL,
  intent TEXT NOT NULL,                      -- short author-supplied "why this exists"
  signatureJson TEXT NOT NULL,               -- JSON-Schema-ish: { args, result }
  contentHash TEXT NOT NULL,                 -- sha256 of source
  version INTEGER NOT NULL DEFAULT 1,
  isScratch INTEGER NOT NULL DEFAULT 0,      -- 1 = auto-saved scratch; 0 = explicit upsert
  fsMode TEXT NOT NULL DEFAULT 'none' CHECK(fsMode IN ('none', 'workspace-rw')),
  createdByAgentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, scope, scopeId)
);

CREATE INDEX idx_scripts_scope ON scripts(scope, scopeId);
CREATE INDEX idx_scripts_scratch ON scripts(isScratch, createdAt);

CREATE TABLE script_versions (
  id TEXT PRIMARY KEY,
  scriptId TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  intent TEXT NOT NULL,
  signatureJson TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  changedByAgentId TEXT,
  changedAt TEXT NOT NULL DEFAULT (datetime('now')),
  changeReason TEXT,
  UNIQUE(scriptId, version)
);

CREATE INDEX idx_script_versions_hash ON script_versions(contentHash);
```

#### 2. Type definitions
**File**: `src/types.ts`
**Changes**: Add `ScriptScopeSchema`, `ScriptRecordSchema`, `ScriptVersionRecordSchema`, `ScriptFsModeSchema` Zod schemas next to the existing `PromptTemplateSchema` block (`src/types.ts:1249-1274`). Mirror that block's shape. Keep `CHECK` constraints in `scope` / `fsMode` in sync with these schemas (see CLAUDE.md migration rule).

#### 3. DB helpers (API-only)
**File**: `src/be/scripts/db.ts` (new)
**Changes**: Pure functions mirroring the `upsertPromptTemplate` / `getPromptTemplateHistory` pattern (`src/be/db.ts:6606`, `:6794`):

- `insertScript(args) -> ScriptRecord` (also writes initial `script_versions` row)
- `upsertScriptByName({ name, scope, scopeId, source, … }) -> { script, isNew, contentDeduped }` — content-hash dedup: if existing row has matching `contentHash`, return as-is (no version bump); otherwise bump `version`, snapshot prior into `script_versions`, update live row.
- `getScript({ name, scope, scopeId }) -> ScriptRecord | null`
- `getScriptVersion({ scriptId, version | contentHash }) -> ScriptVersionRecord | null`
- `listScripts({ scope, scopeId, includeScratch }) -> ScriptRecord[]`
- `deleteScript({ name, scope, scopeId }) -> boolean` (cascades `script_versions` via FK)
- Reuse `computeContentHash` from `src/be/db.ts:365-369` (`Bun.CryptoHasher('sha256')`) — do NOT duplicate.

#### 4. Migration runner verification
**File**: `src/be/migrations.ts` (existing runner)
**Changes**: None expected — runner auto-applies file-based migrations. Verify the new file is picked up.

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint`
- [ ] Type check passes: `bun run tsc:check`
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh` (`src/be/scripts/db.ts` is API-only — fine; runtime not added to allowlist yet — that comes in Phase 2)
- [ ] Fresh DB sanity: `rm agent-swarm-db.sqlite && bun run start:http` boots without error and creates both tables (verify with `sqlite3 agent-swarm-db.sqlite '.schema scripts script_versions'`)
- [ ] Existing DB sanity: bring up an existing DB (e.g. via `cp agent-swarm-db.sqlite agent-swarm-db.sqlite.bak` then re-apply) — `start:http` boots without error
- [ ] Unit tests pass: `bun test src/tests/scripts-db.test.ts` (cover: insert, content-hash dedup, version bump on body change, history rows written, scope uniqueness, cascade delete)

#### Automated QA:
- [ ] CLI walkthrough: `bun test src/tests/scripts-db.test.ts -t "full lifecycle"` exercises upsert → upsert-same-content (no version bump) → upsert-different-content (version bumps, history row written) → delete (cascade)

#### Manual Verification:
- [ ] Schema review: open `src/be/migrations/0NN_scripts.sql`, confirm `(name, scope, scopeId)` unique constraint correctly handles `scopeId IS NULL` for global (SQLite treats NULLs as distinct — confirm the migration uses `COALESCE(scopeId, '')` in the constraint OR verifies global scripts UNIQUE elsewhere)

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, commit `feat(scripts): storage layer + script_versions audit history`.

---

## Phase 2: Runtime — `src/scripts-runtime/` with sandboxed loader

### Overview

Build the in-repo runtime package: a loader that takes `{ source, args, fsMode, agentId, signal }`, evaluates the script in a `Bun.spawn` subprocess wrapped in `sh -c 'ulimit -v 524288 -t 60; exec …'` on POSIX, with a 30s `AbortController` wall-clock cap and a 1 MB stdout cap. Injects `ctx = { swarm, stdlib, logger }` via env-passed config. **No DB / HTTP coupling yet — pure execution.**

### Changes Required:

#### 1. Runtime package layout
**Files** (all new):
- `src/scripts-runtime/loader.ts` — main entry: `runScript({ source, args, fsMode, agentId, signal, timeoutMs, mcpBaseUrl, apiKey }) -> { result, stdout, stderr, truncated, durationMs }`
- `src/scripts-runtime/sandbox.ts` — `Bun.spawn` wrapper, `ulimit` shell composition (POSIX-only; bypass on Windows), AbortSignal threading, output capping, exit-code reporting. Mirror the abort+timeout dance from `src/workflows/executors/script.ts:102-127` (`Bun.spawn` + `Promise.race(runScript, timeoutPromise)` + `.unref()`).
- `src/scripts-runtime/ctx.ts` — constructs the `ctx` shape passed to script bodies via the loader bootstrap
- `src/scripts-runtime/swarm-sdk.ts` — server-side mirror of `BROWSER_SDK_JS` (`src/artifact-sdk/browser-sdk.ts:22-125`); same 8 domains, same methods 1:1:
  - `tasks: { create, list, get, storeProgress }`
  - `agents: { list, get }`
  - `events: { create, list, batch, counts }`
  - `memory: { search, list, get, rate }`
  - `repos: { list, get, create, update, delete }`
  - `schedules: { list, get, create, update, delete, run }`
  - `approvalRequests: { list, get, create, respond }`
  - `kv: { get, set, del, incr, list }`
  Each method delegates to `internalFetch(mcpBaseUrl, path, args, { apiKey, agentId })`, replicating the auth-injection pattern at `src/artifact-sdk/server.ts:42-69`.
- `src/scripts-runtime/stdlib/index.ts` — barrel: `{ fetch, grep, glob, table }`
- `src/scripts-runtime/stdlib/fetch.ts` — retries (3), 30s timeout via AbortController, typed JSON parsing on Content-Type
- `src/scripts-runtime/stdlib/grep.ts` — shells out to `rg` (skip with informative error if not on PATH)
- `src/scripts-runtime/stdlib/glob.ts` — wraps `Bun.Glob` (https://bun.com/docs/api/glob)
- `src/scripts-runtime/stdlib/table.ts` — formats `Array<Record<string, unknown>>` to a fixed-width string
- `src/scripts-runtime/eval-harness.ts` — the file actually `import`-ed by `bun -e`. Reads `SWARM_SCRIPT_ARGS_FILE` and `SWARM_SCRIPT_SOURCE_FILE` from env, evaluates the source (via `new AsyncFunction` or dynamic-`import("data:text/typescript,...")` — exact mechanism documented in the file), passes `args` + `ctx`, writes result to `SWARM_SCRIPT_RESULT_FILE`

#### 2. Subprocess invocation
**File**: `src/scripts-runtime/sandbox.ts`
**Changes**: Single function `runSubprocess({ harnessPath, sourceFile, argsFile, resultFile, fsMode, agentId, signal, timeoutMs, mcpBaseUrl, apiKey })`:

- POSIX: `Bun.spawn(['sh', '-c', `ulimit -v 524288 -t 60; exec bun ${harnessPath}`], { env: { …passthroughEnv, API_KEY: apiKey, X_AGENT_ID: agentId, SWARM_SCRIPT_ARGS_FILE, SWARM_SCRIPT_SOURCE_FILE, SWARM_SCRIPT_RESULT_FILE, MCP_BASE_URL: mcpBaseUrl }, cwd: fsMode === 'workspace-rw' ? '/workspace' : ${perRunTmpDir}, stdout: 'pipe', stderr: 'pipe', signal })`
- Windows: same `Bun.spawn` but without `sh -c 'ulimit …; exec …'` wrapper (skip caps with warning)
- Wall-clock: `setTimeout(() => abortController.abort(), timeoutMs).unref()` — matches `src/workflows/executors/script.ts:117-127`
- Output cap: read `stdout` + `stderr` into bounded buffers, set `truncated: true` if cap exceeded

#### 3. ctx & swarm-sdk
**File**: `src/scripts-runtime/swarm-sdk.ts`
**Changes**: For each of the 8 BROWSER_SDK_JS domains (file 1 above), define a host-side equivalent that fetches `${MCP_BASE_URL}/api/${domain}/${method}` with headers `Authorization: Bearer ${API_KEY}` + `X-Agent-ID: ${agentId}`. Use `internalFetch` helper. Apply `scrubSecrets` (from `src/utils/secret-scrubber.ts:197`) on the response body — note: scrubber only takes `string`, so `JSON.parse(scrubSecrets(JSON.stringify(body)))`.

Mirror domain methods 1:1 with `src/artifact-sdk/browser-sdk.ts:22-125` (do not invent new methods; the brainstorm specifies "mirror"). Each method returns parsed JSON.

#### 4. Eval harness
**File**: `src/scripts-runtime/eval-harness.ts`
**Changes**: Reads the source from disk (avoids shell-quoting and 128KB argv caps), wraps `export default async (args, ctx) => …` into a callable via:

```ts
const source = await Bun.file(env.SWARM_SCRIPT_SOURCE_FILE).text();
const fnSource = source.replace(/^export\s+default\s+/m, 'globalThis.__userFn = ');
await import(`data:text/typescript;base64,${btoa(fnSource)}`);
const userFn = globalThis.__userFn as (args: unknown, ctx: unknown) => Promise<unknown>;
const args = JSON.parse(await Bun.file(env.SWARM_SCRIPT_ARGS_FILE).text());
const ctx = buildCtx({ apiKey: env.API_KEY, agentId: env.X_AGENT_ID, mcpBaseUrl: env.MCP_BASE_URL });
const result = await userFn(args, ctx);
await Bun.write(env.SWARM_SCRIPT_RESULT_FILE, JSON.stringify(result ?? null));
```

(Exact mechanism may need iteration — alternative: write the wrapper source to a tmpfile and `bun run <tmpfile>`. Choose at implementation time based on which gives the cleanest stack traces. Document the choice in `eval-harness.ts` header.)

#### 5. Signature extraction
**File**: `src/scripts-runtime/extract-signature.ts`
**Changes**: Stub for v1 — parse the TS source for the `export default` arrow-function signature; emit a JSON-ish `{ argsType: string, resultType: string, description: string }`. Not a real TS compiler pass — regex-based extraction is sufficient for v1; document the trade-off. Better extraction is a v2 nice-to-have.

#### 6. DB-boundary allowlist
**File**: `scripts/check-db-boundary.sh:18-26`
**Changes**: Add `src/scripts-runtime/` to the worker-safe paths list. The runtime is pulled in via the worker's MCP tool path → must NOT import `src/be/db` or `bun:sqlite`. The boundary check enforces this.

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint`
- [ ] Type check passes: `bun run tsc:check`
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh` (after adding `src/scripts-runtime/` to the worker-safe list, verifies no `src/be/db` or `bun:sqlite` imports leak in)
- [ ] Unit tests pass: `bun test src/tests/scripts-runtime.test.ts` covering:
  - [ ] Trivial transform script returns expected result (`(args) => args.x + 1`)
  - [ ] Script with `ctx.stdlib.fetch` to a mocked endpoint returns parsed JSON
  - [ ] Script timing out is killed within timeoutMs + 500ms slack, returns `{ truncated, error: 'timeout' }`
  - [ ] Script exceeding 1 MB stdout has `truncated: true` set
  - [ ] AbortSignal aborts a running script within 500ms of `.abort()`
  - [ ] Script source never appears in `process.env` (assert env keys are only the explicit list)

#### Automated QA:
- [ ] `bun test src/tests/scripts-runtime-bearer.test.ts` runs a script that deliberately returns `process.env.API_KEY` in its result, and asserts the value is **scrubbed to `<REDACTED>`** by `scrubSecrets` at the loader's outbound result-handling boundary. The threat model in v1 is honest: the subprocess WILL have `API_KEY` in its env because `ctx.swarm.*` needs it to make internal calls — a script CAN read it via `process.env.API_KEY`. The mitigation is the egress scrubber, not isolation. Document this explicitly in `src/scripts-runtime/loader.ts` header: "ctx.swarm hides the bearer for non-malicious scripts; a malicious script can read `process.env.API_KEY` directly. v2 hardening passes the bearer over a non-env channel (e.g., named pipe / Unix socket)."

#### Manual Verification:
- [ ] Inspect a sample stack trace from a thrown script — confirm line numbers in error messages map back to the user's source (not the harness wrapper). If not, document and file a v2 cleanup task.

**Implementation Note**: After this phase, pause for manual confirmation. Phase 2 is the highest-risk phase — make sure the timeout + abort paths work reliably before layering HTTP on top. If commit-per-phase was requested, commit `feat(scripts): runtime sandbox + ctx + stdlib`.

---

## Phase 3: HTTP API — `/api/scripts/*` routes

### Overview

Wire the five HTTP endpoints that the MCP tool surface (Phase 4) and the workflow node (Phase 6) will call. Every route uses the `route()` factory; OpenAPI spec is regenerated and committed.

### Changes Required:

#### 1. Route handlers
**Files** (new):
- `src/http/scripts.ts` — barrel that registers all routes via `route()` from `src/http/route-def.ts:84-90`. Follow the pattern in `src/http/tasks.ts:63-76` (Zod body validation + side-effect-imported handler).

Routes:
- `POST /api/scripts/upsert` — body `{ name, source, description, intent, scope?, fsMode? }`; `scope='global'` requires `agents.isLead = 1` for the caller (resolve via `getAgentById` from `src/be/db.ts:678`); returns `{ name, version, contentDeduped }`. operationId: `scripts_upsert`.
- `POST /api/scripts/run` — body `{ name?, source?, args, intent }`; if `source` provided, runs inline + auto-saves on success (scratch); if `name` provided, fetches source from `scripts` table (scoped to caller's `agentId` + global); returns `{ result, autoSaved?: { slug, reason }, truncated?: boolean, durationMs }`. operationId: `scripts_run`.
- `POST /api/scripts/search` — body `{ query, scope?, limit? }`; Phase 5 wires embeddings; for now, returns name-substring matches only. Returns `Array<{ name, signature, description, score }>`. operationId: `scripts_search`.
- `DELETE /api/scripts/:name` — query `?scope=agent|global`; scope='global' delete also gated on `isLead`; returns `{ deleted: boolean }`. operationId: `scripts_delete`.
- `GET /api/scripts/:name/types` — query `?scope=agent|global`; returns `{ signature, sdkTypes: '...', stdlibTypes: '...' }`. `sdkTypes`/`stdlibTypes` are bundled string blobs of the `.d.ts` exports for `swarm.*` and stdlib — bundle at build time via a tiny script under `scripts/bundle-script-types.ts`. v1: emit a hand-written minimal string; v2: real `.d.ts` extraction. operationId: `scripts_types`.

#### 2. OpenAPI registration
**File**: `scripts/generate-openapi.ts`
**Changes**: Add `import '../src/http/scripts';` to the side-effect imports list (joining the existing 28 handler imports). This triggers the `route()` calls so they appear in OpenAPI.

**File**: `openapi.json`
**Changes**: Regenerated via `bun run docs:openapi`. Commit the result.

#### 3. Per-agent identity resolution
**File**: `src/http/scripts.ts` (handlers)
**Changes**: Each handler reads `X-Agent-ID` from the request (existing pattern at `src/http/core.ts:270-276,315,365,407`), looks up the matching row via `getAgentById(agentId)` (`src/be/db.ts:678`), uses `isLead` for permission checks (`rowToAgent` at `src/be/db.ts:578-582` sets `isLead: row.isLead === 1`). If `X-Agent-ID` is missing, reject with 400 ("X-Agent-ID required for scripts API"). Global bearer enforcement already happens at `src/http/core.ts:241-252`.

#### 4. Secret scrubbing on responses
**File**: `src/http/scripts.ts`
**Changes**: Apply `scrubSecrets` from `src/utils/secret-scrubber.ts:197` to the JSON body returned by `/api/scripts/run` (since script result might contain echoed env values). Scrubber takes `string`, so wrap: `JSON.parse(scrubSecrets(JSON.stringify(body)))`. Other routes don't need scrubbing — they only return script metadata.

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint`
- [ ] Type check passes: `bun run tsc:check`
- [ ] OpenAPI freshness: `bun run docs:openapi` produces no diff after running it again (idempotent)
- [ ] OpenAPI committed: `openapi.json` shows the 5 new operationIds (`scripts_upsert`, `scripts_run`, `scripts_search`, `scripts_delete`, `scripts_types`)
- [ ] HTTP smoke tests pass: `bun test src/tests/scripts-http.test.ts`:
  - [ ] `upsert` round-trips body, sets `version: 1` on first write, `version: 2` on body change
  - [ ] `upsert` with `scope: 'global'` from a non-lead returns 403
  - [ ] `upsert` with `scope: 'global'` from a lead returns 200
  - [ ] `run` with `name` reads from DB, executes, returns result
  - [ ] `run` with `source` (inline) auto-saves a scratch row on success
  - [ ] `run` with `source` that throws does NOT auto-save
  - [ ] `delete` returns `{ deleted: true }` and removes the row + cascades versions
  - [ ] `search` returns substring matches by name (embeddings come in Phase 5)
  - [ ] `types` returns the expected stdlib + SDK type blob

#### Automated QA:
- [ ] Curl walkthrough script `scripts/scripts-api-smoke.sh` (new): start `bun run start:http`, then upsert / search / run / delete the same script and assert each shell exit code is 0. Run via `bash scripts/scripts-api-smoke.sh`.

#### Manual Verification:
- [ ] Open `openapi.json`, eyeball the 5 new operations are present with correct request/response schemas
- [ ] Confirm `docs-site/content/docs/api-reference/**` regenerates without unexpected churn

**Implementation Note**: After this phase, pause for manual confirmation. Commit: `feat(scripts): HTTP API + OpenAPI regen`.

---

## Phase 4: MCP tools — `script_*` family

### Overview

Register five MCP tools that proxy to the HTTP API. Tool surface is intentionally tiny (5 tools, scaling-flat regardless of catalog size).

### Changes Required:

#### 1. Tool registrations
**Files** (new), each following the `createToolRegistrar` pattern from `src/tools/memory-search.ts:1-80`:
- `src/tools/script-search.ts` — `script_search`, wraps `POST /api/scripts/search`
- `src/tools/script-run.ts` — `script_run`, wraps `POST /api/scripts/run`
- `src/tools/script-upsert.ts` — `script_upsert`, wraps `POST /api/scripts/upsert`
- `src/tools/script-delete.ts` — `script_delete`, wraps `DELETE /api/scripts/:name`
- `src/tools/script-query-types.ts` — `script_query_types`, wraps `GET /api/scripts/:name/types`

Each tool:
- Exports `registerScriptXxxTool(server: McpServer)` matching the pattern at `src/tools/memory-search.ts:1`.
- Defines its input schema via Zod, surfaces it in MCP metadata via `createToolRegistrar`.
- Tool descriptions are *load-bearing* for agent discovery — phrase them in the same style as code-mode's tools (concise, action-first, mentions auto-save behavior where relevant).
- Reads the caller's agent ID via `getRequestInfo(req).agentId` from `src/tools/utils.ts:24-46`.
- Forwards `Authorization: Bearer ${apiKey}` + `X-Agent-ID: ${agentId}` headers when calling the internal HTTP API.

#### 2. Server-side registration
**File**: `src/server.ts`
**Changes**: Inside `createServer()` (lines 165-249), add 5 new `registerScriptXxxTool(server)` calls alongside the existing tool registrations. The `McpServer` instance is created at `src/server.ts:151`.

#### 3. CLAUDE.md addition
**File**: `CLAUDE.md`
**Changes**: Add a new `<important if="you are modifying scripts-runtime code">` block:

```markdown
<important if="you are modifying scripts-runtime code (src/scripts-runtime/*, src/be/scripts/*, src/tools/script-*.ts, src/http/scripts.ts)">

Architecture: API server owns the `scripts` + `script_versions` tables. Workers + the runtime invoke via HTTP. The runtime evaluates user-supplied TS in a `Bun.spawn` subprocess wrapped in `ulimit -v 524288 -t 60`, 30s AbortController, 1 MB stdout cap.

Authority injection: agent identity flows via `X-Agent-ID` headers from MCP → HTTP → runtime → ctx. Bearer is in subprocess env (`API_KEY`) — a malicious script can read it; v2 hardens to a non-env channel.

FS modes: `'none'` = per-run tmpdir; `'workspace-rw'` = worker's `/workspace`. Not a real sandbox — convention, not enforcement.

Tests: `bun test src/tests/scripts-*.test.ts`. Sandbox + timeout + abort paths are the highest-risk surface — keep coverage tight.

</important>
```

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint`
- [ ] Type check passes: `bun run tsc:check`
- [ ] MCP docs regenerated: `bun run docs:mcp` (regenerates `MCP.md`); commit the diff alongside this phase
- [ ] MCP tool registration test passes: `bun test src/tests/mcp-tools.test.ts -t "script_"` verifies all 5 tools appear in the MCP listing with correct schemas
- [ ] HTTP→MCP integration test passes: `bun test src/tests/scripts-mcp-e2e.test.ts` exercises `script_upsert → script_search → script_run → script_delete` end-to-end against the in-process server

#### Automated QA:
- [ ] Stdio MCP smoke: a script under `scripts/scripts-mcp-stdio-smoke.ts` opens a stdio MCP client, lists tools, asserts the 5 new tools are present with the documented descriptions. Run via `bun run scripts/scripts-mcp-stdio-smoke.ts`.

#### Manual Verification:
- [ ] In a real Claude Code session against a local swarm worker, observe the agent can call `script_search` from the MCP tool surface (visible in tool-call logs)

**Implementation Note**: After this phase, **agents can author and run scripts**. This is the v1 minimum-viable feature. Phases 5-6 are enhancements. If commit-per-phase, commit: `feat(scripts): MCP tool surface`. **Recommended pause point** — manually exercise the feature for a day before continuing.

---

## Phase 5: Embeddings — semantic `script_search`

### Overview

Replace Phase 3's name-substring search with embedding-based semantic search. Reuse `src/be/embedding.ts` provider plumbing. Embed `description + intent + signature` on every upsert. Hybrid ranking (embedding cosine + name/keyword boost).

### Changes Required:

#### 1. Migration: embeddings storage
**File**: `src/be/migrations/064_script_embeddings.sql`
**Changes**:

```sql
CREATE TABLE script_embeddings (
  scriptId TEXT PRIMARY KEY REFERENCES scripts(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,                   -- float32 array as bytes
  embeddingModel TEXT NOT NULL,
  embeddedText TEXT NOT NULL,                -- the concat'd string we embedded
  embeddedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### 2. Embedding pipeline
**File**: `src/be/scripts/embeddings.ts` (new)
**Changes**:
- `embedScript(script: ScriptRecord) -> Promise<void>` — concat `description + '\n' + intent + '\n' + signatureJson`, call `embeddingProvider.embed(text)` (reuse `OpenAIEmbeddingProvider` from `src/be/memory/providers/openai-embedding.ts:11`, `embed()` at lines 44-66), serialize Float32Array → Buffer via `serializeEmbedding` from `src/be/embedding.ts:30`.
- `searchScripts(query: string, scope, limit) -> Promise<Array<{ script, score }>>` — embed the query, fetch candidate rows via `getCandidateEmbeddings(scope, scopeId)`, deserialize each via `deserializeEmbedding` (`src/be/embedding.ts:37`), score via `cosineSimilarity` (`src/be/embedding.ts:5`), sort, return top N.
- `reembedAllScripts() -> Promise<void>` — bulk re-embed on model change. CLI tool: `bun run src/cli.tsx scripts reembed`.
- Apply `scrubSecrets` (`src/utils/secret-scrubber.ts:197`) to the concat'd text before embedding (the embedding provider gets sensitive payloads otherwise).

#### 3. Hook into upsert
**File**: `src/be/scripts/db.ts`
**Changes**: After `upsertScriptByName` writes the row, if `contentHash` OR `description` OR `intent` OR `signatureJson` changed, schedule a re-embedding. Sync vs async TBD at implementation time — sync is simpler; async is faster for bulk upserts.

#### 4. Wire `/api/scripts/search` to use embeddings
**File**: `src/http/scripts.ts`
**Changes**: Replace name-substring fallback with:
- Embed the query string.
- Score against all `script_embeddings` rows in the caller's accessible scopes (`global` + `agent` matching `X-Agent-ID`).
- Hybrid ranking: `finalScore = 0.7 * cosineSimilarity + 0.3 * nameMatchBonus` where `nameMatchBonus = 1 if name contains query substring, 0 otherwise`. Tune the weights based on smoke results.
- Return top `limit` (default 10) sorted by `finalScore` descending.

#### 5. Backfill command
**File**: `src/cli.tsx`
**Changes**: Add a sub-command `scripts reembed` that re-embeds all rows (for after model changes / schema migrations). Routes to `reembedAllScripts()`.

### Success Criteria:

#### Automated Verification:
- [ ] Lint + type check pass
- [ ] Migration applies cleanly on fresh + existing DB
- [ ] Unit tests pass: `bun test src/tests/scripts-embeddings.test.ts`:
  - [ ] Embed on upsert: new row has `script_embeddings` entry
  - [ ] Re-embed on body change (different `contentHash`)
  - [ ] Re-embed when description changes but body unchanged
  - [ ] No re-embed when nothing tracked changes
  - [ ] Search returns semantically similar scripts above name-substring-only matches (use 3 known-similar fixture scripts)
  - [ ] Hybrid ranking: exact name match outranks weaker semantic match for `query == name`

#### Automated QA:
- [ ] `bun test src/tests/scripts-embeddings.test.ts -t "semantic recall"` seeds 10 fixture scripts with deliberately overlapping intents, runs 5 natural-language queries, asserts top-3 recall matches the expected ranking. Threshold: 4/5 queries hit expected top-1.

#### Manual Verification:
- [ ] Manually upsert ~5 real-looking scripts, run `script_search` with vague queries, eyeball the results — are they sensible? Adjust the 0.7/0.3 hybrid weight if needed.

**Implementation Note**: After this phase, commit: `feat(scripts): semantic search via embeddings`.

---

## Phase 6: Workflow node — `swarm-script`

### Overview

Register `swarm-script` as a new workflow executor (distinct from existing inline-runner `script` node). Engine resolves by `(name, scope)` + optional `pinHash`, executes via the runtime, output keyed by node ID for downstream `inputs` mappings.

### Changes Required:

#### 1. Executor file
**File**: `src/workflows/executors/swarm-script.ts` (new)
**Changes**: Implements the executor interface (study `src/workflows/executors/script.ts:1-128` for the contract — but DO NOT collide with its node-type string `"script"` at `script.ts:29`; new name is `swarm-script`). Reads node config `{ scriptName: string, scope?: 'global' | 'agent', pinHash?: string, args?: object, fsMode?: 'none' | 'workspace-rw' }`, resolves via DB (`getScript` + optional `getScriptVersion` for pinned), calls the runtime, returns the result.

For `fsMode: 'workspace-rw'` scripts, dispatch via the same async-pause pattern as `agent-task`: `src/workflows/executors/agent-task.ts:100-108` returns `{ status: "success", async: true, waitFor: "task.completed", correlationId: task.id }`. Create a task that runs the script on the assigned worker; pause until task completes; resume with the result. (Alternatively, for v1 simplicity, run server-side regardless of `fsMode` and document that `workspace-rw` is intended for worker-context invocation via a future dispatch. Trade-off: simpler v1 vs. honoring the brainstorm Decision #9 split. Implementor's call — flag in the plan summary.)

#### 2. Executor registry
**File**: `src/workflows/executors/registry.ts:62-80`
**Changes**: Inside `createExecutorRegistry(deps)`, add `registry.register(new SwarmScriptExecutor(deps));` alongside the existing 10 executors (`PropertyMatchExecutor`, `CodeMatchExecutor`, `NotifyExecutor`, `RawLlmExecutor`, `ScriptExecutor`, `VcsExecutor`, `ValidateExecutor`, `AgentTaskExecutor`, `HumanInTheLoopExecutor`, `WaitExecutor`). Add the corresponding `import` at the top.

#### 3. Node-type schema
**File**: `src/workflows/types.ts` (or wherever workflow node schemas live — see imports in `src/workflows/executors/registry.ts`)
**Changes**: Add `swarm-script` to the `NodeTypeSchema` union. Define `SwarmScriptNodeConfigSchema` with the fields above. Honor the trigger-schema JSON-Schema subset documented in `runbooks/workflows.md:37-54` (only `type`, `required`, `properties`, `enum`, `const`, `items` are honored; `oneOf`/`anyOf`/`$ref`/`pattern`/`format`/`additionalProperties` are silently ignored).

#### 4. Workflow runbook update
**File**: `runbooks/workflows.md`
**Changes**: Document the new `swarm-script` node type — examples, args/inputs mapping, fsMode behavior, pinHash semantics.

#### 5. CLAUDE.md cross-link
**File**: `CLAUDE.md`
**Changes**: Append to the existing `<important if="you are creating or modifying workflows…">` block: reference `swarm-script` as a sibling of the existing inline `script` runner.

### Success Criteria:

#### Automated Verification:
- [ ] Lint + type check pass
- [ ] Unit tests pass: `bun test src/tests/workflow-swarm-script.test.ts`:
  - [ ] A workflow with one `swarm-script` node resolves by name + runs + returns result
  - [ ] `pinHash` correctly resolves to a historic `script_versions` row
  - [ ] `inputs` mapping from a predecessor node correctly populates `args`
  - [ ] `fsMode: 'workspace-rw'` dispatches to the worker (mock the dispatch); `fsMode: 'none'` runs server-side
  - [ ] Failure in the script surfaces as a workflow-node failure (matches existing `script` node failure shape)
- [ ] E2E test passes: `bun test src/tests/workflow-e2e.test.ts -t "swarm-script"` — full workflow run with the engine

#### Automated QA:
- [ ] `bun test src/tests/workflow-e2e.test.ts -t "swarm-script + agent-task interleave"` runs a 3-node workflow `swarm-script → agent-task → swarm-script` end-to-end against a stub agent provider, asserts all three nodes complete and outputs chain correctly

#### Manual Verification:
- [ ] Open the workflow UI (`ui/`, port 5274), confirm `swarm-script` shows up as a node type in the palette; create a workflow with one `swarm-script` node referencing a real script; run it from the UI; eyeball the output

**Implementation Note**: After this phase, commit: `feat(scripts): swarm-script workflow node`.

### QA Spec (optional):

The cross-cutting QA at the **end of Phase 6** warrants a dedicated QA report — agent invocation + workflow node + embeddings together is broad enough that a single doc collecting screenshots, sample script bodies, and observed agent token-savings deserves a place to live.

**QA Doc**: `thoughts/taras/qa/YYYY-MM-DD-reusable-scripts-runtime.md` (generate via `desplega:qa` after Phase 6; use the actual implementation date).

---

## Appendix

### Follow-up plans

- **v2 sandbox hardening (separate plan)**: revisit just-bash *if* PR #169 merges upstream; alternatives: `isolated-vm`, Deno `--allow-*`, container-per-script. Track in `thoughts/taras/research/2026-05-15-just-bash-integration-shape.md`.
- **v2 stdlib expansion**: `fuzzy-match`, `filter`, `flatten` — gated on actual agent feedback (deferred per research §5).
- **v2 CLI surface**: `bun run src/cli.tsx scripts {run, list, types}` — deferred per research §7. Revisit when a human-debug use case appears.
- **v3 permission manifest**: per-script `requires: ['memory.write']` — gated on ≥ 5 abuse cases.
- **v3 approval-request promotion**: non-lead agents request promotion via `approvalRequests` flow — gated on actual operator demand.

### Derail notes

- **`src/workflows/executors/script.ts` rename consideration**: the existing executor named `script` runs inline `bash|ts|python` strings. After v1 ships, consider renaming it to `inline-script` for clarity (vs `swarm-script`). NOT in this plan to keep scope tight — file a follow-up issue.
- **Embedding model rotation**: when `OpenAIEmbeddingProvider` model changes, `script_embeddings.embeddingModel` reveals the mismatch — `scripts reembed` CLI handles backfill. Document the rotation runbook in `runbooks/memory-system.md` (which already covers the analogous case for memory).
- **Worker disk usage**: every `script_run` against a worker writes `args` / `source` / `result` tmpfiles. Clean up in a `finally` block after each call. Tested by a unit test that asserts the tmpdir is empty after a successful run.
- **Cold-start cost** (Bun subprocess): ~50ms per `script_run`. Acceptable for v1. v2 hardening (just-bash, or a long-lived worker pool) addresses this.

### References

- Research:
  - `thoughts/taras/brainstorms/2026-05-15-agent-reusable-scripts.md` (10 decisions + open questions)
  - `thoughts/taras/research/2026-05-15-agent-reusable-scripts.md` (research + Addendum II final sandbox call)
  - `thoughts/taras/research/2026-05-15-just-bash-integration-shape.md` (1,114 lines; basis for just-bash rejection; v2 revisit reference)
- Codebase precedents:
  - `src/be/migrations/014_prompt_templates.sql` — versioning shape (live + history)
  - `src/artifact-sdk/server.ts:42-69` — Pages SDK auth proxy (`Bearer` + `X-Agent-ID` injection)
  - `src/artifact-sdk/browser-sdk.ts:9-19` — `BROWSER_SDK_JS` 8-domain shape to mirror
  - `src/workflows/executors/script.ts:1-128` — existing inline `script` executor (collision; choose `swarm-script` for the new node)
  - `src/be/embedding.ts` + `src/be/memory/providers/openai-embedding.ts:11` — embedding pipeline to reuse
  - `src/utils/secret-scrubber.ts` — egress hygiene (apply to script result + embedding text)
  - `scripts/check-db-boundary.sh` — DB-ownership invariant (enforces API-only DB writes)
- External:
  - `https://github.com/desplega-ai/code-mode` — reference patterns (separate package, separate storage)
  - `https://bun.com/docs/api/spawn` — `Bun.spawn` reference
  - `https://bun.com/docs/api/glob` — `Bun.Glob` reference

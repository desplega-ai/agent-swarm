---
date: 2026-05-16
planner: Claude (on behalf of Taras)
git_commit: 79eb5690e2a8a4f9e39f417903cb19265af31d26
branch: main
repository: agent-swarm
topic: "Reusable scripts runtime (code-mode for agent-swarm) — v1 foundation"
tags: [plan, scripts, code-mode, runtime, sandbox, embeddings, workflow-node]
status: completed
last_updated: 2026-05-18
last_updated_by: Codex implementing orchestrator
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

- **No `scripts` table.** Storage is greenfield. Highest current migration is `063_cost_context_schema_relax.sql` (landed in #491 on 2026-05-17, post-plan-draft); new migrations claim `064_scripts.sql` and `065_script_embeddings.sql`.
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
- **No `workspace-rw` execution in v1.** When the runtime is invoked via the API server (the only call path in v1), `cwd: '/workspace'` would point at the API server's filesystem — not the calling worker's checkout — which is incoherent. v1 ships with `fsMode: 'none'` only (per-run tmpdir); the column + CHECK constraint accept `'workspace-rw'` for forward compatibility, but `/api/scripts/run` rejects it with 501. Worker-context execution (real `workspace-rw`) is a v2 follow-up that requires the `agent-task` async-dispatch pattern at both the HTTP-route and workflow-executor layers.
- **No real read-only FS sandbox in v1.** `fs: 'none'` (cwd = per-run tmpdir) is convention, not enforcement. No `workspace-ro` until we have a real sandbox.
- **No network egress allow-list in v1.** Scripts inherit the host's outbound posture (unrestricted). v2 hardening can wrap `ctx.stdlib.fetch` with a per-script policy.
- **No permission manifest** (`requires: ['memory.write']`). Scripts inherit the caller agent's full `swarm.*` permissions. v3+ if abuse signals appear.
- **No secrets in subprocess env.** v1 delivers the swarm-owned config (apiKey, agentId, mcpBaseUrl, user-set values) via a JSON blob on **stdin**, not env vars. The subprocess `process.env` reduces to Node/Bun defaults only (`PATH`, `HOME`, `LANG`, etc.) — none of those carry swarm secrets. Combined with the `Redacted<T>` wrapper (next section), this collapses the previously v2-deferred "non-env channel" hardening into v1.
- **No CLI subcommand** (`bun run src/cli.tsx scripts run …`). Defer per research §7. HTTP `curl` is sufficient for ad-hoc debugging.
- **No code-mode importer.** Coexist; document the distinction. Different storage models (FS vs API SQLite), different SDKs.
- **No `fuzzy-match`, `filter`, `flatten` stdlib helpers.** v1 ships only `fetch`, `grep`, `glob`, `table`.
- **No new `agent_definitions` table.** Use the existing `(scope, scopeId)` pattern from `prompt_templates` with `scopeId = agentId` for per-agent scope.

## Implementation Approach

- **Sequence: storage → runtime → HTTP API → MCP tools → embeddings → workflow node.** Each phase ships a verifiable deliverable. Phases 1-4 yield "agents can author and run scripts." Phase 5 yields semantic discovery. Phase 6 yields workflow integration.
- **Reuse, don't invent.** `prompt_templates` + `prompt_template_history` is the versioning template. `src/artifact-sdk/server.ts` is the auth-injection template. `src/be/embedding.ts` + `OpenAIEmbeddingProvider` is the embedding template. `src/workflows/executors/*` is the node-registration template.
- **DB ownership invariant.** All storage + embedding writes go through `src/be/db.ts` + new `src/be/scripts/*` helpers (API-only). Workers + runtime invoke via HTTP through new `/api/scripts/*` routes. `scripts/check-db-boundary.sh` enforces.
- **Auth injection via stdin JSON config, wrapped in `Redacted<T>`.** The loader subprocess receives swarm config (apiKey, agentId, mcpBaseUrl, user values) as a JSON blob on **stdin**, not env vars. The eval-harness reads it on boot, wraps each value in `Redacted<T>` carrying metadata (`{ type: 'system' | 'user', isSecret: boolean }`), and exposes them via `ctx.swarm.config.*`. `process.env` no longer carries swarm-owned values — a malicious script reading `process.env.AGENT_SWARM_API_KEY` gets `undefined`. The SDK calls `Redacted.value()` internally to unwrap when making internal requests; user code never needs to unwrap.
- **Typed SDK derived from MCP tool registry at build time.** Rather than hand-mirroring `BROWSER_SDK_JS`, `scripts/bundle-script-types.ts` reads the MCP tool registry (from `src/server.ts`), pulls each tool's Zod input/output schemas, and emits a `.d.ts` blob that `script_query_types` returns. Scripts get autocomplete + type checking against the live MCP surface. A curated allowlist (~20-30 read-heavy + write-light tools) keeps lifecycle tools (`join_swarm`, `start_worker`) out of the script SDK.
- **Typecheck on explicit upsert, skip on scratch.** `script_upsert` runs `tsc --noEmit` against the generated SDK + stdlib `.d.ts` files; rejects on diagnostics. `script_run` with inline `source` (scratches) skips typecheck for hot-path speed — failures surface at runtime. Promotion (scratch → explicit upsert) must pass typecheck. Same scratches-vs-explicit split as embeddings.
- **Bearer read via `getApiKey()`, never raw env.** Per the recently-added CLAUDE.md rule (`scripts/check-api-key-boundary.sh`), the runtime loader reads the swarm API key via `getApiKey()` from `src/utils/api-key.ts` (precedence `AGENT_SWARM_API_KEY > API_KEY`). Raw `process.env.API_KEY` reads are CI-forbidden.
- **Executor abstraction — pluggable from day one.** Script execution sits behind a `ScriptExecutor` interface (semantic inputs/outputs only — no `Bun.spawn` / `ulimit` / Unix primitives leak through). v1 ships a single `NativeScriptExecutor` (current `Bun.spawn` + `ulimit` + stdin-config implementation). v2 adapters for remote sandboxes (E2B, Modal, Daytona, fly-machines, etc.) are new files implementing the interface + a registry entry — **no refactor of `loader.ts` or anything above it**. Selected at runtime via `SCRIPT_EXECUTOR` env var (default `native`). Same `Redacted<T>` config, same MCP-derived typed SDK, same typecheck-on-upsert — the abstraction is a clean boundary at the "how do I actually execute this source" line.
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
**File**: `src/be/migrations/064_scripts.sql`
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
  typeChecked INTEGER NOT NULL DEFAULT 0,    -- 1 = passed tsc --noEmit at upsert; 0 = scratch / pre-typecheck
  fsMode TEXT NOT NULL DEFAULT 'none' CHECK(fsMode IN ('none', 'workspace-rw')),
  createdByAgentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- (name, scope, scopeId) uniqueness via expression index — SQLite treats NULL as distinct in
-- inline UNIQUE constraints, which would let duplicate ('foo','global',NULL) rows through.
-- COALESCE collapses NULL scopeId for 'global' rows to '' so uniqueness is enforced.
CREATE UNIQUE INDEX idx_scripts_name_scope ON scripts(name, scope, COALESCE(scopeId, ''));
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
- [x] Lint passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] DB boundary check passes: `bash scripts/check-db-boundary.sh` (`src/be/scripts/db.ts` is API-only — fine; runtime not added to allowlist yet — that comes in Phase 2)
- [x] Fresh DB sanity: `rm agent-swarm-db.sqlite && bun run start:http` boots without error and creates both tables (verify with `sqlite3 agent-swarm-db.sqlite '.schema scripts script_versions'`)
- [x] Existing DB sanity: bring up an existing DB (e.g. via `cp agent-swarm-db.sqlite agent-swarm-db.sqlite.bak` then re-apply) — `start:http` boots without error
- [x] Unit tests pass: `bun test src/tests/scripts-db.test.ts` (cover: insert, content-hash dedup, version bump on body change, history rows written, scope uniqueness, cascade delete)

#### Automated QA:
- [x] CLI walkthrough: `bun test src/tests/scripts-db.test.ts -t "full lifecycle"` exercises upsert → upsert-same-content (no version bump) → upsert-different-content (version bumps, history row written) → delete (cascade)

#### Manual Verification:
- [x] Schema review: open `src/be/migrations/064_scripts.sql`, confirm `idx_scripts_name_scope` is a UNIQUE INDEX (not an inline UNIQUE constraint) wrapping `scopeId` in `COALESCE(scopeId, '')` so global scripts (scopeId IS NULL) are deduped correctly

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, commit `feat(scripts): storage layer + script_versions audit history`.

---

## Phase 2: Runtime — `src/scripts-runtime/` with sandboxed loader

### Overview

Build the in-repo runtime package: a loader that takes `{ source, args, fsMode, agentId, signal }`, evaluates the script in a `Bun.spawn` subprocess wrapped in `sh -c 'ulimit -v 524288 -t 60; exec …'` on POSIX, with a 30s `AbortController` wall-clock cap and a 1 MB stdout cap. Injects `ctx = { swarm, stdlib, logger }` via env-passed config. **No DB / HTTP coupling yet — pure execution.**

### Changes Required:

#### 1. Runtime package layout
**Files** (all new):
- `src/scripts-runtime/loader.ts` — main entry: `runScript({ source, args, fsMode, agentId, signal, timeoutMs }) -> { result, stdout, stderr, truncated, durationMs }`. **Executor-agnostic**: resolves the bearer via `getApiKey()`, assembles the `SwarmConfigPayload`, runs the AST import-allowlist pre-flight, picks the configured executor via `getScriptExecutor()`, calls `executor.run({...})`, applies `scrubObject` to the result, returns the typed output. Knows nothing about `Bun.spawn` / `ulimit` / stdin pipes — that's NativeScriptExecutor's job.
- `src/scripts-runtime/executors/types.ts` — the `ScriptExecutor` interface + shared `ExecutorInput` / `ExecutorOutput` types. **No runtime-specific primitives** in the interface — see §2.
- `src/scripts-runtime/executors/registry.ts` — `getScriptExecutor(): ScriptExecutor` reads `SCRIPT_EXECUTOR` env (default `native`), returns the matching implementation. Same shape as the harness-provider registry pattern used in `src/providers/`.
- `src/scripts-runtime/executors/native.ts` — `NativeScriptExecutor`. The v1 implementation: `Bun.spawn` + `ulimit` + tightened caps + env-strip + stdin-config + AbortSignal + output cap + tmpdir cleanup. See §2.
- `src/scripts-runtime/redacted.ts` — `Redacted<T>` abstraction with metadata baked into the WeakMap registry. See §3.
- `src/scripts-runtime/swarm-config.ts` — `SwarmConfig` class with typed getters returning `Redacted<string>`. See §4.
- `src/scripts-runtime/ctx.ts` — constructs the `ctx` shape passed to script bodies (`{ swarm, stdlib, logger }`).
- `src/scripts-runtime/swarm-sdk.ts` — **derived from MCP tool registry**, not hand-mirroring BROWSER_SDK_JS. See §5.
- `src/scripts-runtime/import-allowlist.ts` — AST pre-flight pass over the user source; rejects imports outside the allowed set (relative `./*`, the swarm-sdk barrel, stdlib helpers). Defense-in-depth — bypassable via `eval` but stops the 90% accidental case. See §6.
- `src/scripts-runtime/stdlib/index.ts` — barrel: `{ fetch, grep, glob, table }`
- `src/scripts-runtime/stdlib/fetch.ts` — retries (3), 30s timeout via AbortController, typed JSON parsing on Content-Type
- `src/scripts-runtime/stdlib/grep.ts` — shells out to `rg` (skip with informative error if not on PATH)
- `src/scripts-runtime/stdlib/glob.ts` — wraps `Bun.Glob` (https://bun.com/docs/api/glob)
- `src/scripts-runtime/stdlib/table.ts` — formats `Array<Record<string, unknown>>` to a fixed-width string
- `src/scripts-runtime/eval-harness.ts` — executed by `bun run <harness>`. **Reads the `SwarmConfigPayload` JSON blob from stdin** on boot, hydrates `SwarmConfig` with `Redacted`-wrapped values, then reads `SWARM_SCRIPT_*_FILE` paths from env (data-only — tmpfile paths, not secrets), dynamic-`import()`s the user's tmpfile, passes `args` + `ctx` to the default export, writes the result file. See §7.

#### 2. `ScriptExecutor` interface — **the abstraction boundary**
**File**: `src/scripts-runtime/executors/types.ts`

The interface that future remote-sandbox adapters (E2B / Modal / Daytona / fly-machines / etc.) must implement. **Inputs and outputs are semantic** — no Unix primitives, no provider-specific knobs, no subprocess pipes. Each executor decides internally how to translate the policy to its substrate.

```ts
export type ExecutorInput = {
  // The user's TypeScript source. Executor is responsible for getting Bun (or equivalent
  // TS-capable runtime) to evaluate it. v1 contract: scripts target Bun's TS support; a
  // remote executor without Bun must use a container image that ships Bun.
  source: string;
  // JSON-serializable args + config. Each executor decides the secure delivery channel
  // (native: stdin pipe; E2B: encrypted env / secrets API; Modal: modal.Secret bind).
  args: unknown;
  configPayload: SwarmConfigPayload;

  // Resource policy — SEMANTIC, not Unix-specific. Each executor translates:
  //   native → ulimit flags
  //   E2B    → sandbox config (memory_mb, timeout_ms)
  //   Modal  → @app.function(memory=…, cpu=…, timeout=…)
  resources: {
    memoryMb: number;       // default 512
    cpuTimeSec: number;     // default 60
    wallClockMs: number;    // default 30_000
    maxProcs: number;       // default 32 (native: ulimit -u; remote: usually N/A)
    maxFdCount: number;     // default 64 (native: ulimit -n; remote: usually N/A)
    maxFileBytes: number;   // default 64_000_000
    maxStdoutBytes: number; // default 1_048_576
  };

  // Filesystem mode (semantic):
  //   'none'         — ephemeral per-run tmpdir; no host FS visibility.
  //   'workspace-rw' — v2 only; the worker's checkout. Native rejects at validation time
  //                    (returns 501 from loader). Remote executors with volume-mount
  //                    semantics (E2B, Daytona) implement it differently.
  fsMode: 'none' | 'workspace-rw';

  // Network policy (forward-compat, even though v1 doesn't enforce):
  //   'open'              — script can reach anywhere the runtime can.
  //   { allowlist: [...] }— host:port list (v2 / executor-supported only).
  network: 'open' | { allowlist: string[] };

  signal?: AbortSignal;
};

export type ExecutorOutput = {
  result: unknown | undefined;   // parsed from the result-file/wire (executor's responsibility)
  stdout: string;                // capped to resources.maxStdoutBytes
  stderr: string;                // capped to resources.maxStdoutBytes
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  exitCode: number;              // 0 on success; executor-defined on failure
  error?: 'timeout' | 'oom' | 'killed' | 'import_violation' | 'eval_error' | 'executor_error';
};

export interface ScriptExecutor {
  readonly name: string;        // 'native' | 'e2b' | 'modal' | ...
  run(input: ExecutorInput): Promise<ExecutorOutput>;
}
```

**Invariants every executor must uphold:**
- Honor `signal` — abort the run if signaled; resolve with `error: 'killed'`.
- Enforce `resources.wallClockMs` even if the substrate doesn't (executor sets its own AbortController).
- Apply `maxStdoutBytes` cap — never return more than that, set `truncated.stdout=true` if exceeded.
- **Never** echo the `configPayload` back in stdout/stderr/result. Egress scrubber (`scrubObject` in `loader.ts`) is a safety net, not the executor's responsibility — but executors must not actively leak.
- Reject `fsMode: 'workspace-rw'` in v1 with `error: 'executor_error'` and a clear message in stderr.

**What's intentionally NOT in the interface:**
- No `tmpdir` / `cwd` / `harnessPath` — those are NativeScriptExecutor-internal. Remote executors don't have a "tmpdir" in the host sense.
- No `env` allowlist — that's a Unix concept. Remote executors hide env entirely.
- No raw subprocess handle — caller can't `proc.stdin.write(...)`. All config goes through `configPayload`.

#### 2a. Config payload shape
**File**: `src/scripts-runtime/executors/types.ts` (shared with all executors)

```ts
export type SwarmConfigPayload = {
  system: {
    apiKey: { value: string; isSecret: true };       // from getApiKey()
    agentId: { value: string; isSecret: false };     // from X-Agent-ID header
    mcpBaseUrl: { value: string; isSecret: false };  // from MCP_BASE_URL config
  };
  user: Record<string, { value: string; isSecret: boolean }>;  // future: per-script user-set config
};
```

`loader.ts` assembles this from `getApiKey()` (mandatory — throws if missing) + the request's `X-Agent-ID` + the server's `MCP_BASE_URL`. The eval-harness boot path (§7) converts each `{ value, isSecret }` entry into a `Redacted<string>` via `Redacted.make(value, { type: 'system' | 'user', isSecret })`. User code never sees the raw `value`. Each executor decides the secure delivery channel:
- Native: write JSON to subprocess stdin, close pipe.
- E2B (v2): upload as a file under `/etc/swarm-config.json` with restricted perms, or use their secrets API.
- Modal (v2): `modal.Secret.from_dict(...)` bound to the function.

#### 2b. NativeScriptExecutor — v1 implementation
**File**: `src/scripts-runtime/executors/native.ts`

The v1 implementation of `ScriptExecutor`. Translates the semantic input to `Bun.spawn` + `ulimit` + stdin pipe + AbortSignal + tmpdir + output cap + cleanup.

```ts
export class NativeScriptExecutor implements ScriptExecutor {
  readonly name = 'native';

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (input.fsMode === 'workspace-rw') {
      return { result: undefined, stdout: '', stderr: 'workspace-rw not supported by native executor in v1', truncated: { stdout: false, stderr: false }, durationMs: 0, exitCode: 1, error: 'executor_error' };
    }

    const tmpdir = await Bun.file(`${os.tmpdir()}/swarm-script-${crypto.randomUUID()}`);
    try {
      // Write args + source to tmpfiles (paths passed via env, not values).
      await Bun.write(`${tmpdir}/args.json`, JSON.stringify(input.args));
      await Bun.write(`${tmpdir}/source.ts`, input.source);
      const resultFile = `${tmpdir}/result.json`;
      const harnessPath = new URL('../eval-harness.ts', import.meta.url).pathname;

      const ulimits = [
        `ulimit -v ${Math.floor(input.resources.memoryMb * 1024)}`,     // KB
        `ulimit -t ${input.resources.cpuTimeSec}`,
        `ulimit -u ${input.resources.maxProcs}`,
        `ulimit -f ${Math.floor(input.resources.maxFileBytes / 1024)}`, // KB blocks
        `ulimit -n ${input.resources.maxFdCount}`,
      ].join('; ');

      const proc = Bun.spawn(['sh', '-c', `${ulimits}; exec bun run ${harnessPath}`], {
        env: {  // explicit allowlist — no swarm-owned values, no host env leakage
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          LANG: process.env.LANG ?? 'C.UTF-8',
          LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
          TMPDIR: tmpdir,
          SWARM_SCRIPT_TMPDIR: tmpdir,
          SWARM_SCRIPT_ARGS_FILE: `${tmpdir}/args.json`,
          SWARM_SCRIPT_SOURCE_FILE: `${tmpdir}/source.ts`,
          SWARM_SCRIPT_RESULT_FILE: resultFile,
        },
        cwd: tmpdir,
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        signal: input.signal,
      });
      proc.stdin.write(JSON.stringify(input.configPayload));
      proc.stdin.end();

      // ... wall-clock timer + output capping + exit-code handling + result-file read
      // ... maps Bun.spawn errors → ExecutorOutput.error union
    } finally {
      await Bun.$`rm -rf ${tmpdir}`;
    }
  }
}
```

**Windows note:** Same shape, but skip the `sh -c '...ulimit...; exec ...'` wrapper (POSIX-only). Emit a one-line warning on first use that resource caps don't apply. Production swarms run on Linux containers; Windows is dev-machine-only.

**Wall-clock:** `setTimeout(() => abortController.abort(), input.resources.wallClockMs).unref()` — matches `src/workflows/executors/script.ts:117-127`.

#### 2c. Executor registry & selection
**File**: `src/scripts-runtime/executors/registry.ts`

```ts
const EXECUTORS: Record<string, () => ScriptExecutor> = {
  native: () => new NativeScriptExecutor(),
  // v2: add 'e2b' / 'modal' / etc. — single line per provider, no other changes
};

export function getScriptExecutor(): ScriptExecutor {
  const name = process.env.SCRIPT_EXECUTOR ?? 'native';
  const factory = EXECUTORS[name];
  if (!factory) throw new Error(`Unknown SCRIPT_EXECUTOR: ${name}. Available: ${Object.keys(EXECUTORS).join(', ')}`);
  return factory();
}
```

Single env var picks the executor at runtime. Default `native`. For v2 adapters, add a single factory line — no other code change.

**Future executor placement convention:** `src/scripts-runtime/executors/<provider>.ts`. Each implements `ScriptExecutor`. May ship with its own README under `src/scripts-runtime/executors/<provider>.md` covering image requirements, secret-channel choice, and known-limitations vs the native executor.

#### 3. `Redacted<T>` abstraction
**File**: `src/scripts-runtime/redacted.ts`

WeakMap-backed wrapper. Metadata baked into the value, accessible via `Redacted.meta()` / `Redacted.isSecret()`. All standard stringification surfaces (`toString`, `toJSON`, `Symbol.for('nodejs.util.inspect.custom')`) return `<redacted>` — accidental `console.log` / `JSON.stringify` / `util.inspect` leaks are impossible. Only `Redacted.value()` returns the underlying value; SDK internals call it to unwrap when making outbound requests.

```ts
export interface Redacted<A> extends Object {}
export type RedactedMeta = { type: 'system' | 'user'; isSecret: boolean };

const registry = new WeakMap<Redacted<unknown>, { value: unknown; meta: RedactedMeta }>();

const proto = {
  toString() { return '<redacted>'; },
  toJSON() { return '<redacted>'; },
  [Symbol.for('nodejs.util.inspect.custom')]() { return '<redacted>'; },
};

export const Redacted = {
  make<A>(value: A, meta: RedactedMeta = { type: 'user', isSecret: false }): Redacted<A> {
    const r = Object.create(proto);
    registry.set(r, { value, meta });
    return r;
  },
  value<A>(self: Redacted<A>): A {
    const entry = registry.get(self);
    if (!entry) throw new Error('Redacted value was not in registry');
    return entry.value as A;
  },
  meta<A>(self: Redacted<A>): RedactedMeta {
    const entry = registry.get(self);
    if (!entry) throw new Error('Redacted value was not in registry');
    return entry.meta;
  },
  isSecret<A>(self: Redacted<A>): boolean { return Redacted.meta(self).isSecret; },
} as const;
```

Exposed to user scripts as `ctx.stdlib.Redacted`. Documented threat model in the header:

> "Defense-in-depth, not isolation. Accidental leaks (`console.log`, `JSON.stringify`, returned in script result) emit `<redacted>` automatically. A malicious script can still call `Redacted.value()` and exfiltrate the underlying string. The mitigation in v1 is two-fold: (a) `process.env` carries no swarm-owned values (config arrives via stdin), and (b) the host's egress scrubber (`scrubObject`) catches secret-shaped strings in script results."

#### 4. `SwarmConfig` class
**File**: `src/scripts-runtime/swarm-config.ts`

Typed getters for system values, generic getter for user-set. Hydrated by `eval-harness.ts` from the stdin `SwarmConfigPayload`.

```ts
export class SwarmConfig {
  readonly apiKey: Redacted<string>;     // type=system, isSecret=true
  readonly agentId: Redacted<string>;    // type=system, isSecret=false
  readonly mcpBaseUrl: Redacted<string>; // type=system, isSecret=false

  private readonly userValues: Map<string, Redacted<string>>;

  constructor(payload: SwarmConfigPayload) {
    this.apiKey = Redacted.make(payload.system.apiKey.value, { type: 'system', isSecret: true });
    this.agentId = Redacted.make(payload.system.agentId.value, { type: 'system', isSecret: false });
    this.mcpBaseUrl = Redacted.make(payload.system.mcpBaseUrl.value, { type: 'system', isSecret: false });
    this.userValues = new Map(
      Object.entries(payload.user ?? {}).map(([k, v]) => [k, Redacted.make(v.value, { type: 'user', isSecret: v.isSecret })])
    );
  }

  get<T = string>(key: string): Redacted<T> | undefined {
    return this.userValues.get(key) as Redacted<T> | undefined;
  }
}
```

Exposed to scripts as `ctx.swarm.config`.

#### 5. swarm-sdk — **derived from MCP tool registry**
**File**: `src/scripts-runtime/swarm-sdk.ts`

**Source of truth:** the MCP tool registry in `src/server.ts:165-249` (every `registerXxxTool(server)` call). At build time, `scripts/bundle-script-types.ts` (Phase 4 §3) reads each tool's Zod input/output schemas via `tool.inputSchema` / `tool.outputSchema` and emits a `.d.ts` blob exposing them as `ctx.swarm.<tool_name>(args) -> Promise<output>`.

**Runtime implementation** (this file): a thin proxy that dispatches `ctx.swarm.<tool_name>(args)` to a single HTTP POST against `${ctx.swarm.config.mcpBaseUrl}/mcp/tools/${tool_name}/call` (or the equivalent internal MCP endpoint), unwrapping `apiKey` + `agentId` via `Redacted.value()` once per request inside the SDK and never exposing the raw strings to user code:

```ts
async function callTool(name: string, args: unknown, config: SwarmConfig): Promise<unknown> {
  const res = await fetch(`${Redacted.value(config.mcpBaseUrl)}/api/mcp/tools/${name}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
      'X-Agent-ID': Redacted.value(config.agentId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`swarm-sdk: ${name} failed with ${res.status}`);
  return scrubObject(await res.json());
}
```

**Curated allowlist:** not every MCP tool is a sensible script primitive. Lifecycle tools (`join_swarm`, `start_worker`, `kill_task`) and provider-cred tools (`oauth_*`) are excluded. v1 ships ~20-30 read-heavy + write-light tools: `memory_*`, `task_*` (list/get/storeProgress, not create), `event_create`, `kv_*`, `agent_list/get`, `script_search/run` (recursive), `repo_*` (read-only initially). The allowlist lives in `src/scripts-runtime/sdk-allowlist.ts` as an exported `string[]` consumed by both the bundler (Phase 4 §3) and the runtime proxy (this file — rejects calls outside the allowlist with `"Tool 'X' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent"`).

`scrubObject` (Phase 3 §4) is applied on every response before handing back to user code — secret-shaped strings echoed back by the API still get redacted.

#### 7. Eval harness — **stdin config + tmpfile dynamic `import()`**
**File**: `src/scripts-runtime/eval-harness.ts`

Two-step bootstrap: (1) read the `SwarmConfigPayload` from stdin and hydrate `SwarmConfig`; (2) write user source to a tmpfile and dynamically `import()` it. The tmpfile + dynamic `import()` approach is the only one that preserves user-source line numbers in stack traces, handles arbitrary Unicode, doesn't depend on the `data:` URL scheme being importable, and doesn't lose source maps the way `new AsyncFunction` does.

```ts
// 1. Hydrate SwarmConfig from stdin (parent writes JSON then closes the pipe).
const stdinBuf = await Bun.stdin.text();
const payload: SwarmConfigPayload = JSON.parse(stdinBuf);
const swarmConfig = new SwarmConfig(payload);

// 2. Load args, build ctx with Redacted-wrapped config.
const args = JSON.parse(await Bun.file(process.env.SWARM_SCRIPT_ARGS_FILE!).text());
const ctx = buildCtx({ swarmConfig });  // builds { swarm: { config, ...sdk }, stdlib, logger }

// 3. Write user source to tmpfile (verbatim) and dynamic-import.
const sourceText = await Bun.file(process.env.SWARM_SCRIPT_SOURCE_FILE!).text();
const userModulePath = `${process.env.SWARM_SCRIPT_TMPDIR}/user-script.ts`;
await Bun.write(userModulePath, sourceText);
const mod = await import(userModulePath);
const userFn = mod.default as (args: unknown, ctx: unknown) => Promise<unknown>;

// 4. Run + persist result. Result is scrubbed by the host on read-back (Phase 3 §4 scrubObject).
const result = await userFn(args, ctx);
await Bun.write(process.env.SWARM_SCRIPT_RESULT_FILE!, JSON.stringify(result ?? null));
```

**Stdin handshake invariant:** parent writes the JSON payload and closes stdin **before** spawning the eval to look at any file. The harness `Bun.stdin.text()` resolves to the full payload string; if it's empty or unparseable, the harness exits 2 with a clear diagnostic so the host can distinguish "user script bug" from "config delivery bug".

Tmpdir cleanup: parent removes `SWARM_SCRIPT_TMPDIR` in a `finally` block after the subprocess exits. Asserted by a unit test.

**Rejected alternatives** (do not revisit without a regression case):
- `new AsyncFunction(source)`: kills line numbers in stack traces; doesn't support `import` statements.
- `data:text/typescript;base64,${btoa(source)}`: `btoa` throws on non-ASCII; the `data:` scheme isn't a guaranteed Bun contract.
- `bun -e <source>`: 128KB argv cap; shell-quoting hell; loses line numbers.
- Config-via-env: rejected — defeats the env-stripping posture and re-introduces the v2 hardening we just collapsed into v1.

#### 6. Import allowlist — AST pre-flight
**File**: `src/scripts-runtime/import-allowlist.ts`

Static analysis pass over the user source **before** writing it to the tmpfile. Uses the `typescript` dep (`ts.createSourceFile` + AST walk) to enumerate every `import` statement and dynamic `import()` call. Rejects with a clear diagnostic if any import is outside the allowed set:

- Relative paths starting with `./` or `../` (limited to within the tmpdir — Bun will fail anyway if they reach outside it).
- `swarm-sdk` (the typed SDK barrel, served virtual by the loader).
- `stdlib` (the runtime's `{ fetch, grep, glob, table, Redacted }` barrel).
- The `typescript`-equivalent literal node modules expected by user scripts? **No** — explicitly reject `node:*`, `bun:*` (except the stdlib re-exports), `fs`, `child_process`, `crypto`, raw `bun:sqlite`, etc.

Defense-in-depth, not isolation. Bypass paths (documented in the file header):
- `eval('import("...")')` — string-concatenation tricks.
- `globalThis['imp' + 'ort']('...')` — property-name obfuscation.

Both are caught by code review, not the runtime. The pre-flight stops the 90% accidental case (a script trying to `import('fs')` because the author copy-pasted from a Node example).

Wired in `loader.ts` between source-validation and tmpfile-write. Pre-flight failure surfaces as `{ error: 'import_violation', diagnostic: '...' }` from `runScript`; the HTTP handler returns 400.

#### 7. Signature extraction — **real TS AST, not regex**
**File**: `src/scripts-runtime/extract-signature.ts`
**Changes**: Use the `typescript` package (already a dependency at `^5` in `package.json`) to parse the source via `ts.createSourceFile(...)` and walk the AST for the `export default` arrow function or function declaration. Emit `{ argsType: string, resultType: string, description: string }` where:

- `argsType` / `resultType` are stringified via `node.getText()` on the relevant `TypeNode` — this is robust against destructuring, generics, multi-line types, `Promise<…>` wrappers, etc. Regex extraction is **not acceptable** for v1 because `script_query_types` returns this value and the embedding pipeline includes it — garbage signatures degrade both IDE introspection and semantic search recall on real-world scripts.
- `description` comes from the leading JSDoc comment on the export default node (`ts.getJSDocCommentsAndTags(node)`), or the empty string if absent.
- Fall back to `{ argsType: 'unknown', resultType: 'unknown', description: '' }` if AST parsing throws or no `export default` is found (signature is best-effort, not load-bearing for runtime).

50-line shim, no transitive overhead (TS is already in the dep tree for `tsc:check`). Tested by `bun test src/tests/scripts-extract-signature.test.ts` covering: arrow function with destructured args, generics (`<T extends ...>`), multi-line `Promise<{ a: string; b: number }>` returns, async function with `function` keyword (not arrow), no `export default` (fallback path), syntax error (fallback path).

#### 8. Boundary allowlists
**File**: `scripts/check-db-boundary.sh`
**Changes**: Append `src/scripts-runtime/` to the `WORKER_PATHS` bash array (currently 7 entries: `src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`, `plugin/opencode-plugins/`). Single-line edit. The runtime (including all `executors/*.ts` files, present and future) is pulled in via the worker's MCP tool path → must NOT import `src/be/db` or `bun:sqlite`. The recursive grep covers all nested directories — no separate entry needed for `executors/`.

**File**: `scripts/check-api-key-boundary.sh` (added in the recent CLAUDE.md update)
**Changes**: Append `src/scripts-runtime/` to its worker-paths allowlist as well. The loader reads the bearer via `getApiKey()` from `src/utils/api-key.ts` (which honors `AGENT_SWARM_API_KEY > API_KEY` precedence); raw `process.env.AGENT_SWARM_API_KEY` / `process.env.API_KEY` reads inside `src/scripts-runtime/` — including any future `executors/<provider>.ts` adapter — would trip this check.

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] DB boundary check passes: `bash scripts/check-db-boundary.sh` (after adding `src/scripts-runtime/` to the worker-safe list, verifies no `src/be/db` or `bun:sqlite` imports leak in)
- [x] API-key boundary check passes: `bash scripts/check-api-key-boundary.sh` (after adding `src/scripts-runtime/` to its allowlist, verifies no raw `process.env.AGENT_SWARM_API_KEY` / `process.env.API_KEY` reads in the runtime — must use `getApiKey()`)
- [x] Unit tests pass: `bun test src/tests/scripts-runtime.test.ts` covering:
  - [x] Trivial transform script returns expected result (`(args) => args.x + 1`)
  - [x] Script with `ctx.stdlib.fetch` to a mocked endpoint returns parsed JSON
  - [x] Script timing out is killed within timeoutMs + 500ms slack, returns `{ truncated, error: 'timeout' }`
  - [x] Script exceeding 1 MB stdout has `truncated: true` set
  - [x] AbortSignal aborts a running script within 500ms of `.abort()`
  - [x] **Env hygiene:** subprocess `process.env` keys are exactly `{ PATH, HOME, LANG, LC_ALL, TMPDIR, SWARM_SCRIPT_TMPDIR, SWARM_SCRIPT_ARGS_FILE, SWARM_SCRIPT_SOURCE_FILE, SWARM_SCRIPT_RESULT_FILE }` — assert via `Object.keys(process.env)` inside a test script. Specifically, `process.env.AGENT_SWARM_API_KEY === undefined` AND `process.env.API_KEY === undefined`.
- [x] `Redacted` unit tests pass: `bun test src/tests/redacted.test.ts` covering:
  - [x] `Redacted.make(value).toString() === '<redacted>'`
  - [x] `JSON.stringify({ secret: Redacted.make('hunter2') }) === '{"secret":"<redacted>"}'`
  - [x] `util.inspect(Redacted.make('hunter2'))` contains `<redacted>` (not the raw value)
  - [x] `Redacted.value(r)` round-trips the original value
  - [x] `Redacted.meta(r)` returns the stored `{ type, isSecret }`
  - [x] `Redacted.value()` on an unregistered object throws
- [x] `SwarmConfig` unit tests pass: `bun test src/tests/swarm-config.test.ts` covering: hydration from a fixture payload, typed getters return `Redacted<string>` with correct meta, `config.get('user-key')` returns the user-set value, missing user key returns `undefined`.
- [x] Import allowlist tests pass: `bun test src/tests/scripts-import-allowlist.test.ts` covering: allowed imports pass (relative `./helper`, `swarm-sdk`, `stdlib`); rejected imports fail with diagnostic (`node:fs`, `child_process`, `bun:sqlite`, `import('fs')` dynamic).
- [x] **Executor interface conformance test passes**: `bun test src/tests/script-executor-conformance.test.ts` — runs the same test suite against `NativeScriptExecutor` AND a `FakeScriptExecutor` (in-process, no-subprocess implementation used for unit testing). Suite covers: happy-path run, timeout, OOM (only native — fake skips), stdout cap + `truncated.stdout=true`, abort via signal, `fsMode: 'workspace-rw'` returns `error: 'executor_error'`, config payload is delivered (script can `Redacted.value(ctx.swarm.config.apiKey)` and return a hash of it). The same test file is the **conformance contract** for future v2 adapters — adding `E2BScriptExecutor` requires extending this test, not refactoring it.
- [x] **`getScriptExecutor()` honors `SCRIPT_EXECUTOR` env**: `bun test src/tests/script-executor-registry.test.ts` — `SCRIPT_EXECUTOR=native` returns NativeScriptExecutor; unset returns native (default); unknown value throws with a clear "Available: native" diagnostic.

#### Automated QA:
- [x] `bun test src/tests/scripts-runtime-secret-egress.test.ts`: runs a script that returns `{ leaked: Redacted.value(ctx.swarm.config.apiKey) }` — confirms the host's `scrubObject` (Phase 3 §4) scrubs the leaked string in the response. Also runs a script that returns `{ wrapped: ctx.swarm.config.apiKey }` (without unwrapping) — confirms the result file contains `"<redacted>"` (because `JSON.stringify` of a `Redacted<T>` emits `<redacted>`). Documented in `src/scripts-runtime/loader.ts` header: "Defense-in-depth: env-stripping prevents `process.env.AGENT_SWARM_API_KEY` access; `Redacted` prevents accidental log/JSON leaks; egress `scrubObject` catches values that were unwrapped and returned. A malicious script can still call `Redacted.value()` and exfiltrate via a fetch — v2 hardening tracks attribution per call."

#### Manual Verification:
- [x] Inspect a sample stack trace from a thrown script — confirm line numbers in error messages map back to the user's source file at `${tmpdir}/user-script.ts` (the tmpfile path will appear in the trace; tmpdir doesn't need to be redacted). If line numbers are off, the tmpfile + dynamic-import eval mechanism is broken — file as a blocker, not a v2 cleanup.

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
- `POST /api/scripts/upsert` — body `{ name, source, description, intent, scope?, fsMode? }`; **typecheck precondition** (see §5 below): rejects with 400 + diagnostics if source fails `tsc --noEmit` against the generated SDK + stdlib `.d.ts`. `scope='global'` requires `agents.isLead = 1` for the caller (resolve via `getAgentById` from `src/be/db.ts:678`); returns `{ name, version, contentDeduped }`. operationId: `scripts_upsert`.
- `POST /api/scripts/run` — body `{ name?, source?, args, intent }`; if `source` provided, runs inline + auto-saves on success (scratch); if `name` provided, fetches source from `scripts` table (scoped to caller's `agentId` + global); returns `{ result, autoSaved?: { slug, reason }, truncated?: boolean, durationMs }`. **v1 rejects `fsMode: 'workspace-rw'` with `501 Not Implemented`** (the subprocess spawns on the API server, not the caller's worker — see "What We're NOT Doing"). operationId: `scripts_run`.
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

**Audit logging for global-scope writes:** the `/api/scripts/upsert` handler emits an `events` row whenever a script lands at `scope='global'` (whether new or version bump). Event shape: `{ type: 'script.global_upsert', payload: { scriptId, name, version, contentHash, changedByAgentId, isNew, isPromotion } }` where `isPromotion=true` iff the previous row was `scope='agent'`. `script_versions.changedByAgentId` already records who upserted, but a scope change is a privileged action and deserves a queryable, separate trail. Use the existing `events` table — no new schema. Manually verifiable: `sqlite3 agent-swarm-db.sqlite "SELECT * FROM events WHERE type='script.global_upsert' ORDER BY createdAt DESC LIMIT 10"`.

**Stdio MCP transport limitation:** `src/stdio.ts` does not currently plumb `X-Agent-ID` through to internal HTTP calls. v1 ships with the scripts API as **HTTP-MCP-only**. The Phase 4 tool handlers (next phase) detect a missing `agentId` from `getRequestInfo(req)` and surface a clear error: `"script_* tools require HTTP MCP transport — agent identity is not available over stdio in this build. Switch to MCP_BASE_URL=http://... or invoke the HTTP API directly."` Forward-compatibility: extending stdio is a follow-up tracked in the Appendix; it requires a session-init handshake that captures the agent identity and forwards it on every internal call.

#### 4. Typecheck as upsert precondition
**File**: `src/be/scripts/typecheck.ts` (new)

Function `typecheckScript(source: string) -> { ok: true } | { ok: false, diagnostics: string[] }`:

- Construct a virtual `ts.createProgram` with two files: the user's source as `user-script.ts`, and the generated `swarm-sdk.d.ts` + `stdlib.d.ts` (from Phase 4 §3) as the SDK contract. Use a custom `CompilerHost` that resolves these in-memory rather than from disk.
- Set `strict: true`, `target: 'ES2022'`, `module: 'ESNext'`, `moduleResolution: 'bundler'`. Match the repo's `tsconfig.json` where reasonable.
- Run `program.getSyntacticDiagnostics()` + `getSemanticDiagnostics()`. If non-empty, format with `ts.formatDiagnosticsWithColorAndContext` and return as `diagnostics`.

**Where it's called:**
- `POST /api/scripts/upsert` — always, before writing the row. Failure → 400 with `{ error: 'typecheck_failed', diagnostics: [...] }`.
- `POST /api/scripts/run` with inline `source` — **skipped** for the hot path. Auto-saved scratches inherit `typeChecked = 0`. Authors find out at runtime if the script crashes; that's the trade-off.
- Promotion (scratch → explicit upsert) — typecheck runs, scratches that fail are blocked from promotion.

**Cost budget:** ~500ms-2s per upsert. Explicit upserts are infrequent author moves, not the hot path. Documented in the route description.

**Schema dependency:** the `scripts.typeChecked` column (added in Phase 1 SQL) is set to 1 by `script_upsert` on success, 0 by inline `script_run` auto-save.

#### 5. Secret scrubbing on responses — **add `scrubObject` overload**
**File**: `src/utils/secret-scrubber.ts`
**Changes**: Add a typed object overload alongside the existing `scrubSecrets(text)`:

```ts
export function scrubObject<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubSecrets(value) as T;
  if (typeof value !== 'object') return value;
  // walk arrays + plain objects in-place-equivalent; recurse via JSON shape
  if (Array.isArray(value)) return value.map(scrubObject) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubObject(v);
  }
  return out as T;
}
```

Walks the tree once (single pass; no `JSON.stringify`/`JSON.parse` double round-trip), preserves types, scrubs every string leaf via the existing single-string `scrubSecrets`. Matches the perf budget for `/api/scripts/run` returning large result payloads.

**File**: `src/http/scripts.ts`
**Changes**: Apply `scrubObject` to the JSON body returned by `/api/scripts/run` (since script result might contain echoed env values). Other routes don't need scrubbing — they only return script metadata. Add a unit test in `src/tests/secret-scrubber.test.ts` covering the new overload: nested objects, arrays of strings, mixed types, null/undefined leaves, circular references (must not infinite-loop — if circular handling is non-trivial, document as "non-circular only" since JSON-serializable script results can't contain cycles).

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] OpenAPI freshness: `bun run docs:openapi` produces no diff after running it again (idempotent)
- [x] OpenAPI committed: `openapi.json` shows the 5 new operationIds (`scripts_upsert`, `scripts_run`, `scripts_search`, `scripts_delete`, `scripts_types`)
- [x] HTTP smoke tests pass: `bun test src/tests/scripts-http.test.ts`:
  - [x] `upsert` round-trips body, sets `version: 1` on first write, `version: 2` on body change
  - [x] `upsert` with source that has TS errors returns 400 + `{ error: 'typecheck_failed', diagnostics: [...] }`; row is NOT written
  - [x] `upsert` with `script_run`-style inline source that uses `ctx.swarm.<unknown_tool>` fails typecheck
  - [x] `run` with inline `source` that has TS errors STILL runs (no typecheck) — assert via a fixture with a deliberate type error
  - [x] Promotion path: upserting an existing `isScratch=1` row that fails typecheck returns 400 and does NOT clear the scratch flag
  - [x] `upsert` with `scope: 'global'` from a non-lead returns 403
  - [x] `upsert` with `scope: 'global'` from a lead returns 200 AND writes an `events` row with `type='script.global_upsert'` (assert via direct DB query)
  - [x] `upsert` that promotes an existing `scope='agent'` row to `scope='global'` writes an `events` row with `isPromotion=true`
  - [x] `run` with `name` reads from DB, executes, returns result
  - [x] `run` with `source` (inline) auto-saves a scratch row on success
  - [x] `run` with `source` that throws does NOT auto-save
  - [x] `delete` returns `{ deleted: true }` and removes the row + cascades versions
  - [x] `search` returns substring matches by name (embeddings come in Phase 5)
  - [x] `types` returns the expected stdlib + SDK type blob

#### Automated QA:
- [x] Curl walkthrough script `scripts/scripts-api-smoke.sh` (new): start `bun run start:http`, then upsert / search / run / delete the same script and assert each shell exit code is 0. Run via `bash scripts/scripts-api-smoke.sh`.

#### Manual Verification:
- [x] Open `openapi.json`, eyeball the 5 new operations are present with correct request/response schemas
- [x] Confirm `docs-site/content/docs/api-reference/**` regenerates without unexpected churn

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
- Reads the caller's agent ID via `getRequestInfo(req).agentId` from `src/tools/utils.ts:24-46`. If the agent ID is absent (stdio MCP transport), the tool short-circuits with the error described in Phase 3 § 3 — does not call the HTTP API.
- Forwards `Authorization: Bearer ${apiKey}` + `X-Agent-ID: ${agentId}` headers when calling the internal HTTP API.

**Tool descriptions — disambiguation from `code-mode`** (load-bearing for agent discovery; both surfaces coexist in the same MCP listing):

| Tool | Description (use verbatim) |
|---|---|
| `script_search` | "Semantic search over **swarm-shared** TypeScript scripts (catalog persisted in the agent-swarm DB; callable from agents and workflows). For ephemeral throwaway TS on your local machine, use code-mode instead." |
| `script_run` | "Run a named swarm-shared script (callable across agents and from workflow `swarm-script` nodes), OR inline source (auto-saved as scratch to the catalog). Use for swarm-visible, durable scripts. For local-only throwaway TS, use code-mode `run`." |
| `script_upsert` | "Persist a TypeScript script to the swarm catalog under your agent scope (or global if you're a lead). Other agents and workflow nodes will be able to find and run it. For local-only scripts, use code-mode `save`." |
| `script_delete` | "Remove a swarm-shared script from the catalog. Versions table preserves history." |
| `script_query_types` | "Fetch the signature + the auto-generated `swarm-sdk.d.ts` (derived from the live MCP tool registry) + the `stdlib.d.ts` blobs — for IDE-style introspection before authoring or running a script. The same types are used by `script_upsert`'s typecheck pass, so they are authoritative." |

Pattern: every description leads with **"swarm-shared"** / **"swarm catalog"** to disambiguate from code-mode (whose tools describe local-FS scratch). Agents reading both descriptions should be able to pick the right surface without operator intervention.

#### 2. Server-side registration
**File**: `src/server.ts`
**Changes**: Inside `createServer()` (lines 165-249), add 5 new `registerScriptXxxTool(server)` calls alongside the existing tool registrations. The `McpServer` instance is created at `src/server.ts:151`.

#### 3. Bundle script types from the MCP tool registry
**File**: `scripts/bundle-script-types.ts` (new)

Build-time generator that emits two `.d.ts` blobs returned by `script_query_types`:

**`swarm-sdk.d.ts`** — derived from the MCP tool registry:
1. Boot a `createServer()` instance (or import the registry directly without full MCP wiring).
2. For each registered tool whose `name` is in the curated allowlist (`src/scripts-runtime/sdk-allowlist.ts`):
   - Pull `inputSchema` (Zod) and `outputSchema` (Zod) from the tool metadata.
   - Convert each Zod schema to TS via `zod-to-ts` (already used elsewhere in the repo if applicable; otherwise vendor a small Zod → TS shim — Zod has stable schema introspection APIs).
3. Emit a `SwarmSdk` interface where each property is `(args: InputType) => Promise<OutputType>`, plus a `SwarmConfig` type re-export.

**`stdlib.d.ts`** — hand-curated, mirrors the `src/scripts-runtime/stdlib/*.ts` exports plus the `Redacted` interface.

Runs on every `bun run build:script-types` (added to package.json) and as a CI step. The bundled blobs land at `src/scripts-runtime/types/swarm-sdk.d.ts` / `stdlib.d.ts` and are committed (small, useful diff signal).

**File**: `src/scripts-runtime/sdk-allowlist.ts` (new)
Single exported `export const SDK_ALLOWLIST: string[]`. v1 contents (~25 tools): `memory_search`, `memory_list`, `memory_get`, `memory_rate`, `memory_create`, `task_list`, `task_get`, `task_storeProgress`, `event_create`, `event_list`, `event_batch`, `event_counts`, `kv_get`, `kv_set`, `kv_del`, `kv_incr`, `kv_list`, `agent_list`, `agent_get`, `repo_list`, `repo_get`, `schedule_list`, `schedule_get`, `script_search`, `script_run`. Lifecycle / cred / privileged tools are excluded.

#### 4. CLAUDE.md addition
**File**: `CLAUDE.md`
**Changes**: Add a new `<important if="you are modifying scripts-runtime code">` block:

```markdown
<important if="you are modifying scripts-runtime code (src/scripts-runtime/*, src/be/scripts/*, src/tools/script-*.ts, src/http/scripts.ts)">

Architecture: API server owns the `scripts` + `script_versions` tables. Workers + the runtime invoke via HTTP. The runtime evaluates user-supplied TS in a `Bun.spawn` subprocess wrapped in `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, 30s AbortController, 1 MB stdout cap.

Config injection: agent identity + bearer + mcpBaseUrl flow as a JSON `SwarmConfigPayload` over the subprocess **stdin** — NOT env vars. Bearer is wrapped in `Redacted<string>` inside the script; user code never unwraps. `process.env` carries only Node/Bun defaults. Loader reads the bearer via `getApiKey()` from `src/utils/api-key.ts` (never raw env).

FS modes: `'none'` = per-run tmpdir (v1 only); `'workspace-rw'` returns 501 in v1 (worker dispatch is v2).

SDK surface: derived from MCP tool registry at build time via `scripts/bundle-script-types.ts`. Curated allowlist in `src/scripts-runtime/sdk-allowlist.ts`.

Typecheck: `script_upsert` runs `tsc --noEmit` against the generated `.d.ts`; rejects on diagnostics. Inline `script_run` skips typecheck (scratch hot path).

Boundaries: `src/scripts-runtime/` is on both `check-db-boundary.sh` (no `src/be/db` imports) and `check-api-key-boundary.sh` (must use `getApiKey()`) allowlists.

Tests: `bun test src/tests/scripts-*.test.ts`. Sandbox + timeout + abort + stdin-config + env-hygiene paths are the highest-risk surfaces — keep coverage tight.

</important>
```

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check`
- [x] MCP docs regenerated: `bun run docs:mcp` (regenerates `MCP.md`); commit the diff alongside this phase
- [x] MCP tool registration test passes: `bun test src/tests/mcp-tools.test.ts -t "script_"` verifies all 5 tools appear in the MCP listing with correct schemas
- [x] HTTP→MCP integration test passes: `bun test src/tests/scripts-mcp-e2e.test.ts` exercises `script_upsert → script_search → script_run → script_delete` end-to-end against the in-process server
- [x] **Type bundler regenerates clean**: `bun run build:script-types` produces no diff after running it again (idempotent); commit the generated `src/scripts-runtime/types/swarm-sdk.d.ts` + `stdlib.d.ts`
- [x] **SDK allowlist is enforced**: `bun test src/tests/sdk-allowlist.test.ts` verifies (a) every tool in `SDK_ALLOWLIST` exists in the live MCP registry (no dangling names), (b) calling a non-allowlisted tool name through the runtime proxy throws with the expected diagnostic, (c) the bundled `swarm-sdk.d.ts` exposes only allowlisted tools
- [x] **Typed SDK roundtrip**: a fixture script `import { SwarmSdk } from 'swarm-sdk'; export default async (args, ctx) => ctx.swarm.memory_search({ query: 'foo' });` passes `script_upsert` typecheck, runs successfully, and returns a typed result. Modifying it to `ctx.swarm.memory_search({ query: 123 })` (wrong arg type) fails typecheck on upsert.

#### Automated QA:
- [x] Stdio MCP smoke: a script under `scripts/scripts-mcp-stdio-smoke.ts` opens a stdio MCP client, lists tools, asserts the 5 new tools are present with the documented descriptions. Run via `bun run scripts/scripts-mcp-stdio-smoke.ts`.

#### Manual Verification:
- [ ] In a real Claude Code session against a local swarm worker, observe the agent can call `script_search` from the MCP tool surface (visible in tool-call logs)

**Implementation Note**: After this phase, **agents can author and run scripts**. This is the v1 minimum-viable feature. Phases 5-6 are enhancements. If commit-per-phase, commit: `feat(scripts): MCP tool surface`. **Recommended pause point** — manually exercise the feature for a day before continuing.

---

## Phase 5: Embeddings — semantic `script_search`

### Overview

Replace Phase 3's name-substring search with embedding-based semantic search. Reuse `src/be/embedding.ts` provider plumbing. Embed `description + intent + signature` on every upsert. Hybrid ranking (embedding cosine + name/keyword boost).

### Changes Required:

#### 1. Migration: embeddings storage
**File**: `src/be/migrations/065_script_embeddings.sql`
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
**Changes**: After `upsertScriptByName` writes the row, **skip embedding entirely when `isScratch = 1`** (auto-saves from inline `script_run` — keeping the hot path free of OpenAI latency, which would otherwise add ~200-500ms per inline run). For explicit upserts (`isScratch = 0`), if `contentHash` OR `description` OR `intent` OR `signatureJson` changed, embed **synchronously** before returning to the caller. Reason: explicit upserts are infrequent (an agent promoting a scratch, or an operator authoring); the latency is acceptable and search results are immediately consistent. Bulk re-embed (`scripts reembed` CLI) handles model rotations and any scratches promoted later. Document the trade-off in the function header: "Scratch saves skip embedding; they become searchable only after explicit promotion via upsert OR after a `scripts reembed` pass."

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
- [x] Lint + type check pass
- [x] Migration applies cleanly on fresh + existing DB
- [x] Unit tests pass: `bun test src/tests/scripts-embeddings.test.ts`:
  - [x] Embed on explicit upsert (`isScratch=0`): new row has `script_embeddings` entry
  - [x] **No embed on scratch upsert (`isScratch=1`)**: row exists, `script_embeddings` row is absent — covered by an explicit assertion
  - [x] Re-embed on body change (different `contentHash`) for explicit rows
  - [x] Re-embed when description changes but body unchanged for explicit rows
  - [x] No re-embed when nothing tracked changes
  - [x] `scripts reembed` CLI backfills scratches that were later promoted (`isScratch` flipped from 1 → 0)
  - [x] Search returns semantically similar scripts above name-substring-only matches (use 3 known-similar fixture scripts)
  - [x] Hybrid ranking: exact name match outranks weaker semantic match for `query == name`

#### Automated QA:
- [x] `bun test src/tests/scripts-embeddings.test.ts -t "semantic recall"` seeds 10 fixture scripts with deliberately overlapping intents, runs 5 natural-language queries, asserts top-3 recall matches the expected ranking. Threshold: 4/5 queries hit expected top-1.

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

**v1: run server-side only.** The executor rejects `fsMode: 'workspace-rw'` at config-validation time (return a clear workflow error: "swarm-script: fsMode 'workspace-rw' is v2 only; use 'none' or omit"). All v1 invocations spawn on the API server with `fsMode: 'none'`. The async worker-dispatch pattern (mirror `src/workflows/executors/agent-task.ts:100-108` → `{ status: "success", async: true, waitFor: "task.completed", correlationId: task.id }`) is documented as the v2 path in the Appendix follow-ups but not built. Reason: shipping v1 without dispatch keeps Phase 6 small (1 executor file + registry edit) and unblocks the storage / runtime / HTTP / MCP / embeddings phases, which deliver the bulk of the value.

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
- [x] Lint + type check pass
- [x] Unit tests pass: `bun test src/tests/workflow-swarm-script.test.ts`:
  - [x] A workflow with one `swarm-script` node resolves by name + runs + returns result
  - [x] `pinHash` correctly resolves to a historic `script_versions` row
  - [x] `inputs` mapping from a predecessor node correctly populates `args`
  - [x] `fsMode: 'workspace-rw'` is rejected at config validation with a clear error message; `fsMode: 'none'` runs server-side
  - [x] Failure in the script surfaces as a workflow-node failure (matches existing `script` node failure shape)
- [x] E2E test passes: `bun test src/tests/workflow-e2e.test.ts -t "swarm-script"` — full workflow run with the engine

#### Automated QA:
- [x] `bun test src/tests/workflow-e2e.test.ts -t "swarm-script + agent-task interleave"` runs a 3-node workflow `swarm-script → agent-task → swarm-script` end-to-end against a stub agent provider, asserts all three nodes complete and outputs chain correctly

#### Manual Verification:
- [ ] Open the workflow UI (`ui/`, port 5274), confirm `swarm-script` shows up as a node type in the palette; create a workflow with one `swarm-script` node referencing a real script; run it from the UI; eyeball the output

**Implementation Note**: After this phase, commit: `feat(scripts): swarm-script workflow node`.

### QA Spec (optional):

The cross-cutting QA at the **end of Phase 6** warrants a dedicated QA report — agent invocation + workflow node + embeddings together is broad enough that a single doc collecting screenshots, sample script bodies, and observed agent token-savings deserves a place to live.

**QA Doc**: `thoughts/taras/qa/YYYY-MM-DD-reusable-scripts-runtime.md` (generate via `desplega:qa` after Phase 6; use the actual implementation date).

---

## Appendix

### Follow-up plans

- **v2 remote-sandbox executors (E2B, Modal, Daytona, fly-machines)**: implement `ScriptExecutor` in `src/scripts-runtime/executors/<provider>.ts`, add a registry entry, ship a Dockerfile that includes Bun in the sandbox image (E2B / Modal / Daytona all support custom images). No `loader.ts` / `swarm-sdk.ts` / `redacted.ts` changes — the conformance test suite is the contract. Likely first target: **E2B** (clean HTTP API, custom image support, ~100ms cold-start, transparent network policy). Each adapter is a separate small plan; the abstraction is the unblock.
- **v2 sandbox hardening (separate plan)**: revisit just-bash *if* PR #169 merges upstream; alternatives: `isolated-vm`, Deno `--allow-*`, container-per-script. The remote-sandbox executors above ARE the container-per-script path on a managed substrate — pursuing both in parallel makes sense (`isolated-vm` is for self-hosted swarms that don't want a remote dependency). Track in `thoughts/taras/research/2026-05-15-just-bash-integration-shape.md`.
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
  - `src/artifact-sdk/browser-sdk.ts:9-19` — `BROWSER_SDK_JS` 8-domain shape (was the v0 mirror plan; v1 supersedes this with MCP-registry derivation, but the auth-injection pattern at `src/artifact-sdk/server.ts:42-69` remains relevant for the SDK proxy)
  - `src/workflows/executors/script.ts:1-128` — existing inline `script` executor (collision; choose `swarm-script` for the new node)
  - `src/be/embedding.ts` + `src/be/memory/providers/openai-embedding.ts:11` — embedding pipeline to reuse
  - `src/utils/secret-scrubber.ts` — egress hygiene (apply to script result + embedding text)
  - `scripts/check-db-boundary.sh` — DB-ownership invariant (enforces API-only DB writes)
- External:
  - `https://github.com/desplega-ai/code-mode` — reference patterns (separate package, separate storage)
  - `https://bun.com/docs/api/spawn` — `Bun.spawn` reference
  - `https://bun.com/docs/api/glob` — `Bun.Glob` reference

---

## Review Errata

_Reviewed: 2026-05-18 by Claude (Critical autonomy). Updated: 2026-05-18 — all Critical + Important items resolved in-plan; this section preserved as an audit trail._

### Resolved — Critical

- [x] **SQL UNIQUE for global scripts.** Replaced inline `UNIQUE(name, scope, scopeId)` with `CREATE UNIQUE INDEX idx_scripts_name_scope ON scripts(name, scope, COALESCE(scopeId, ''))` in Phase 1 § 1. Manual-verification step updated to assert the index shape directly.
- [x] **`/api/scripts/run` workspace-rw incoherence.** `workspace-rw` lifted out of v1 entirely. "What We're NOT Doing" now states v1 ships `fsMode: 'none'` only; the column + CHECK accept `'workspace-rw'` for forward compatibility but the HTTP route rejects it with `501 Not Implemented`. Phase 3 § 1 documents the rejection in the operationId description.
- [x] **Eval mechanism committed.** Phase 2 § 4 now commits to tmpfile + dynamic `import()` (write source verbatim, no rewriting, dynamic-import the tmpfile path). Rejected alternatives (`new AsyncFunction`, `data:text/typescript;base64,${btoa(...)}`, `bun -e`) enumerated with reasons. Manual stack-trace inspection elevated from "v2 cleanup" to "blocker if it fails".
- [x] **Phase 6 workspace-rw deferred cleanly.** Phase 6 § 1 commits to "v1: run server-side only, executor rejects `fsMode: 'workspace-rw'` at config-validation time". Async worker-dispatch pattern documented as v2 in the Appendix. Success criteria rewritten to assert rejection (not aspirational dispatch).

### Resolved — Important

- [x] **`X-Agent-ID` on stdio MCP.** Phase 3 § 3 documents the v1 limitation: scripts API is HTTP-MCP-only; stdio agents get a clear error from the tool handler. Phase 4 § 1 mirrors this — tool handlers short-circuit on missing agentId rather than calling the HTTP API.
- [x] **`code-mode` vs `script_*` disambiguation.** Phase 4 § 1 now prescribes verbatim tool descriptions for all 5 `script_*` tools, leading with **"swarm-shared"** / **"swarm catalog"** to make the agent-discovery choice obvious against code-mode's local-FS scratch surface.
- [x] **Embedding on hot path.** Phase 5 § 3 commits to "skip embedding when `isScratch=1`; embed sync only on explicit upserts". `scripts reembed` CLI handles promoted scratches. Success criteria expanded to assert the skip explicitly.
- [x] **Signature extraction.** Phase 2 § 5 replaced the regex stub with real TS-AST extraction via the existing `typescript` dep — `ts.createSourceFile` + `node.getText()` on `TypeNode`s + JSDoc for description, with documented fallback to `{ argsType: 'unknown', resultType: 'unknown' }` on parse error. New test file scoped (destructuring, generics, multi-line returns, function-keyword, no `export default`, syntax errors).
- [x] **Audit log for `agent → global` promotion.** Phase 3 § 3 now requires emitting an `events` row of type `script.global_upsert` on every global upsert, with `isPromotion=true` flag when the prior row was `scope='agent'`. Uses the existing `events` table — no new schema. Success criteria asserts the row via direct DB query.
- [x] **Scrubber `scrubObject` overload.** Phase 3 § 4 promotes the "object overload" from a deferred nice-to-have to an in-scope Phase 3 task: adds typed `scrubObject<T>(value: T): T` to `src/utils/secret-scrubber.ts`, single-pass tree walk (no JSON round-trip), with a unit test covering the new overload. Phase 2 § 3 (ctx swarm-sdk) updated to call `scrubObject` instead of the round-trip pattern.
- [x] **`scripts/check-db-boundary.sh` allowlist shape.** Verified: the script has a `WORKER_PATHS` bash array at lines 18-26 (7 current entries). Phase 2 § 6 updated to "append to the `WORKER_PATHS` bash array" — single-line edit confirmed.

### Resolved — Minor (auto-applied initially)

- [x] `last_updated: 2026-05-16` → `2026-05-18` (stale by 2 days).
- [x] Migration numbers bumped: `063_scripts.sql` → `064_scripts.sql`, `064_script_embeddings.sql` → `065_script_embeddings.sql`. Reason: `063_cost_context_schema_relax.sql` landed in #491 on 2026-05-17, after the plan was drafted.

---

## Round 2 — Architectural updates (2026-05-18)

After the Radical Candor exchange + iteration on isolation, the plan absorbed five additional architectural decisions. All landed in-plan; this section is the audit trail.

### Applied — v1.5 hardening (folded into Phase 2)

- [x] **Tightened `ulimit`**: added `-u 32` (fork-bomb guard), `-f 65536` (max file size), `-n 64` (max FDs). Phase 2 §2.
- [x] **Env stripping to explicit allowlist**: subprocess `env` is now `{ PATH, HOME, LANG, LC_ALL, TMPDIR, SWARM_SCRIPT_* }` only. No swarm-owned values, no host env spread. Phase 2 §2 + Success Criteria. `process.env.AGENT_SWARM_API_KEY === undefined` is now an asserted invariant.
- [x] **AST pre-flight import allowlist**: new `src/scripts-runtime/import-allowlist.ts` rejects `import` / dynamic `import()` outside `./*`, `swarm-sdk`, `stdlib`. Defense-in-depth, documented as bypassable via `eval`. Phase 2 §6.

### Applied — `Redacted<T>` + `SwarmConfig` over stdin

- [x] **`Redacted<T>` abstraction** with metadata baked into the WeakMap registry (`{ type: 'system' | 'user', isSecret: boolean }`). `toString` / `toJSON` / `util.inspect.custom` return `<redacted>`. Phase 2 §3. Exposed as `ctx.stdlib.Redacted`.
- [x] **`SwarmConfig` class** with typed system-value getters (`apiKey`, `agentId`, `mcpBaseUrl`) + generic `get(key)` for user-set. All values return `Redacted<string>`. Phase 2 §4. Exposed as `ctx.swarm.config`.
- [x] **Config delivered over stdin, not env**. `loader.ts` assembles a `SwarmConfigPayload` JSON blob and pipes it to the subprocess stdin; the eval-harness reads it on boot and hydrates `SwarmConfig`. Phase 2 §2 + §2a + §7. Net effect: the v2-deferred "non-env channel" hardening is **now in v1**.

### Applied — Typed SDK from MCP registry + typecheck on upsert

- [x] **SDK derived from MCP tool registry at build time**. `scripts/bundle-script-types.ts` (Phase 4 §3) reads each registered tool's Zod schemas and emits `swarm-sdk.d.ts`. Curated allowlist (~25 tools) in `src/scripts-runtime/sdk-allowlist.ts` excludes lifecycle / cred tools.
- [x] **`script_upsert` runs `tsc --noEmit`** against the generated `.d.ts`; rejects on diagnostics. Phase 3 §4. Inline `script_run` (scratches) skips typecheck for hot-path speed; promotion (scratch → upsert) requires passing typecheck. New `scripts.typeChecked` column added to Phase 1 SQL.
- [x] **MCP-proxy implementation**. `swarm-sdk.ts` (Phase 2 §5) is a thin proxy that dispatches `ctx.swarm.<tool>(args)` to `${mcpBaseUrl}/api/mcp/tools/<tool>/call` with `Redacted.value()`-unwrapped headers. `scrubObject` applied on responses. Phase 4 §1 tool-description for `script_query_types` updated to reflect MCP-derived authority.

### Applied — `getApiKey()` + `AGENT_SWARM_API_KEY` precedence

- [x] **Loader uses `getApiKey()`** from `src/utils/api-key.ts` (precedence `AGENT_SWARM_API_KEY > API_KEY`) per the recent CLAUDE.md addition. Raw `process.env.*` reads inside `src/scripts-runtime/` would trip the new `scripts/check-api-key-boundary.sh`.
- [x] **`src/scripts-runtime/` added to both boundary-check allowlists**: `check-db-boundary.sh` (existing) AND `check-api-key-boundary.sh` (new). Phase 2 §8. New CI test in Phase 2 Success Criteria.

### Not applied — explicit non-decisions

- [ ] **Network egress allowlist** — still v2 (Phase 1.5 medium-cost item). Wrapping `ctx.stdlib.fetch` is meaningful but bypassable from user code via raw `fetch`; deferred until real abuse signals appear. **Note:** the executor abstraction (Round 3) carries a forward-compatible `network: 'open' | { allowlist: string[] }` field, so when this lands, only the executor implementation needs to honor it — the policy plumbing is already in place.
- [ ] **Real isolation (Deno/isolated-vm/container-per-script)** — still v2 (Phase 1.5 high-cost item). Now strictly the **self-hosted** path; remote sandboxes (E2B/Modal) are tracked separately as Round 3 v2 adapters.

---

## Round 3 — Executor pluggability (2026-05-18)

After the architectural Round 2 landed, one more concern surfaced: should we be able to swap script execution providers (E2B / Modal / Daytona / fly-machines / etc.) later without a refactor? **Yes — folded into v1 as an abstraction boundary.** Native is the v1 implementation; v2 adapters are new files + a registry entry.

### Applied

- [x] **`ScriptExecutor` interface** introduced as the abstraction boundary. `ExecutorInput` (semantic — `memoryMb`, `cpuTimeSec`, `wallClockMs`, `maxStdoutBytes`, `fsMode`, `network`) and `ExecutorOutput` (`result`, `stdout`/`stderr` with `truncated` flags, `durationMs`, `exitCode`, typed `error` union) carry **no Unix primitives** — `ulimit` flags, subprocess pipes, tmpdirs, env allowlists are NativeScriptExecutor-internal. Phase 2 §2.
- [x] **`src/scripts-runtime/executors/` directory** holds `types.ts` (interface), `registry.ts` (`getScriptExecutor()` reads `SCRIPT_EXECUTOR` env), `native.ts` (v1 implementation). Phase 2 §1 file list restructured.
- [x] **`loader.ts` is executor-agnostic.** Orchestrates config assembly + import-allowlist pre-flight + egress scrubbing; calls `executor.run(input)`. Knows nothing about `Bun.spawn`.
- [x] **Conformance test suite as the contract.** `src/tests/script-executor-conformance.test.ts` runs the same scenarios against `NativeScriptExecutor` AND a `FakeScriptExecutor` (in-process stub for unit testing). Adding `E2BScriptExecutor` later means extending this suite, not refactoring it. Phase 2 Success Criteria.
- [x] **`network` policy field** baked into `ExecutorInput` from day one (`'open' | { allowlist: string[] }`). v1 is `'open'`; when network-egress hardening lands, only the executor implementation honors it — the policy plumbing is pre-built.
- [x] **Appendix follow-ups** updated to name E2B / Modal / Daytona / fly-machines as concrete v2 adapter targets, with E2B as the likely first.

### Not applied

- [ ] **No streaming output** in the interface (`stdout` / `stderr` are batched). v1 caps at 30s wall-clock and 1MB stdout — batching is fine. If long-running scripts become a need, add `stdoutStream` / `stderrStream` to `ExecutorOutput` as an opt-in alongside the batched fields. Not a refactor — additive.
- [ ] **No per-script executor selection** (e.g. `swarm-script` workflow node specifying `executor: 'e2b'`). v1 is one executor per process via env var. Per-script routing is a v3 nice-to-have if needed; the registry already supports lookup by name.

---
date: 2026-05-15T00:00:00-03:00
author: Taras
topic: "Reusable scripts / code-mode for agent-swarm agents"
tags: [brainstorm, code-mode, scripts, agent-efficiency, cost-reduction]
status: synthesis-complete
exploration_type: idea (confirmed: shape code-mode-style scripts into something buildable for agent-swarm)
last_updated: 2026-05-15
last_updated_by: Taras
---

# Reusable scripts / code-mode for agent-swarm agents — Brainstorm

## Context

Taras wants a "scripts concept" for agent-swarm: reusable code that agents can run to
shortcut tasks, making them faster and cheaper. Related to the code-mode idea and
specifically to https://github.com/desplega-ai/code-mode.

**Existing reference (code-mode):**
- TS scripts with typed stdlib helpers (`fetch`, `grep`, `glob`, `fuzzy-match`, `table`,
  `filter`, `flatten`).
- MCP tools: `run` (inline/named), `save`, `search`, `query_types`, `list_sdks`.
- Successful inline runs auto-persist to `.code-mode/scripts/auto/<slug>.ts` driven by
  the `intent` field. Hand-curated scripts go under `.code-mode/scripts/<name>.ts`.
- Idea: agents reuse scripts instead of repeatedly burning tokens re-deriving the same
  multi-step transform.

**Initial framing for agent-swarm:**
- Workers are containerized (Docker), spawned per task, often disposable.
- API server owns SQLite; workers talk HTTP. Scripts would likely live worker-side but
  the registry/discovery may need to be server-side (so multiple workers can share).
- We already have skills, prompts, workflow nodes. Need to clarify how "scripts" differ
  from those, and where they slot in.

## Exploration

### Q: Who writes these scripts?

**Answer:** Build a tool for it, let the agent control invocation (code-mode style). Also: scripts should be usable inside workflows.

**Insights:**
- Authoring is agent-driven, not human-curated upfront. Implies an auto-save + dedup loop similar to code-mode's `.code-mode/scripts/auto/<slug>.ts`.
- Cross-cutting requirement: scripts are a **first-class primitive** that bridges two execution contexts — ad-hoc agent invocation AND deterministic workflow DAG nodes.
- A "script node" in a workflow would be a non-LLM, deterministic step. That's a new node type alongside agent-task / structured-output / etc.
- This means scripts need: stable signatures (typed inputs/outputs), versioning (workflows reference by ID/version), and a runtime that workers AND the API/workflow engine can both invoke.

### Q: Where do scripts execute?

**Answer:** Worker or wherever — build a shared **package** that runs in both worker and API. Reference: `vercel-labs/just-bash` executor-tools (`examples/executor-tools/README.md`).

**Insights:**
- just-bash's pattern: tools defined inline OR auto-discovered from SDK schemas, invokable from a sandboxed `js-exec` environment, agent calls `tools.<ns>.<name>(args)`. Same surface auto-exposed as bash commands too. Multi-turn agent loop with a virtual filesystem for intermediate results.
- For agent-swarm: a single npm package (`@swarm/scripts-runtime` or similar) provides:
  - Typed `swarm.*` SDK (mirror of `BROWSER_SDK_JS` domain modules: `tasks`, `agents`, `memory`, `kv`, `events`, `repos`, `schedules`, `approvalRequests`).
  - Stdlib helpers (`fetch`, `grep`, `glob`, `table`, `filter`, `fuzzy-match`, `flatten`).
  - A loader: given script ID + args, fetch source from registry, eval in sandboxed Bun process, return typed result.
  - Auth injection: runtime fills in `API_KEY` + `X-Agent-ID` so script bodies never see secrets.
- Same package runs server-side (for pure scripts / workflow nodes) and worker-side (for FS-touching scripts). One execution model, two host environments.
- Dual surface: scripts callable from agent JS AND as workflow nodes AND potentially as CLI commands. Maps to the just-bash "tools + bash commands" pattern.

### Q: What kind of work would these scripts actually do?

**Answer:** All four — pure transforms, API/integration calls, repo/FS operations, orchestration shortcuts. AND align with the existing **Swarm Pages SDK** idea (`src/artifact-sdk/browser-sdk.ts`, `BROWSER_SDK_JS`).

**Insights:**
- The Pages SDK is already a domain-grouped, auth-handled-by-runtime surface for `tasks` / `agents` / `events` / `memory` / `repos` / `schedules` / `approvalRequests` / `kv`. It routes through a `/@swarm/api/*` proxy that injects credentials server-side, so the page never touches a token.
- Scripts can borrow this exact pattern: a typed `swarm.*` object available in script scope, with auth injected by the runtime (no API key handling in script bodies). This is HUGE for security — scripts can't leak credentials, and we can scope per-script (e.g. read-only memory, write KV only).
- Plus a code-mode-style **stdlib** (`fetch`, `grep`, `glob`, `table`, `filter`, `fuzzy-match`, `flatten`).
- Workload diversity = scripts must straddle two execution contexts: pure (no FS, can run anywhere) and workspace-aware (needs `/workspace`, git, must run in worker container).
- Orchestration scripts blur the line between "script" and "mini-workflow" — need to decide if there's a clean split or if scripts can call other scripts.

### Q: Agent invocation surface?

**Answer:** Option 2 — two generic MCP tools `script_search` + `script_run`. Plus an `upsert` and `delete` tool for managing the catalog.

**Insights:**
- Mirrors code-mode's surface: `search` / `run` / `save` (= upsert) / `delete`. Plus probably `query_types` for stdlib/SDK introspection.
- MCP tool surface stays tiny (4–5 tools) regardless of how many scripts exist. Token cost stays flat.
- One extra round trip per call (search → run) is acceptable. Search results carry signatures + descriptions so the agent picks correctly.
- `upsert` semantics matter: same name = overwrite (versioning?); auto-dedup on identical content; auto-save on successful inline run is a separate question from this explicit upsert tool.
- `delete` enables cleanup for failed experiments. Probably requires confirmation or restricted to recently-created-by-this-agent in non-curated tier.

### Q: Sharing scope?

**Answer:** Global or per-agent, matching how other things (prompts, memory tiers) are scoped today.

**Insights:**
- Two-tier resolution: **global** (everyone sees) + **per-agent-definition** (only that agent sees). No per-repo, no per-task scratch.
- On `script_search`: results = built-in stdlib (global, immutable) ∪ user-promoted global ∪ caller's agent-definition scope.
- On `script_run`: identity comes from the caller; agent X cannot run agent Y's private scripts.
- On `script_upsert`: defaults to caller's agent scope. Explicit `scope: "global"` requires either a promote step or a privileged caller (admin / agent definition owner).
- Storage: scripts probably get their own table with `agent_definition_id` nullable (NULL = global). Mirrors the existing pattern for prompts and memory.
- No per-repo scope keeps cross-repo agents (Linear triage, Slack bot) clean. Repo-specific helpers fall back to per-agent if you make a "repo-X-agent".

### Q: Script interface shape?

**Answer:** Typed default export — `fn(args, ctx) => result`.

**Insights:**
- Single canonical shape. Args + return type extracted from TS signature → JSON Schema auto-generated for `script_run` validation and workflow `inputs` mapping.
- `ctx` carries the auth-injected `swarm.*` SDK + stdlib + logger. Script body stays pure-feeling.
- No stdout coupling, no multi-export complexity. If an agent needs a toolkit, it just writes N separate scripts (search groups them by namespace/intent).

### Q: Auto-save semantics on successful inline run?

**Answer:** Auto-save to a `scratch` slug, code-mode style.

**Insights:**
- Successful inline `script_run` → persists to scratch with slug derived from `intent`. Content-hash dedup so identical bodies collapse.
- Agent can promote scratch → named with `script_upsert`. Stale scratch entries pruneable.
- Failure does NOT auto-save (prevents catalog rot from broken experiments).
- Auto-save scope = caller's agent (private), never global. Promotion to global is an explicit step (admin or curated path).

### Q: Workflow node execution shape?

**Answer:** Sync function call — script returns inline, output flows via `inputs` mapping into next nodes.

**Insights:**
- Workflow node shape: `{ type: 'script', scriptId, inputs: {...} }`. Engine resolves, runs (server-side for pure scripts; dispatches to a worker for `runtime: workspace` scripts), result merges into the node's output.
- No async/long-running mode in v1. Orchestration scripts that need to wait on a task should be modeled as multi-step workflows (script → agent-task node → script), not as a single long script.
- Keeps scripts conceptually "function calls" — uniform mental model across agent invocation and workflow invocation.
- Determinism benefit Taras flagged: a workflow with N script-nodes between agent-task-nodes runs the deterministic parts without burning LLM tokens.

### Q: Discovery — semantic (embeddings) over keyword fuzzy?

**Answer (proposal from Taras):** Embed scripts so `script_search` is semantic, not just keyword fuzzy.

**Insights:**
- Agent-swarm already has an embedding pipeline (`src/be/embedding.ts` for the memory system). Scripts can reuse it — same provider, same vector store, same scrubbing rules.
- `script_search` query is naturally a natural-language description of what the agent wants ("parse Linear issue JSON into a flat row", "fetch GitHub PR comments and group by author"). Keyword search misses synonyms; embeddings nail this.
- Embedding budget: scripts are smaller and far fewer than memories, so cost is negligible. Re-embed only on upsert.
- Open question (need to confirm): what gets embedded? Three candidates:
  - **(a)** Just the description + intent (cheap, semantic, but ignores body).
  - **(b)** Description + intent + TS signature (the function shape) — best signal for "what does this do" without bloating with implementation details.
  - **(c)** Full source — captures rare cases where body reveals purpose but adds noise.
- Hybrid ranking option: embeddings for recall, exact-name/keyword as a boost — likely the right pragmatic combo.

### Q: What gets embedded?

**Answer:** Description + intent + TS signature.

**Insights:**
- Three-part concat into a single vector per script. Re-embed only on upsert (cheap; far fewer scripts than memories).
- Signature inclusion is the differentiator from a pure-prose embed — it disambiguates `parse_issue(input: string) -> Issue` from `parse_issue_comments(issueId: number) -> Comment[]` when descriptions overlap.
- Search query is whatever the agent passes — typically a NL description of what it wants to do, sometimes a hypothetical signature it'd ask for.
- Implementation: reuse `src/be/embedding.ts` provider + chunking; store vector in a new `scripts_embeddings` table or alongside the script row.

## Synthesis

### Key Decisions

1. **Authoring** — Agent-driven via a dedicated MCP tool surface. No upfront human curation; humans optionally promote.
2. **Workload** — Scripts cover all four classes: pure transforms, API/integration calls, repo/FS ops, orchestration shortcuts.
3. **Execution** — Shared TypeScript package runs in both API-server and worker contexts (à la `vercel-labs/just-bash` executor-tools). One execution model, two hosts. Worker for FS-touching scripts, API for pure ones.
4. **Invocation surface (MCP)** — Four (5) generic tools, scaling-flat:
   - `script_search(query)` — semantic search returning signatures + descriptions.
   - `script_run({ name?, source?, args, intent })` — run by name OR inline source; auto-save on success when inline.
   - `script_upsert({ name, source, description, scope })` — explicit save/promote.
   - `script_delete({ name })` — cleanup.
   - `script_query_types(name?)` — introspect SDK/stdlib types.
5. **Sharing scope** — Two tiers: **global** (built-in stdlib + admin-promoted) + **per-agent-definition** (the agent's own saved scripts). No per-repo, no per-task. Mirrors existing prompts/memory scoping.
6. **Script interface** — Typed `export default async (args, ctx) => result`. `ctx` carries `swarm.*` SDK (mirror of `BROWSER_SDK_JS`) + stdlib (`fetch`, `grep`, `glob`, `table`, `filter`, `fuzzy-match`, `flatten`) + logger.
7. **Auth injection** — Runtime injects agent identity into `ctx.swarm`; script bodies never handle API keys. Same trust pattern as the `/@swarm/api/*` proxy used by Pages SDK.
8. **Auto-save** — Successful inline runs persist to a `scratch` slug derived from `intent`. Content-hash dedup. Auto-save scope = caller's agent. Failures do NOT auto-save.
9. **Workflow integration** — Scripts are a first-class **sync node type** in workflow DAGs: `{ type: 'script', scriptId, inputs: {...} }`. Returns inline, output flows into `next` via the existing `inputs` mapping.
10. **Discovery** — Semantic search via embeddings reusing `src/be/embedding.ts`. Embedded payload = `description + intent + TS signature`. Hybrid ranking (embedding recall + name/keyword boost) likely.

### Open Questions

- **Versioning** — Mutable-by-name with content-hash audit log, or immutable + content-addressable with name → head pointer? Workflows referencing scripts may need pin-by-hash for stability.
- **Trust model & resource limits** — Default sandbox: per-script timeout, memory cap, network egress policy. Do scripts inherit the full agent permission set, or declare a permissions manifest (`requires: ['memory.write', 'kv.read']`)? v1 likely "inherit" for simplicity, future hardening with manifests.
- **Promotion to global** — Who can promote a scratch script to `scope: global`? Admin-only? Self-service with a review step? Auto-promote on N agent-X invocations?
- **Distribution / packaging** — Is the executor a standalone npm package (`@desplega/swarm-scripts`) or part of `agent-swarm`? Standalone enables external reuse (similar to how `code-mode` lives independently).
- **Stdlib v1 surface** — Which helpers to ship: full `fetch + grep + glob + table + filter + fuzzy-match + flatten` (code-mode set) or a smaller swarm-tailored subset? Plus the full `swarm.*` SDK from `BROWSER_SDK_JS`.
- **Migration path from existing code-mode auto-saves** — If a deployment already uses code-mode plugin, can scripts ingest those?
- **CLI surface (optional)** — Mirror just-bash's "tools as bash commands too" pattern: expose scripts as a CLI subcommand? Useful for humans running the same primitives the agents use.

### Constraints Identified

- **DB ownership invariant** — Script storage + embedding tables live API-server side (`src/be/db.ts`). Workers consume via HTTP through new `/api/scripts/*` routes. Enforced by `scripts/check-db-boundary.sh`.
- **Bun-only runtime** — Use `bun:sqlite` for storage, `Bun.spawn` for sandboxed exec, `Bun.file` for source caching. No Node/npm/pnpm execution paths.
- **Embedding reuse** — Must reuse the existing `src/be/embedding.ts` provider plumbing (incl. secret scrubbing). Do not introduce a second embedding pipeline.
- **Auth proxy pattern** — Script `ctx.swarm.*` must route through an internal proxy that injects bearer + agent-id, mirroring `/@swarm/api/*` for Pages SDK. Scripts never see raw API keys.
- **Secret scrubbing** — Anything scripts log (stdout/stderr, return values surfaced to `session_logs`) MUST pass through `scrubSecrets` at egress.
- **OpenAPI sync** — New `/api/scripts/*` routes must use `route()` factory; regenerate `openapi.json` + `docs-site/.../api-reference/**` in same PR.
- **Workflow node validator subset** — A new `script` node type must integrate with the existing `triggerSchema` JSON-Schema subset (see `runbooks/workflows.md`). No `oneOf`/`anyOf`/`$ref` use in script arg schemas.

### Core Requirements

**MCP tool surface (worker-side, server-backed):**
1. `script_search(query: string, scope?: 'all'|'global'|'mine') -> Array<{ name, signature, description, score }>`
2. `script_run({ name?, source?, args, intent: string }) -> { result, autoSaved?: { slug, reason } }`
3. `script_upsert({ name, source, description, scope?: 'agent'|'global' }) -> { name, version }`
4. `script_delete({ name }) -> { deleted: boolean }`
5. `script_query_types({ name? }) -> { signature, sdkTypes, stdlibTypes }`

**Storage (API-server / SQLite):**
- `scripts` table: `id`, `name`, `agent_definition_id` (nullable = global), `source`, `description`, `intent`, `signature_json`, `content_hash`, `created_by_agent_id`, `created_at`, `updated_at`, `is_scratch` flag.
- `scripts_embeddings` (or column on `scripts`): embedding vector for `description + intent + signature`.
- Migration: `src/be/migrations/NNN_scripts.sql`.

**Runtime package (`@swarm/scripts-runtime` or in-repo):**
- Loader: fetch source, eval in sandboxed Bun process, inject `ctx = { swarm, stdlib, logger }`.
- Runs identically in worker (with `/workspace`) and API server (without).
- Auth injection via internal proxy fetch.
- Timeout + memory cap enforced via Bun's process limits.

**Workflow integration:**
- New `script` node type in workflow DAG schema.
- Engine resolves script, runs in appropriate host (worker for `runtime: workspace` declared scripts; API otherwise), output keyed by node ID for downstream `inputs` mappings.

**Search:**
- Reuse `src/be/embedding.ts` provider. New helpers in `src/be/scripts.ts` API-only, mirroring memory-system structure.
- Hybrid: embedding similarity + name/keyword boost.

**HTTP API (`/api/scripts/*`):**
- `POST /api/scripts/search`, `POST /api/scripts/run`, `POST /api/scripts/upsert`, `DELETE /api/scripts/:name`, `GET /api/scripts/:name/types`. All via `route()` factory. OpenAPI regenerated.

## Next Steps

**Decision (2026-05-15):** Handoff to research. File-review skipped.

Run:

```
/desplega:research

Use thoughts/taras/brainstorms/2026-05-15-agent-reusable-scripts.md as input
context. Audit existing primitives that the scripts feature will plug into:

1. Pages SDK / artifact-sdk
   - src/artifact-sdk/browser-sdk.ts (BROWSER_SDK_JS)
   - src/artifact-sdk/server.ts
   - /@swarm/api/* proxy (cookie -> bearer + agent-id injection)
   - How auth is injected without scripts seeing keys (the pattern we'll mirror)

2. Memory embeddings pipeline
   - src/be/embedding.ts (provider, chunking, secret scrubbing)
   - src/be/memory/* (storage shape, vector index, search)
   - runbooks/memory-system.md
   - What to copy vs reuse for scripts_embeddings

3. Workflow node registration
   - How current node types are registered (agent-task, structured-output, etc.)
   - runbooks/workflows.md, especially "trigger schema" + cross-node inputs
   - Where to slot a new sync `script` node type

4. MCP tool registration
   - src/tools/* (registration, schema, agent-id propagation)
   - How a new tool gets exposed to workers
   - Stdio vs HTTP MCP transports for these new tools

5. DB-boundary invariant + migrations
   - src/be/db.ts (API-only DB access)
   - scripts/check-db-boundary.sh
   - src/be/migrations/ — sample of recent forward-only migration shapes

6. Secret scrubbing egress points
   - src/utils/secret-scrubber.ts (scrubSecrets)
   - runbooks/secret-scrubbing.md
   - Where script stdout/return values would funnel into session_logs

7. Reference projects (read-only, just summarize patterns)
   - https://github.com/desplega-ai/code-mode (tool surface, auto-save slug, intent)
   - https://github.com/vercel-labs/just-bash examples/executor-tools/
     (executor-tools README — same-package-runs-everywhere pattern)

Produce a research doc at thoughts/taras/research/2026-05-15-agent-reusable-scripts.md
with concrete file:line references for each primitive and a "fits/doesn't fit"
note vs the decisions in the brainstorm.
```

After research, handoff to `/desplega:create-plan` to phase the build:
storage → runtime → MCP tools → embeddings → workflow node → CLI (optional).

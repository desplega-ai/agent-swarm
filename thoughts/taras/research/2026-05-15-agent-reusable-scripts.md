---
date: 2026-05-15
researcher: Claude (on behalf of Taras)
git_commit: 79eb5690e2a8a4f9e39f417903cb19265af31d26
branch: main
repository: agent-swarm
topic: Open-question resolution for agent-runnable reusable TypeScript scripts (code-mode for agent-swarm)
tags: [research, scripts, code-mode, runtime, sandbox, versioning, scope, stdlib, embeddings]
status: complete (just-bash rejected 2026-05-15 — see Addendum II)
last_updated: 2026-05-15
---

# Agent-runnable reusable scripts — open question resolution

## Input

- Brainstorm: `thoughts/taras/brainstorms/2026-05-15-agent-reusable-scripts.md` (all
  decisions there are locked; this doc only resolves the **Open Questions** section).
- External references: `desplega-ai/code-mode` (raw GitHub URLs cited inline) and
  `vercel-labs/just-bash` (referenced conceptually via the brainstorm).
- Code grounding: every claim below points at a `file:line` or a URL.

## Surprises the planner needs to know up-front

1. **There is no `agent_definitions` table.** The brainstorm and brainstorm-derived
   "Core Requirements" both speak of `agent_definition_id` as the per-agent
   scope, but the only thing the schema offers today is the `agents` table
   (`src/be/migrations/053_agent_waiting_for_credentials_status.sql:20-50` —
   columns: `id`, `name`, `isLead`, `role`, `provider`, …). The closest reusable
   pattern is **`prompt_templates(scope, scopeId)`** where `scope ∈ {global,
   agent, repo}` and `scopeId` is the agentId (when scope='agent'). See
   `src/be/migrations/014_prompt_templates.sql:5-18`. **Recommendation: adopt
   the same `(scope TEXT, scopeId TEXT NULL)` shape for `scripts` and treat
   "agent definition" as "agents.name" for now (one script-set per role name).
   This is the simplest precedent and the planner should not invent a new
   `agent_definitions` table.**
2. **A `script` workflow node already exists** at
   `src/workflows/executors/script.ts:1-128`, but it is a **runtime: bash | ts
   | python inline string runner** — totally different from the new reusable
   scripts concept. It even shells out to `bun -e <inlineSource>`. The new node
   type for reusable scripts MUST be named distinctly (e.g. `script-ref` or
   `swarm-script`) to avoid colliding, OR the existing `script` executor must
   be promoted to a typed dispatcher. The simpler call is the former: keep the
   inline `script` node, register a new `swarm-script` node that resolves by
   ID. Flagged for `/desplega:create-plan`.
3. **The API server has a single-key auth model.** `src/http/core.ts:241-252`
   gates every non-public route on a global `apiKey === Bearer …` check. There
   is no per-user role concept, no admin separation. The only built-in
   "elevated identity" is the **`agents.isLead = 1`** flag used heavily by the
   memory store (e.g. `src/be/memory/providers/sqlite-store.ts:366-383`,
   `src/be/db.ts:1629,4374`). That is the most natural gate for
   promote-to-global.
4. **Container egress is unrestricted.** `docker-compose.local.yml`,
   `docker-compose.example.yml`, and `Dockerfile.worker` set no `mem_limit`,
   no `cpus:`, no egress policy, no proxy. There is no precedent in this repo
   for sandbox network filtering. Any "egress allowlist" v1 is a green-field
   feature, not a hardening of something that exists.
5. **`Bun.spawn` with `AbortSignal` is the established pattern.** Twelve+ call
   sites (`src/claude.ts:26`, `src/tools/context-diff.ts:17`,
   `src/be/memory/raters/llm-client.ts:127`,
   `src/utils/internal-ai/complete-structured.ts:102`,
   `src/workflows/executors/script.ts:102-115`,
   `src/providers/claude-adapter.ts:290`) — but **none use `ulimit -v / -t`**
   the way code-mode's `BunExecutor` does
   (https://raw.githubusercontent.com/desplega-ai/code-mode/main/packages/core/src/runner/bun-executor.ts).
   So if we want memory/CPU caps in v1 we are importing a code-mode pattern
   that does not yet exist anywhere in this repo.

---

## 1. Versioning / immutability

### TL;DR recommendation

**Mutable-by-name, with a separate `script_versions` audit table that records
every prior body (id, content_hash, body, signature_json, changed_by,
changed_at, change_reason).** Workflows reference scripts by `(name, scope)`
with an **optional `pinHash`** field that locks to a specific
`script_versions.contentHash`. If `pinHash` is set, the engine resolves to
that historic row; otherwise it resolves to the live row. No
`@version` syntax in the script ID itself in v1. Default: workflows pin on
first use, the agent invocation path uses live.

### Evidence from codebase

This is the **dominant pattern in the repo already** — two strong precedents:

- **`prompt_templates` + `prompt_template_history`**
  (`src/be/migrations/014_prompt_templates.sql:5-29`): live table has
  `version INTEGER DEFAULT 1`; history table carries `templateId`, `version`,
  `body`, `state`, `changedBy`, `changedAt`, `changeReason`. Exactly the
  shape we want for scripts.
- **`context_versions`** (`src/be/migrations/001_initial.sql:310-325`,
  helpers at `src/be/db.ts:365-444`): immutable history with
  `contentHash TEXT NOT NULL`, `previousVersionId TEXT`,
  `changeSource`, `changedByAgentId`. SHA-256 via `Bun.CryptoHasher`
  (`src/be/db.ts:365-369`). Same pattern.
- Workflow definition snapshotting: `src/workflows/version.ts:5-40` already
  snapshots whole-workflow versions into `workflow_versions`. Scripts can
  borrow the **same conceptual split**: live `scripts` row + frozen
  `script_versions` rows.

The brainstorm "Core Requirements" already specifies `content_hash` as a
column (`thoughts/taras/brainstorms/2026-05-15-agent-reusable-scripts.md:199`).
This recommendation just adds the history table and the optional pin field.

### Tradeoffs considered

| Option | Pros | Cons |
|---|---|---|
| **(A) Mutable-by-name + history table (recommended)** | Mirrors two existing repo patterns; agents reference scripts naturally by name; workflows can pin when they want stability. | Slightly more complex than (B); two-table query for "show me v3 of fix-issue". |
| (B) Immutable content-addressable with `name → head` pointer | Conceptually clean (every body is its own immutable row); cryptographic identity for free. | No analog in the repo — agents and humans already think in names; agents would have to remember they re-saved and search by hash; foreign behavior for the codebase. |
| (C) Mutable, no history at all | Smallest schema. | We *will* want diff/blame the moment a script breaks; no audit trail for promotion-to-global; throws away cheap insurance. |

### Recommendation rationale

`prompt_templates`/`prompt_template_history` is the **closest behavioural
sibling** to scripts and it ships exactly this pattern. Copy it. Adding an
optional `pinHash` field at the **workflow node level** (not on the script
row) gives workflows determinism without polluting the script ID surface.
This means agent invocations remain "name → latest", and workflow authors
opt into stability when they want it.

---

## 2. Trust model & resource limits

### TL;DR recommendation

**v1 sandbox: subprocess `Bun.spawn` of `bun -e <loader>` with three layers**:

1. **Wall-clock timeout** via `AbortController` + `setTimeout` — copy the
   pattern at `src/workflows/executors/script.ts:117-127`. **Default 30s,
   max 300s**, configurable per call.
2. **Memory + CPU caps** via a `sh -c 'ulimit -v <kb> -t <s>; exec bun -e …'`
   wrapper on POSIX; skipped on Windows. Lift directly from code-mode's
   `BunExecutor`
   (https://raw.githubusercontent.com/desplega-ai/code-mode/main/packages/core/src/runner/bun-executor.ts).
   **Defaults: 512 MB virtual, 60 CPU-seconds.**
3. **Output cap** at 1 MB stdout+stderr per call (truncate, surface flag).

**Auth scope: scripts inherit the caller agent's full `swarm.*` SDK
permissions in v1. No permission manifest.** Same trust model as the
existing Pages SDK proxy at `src/artifact-sdk/server.ts:42-69`.

**Network egress: unrestricted in v1.** Workers and the API server already
have unrestricted egress
(`docker-compose.local.yml`, `Dockerfile.worker` — no `network_mode`,
no proxy). Scripts adopt the host's posture. v2 hardening can add an
allow-listed `fetch` helper.

### Evidence from codebase

- **Subprocess + AbortController is the in-repo norm.** `src/claude.ts:26`,
  `src/tools/context-diff.ts:17`, `src/be/memory/raters/llm-client.ts:127`,
  `src/utils/internal-ai/complete-structured.ts:102`,
  `src/providers/claude-adapter.ts:264-290`, and crucially
  `src/workflows/executors/script.ts:102-115` — which already implements the
  `Bun.spawn` + `Promise.race(runScript, timeoutPromise)` pattern with
  `.unref()` on the timer (lines 117-127). Lift this verbatim.
- **No ulimit precedent in agent-swarm.** None of the call sites above
  apply memory or CPU caps. Importing this from code-mode is net-new.
- **Network egress is unrestricted.** Searching
  `docker-compose.local.yml`, `docker-compose.example.yml`, and
  `Dockerfile.worker` shows no `network_mode`, no `--network=` flag, no
  proxy env, no `HTTP_PROXY`/`HTTPS_PROXY`. The provider adapters
  (`src/providers/*`) and agent commands (`src/commands/*`) likewise make
  raw `fetch` calls with no egress policy. The only "managed sandbox"
  concept is **Anthropic Managed Agents** (`src/providers/claude-managed-adapter.ts:11-94`),
  which is a remote-execution path, not local sandboxing — irrelevant to script egress.
- **Auth/identity is single-key + agent-id header.** `src/http/core.ts:241-252`
  enforces `Authorization: Bearer ${API_KEY}`. The Pages SDK proxy at
  `src/artifact-sdk/server.ts:42-69` injects this token + `X-Agent-ID` on the
  page's behalf — same trick scripts must use. There is no
  finer-grained permission model to reuse, so a "manifest declaring
  `requires: ['memory.write']`" would be inventing a new permission system
  from scratch; not a v1 problem.
- **Bun's `Subprocess` reference (relevant API):**
  https://bun.com/docs/api/spawn — `Bun.spawn({ signal, timeout })` is
  available; on POSIX, the spawn API delivers SIGKILL on abort and the
  child observes it normally.

### Tradeoffs considered

| Option | Pros | Cons |
|---|---|---|
| (1) In-process `vm` / `isolated-vm` | Lower latency than subprocess; same memory address space | No `isolated-vm` in deps; same-process means a runaway script can crash the API server; no precedent in repo |
| (2) Subprocess `bun -e` (recommended) | Strong process boundary; matches repo norms; copy code-mode's hardened wrapper | Per-call cold start (~50ms); cannot share state across calls |
| (3) Docker exec into per-call sandbox container | Strongest isolation | Adds infra dependency to the API server (which currently has no docker dep); 200ms+ cold start; v2 hardening |
| (4) Permission manifest now | Future-proof | We'd be designing a permission system off no real signal; v1 inherits caller scope. |

### Recommendation rationale

The repo already does subprocess+abort everywhere. Adding `ulimit` is a
~30-line lift from code-mode. Permission manifests can be retrofitted once
we have ≥ 5 abuse cases to point at. Network egress restrictions are a v2
problem — neither workers nor the API restrict outbound today, and a script
runtime that's strictly more restrictive than its host invites footguns
(scripts that "work in worker, broken in API"). For v2, the natural hook
point is the `fetch` stdlib helper: replace it with a wrapper that
allowlist-checks the URL.

---

## 3. Promotion to global

### TL;DR recommendation

**v1: `script_upsert` accepts `scope: 'agent' | 'global'`. `scope: 'global'`
is permitted only when the calling agent has `isLead = 1`. Non-lead agents
get a 403 with a hint to "ask the lead to promote".** No new permission
infrastructure. No approval workflow. Document the promotion path in the
tool description.

### Evidence from codebase

- **`isLead` is THE elevated-role flag in this repo.** Schema at
  `src/be/migrations/053_agent_waiting_for_credentials_status.sql:23` (
  `isLead INTEGER NOT NULL DEFAULT 0`). Used by the memory store to gate
  cross-agent visibility (`src/be/memory/providers/sqlite-store.ts:366-407`)
  and by lead-only filters
  (`src/be/db.ts:1629`, `src/be/db.ts:4374`,
  `src/http/memory.ts:318,384,430`).
- **The API auth model has no other role concept.** Single-key bearer
  (`src/http/core.ts:241-252`). No `role: 'admin'`, no `users` table.
- **Memory has no promotion concept** — memories are written with their
  scope at creation time (`AgentMemoryScopeSchema = z.enum(['agent',
  'swarm'])`, `src/types.ts:772`). Cross-agent visibility is read-time via
  `isLead`, not via post-hoc promotion. So we can't copy a "memory.promote"
  pattern — none exists.
- **Prompt templates also have no formal promotion** —
  `prompt_templates` directly accepts `scope IN ('global', 'agent',
  'repo')` (`src/be/migrations/014_prompt_templates.sql:8`) at insert
  time. Whether the caller is allowed to insert `scope='global'` is
  enforced at the HTTP handler level today, not the schema; the same
  pattern applies cleanly to scripts.
- **`approvalRequests` exists** (referenced in the brainstorm) at
  `src/be/migrations/020_approval_requests.sql` — but it's a heavyweight
  human-in-the-loop primitive (full state machine, dedicated table,
  approval/respond endpoints). Overkill for v1 promote.

### Tradeoffs considered

| Option | Pros | Cons |
|---|---|---|
| (A) `isLead`-gated upsert (recommended) | Zero new infra; reuses an existing distinction every operator already understands | A swarm without an explicit lead can't promote (workaround: any agent can be marked lead) |
| (B) approvalRequests flow | Visible audit trail; non-lead self-service | Heavy for v1; introduces UI and review burden; no precedent for "script approval" |
| (C) Auto-promote on N invocations | Frictionless | Hard to define N; bad scripts get auto-promoted; no human in the loop |
| (D) Admin-only via an env-var allowlist | Cheap | Adds a new auth concept; not connected to anything else in the system |

### Recommendation rationale

Reusing `isLead` keeps the surface area to one boolean check in the upsert
HTTP handler. It mirrors what `src/be/memory/providers/sqlite-store.ts:376-381`
already does conceptually for memory ("lead sees everything"). The
`approvalRequest` path is a v3 enhancement when we want non-lead curation;
keep it on the roadmap but not the v1 critical path.

Caveat for the planner: the recommendation implies the HTTP handler reads
`X-Agent-ID`, looks up `agents.isLead`, and rejects with 403 if scope='global'
is requested by a non-lead. Document this clearly in the openapi spec.

---

## 4. Distribution / packaging

### TL;DR recommendation

**Option (c): place the executor runtime as a single folder under `src/`
in this repo — `src/scripts-runtime/`. No workspaces, no separate package,
no npm publish.** Re-evaluate publishing as a standalone npm in v2 if and
only if an external consumer asks for it.

### Evidence from codebase

- **The repo is NOT a workspace monorepo.** `package.json` has no
  `workspaces` field (verified by reading the full file). There is no
  `packages/` directory. The repo ships **one** npm package
  (`@desplega.ai/agent-swarm`, `package.json:1`). The `files` array
  (`package.json:25-35`) lists `src/`, `tsconfig.json`, `plugin/`,
  `templates/`, `openapi.json` — that's it.
- The repo has a long list of in-`src/` sub-systems already proving this
  pattern works at scale: `src/artifact-sdk/` (Pages SDK runtime),
  `src/workflows/` (workflow engine + 11 executors), `src/be/memory/`
  (the entire memory subsystem with providers, types, store, rerankers).
  None of these are separate packages.
- **Code-mode is a separate package** because it has a separate distribution
  story (a global CLI installable via `npm i -g @desplega/code-mode`,
  https://raw.githubusercontent.com/desplega-ai/code-mode/main/README.md).
  agent-swarm's distribution story is "users `bun install
  @desplega.ai/agent-swarm` and run the bins". Adding a second package
  means a second `npm publish`, a second changelog, a second `version`
  field that goes out of sync.
- **Code-mode itself IS a Bun workspace monorepo with `packages/core` +
  `packages/inspector`** (`https://raw.githubusercontent.com/desplega-ai/code-mode/main/README.md`),
  which underscores that moving to a multi-package layout is a non-trivial
  structural change (root `package.json` workspaces, separate `bun.lock`
  semantics, separate tsconfigs). The brainstorm's premise that the runtime
  must run in both worker and API doesn't require a package boundary — it
  requires that the code is **referenceable** from both worker-side
  (`src/commands/*`, `src/tools/*`) and API-side (`src/http/*`). A single
  `src/scripts-runtime/` folder satisfies both.

### Tradeoffs considered

| Option | Pros | Cons |
|---|---|---|
| (a) New `packages/scripts-runtime` workspace | Cleanest boundary; reusable externally | Requires turning the repo into a workspace monorepo; biome/tsconfig/CI churn |
| (b) Standalone npm package | External reuse; can be published independently | Two release cycles; version skew; duplicate type-definitions; can't import from `src/be/*` without making `agent-swarm` a peer dep |
| **(c) `src/scripts-runtime/` folder (recommended)** | Zero infra change; full type access to `src/types.ts` and `src/artifact-sdk/browser-sdk.ts`; one CI; one openapi gen | "External reuse" is a future hypothetical |

### Recommendation rationale

The DB-boundary rule (`scripts/check-db-boundary.sh`) already partitions
`src/` into "API-only" vs "worker-safe" code without a package boundary,
proving that a folder + a script-enforced invariant is the repo's chosen
mechanism for cross-cut boundaries. Apply the same here: put the
runtime under `src/scripts-runtime/` with a sub-folder split:

```
src/scripts-runtime/
  loader.ts             # accepts source + args, produces eval'd result
  ctx.ts                # builds the ctx { swarm, stdlib, logger } object
  stdlib/               # the few helpers we ship (see Q5)
  swarm-sdk.ts          # mirrored, server-side variant of BROWSER_SDK_JS
```

This composes naturally with the existing layout (`src/artifact-sdk/` is
precedent). If a future external consumer needs it, lifting one folder to
a workspace is much cheaper than reversing a premature monorepo split.

---

## 5. Stdlib v1 surface

### TL;DR recommendation

**v1 ships exactly 4 stdlib helpers: `fetch`, `grep`, `glob`, `table`.**
Plus the **full `swarm.*` SDK** mirroring `BROWSER_SDK_JS` 1:1 (eight
domains: `tasks`, `agents`, `events`, `memory`, `repos`, `schedules`,
`approvalRequests`, `kv` — confirmed in
`src/artifact-sdk/browser-sdk.ts:9-19` and the doc-comment header at
lines 9-22). Drop `fuzzy-match`, `filter`, `flatten` from v1 (move to v2).

### Evidence from codebase

- **`BROWSER_SDK_JS` is the single source of truth for the `swarm.*` shape.**
  `src/artifact-sdk/browser-sdk.ts:22-132` enumerates every method on
  every domain. Eight domains, each with 3-6 methods. The doc-comment at
  the file head (`browser-sdk.ts:1-22`) lists them explicitly: "tasks,
  agents, events, memory, repos, schedules, approvalRequests, kv". This
  is the canonical surface to mirror.
- **The Pages SDK proxy** at `src/artifact-sdk/server.ts:42-69` shows the
  exact auth-injection pattern scripts must replicate: every call routes
  through `mcpBaseUrl + /api/*` with `Authorization: Bearer ${apiKey}`
  and `X-Agent-ID: ${agentId}` injected by the runtime. Scripts get the
  identical wrapper.
- **Bun has native `fetch` (global) and native `Bun.Glob`.**
  - `fetch` is a global in Bun runtime; `src/artifact-sdk/browser-sdk.ts:34`
    uses it without import. Code-mode's `fetch` wrapper layers retries +
    typed JSON + 30s timeout on top
    (https://raw.githubusercontent.com/desplega-ai/code-mode/main/README.md
    "fetch: Typed wrapper around global fetch with 30s timeout, retries,
    JSON parsing"). For scripts, we want that wrapper too because raw
    `fetch` has no retry, no auto-timeout, no auto-JSON.
  - `Bun.Glob` exists (https://bun.com/docs/api/glob). However the repo
    doesn't currently use it (one comment at
    `src/utils/page-session.ts:27` mentions `Buffer` but no glob usage).
    Code-mode's `glob` helper wraps `fs.glob` (Node 22+) with a fallback,
    which is more portable than `Bun.Glob` alone.
- **`grep` requires ripgrep on PATH.** Code-mode shells out to `rg`
  (its README: "ripgrep-backed content search"). In agent-swarm,
  workers run in a container where we control PATH (`Dockerfile.worker`),
  so we can ensure `rg` is installed. The API server is harder — but for
  most pure-transform scripts, `grep` would be worker-side only (the
  workflow engine dispatches `runtime: workspace` scripts to the worker
  already per the brainstorm's Decision 9).
- **`table`, `filter`, `flatten`, `fuzzy-match`** are pure-JS utilities.
  None are present anywhere in agent-swarm today; all are net-new.
  Code-mode's set is from
  https://raw.githubusercontent.com/desplega-ai/code-mode/main/README.md.

### Tradeoffs considered

| Helper | Ship in v1? | Why |
|---|---|---|
| `fetch` (wrapped) | YES | Every script that hits an external API wants retries + JSON; raw `fetch` is too low-level |
| `grep` | YES | Hugely common request pattern; cheap wrapper around `rg`; worker-side only is fine for v1 |
| `glob` | YES | Workspace-touching scripts will need it; the wrapping cost is trivial |
| `table` | YES | Tiny helper; meaningfully improves agent-readable output formatting |
| `fuzzy-match` | NO | Niche; defer |
| `filter` | NO | One-line over `Array.filter`; defer |
| `flatten` | NO | One-line; defer |
| `swarm.*` SDK | YES, all 8 domains | Non-negotiable — this is the actual API surface |

### Recommendation rationale

Code-mode's seven helpers were chosen for a *general-purpose* coding
agent scratchpad. Our agents are doing tasks in a structured swarm — the
`swarm.*` SDK (tasks, memory, kv, events, approvals) is **vastly more
important** than yet another array helper. Ship the four helpers that
have non-obvious value (network reliability, ripgrep wrapping, glob
portability, pretty-printing) and defer the trivia. `filter` and
`flatten` are five lines an agent can inline if needed. `fuzzy-match`
is the kind of helper that's nice-to-have for code-mode (which often
searches through script names) but not load-bearing for swarm scripts.

For v2, add `fuzzy-match` if and only if `script_search` itself isn't
already meeting the matching needs (embeddings should obviate fuzzy
recall for most queries).

---

## 6. Code-mode migration path

### TL;DR recommendation

**They coexist — no importer.** Position swarm-scripts as "code-mode for
the swarm" with strictly separate storage. Document the conceptual
overlap in the docs site; do not build a one-shot importer command.
Recommend "if you use code-mode in your local dev workspace, that's
fine; swarm-scripts run inside the swarm runtime and have access to
`swarm.*` which code-mode doesn't have anyway".

### Evidence from external repo

- **Code-mode storage is filesystem-rooted under `.code-mode/`** in each
  workspace. Schema at
  https://raw.githubusercontent.com/desplega-ai/code-mode/main/packages/core/src/db/schema.ts
  uses `path TEXT PRIMARY KEY` — disk is the source of truth, the SQLite
  index is a derived structure rebuilt by `reindex`. Initial migration:
  https://raw.githubusercontent.com/desplega-ai/code-mode/main/packages/core/src/db/migrations/001_initial.sql
  (tables: `scripts(path PRIMARY KEY, …)`, `scripts_fts`, `symbols`,
  `symbols_fts`, `sdks`).
- **Code-mode's surface includes things swarm-scripts does NOT need**:
  `query-types` (typed SDK introspection across multiple user-defined
  SDKs), `list-sdks`, `doctor` (typecheck broken scripts), `gc` (move
  stale to trash). These exist because code-mode is itself a *script
  development environment*, not a *script execution surface*. Swarm
  scripts are agent-authored and agent-consumed — no IDE-grade
  introspection.
- **Code-mode auto-saves to `.code-mode/scripts/auto/<slug>.ts`** driven
  by `intent`
  (https://raw.githubusercontent.com/desplega-ai/code-mode/main/packages/core/src/runner/exec.ts
  see `AutoSaveInfo`). The slug-from-intent + content-hash dedup logic
  is worth copying conceptually (and the brainstorm Decision 8 already
  does). We don't need to share the storage format.
- **Code-mode is published as `@desplega/code-mode`** (separate
  workspace). It's NOT designed for cross-tool import — scripts there
  reference local `.code-mode/sdks/stdlib/` files, not a swarm SDK.

### Tradeoffs considered

| Option | Pros | Cons |
|---|---|---|
| (A) One-shot `code-mode-import` CLI | Honors users who already invested in code-mode scripts | Code-mode scripts use code-mode's stdlib (literal file imports under `.code-mode/sdks/stdlib/`); swarm scripts use `ctx.stdlib` — paths don't translate; near-zero overlap in real scripts; we'd be importing TS that wouldn't typecheck against `ctx` shape |
| **(B) Coexist, no importer (recommended)** | Honest about the difference; no false promise; lets each tool be opinionated about its model | Users with existing code-mode investment hand-port scripts |
| (C) Share the storage format | "One library" story | Locks both tools to a shared schema forever; code-mode is filesystem-rooted, swarm is DB-rooted; fundamentally different |

### Recommendation rationale

Code-mode and swarm-scripts solve **different problems despite the
surface similarity**:
- Code-mode = developer-on-laptop convenience CLI; storage is the
  filesystem; the user is a human inside Claude Code.
- Swarm-scripts = production-runtime agent shortcuts; storage is the
  API-server SQLite; the user is an agent inside a swarm.

The two will share **patterns** (MCP tool surface shapes, auto-save by
intent, content-hash dedup), not **storage**. An importer would have
to translate script bodies from "imports `../sdks/stdlib/fetch.ts`" to
"uses `ctx.stdlib.fetch`" and from "calls user-defined SDK methods"
to "calls `ctx.swarm.tasks.create` shaped differently". The conversion
fidelity would be very low.

Opinionated take: **do not build an importer; build a docs page that
explains the distinction so users don't conflate the two.**

---

## 7. CLI surface (optional v1)

### TL;DR recommendation

**Defer.** Do not ship `bun run src/cli.tsx scripts <name>` in v1. The
incremental complexity (auth bootstrap, args parsing, output formatting,
adding a `scripts` entry to `COMMAND_HELP` and the `commands` array, plus
its own `--help` block) is real, and the use case ("humans run the same
primitives agents use") has no concrete validation yet.

Re-evaluate when (a) a human user files a bug "I want to dry-run this
script locally" OR (b) the workflow team wants a CLI for debugging
script-node executions.

### Evidence from codebase

- **Adding a CLI subcommand is non-trivial.** `src/cli.tsx:130-282` shows
  `COMMAND_HELP` with ~12 entries averaging 15 lines each (usage,
  description, options, examples). Lines `300-314` list every command
  for the top-level help. Then routing in the `App` switch
  (`src/cli.tsx:522` and surrounding code). Per the CLAUDE.md
  "CLI commands" guidance, the pattern is well-trodden but
  every new subcommand needs all three touchpoints (`COMMAND_HELP`
  entry, top-level list, switch case).
- **No equivalent precedent exists for invoking MCP-tool functionality
  via CLI.** Looking at `src/cli.tsx`: `claude`, `worker`, `lead`,
  `api`, `onboard`, `connect`, `hook`, `artifact`, `docs`,
  `codex-login`, `claude-managed-setup`, `version`, `help`. All are
  *lifecycle/bootstrap* commands (start a process, configure a thing).
  Nothing in the CLI is "invoke an MCP tool and print the result".
  Building this means designing how the CLI authenticates to the API
  (read `.env`'s `API_KEY`? prompt? assume `MCP_BASE_URL` set?), which
  is its own design problem.
- **The just-bash pattern** (per the brainstorm: tools auto-exposed as
  bash commands like `country lookup code=BR | jq -r .name`) requires
  a runtime layer that's specifically designed to dual-publish each
  tool. We'd be lifting that pattern wholesale into a context that
  doesn't yet have any consumer for it.

### Tradeoffs considered

| Option | Pros | Cons |
|---|---|---|
| (A) Ship CLI in v1 | Humans can debug scripts; "tools as bash commands" feel | ~150-200 LOC of CLI plumbing; auth design; output formatting; no concrete consumer |
| **(B) Defer (recommended)** | v1 stays tight; MCP tools are sufficient for the agent case; can ship later when there's a real use case | Humans rely on `curl` (which works fine — POST to `/api/scripts/run`) for ad-hoc debugging until the CLI ships |
| (C) Ship a minimal "scripts list" command only | One-third the work | Splits the surface awkwardly; "why can I list but not run?" |

### Recommendation rationale

CLAUDE.md says "doing it right is better than doing it fast" and "you
are not in a rush." The CLI is **strictly additive** — every script
operation is reachable via the HTTP API (and `curl` from any shell).
There is no scenario blocked by the CLI's absence. Ship the storage,
runtime, MCP tools, embeddings, and workflow node first; gather data
on whether humans actually want to run scripts directly; then add the
CLI as a v2 quality-of-life feature with one well-scoped PR.

---

## Plan-ready summary

The seven decisions, one line each, ready for `/desplega:create-plan`:

1. **Versioning**: mutable-by-name with a `script_versions` history table
   (mirror `prompt_templates`/`prompt_template_history`); workflows pin
   via optional `pinHash` on the node, not on the script ID.
2. **Sandbox**: `Bun.spawn('bun -e <loader>')` wrapped in
   `sh -c 'ulimit -v 524288 -t 60; exec …'` on POSIX, with a 30s
   AbortController timeout and 1 MB output cap; scripts inherit caller's
   `swarm.*` permissions; no egress restrictions in v1.
3. **Promotion**: `script_upsert({ scope: 'global' })` requires
   `agents.isLead = 1` on the caller; non-leads get 403; no
   approvalRequest flow in v1.
4. **Packaging**: in-repo folder `src/scripts-runtime/`; no monorepo
   conversion, no separate npm package.
5. **Stdlib v1**: `fetch` (wrapped), `grep` (ripgrep), `glob`, `table`
   — plus the full 8-domain `swarm.*` SDK mirrored from
   `BROWSER_SDK_JS`; defer `fuzzy-match`, `filter`, `flatten` to v2.
6. **Code-mode**: coexist, no importer; document the distinction in the
   docs site.
7. **CLI**: defer; HTTP API + `curl` is sufficient; revisit when there's
   a concrete human-debug use case.

## Cross-cutting notes for the planner

- The brainstorm's mention of `agent_definition_id` should be implemented
  as **`scope TEXT CHECK(scope IN ('global','agent'))` + `scopeId TEXT
  NULL` (= agentId when scope='agent')** to match `prompt_templates`
  and `swarm_config`. Reconfirm with Taras before migrating to anything
  more elaborate.
- The existing `script` workflow node type
  (`src/workflows/executors/script.ts:1-128`) is a separate concept
  (inline bash/ts/python runner). The new reusable-scripts node must
  use a distinct type name (suggested: `swarm-script`).
- Auth for `ctx.swarm.*` inside the script runtime should reuse the
  proxy logic at `src/artifact-sdk/server.ts:42-69` verbatim — the
  contract is identical (bearer + `X-Agent-ID`).
- For embeddings reuse: `OpenAIEmbeddingProvider` at
  `src/be/memory/providers/openai-embedding.ts:11` and the
  `EmbeddingProvider` interface at `src/be/memory/types.ts:7-12` are
  the entry points; serialize/deserialize at `src/be/embedding.ts:30-42`.
- All new HTTP routes (`/api/scripts/*`) MUST use the `route()` factory
  at `src/http/route-def.ts:1-40` and trigger an `openapi.json` regen
  per CLAUDE.md.

---

## Addendum — 2026-05-15 (post-research pushback)

Taras pushed back on decision **#2 (Sandbox)**: the `Bun.spawn + ulimit` wrapper is
weaker than `vercel-labs/just-bash`, which provides:

- Real JS isolation (`js-exec` via QuickJS, sandboxed) — not just a separate process
- `MountableFs` — per-script FS mount config (`InMemoryFs` / `OverlayFs` / `ReadWriteFs`)
- Default-deny network with `allowedUrlPrefixes` allow-list — agent-swarm has zero
  egress controls today, this is a genuine upgrade
- `AbortSignal` cancellation + `executionLimits.maxCallDepth` runaway protection
- `defineCommand` + `js-exec` bootstrap — clean injection of the `swarm.*` SDK

**Concerns flagged but not yet validated** (pending the focused integration spike):

1. README marks just-bash as "beta software" — pin version, expect breakage
2. `js-exec` runs on QuickJS, NOT Bun. Scripts cannot use `Bun.file`, `Bun.spawn`,
   `bun:sqlite`. Our `swarm.*` SDK is HTTP-only so fine; but no native Bun helpers
   inside script bodies.
3. Bun runtime compat unverified — just-bash ships via pnpm. Plain TS source should
   work as a Bun dep; QuickJS-wasm + CPython optional runtimes may bring pain.
4. Cold-start cost for trivial transforms — unmeasured; needs a quick benchmark.

**Decisions amended:**

- **#2 (Sandbox)** — re-evaluation pending parallel integration spike. Fall back
  to the original `Bun.spawn + ulimit` if just-bash fails the spike.
- **#5 (Stdlib v1)** — likely shrinks: just-bash ships `grep`, `jq`, `awk`, `sed`,
  `curl`, etc. as built-in commands. We probably only need to register the
  `swarm.*` SDK as a custom command / bootstrap global; the other helpers
  (`fetch`, `grep`, `glob`, `table`) become redundant. Confirm in the spike.
- **NEW decision: Per-script FS scope contract** — caller specifies FS mount at
  invocation time (option B from the AskUserQuestion), with a default applied when
  not passed. Proposed default: `none` (InMemoryFs only, no /workspace access) —
  workspace-touching scripts must be invoked with explicit `fs: 'workspace-ro'`
  or `fs: 'workspace-rw'`. Safe-by-default. Confirm exact surface in the spike.

**Next:** parallel research agent spawned to dive into just-bash internals
(FS impls, js-exec QuickJS bootstrap, network allow-listing, AbortSignal
propagation, Bun-compat surface) and produce an integration-shape doc before
planning starts.

---

## Addendum II — 2026-05-15 (just-bash rejected, falling back)

The just-bash integration-shape dive lives at
`thoughts/taras/research/2026-05-15-just-bash-integration-shape.md` (1,114 lines).

**Verdict: rejected.** Reasoning:

- The shape is technically right (`MountableFs`, `invokeTool` bridge, default-deny
  network, 64 MB QuickJS cap — all strictly stronger than `Bun.spawn + ulimit`).
- **But** `js-exec` is currently broken on Bun: the QuickJS worker statically
  imports `stripTypeScriptTypes` from `node:module` (`js-exec-worker.ts:12`),
  Bun's `node:module` shim doesn't export it, the worker dies at link time, the
  main thread times out after 10s. Reproduced with `bun 1.3.11` + `just-bash@3.0.1`.
- Open PR [#169](https://github.com/vercel-labs/just-bash/pull/169) fixes it,
  **idle 2 months with no maintainer response**. Combined with the
  README's explicit "beta software" disclaimer, the project-health signal is
  weak.
- Patch-ownership cost (Bun `patchedDependencies` on every version bump) +
  upstream-dead risk outweigh the sandbox gains for a v1 feature.

**Final calls:**

- **Decision #2 (Sandbox) — confirmed as original:** `Bun.spawn` of `bun -e <loader>`
  wrapped in `sh -c 'ulimit -v 524288 -t 60; exec …'`, 30s `AbortController`,
  1MB output cap. Scripts inherit caller's permissions. No egress restrictions in v1.
- **Decision #5 (Stdlib v1) — confirmed as original:** ship `fetch`, `grep`,
  `glob`, `table` + full 8-domain `swarm.*` SDK. Defer `fuzzy-match`, `filter`,
  `flatten`. (No bash builtins available without just-bash; back to JS imports.)
- **NEW decision (FS scope contract) — narrowed to honest v1:**
  Caller passes `fs?: 'none' | 'workspace-rw'`, default `'none'`. **No
  `workspace-ro` in v1** — without a real sandbox we can't honestly enforce
  read-only against a determined script. `'none'` = subprocess `cwd` set to a
  per-run tmpdir under `/tmp/swarm-scripts/<runId>/`; `'workspace-rw'` = `cwd`
  set to the agent's `/workspace`. The contract is "scope-by-cwd-convention,"
  not real isolation. The planner should clearly label this in the v1 docs.
- **v2 hardening path:** revisit just-bash (or alternative — `isolated-vm`,
  Deno's `--allow-*`, container-per-script) once we have a working v1 and
  agent-author trust signals.

**No further blockers.** Ready for `/desplega:create-plan`.

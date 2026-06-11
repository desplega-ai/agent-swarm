---
date: 2026-06-11T20:30:00Z
topic: "Evals: sandbox base envs (memory), multi-worker swarm, SQL-dump seeding"
researcher: Claude
git_commit: 19e3bf8d
branch: feat/evals-subproject
repository: agent-swarm
tags: [evals, memory, embeddings, e2b, multi-worker, sqlite, seeding]
status: complete
---

# Evals: sandbox base envs (memory), multi-worker swarm, SQL-dump seeding

Three questions from Taras about the `evals/` sub-package (read-only research;
no evals code touched).

---

## Q1 — Base envs for a faithful sandbox (especially memory)

### 1.1 How the memory system actually works, and which envs it needs

**Embeddings (API-server side).** `src/be/embedding.ts` is *only* vector math
(cosine similarity, BLOB serialization) — no provider, no env
(`src/be/embedding.ts:1-42`). The real provider is
`OpenAIEmbeddingProvider`, lazily constructed by `getEmbeddingProvider()`
(`src/be/memory/index.ts:6-13`):

| Env | Default | Source |
|---|---|---|
| `EMBEDDING_API_KEY` → falls back to `OPENAI_API_KEY` | none | `src/be/memory/providers/openai-embedding.ts:20` |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | `openai-embedding.ts:22` |
| `EMBEDDING_API_BASE_URL` | OpenAI default | `openai-embedding.ts:35` |
| `SQLITE_VEC_EXTENSION_PATH` | — | vec0 vector index (`src/be/memory/providers/sqlite-store.ts:105-119`) |

**Missing-key behavior is graceful everywhere, and that's the trap**: with no
key, `embed()` returns `null` (`openai-embedding.ts:31-43`), never throws.
Consequences per call site:

- **Ingestion** — memories are still *stored* (rows in `agent_memory`), just
  with NULL embeddings: `store-progress.ts` task-completion indexing stores
  then embeds fire-and-forget (`src/tools/store-progress.ts:354-368`, embed at
  `:365`); `/api/memory/index` stores rows sync, embeds async
  (`src/http/memory.ts:24-45`, batch embed at `:315-325`).
- **Retrieval (the one that bites)** — `POST /api/memory/search` embeds the
  query and **returns `{results: []}` when the embedding is null**
  (`src/http/memory.ts:347-351`). No fallback.
- The **MCP `memory-search` tool** (agent-invoked) *does* have a recency
  fallback: "Embedding unavailable (no OPENAI_API_KEY). Showing N most recent
  memories." (`src/tools/memory-search.ts:141-168`). But that only helps if
  the agent explicitly searches.

**Automatic prompt injection (worker side, no env gate).** At every
`task_assigned`/`task_offered` trigger the worker runner calls
`fetchRelevantMemories` → `POST /api/memory/search` with
`X-Source-Task-ID` (records `memory_retrieval` rows) and appends a
"Relevant Past Knowledge" section when results have similarity > 0.4
(`src/commands/runner.ts:4710-4726`, `:2289-2326`;
`src/prompts/memories.ts:34-49`). This path is always attempted — it just
silently yields nothing when the API can't embed.

**Memory raters.** Registry gated on `MEMORY_RATERS` (comma list); unset/empty
→ `NoopRater` only, nothing fires — "byte-identical when off"
(`src/be/memory/raters/registry.ts:45-68`; `runbooks/memory-system.md:53`).
Three raters:

- `implicit-citation` — **server-side**, fired from `store-progress` at task
  completion (`src/tools/store-progress.ts:413-434`,
  `registry.ts:44 SERVER_RATERS`). Pure ID-grep over session logs — **no LLM,
  no key**. Needs `MEMORY_RATERS=implicit-citation` on the **API** env.
- `llm` — **worker-side** piggyback on the session summary; gated by
  `MEMORY_RATERS` containing `llm` *in the worker env*
  (`src/hooks/hook.ts:330-340`, `src/be/memory/raters/llm.ts:248-250`).
  Model: `MEMORY_RATER_MODEL` (default `google/gemini-3-flash-preview`,
  `src/be/memory/raters/llm-summarizer.ts:21,53-57`); legacy claude-cli client
  uses `MEMORY_LLM_RATER_MODEL`/`MEMORY_LLM_RATER_PROVIDER`
  (`llm-client.ts:123,172`).
- `explicit-self` — worker-side `memory_rate` tool; the prompt hint is gated
  on `MEMORY_RATERS` containing `explicit-self` (`src/prompts/memories.ts:44-46,55-60`).

Tuning (all optional): `MEMORY_RATER_WEIGHTS`, `MEMORY_DEMOTION_FLOOR`,
`MEMORY_RECENCY_HALF_LIFE_DAYS` (`runbooks/memory-system.md:53-55`,
`src/be/memory/constants.ts:21`, `src/be/memory/reranker.ts:60`).

**Session-summary ingestion (worker side).** Each harness writes a session
summary to `POST /api/memory/index` at session end via the shared
`internal-ai` abstraction; credentials resolve in order
`OPENROUTER_API_KEY → ANTHROPIC_API_KEY → OPENAI_API_KEY → codex OAuth →
CLAUDE_CODE_OAUTH_TOKEN (claude -p fallback)`; none → **silent skip**
(`src/utils/internal-ai/credentials.ts:61-65,170`):

| Provider | Path | Notes |
|---|---|---|
| claude | Stop hook `runStopHookSessionSummary` (`src/hooks/hook.ts:298-380`) | skipped if `SKIP_SESSION_SUMMARY` set (`hook.ts:303`) |
| pi | `summarizeSessionForPi` (`src/providers/pi-mono-extension.ts:317,380`) | |
| codex | codex adapter (`src/providers/codex-adapter.ts:1118-1160`) | forwards `MEMORY_RATERS`/`OPENROUTER_API_KEY` into child env (`:1441-1455`) |
| **opencode** | **none** — no summarize path exists in `src/providers/opencode-adapter.ts` | opencode workers form *no* session-summary memories; only task-completion memories (server-side) |

Task-completion memory is filtered by `shouldPersistTaskCompletionMemory` —
only `schedule`/`system`-sourced (automatic) tasks need opt-in
(`src/memory/automatic-task-gate.ts:27-47`); eval tasks created via
`POST /api/tasks` persist by default.

### 1.2 What evals passes today

**API sandbox** — `apiRuntimeEnv` (`evals/src/swarm/sandbox.ts:90-108`):
`API_KEY`, `AGENT_SWARM_API_KEY`, `PORT=3013`,
`DATABASE_PATH=/app/data/agent-swarm-db.sqlite`, `MIGRATIONS_DIR`,
`SQLITE_VEC_EXTENSION_PATH=/app/extensions/vec0.so`, `SCRIPT_RUNTIME_DIR`,
`TS_LIB_DIR`, `SCRIPT_TYPES_DIR`, and
`SLACK/GITHUB/GITLAB/JIRA/LINEAR/AGENTMAIL_DISABLE=true`.
**No embedding key. No `MEMORY_RATERS`. No OPENROUTER key.**

**Worker sandbox** — `workerRuntimeEnv` (`sandbox.ts:110-151`): swarm key pair,
`MCP_BASE_URL`, `AGENT_ROLE=worker`, `AGENT_ID`, `HARNESS_PROVIDER`,
`MODEL_OVERRIDE` (if set), `YOLO=true`, `MAX_CONCURRENT_TASKS=1`, log dirs,
image-runtime paths (HOME/BUN_INSTALL/PATH/…), plus per-config credentials
from `credentialsForConfig` (`sandbox.ts:54-88`):

| Config provider | Worker creds forwarded |
|---|---|
| claude | `CLAUDE_CODE_OAUTH_TOKEN` if present, else `ANTHROPIC_API_KEY` |
| codex | `OPENAI_API_KEY` |
| pi / opencode | key matching `MODEL_OVERRIDE` prefix: `anthropic/`→`ANTHROPIC_API_KEY`, `openai/`→`OPENAI_API_KEY`, else `OPENROUTER_API_KEY` |

Plus `config.env` overrides (`evals/src/types.ts:24-25` — a per-config
escape hatch that already exists).

### 1.3 Gap table

| Env | Needed for | Passed today? | Consequence in evals |
|---|---|---|---|
| `OPENAI_API_KEY` (or `EMBEDDING_API_KEY`) on **API** sandbox | embedding writes at ingestion + query embedding at search | **NO** | memories stored with NULL embeddings; `/api/memory/search` returns `[]`; **automatic memory injection into task prompts silently never happens** |
| `EMBEDDING_MODEL` / `EMBEDDING_API_BASE_URL` (API) | non-OpenAI embedding backends | NO | defaults fine if OpenAI key supplied |
| `MEMORY_RATERS=implicit-citation` (API) | server-side usefulness rating | NO | no rating events; ranking is similarity+recency only — fine for v1 |
| `MEMORY_RATERS=llm` (+`MEMORY_RATER_MODEL`) (worker) | LLM rater piggyback | NO | no per-memory ratings — fine for v1 |
| internal-ai cred (worker) | session-summary memory ingestion | **YES, incidentally** — harness creds double as internal-ai creds for claude/pi/codex | summaries DO get posted to `/api/memory/index` today (then sit unembedded). opencode: no path at all |
| `SKIP_SESSION_SUMMARY` | disabling summaries | not set | correct (we want them) |

### 1.4 The 2-tasks-in-a-row scenario, end to end

The runner already creates tasks **sequentially** — create task 1, wait to
terminal, then create task 2 (`evals/src/runner/index.ts:288-300`). So the
flow would be:

1. Task 1 completes → server stores a `task_completion` memory and (worker
   side) a session summary lands at `/api/memory/index`.
2. Task 2 is created → worker claims → runner calls `fetchRelevantMemories`
   → `/api/memory/search`.

**The single hard gap is the embedding key on the API sandbox.** Nothing is
missing worker-side: prompt injection is automatic in `runner.ts`, and the
memory MCP tools (`memory-search`/`memory-get`/`memory_rate`) are served by
the API. Two soft caveats:

- **Race**: embedding (store-progress `:344-368`) and the stop-hook summary
  are async fire-and-forget; task 2 created milliseconds after task 1's
  terminal status could beat them. In practice claim+boot latency (seconds)
  covers the embed; the *summary* (an extra LLM call at session end) can lag
  more. A scenario-level settle delay (2–5 s) or a deterministic check that
  task 2's transcript contains "Relevant Past Knowledge" makes this robust.
- `ScenarioSeed.memories?: string[]` is declared (`evals/src/types.ts:36-37`)
  but **implemented nowhere** (only reference in the repo is the type). Wiring
  it to `POST /api/memory/index` would let scenarios pre-seed memories
  directly (remember embedding there is async — settle or hit
  `/api/memory/re-embed`, `src/http/memory.ts:66-82`).

### 1.5 Recommendation (Q1)

Minimal change, all in `evals/src/swarm/sandbox.ts:apiRuntimeEnv`:

1. Forward `OPENAI_API_KEY` from `evals/.env` (already required there for
   codex workers — `evals/README.md:64-67`) as both `EMBEDDING_API_KEY` and
   `OPENAI_API_KEY` into the API sandbox. Conditionally (`if present`), so
   non-memory runs don't hard-require it.
2. Optionally pass `MEMORY_RATERS=implicit-citation` (keyless, server-side)
   when memory scenarios appear; defer `llm`/`explicit-self` raters.
3. Implement `seed.memories` against `/api/memory/index` (worker-agent scoped,
   `X-Agent-ID: workerAgentId`) + a settle/re-embed step — cheaper than SQL
   dumps for the memory use case.

### 1.6 Q1-adjacent: other production envs evals omits

| Env | Behavior when absent | Distorts evals? |
|---|---|---|
| `SECRETS_ENCRYPTION_KEY`(`_FILE`) | API auto-generates a key file and logs a notice (`src/be/crypto/key-bootstrap.ts:10-26`, `src/be/db.ts:5730-5735`) | No — sandbox DB is fresh; nothing pre-encrypted to decrypt |
| `NODE_ENV` | not "production" → MCP OAuth `allowInsecure` (`src/http/mcp-oauth.ts:36`), dev behavior in pages (`src/http/pages.ts:323`, `pages-public.ts:189,329`) | Mild fidelity gap; set `NODE_ENV=production` in `apiRuntimeEnv` for parity — cheap and safe |
| `PUBLIC_MCP_BASE_URL` | API URL defaults to the E2B proxy URL workers already get via `MCP_BASE_URL` | No — affects outward links only |
| Integration disables | already set to `true` (`sandbox.ts:101-106`) | Matches an integrations-off deployment; prevents handler noise. Correct |
| `OPENROUTER_API_KEY` (API) | workflow `raw-llm` executor uses it (`src/workflows/executors/raw-llm.ts:31`) | Only if scenarios exercise LLM workflow nodes — add when needed |

---

## Q2 — Proper swarm: multiple workers per attempt

### 2.1 What the swarm itself supports

- **Topology**: `e2b start-stack` already boots API + lead + N workers
  (`src/cli.tsx:319-355`; worker loop `src/commands/e2b.ts:1017-1024`;
  `--no-lead` for API+workers). Evals deliberately mirrors the no-lead shape
  with N=1 (`evals/src/swarm/sandbox.ts:5-7`).
- **Registration**: each worker self-registers via `POST /api/agents` keyed on
  `X-Agent-ID` (`src/http/agents.ts:35-39`; worker side
  `src/commands/runner.ts:2040-2076`, re-register `:3932-3950`). **Gotcha
  already codified**: a shared `--agent-id` with `--workers > 1` is an error
  because N workers would collapse into one agent record
  (`src/commands/e2b.ts:974-984`) → evals must mint one UUID per worker
  (it already does for the single worker, `sandbox.ts:207`).
- **Routing**: `POST /api/tasks` without `agentId` defaults to the **lead**
  (`src/http/tasks.ts:374-383`, `getLeadAgent()` at `:382`); with no lead the
  task lands `unassigned` and workers will NOT pick it up (workers only act on
  assigned/offered triggers; `unassigned` filter exists at
  `src/be/db.ts:1605-1606`). Evals sidesteps this by always assigning
  `stack.workerAgentId` explicitly (`evals/src/runner/index.ts:289-292`).

### 2.2 What N-workers-per-attempt would take in evals

| Surface | Change |
|---|---|
| `bootStack` (`sandbox.ts:192-312`) | loop worker creation; `StackHandle.workerSandbox` → `workerSandboxes: E2BSandboxInfo[]`, `workerAgentId` → `workerAgentIds[]`. Boot workers in parallel (`Promise.all`) — sequential adds ~1–3 min/worker (registration wait `:294` + idle wait `:296`). Merge all worker envs into the `redact` secret set (`:298`) |
| Scenario schema (`evals/src/types.ts:79-91`) | `workers?: number` (default 1) on `Scenario`; `TaskSpec` gains `worker?: number` index (default 0) |
| Runner (`runner/index.ts:288-300`) | `createTask({ agentId: stack.workerAgentIds[spec.worker ?? 0] })`. Sequential-await per task stays; parallel tasks across workers is a separate (deferrable) feature |
| Artifacts | `markAttemptStart` per worker sandbox (`sandbox.ts:390-392`); `collectHarnessSessionFiles(sandboxId, provider)` is already per-sandbox parameterized (`:404-450`) — loop and namespace artifacts (`worker-0/session-files.json`, …); worker entrypoint log tail per sandbox (`runner/index.ts:604-616`) |
| Cost/logs | **no change** — session logs and cost rows are fetched per *task* (`evals/src/swarm/client.ts:53,81,162`), not per sandbox |
| DB/UI | `SandboxInfo` (`types.ts:128-141`) holds a single `workerSandboxId`/`workerAgentId` → arrays; ripples into attempt rows + the evals UI panels |
| Sweep | **no change** — `sweepRunSandboxes` matches `metadata.swarm` slug, which all sandboxes of a run share (`sandbox.ts:351-377`) |

**What makes it hard:**

- *Heterogeneous workers break the matrix semantics*: an attempt cell is
  currently `scenario × ONE HarnessConfig`; per-worker configs would mean a
  cell is a config *set* (registry, results grouping, cost recompute per
  provider, and `credentialsForConfig` unions leaking creds across harnesses).
- *Lead topology is a different feature*: routing through a lead means
  unassigned task creation, delegation via `send-task`, judging across
  sub-tasks, and cost attribution across agents — none of which the judge
  context (`types.ts:93-104`, single transcript + single sandbox `exec`)
  models today.

### 2.3 Recommendation (Q2)

v1: **homogeneous N workers, single config per cell** — `Scenario.workers`,
per-task `worker` index, parallel boot, per-worker artifact namespacing, array
`SandboxInfo`. This unlocks "two workers race / divide tasks" scenarios with
modest surface area. Defer: heterogeneous per-worker configs, lead-based
delegation scenarios, and unassigned-task routing (would require a lead or new
claim semantics).

---

## Q3 — SQL-dump seeding of the API DB

### 3.1 How seeding works today

`scenario.seed.exec` runs **in the worker sandbox**, **after** the full stack
is healthy (API booted, worker registered+idle) — `evals/src/runner/index.ts:246-285`,
via `sandboxExec` (`bash -lc`, root, 60 s cap, `sandbox.ts:315-339`). It
**cannot touch the API DB** — different sandbox. Outputs persist as
`seed-output.json` (`runner/index.ts:279-282`).

### 3.2 The API sandbox's DB and tooling

- DB path: `/app/data/agent-swarm-db.sqlite` (`Dockerfile:123`, evals override
  identical at `sandbox.ts:95`). Created at first server boot; migrations
  auto-applied by `runMigrations` (`src/be/db.ts:184-185`) from
  `/app/migrations` (`Dockerfile:87,124`). The runner keeps a `_migrations`
  table (version, name, checksum, applied_at — `src/be/migrations/runner.ts:116-119`),
  skips applied versions, verifies checksums (warns on mismatch), and
  bootstraps pre-migration DBs by marking `001_initial` applied when tables
  already exist (`runner.ts:109-111,176-178`).
- **No `sqlite3` CLI** in the API image — apt installs only ca-certificates,
  wget, curl, jq, python3, fuse3/libfuse2 (`Dockerfile:63-69`). But:
  - the **bun CLI** is present at `/usr/local/bin/bun` (`Dockerfile:75`) →
    `bun -e` with `bun:sqlite` works;
  - **python3** ships the stdlib `sqlite3` module as a fallback.
- Server lifecycle in evals: `bootStack` launches `/api-entrypoint.sh`
  (which just `exec`s the compiled `agent-swarm-api` binary,
  `api-entrypoint.sh:51-56`) **immediately** after `createSandbox`
  (`sandbox.ts:245-256`) and waits on `/health`. So at `seed.exec` time the
  server is running and holds the WAL-mode DB open.

### 3.3 Design options for `seed.sqlDump`

1. **Pre-boot import (recommended).** `createSandbox` does not start the
   entrypoint — `startDetachedProcess` is a separate call (`sandbox.ts:228-253`;
   `src/e2b/dispatch.ts:234,349`). Insert the import between them: no lock
   contention, no server caches to invalidate, and `runMigrations`
   forward-applies anything the dump predates at first boot.
2. *Stop → import → restart*: workable (kill the envd-tracked process, rerun
   entrypoint) but adds a second boot, double health-waits, and entrypoint-log
   ambiguity for zero benefit over (1).
3. *Import while running*: WAL tolerates concurrent INSERTs (with busy
   timeout), so small **additive** seeds would mostly work — but full dumps
   contain `CREATE TABLE`/`DROP`, which fight the server's open prepared
   statements, and boot-time seeding (pricing, prompt templates,
   `runBootReembed` at `src/http/index.ts:566`) has already run against the
   empty DB. Reject for dumps.

**Schema-version mismatch risks:**

- Dump **older** than image migrations → safe: forward-only runner applies the
  missing versions at boot (checksum warnings only if a *shipped* migration
  file was edited).
- Dump **without `_migrations` rows** but with tables → the pre-migration
  bootstrap marks only `001_initial` applied, then re-applies 002+ onto
  already-migrated tables → breakage. **Fixture dumps MUST include the
  `_migrations` table** (a full `.dump` does).
- Dump **newer** than the image (created on a later branch) → binary reads
  columns it doesn't know about: undefined behavior. Guard cheaply: runner
  asserts `SELECT MAX(version) FROM _migrations` in the dump ≤ the number of
  `.sql` files under `src/be/migrations/` at build time, or simply documents
  "regenerate fixtures when migrations change".

### 3.4 Recommended design + exact runner steps

Scenario schema: `seed.sqlDump?: string` — path resolved against
`evals/scenarios/fixtures/` (e.g. `"fixtures/two-agents-history.sql"`).
Fixtures are **full text dumps** (`sqlite3 dev.sqlite .dump > fixture.sql`)
— reviewable in git, schema+data+`_migrations` included.

Runner/bootStack execution order (new `preBootSql` option on `bootStack`):

1. Runner reads the dump host-side (`Bun.file(...).text()`), passes it to
   `bootStack`.
2. `createSandbox(API)` as today (`sandbox.ts:228-243`).
3. Upload: `Sandbox.connect(...).files.write("/tmp/seed.sql", dump)` (the e2b
   SDK file API; avoids shell-quoting megabyte heredocs through
   `commands.run`).
4. Import with the image's bun CLI:
   ```sh
   mkdir -p /app/data && bun -e '
     const { Database } = require("bun:sqlite");
     const db = new Database("/app/data/agent-swarm-db.sqlite");
     db.exec(require("fs").readFileSync("/tmp/seed.sql", "utf8"));
     db.close();
   ' && rm /tmp/seed.sql
   ```
   (multi-statement `exec` is supported by `bun:sqlite`; run via the existing
   `commands.run` root path).
5. `startDetachedProcess(/api-entrypoint.sh)` → health wait → migrations
   forward-apply on the seeded DB (`sandbox.ts:245-256` unchanged).
6. Persist import stdout/stderr as an artifact (`sql-seed-output.json`),
   secret-redacted like `seed-output.json`.

Caveats to document in the scenario authoring guide:

- Seed **reference data** (memories, scripts, pricing, workflows, historical
  tasks), not live agents — a dumped `agents` row is a phantom (no sandbox
  behind it) and could confuse lead-routing (`src/http/tasks.ts:374-383`
  routes unassigned ingress tasks to any agent with the lead role).
- The eval worker's `AGENT_ID` is a fresh UUID per attempt — dumps can't
  pre-reference it. If a fixture must point at "the worker under test", use a
  placeholder token (e.g. `__WORKER_AGENT_ID__`) string-replaced by the runner
  before upload — trivial since the dump is text.
- An alternative binary form (`seed.dbFixture: *.sqlite` written straight to
  `DATABASE_PATH` pre-boot) needs zero in-sandbox tooling but puts
  unreviewable binaries in git — keep `.sql` as the canonical format.

---

## Cross-cutting summary of recommended changes

1. **Q1**: `apiRuntimeEnv` forwards `OPENAI_API_KEY`/`EMBEDDING_API_KEY` (and
   optionally `NODE_ENV=production`, later `MEMORY_RATERS=implicit-citation`)
   from `evals/.env`; implement the already-typed `seed.memories` via
   `/api/memory/index`. That alone makes the 2-task memory scenario work.
2. **Q2**: v1 = homogeneous `Scenario.workers: number` + per-task `worker`
   index; arrays through `StackHandle`/`SandboxInfo`; per-worker artifact
   namespacing. Defer heterogeneous configs and lead topology.
3. **Q3**: `seed.sqlDump` = full text dump under `evals/scenarios/fixtures/`,
   imported **pre-boot** in the API sandbox via the image's bun CLI
   (`bun -e` + `bun:sqlite`), then normal entrypoint boot lets migrations
   forward-apply. No sqlite3 CLI exists in the image; don't try to seed the
   API DB from `seed.exec` (wrong sandbox, server already running).

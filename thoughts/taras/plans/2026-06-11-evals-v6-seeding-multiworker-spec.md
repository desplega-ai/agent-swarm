---
date: 2026-06-11
topic: "Evals round 6 — seed.sqlDump, seed.memories, multi-worker v1 (+ timestamped sandbox logs, Logs-tab display contract; ext: task dependencies, config-catalog seeding, multi-config picker, opencode infra-failure net, scenario proposals)"
author: Claude (design agent)
git_commit_at_design: 19e3bf8d
branch: feat/evals-subproject
status: ready-for-implementation
groundwork: thoughts/taras/research/2026-06-11-evals-sandbox-envs-multiworker-sql-seeding.md (Q2, Q3)
---

# Evals v6 implementation spec: SQL-dump seeding, memory seeding, multi-worker v1

> **DRIFT WARNING — read before implementing.** A parallel workflow is editing
> `evals/src/api/server.ts`, `evals/src/swarm/client.ts`, `evals/src/runner/index.ts`,
> `RunsPage`, and analytics files concurrently with this spec. **All line numbers in
> this document are approximate** (snapshot at commit `19e3bf8d`). Anchor every change
> to the **function/component names and flow descriptions** given here, not to line
> numbers. Re-read the current file state before editing. If a named function has been
> renamed/moved by the parallel work, find it by its described behavior.

This spec is written for **blind parallel implementation**: every cross-package
contract is **FROZEN** (exact type shapes, JSON shapes, artifact names, endpoint
bodies). Implementers must not deviate from frozen contracts without coming back to
Taras. Sections marked *implementation note* are advisory.

---

## 0. Frozen contracts summary (the inter-agent API)

These are the shapes every work package codes against. Defined once here; the
feature sections explain semantics.

### 0.1 Scenario schema additions (`evals/src/types.ts`)

```ts
export interface TaskSpec {
  title: string;
  description: string;
  /** Index of the worker this task is assigned to. Default 0. Must be < Scenario.workers. */
  worker?: number;                                     // NEW (F3)
  /**
   * Indices of tasks this task depends on (native swarm-API dependsOn, §9).
   * Every entry must be < this task's own index (validateScenario, §0.11).
   * Absent/empty = no dependencies.
   */
  dependsOn?: number[];                                // NEW (F4, §9)
}

export interface ScenarioSeed {
  /** Shell commands run inside worker 0's sandbox after the stack is healthy. */
  exec?: string[];
  /** Memories indexed into the swarm API (scope "swarm") before tasks start. */
  memories?: string[];                                 // EXISTS (typed), now implemented (F2)
  /**
   * Filename of a SQLite text dump under evals/scenarios/fixtures/, imported into
   * the API sandbox DB BEFORE the API server first boots. Bare filename only
   * (no path separators), must end in ".sql". Example: "seeded-history.sql".
   */
  sqlDump?: string;                                    // NEW (F1)
}

export interface Scenario {
  // ...existing fields unchanged (id, name, description?, tasks, seed?, outcome, timeoutMs?)
  /** Number of homogeneous workers to boot for each attempt. Default 1. Max 3. */
  workers?: number;                                    // NEW (F3)
}
```

### 0.2 StackHandle v2 (in-memory, `evals/src/swarm/sandbox.ts`)

`StackHandle` loses `workerSandbox` / `workerAgentId` / `workerVersion` and gains a
worker array plus the SQL-seed result. The runner is the only consumer; both files
are in the same work package (WP-A), so this is an internal-but-frozen contract:

```ts
export interface WorkerHandle {
  /** 0-based index, stable for the attempt's lifetime. */
  index: number;
  sandbox: E2BSandboxInfo;
  /** UUID generated host-side; the worker self-registers under it via AGENT_ID env. */
  agentId: string;
  /** `agent-swarm version` output inside this worker's sandbox; null = capture failed. */
  version: string | null;
}

export interface SqlSeedResult {
  fixture: string;        // bare filename, e.g. "seeded-history.sql"
  exitCode: number;       // always 0 on a returned StackHandle (non-zero throws in boot)
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface StackHandle {
  apiSandbox: E2BSandboxInfo;
  workers: WorkerHandle[];          // length === scenario.workers ?? 1, ordered by index
  apiUrl: string;
  swarmKey: string;
  apiVersion: string | null;
  sqlSeed: SqlSeedResult | null;    // null when scenario had no seed.sqlDump
  redact: (text: string) => string;
  kill: () => Promise<void>;        // idempotent teardown of API + ALL worker sandboxes
}
```

### 0.3 Persisted `sandboxJson` v2 (attempts.sandbox_json) — **the back-compat-critical shape**

Written by the runner at boot (in `runAttemptOnce`, the `updateAttempt(...{ sandboxJson })`
call right after `bootStack` returns). Old rows in existing `evals.db` files carry the
v1 flat shape; **new code always writes v2**; the UI normalizes both.

```jsonc
// v2 — discriminated by BOTH `"v": 2` and the presence of a `workers` array
{
  "v": 2,
  "apiSandboxId": "ix1abc...",
  "apiTemplate": "agent-swarm-api-latest",
  "apiUrl": "https://3013-....e2b.dev",
  "swarmKey": "evals-<uuid>",
  "domain": "e2b.dev",              // string | null
  "apiStartedAt": "2026-06-11T...", // string | null
  "apiVersion": "1.94.0",           // string | null
  "workers": [
    {
      "index": 0,
      "sandboxId": "ix2def...",
      "template": "agent-swarm-worker-latest",
      "agentId": "<uuid>",
      "startedAt": "2026-06-11T...",  // string | null
      "expiresAt": "2026-06-11T...",  // string | null (sandbox endAt/expiresAt)
      "version": "1.94.0"             // string | null
    }
    // ... one entry per worker, ascending index
  ]
}
```

**HARD INVARIANT:** the top-level keys `swarmKey` and `apiUrl` MUST stay top-level
and unrenamed in v2. The evals API server (`evals/src/api/server.ts`, NOT touched by
this spec) reads them out of the stored blob for the live-transcript path
(`/api/attempts/:id/transcript?live=1`). v1 and v2 agree on these keys, so the server
needs no change — keep it that way.

v1 (legacy, read-only) for reference — flat: `apiSandboxId, workerSandboxId,
apiTemplate, workerTemplate, apiUrl, swarmKey, workerAgentId, domain, apiStartedAt,
workerStartedAt, expiresAt, apiVersion?, workerVersion?`.

`attempts.sandbox_id` (the scalar column) keeps meaning **worker 0's sandboxId** —
set it to `stack.workers[0].sandbox.sandboxID`.

Runner-side TypeScript (`evals/src/types.ts`): rename today's `SandboxInfo` to the v2
shape (with `v: 2` and `workers: SandboxWorkerInfo[]`); the runner only ever writes it,
never reads it back, so no runner-side normalizer is needed.

```ts
export interface SandboxWorkerInfo {
  index: number;
  sandboxId: string;
  template: string;
  agentId: string;
  startedAt: string | null;
  expiresAt: string | null;
  version: string | null;
}
export interface SandboxInfo {        // v2 — the only shape new code writes
  v: 2;
  apiSandboxId: string;
  apiTemplate: string;
  apiUrl: string;
  swarmKey: string;
  domain: string | null;
  apiStartedAt: string | null;
  apiVersion: string | null;
  workers: SandboxWorkerInfo[];
}
```

### 0.4 UI normalizer (NEW file `evals/ui/src/lib/sandbox.ts`)

The UI must render BOTH shapes. Normalization happens in exactly one place:

```ts
// evals/ui/src/lib/sandbox.ts
import type { SandboxInfoJson } from "../types"; // becomes the union below

export interface NormalizedWorker {
  index: number;
  sandboxId: string;
  template: string | null;
  agentId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  version: string | null;
}
export interface NormalizedSandboxInfo {
  apiSandboxId: string;
  apiTemplate: string | null;
  apiUrl: string;
  swarmKey: string;
  domain: string | null;
  apiStartedAt: string | null;
  apiVersion: string | null;
  workers: NormalizedWorker[];
}

/** v2 if raw.v === 2 OR Array.isArray(raw.workers); otherwise treat as v1 flat. */
export function normalizeSandboxInfo(raw: unknown): NormalizedSandboxInfo | null;
```

v1 mapping rule (frozen): `workers = [{ index: 0, sandboxId: raw.workerSandboxId,
template: raw.workerTemplate ?? null, agentId: raw.workerAgentId ?? null,
startedAt: raw.workerStartedAt ?? null, expiresAt: raw.expiresAt ?? null,
version: raw.workerVersion ?? null }]`. Missing/garbage input → `null` (render the
existing "Sandbox info not captured" fallback).

`evals/ui/src/types.ts`: change `SandboxInfoJson` to the **union** of the v1 and v2
shapes (define `SandboxInfoV1Json` + `SandboxInfoV2Json`, `type SandboxInfoJson =
SandboxInfoV1Json | SandboxInfoV2Json`). All UI consumers go through
`normalizeSandboxInfo` — no direct field access on the union outside `lib/sandbox.ts`.

### 0.5 Artifact naming (runner → UI contract)

| Artifact | kind | name | Notes |
|---|---|---|---|
| Runner log | `log` | `runner.log` | unchanged |
| API entrypoint log | `sandbox-log` | `api.log` | unchanged; now line-timestamped (§5) |
| Worker entrypoint log | `sandbox-log` | `worker-<i>.log` | **NEW naming — always indexed, even when workers=1.** Legacy rows keep `worker.log`; UI maps `worker.log` → worker 0 |
| SQL seed output | `meta` | `sql-seed-output.json` | NEW (F1); JSON of `SqlSeedResult` |
| Memory seed record | `meta` | `seed-memories.json` | NEW (F2); see §2.4 |
| seed.exec output | `meta`* | `seed-output.json` | unchanged (*keep whatever kind it has today) |
| Harness session file | `harness-session` | `worker-<i>/<absolute path>` | **NEW prefix** when collected per worker; legacy rows have bare paths. UI renders name as-is (no parsing) |
| Session-file listing | (existing kind) | `worker-<i>/session-files.json` (or today's name prefixed) | prefix rule same as above |
| session-costs.json, session-logs.jsonl, transcript, tasks | — | — | unchanged |

### 0.6 Swarm API memory endpoints used (root repo, `src/http/memory.ts` — NOT modified)

**Index** — `POST {apiUrl}/api/memory/index`, headers `Authorization: Bearer <swarmKey>`.
Body (zod, exact):

```jsonc
{
  "content": "<memory text>",        // required, min 1
  "name": "seed-memory-1",           // required, min 1
  "scope": "swarm",                  // "agent" | "swarm" — evals always sends "swarm"
  "source": "manual",                // "manual" | "file_index" | "session_summary" | "task_completion"
  "tags": ["eval-seed"],             // optional
  // "agentId": "<uuid>"             // optional — OMITTED by evals (swarm scope)
  // sourceTaskId / sourcePath / persistMemory — unused by evals
}
```

Response `202 { "queued": true, "memoryIds": ["<uuid>", ...] }` (content is chunked
server-side → can be >1 id). **Embedding is async** — the server responds 202 and
embeds in the background; hence the readiness gate in §2.3.

**Search (readiness probe)** — `POST {apiUrl}/api/memory/search`, headers
`Authorization: Bearer <swarmKey>` **and `X-Agent-ID: <worker-0 agentId>`** (the route
hard-requires X-Agent-ID; without it → 400). Body:
`{ "query": "<text>", "limit": 5, "scope": "all" }`. Response
`200 { "results": [{ "id": "<memoryId>", ... }, ...] }`. With no embedding key
configured server-side it silently returns `{"results": []}` — the readiness gate
turns that silence into a loud attempt error.

Embedding key plumbing **already exists**: `apiRuntimeEnv` in `evals/src/swarm/sandbox.ts`
forwards host `EMBEDDING_API_KEY` and/or `OPENAI_API_KEY` into the API sandbox
(server-side `EMBEDDING_API_KEY` falls back to `OPENAI_API_KEY`). No change needed —
but the memory E2E scenarios REQUIRE one of those keys in `evals/.env`.

### 0.7 SwarmClient additions (`evals/src/swarm/client.ts` — ⚠ parallel-edit file)

Extend `private request<T>(method, path, body?)` with an optional
`headers?: Record<string, string>` parameter (merged over the defaults), then add:

```ts
async indexMemory(body: {
  content: string; name: string;
  scope: "swarm" | "agent"; source: "manual";
  agentId?: string; tags?: string[];
}): Promise<{ queued: boolean; memoryIds: string[] }>;   // POST /api/memory/index

async searchMemory(opts: {
  agentId: string;            // sent as X-Agent-ID header
  query: string;
  limit?: number;             // default 5
  scope?: "agent" | "swarm" | "all";  // default "all"
}): Promise<{ results: { id: string }[] }>;              // POST /api/memory/search
```

`createTask` (existing method) additionally gains an optional
`dependsOn?: string[]` opt (task UUIDs) passed through verbatim as the
`POST /api/tasks` body's `dependsOn` array — natively supported by the swarm
API (§9.1). No other call-shape change.

### 0.8 JudgeContext additions (`evals/src/types.ts` + ctx construction in `runAttemptOnce`)

```ts
export interface JudgeWorkerContext {
  index: number;
  agentId: string;
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile: (path: string) => ReturnType<typeof sandboxReadFile>; // same type as today's ctx.readFile
}

export interface JudgeContext {
  // existing: tasks, transcript, exec, readFile, apiGet — UNCHANGED SEMANTICS,
  // with exec/readFile now defined as ALIASES of workers[0] (back-compat for all
  // existing checks and the agentic judge).
  workers: JudgeWorkerContext[];   // NEW — one entry per booted worker
}
```

The agentic judge (`evals/src/judge/agentic.ts`) stays bound to `ctx.exec`/`ctx.readFile`
= worker 0 in v1 (documented limitation, see Non-goals).

### 0.9 Deterministic check helpers (`evals/src/judge/deterministic.ts`)

```ts
/** Like fileContains, but against ctx.workers[worker]. Name: `file-contains[w<worker>]:<path>` */
export function fileContainsOnWorker(worker: number, path: string, pattern: RegExp): DeterministicCheck;

/** Passes when the file does NOT exist on that worker. Name: `file-absent[w<worker>]:<path>` */
export function fileAbsentOnWorker(worker: number, path: string): DeterministicCheck;
```

Both must return `{ pass: false, detail: "worker <n> not booted" }` when
`ctx.workers[worker]` is missing (defensive; registry validation should prevent it).

### 0.10 SerializedScenario v2 (`evals/src/registry.ts` → consumed by server `/api/scenarios` + UI ScenariosPage)

```ts
export interface SerializedScenario {
  id: string; name: string; description: string | null;
  workers: number;                                          // NEW, default 1
  tasks: { title: string; description: string; worker: number; dependsOn: number[] }[];  // worker ?? 0, dependsOn ?? []
  seed: { exec: string[]; sqlDump: string | null; memories: string[] } | null;  // EXTENDED
  timeoutMs: number;
  outcome: { /* unchanged */ };
}
```

`seed` is non-null when ANY of exec/sqlDump/memories is present; absent members
serialize as `[]` / `null` / `[]` respectively. This is additive for the UI — old
clients ignore unknown fields; ScenariosPage MAY render the new fields (optional
polish, WP-C).

### 0.11 Scenario validation (`evals/src/registry.ts`)

```ts
/** Returns human-readable violations; empty array = valid. */
export function validateScenario(s: Scenario): string[];
```

Rules (frozen):
- `workers` if present: integer, `1 <= workers <= 3`.
- every `task.worker` if present: integer, `0 <= worker < (s.workers ?? 1)`.
- `seed.sqlDump` if present: matches `/^[A-Za-z0-9._-]+\.sql$/` (bare filename, no
  path separators — prevents traversal out of `evals/scenarios/fixtures/`).
- `seed.memories` if present: every entry non-empty string; max 16 entries.
- every `task.dependsOn` if present: integer entries, no duplicates, each entry
  `0 <= d < taskIndex` (strictly earlier task). Self-references, forward
  references — and therefore cycles — are impossible by construction; this rule
  IS the cycle check (§9.2). Scenario authors list tasks in topological order
  (every DAG has one, so this is not a restriction).

`loadRegistry()` calls `validateScenario` for every registered scenario and **throws**
an aggregated error listing all violations (fail fast at CLI/server startup). File
*existence/content* of the dump is validated later, host-side in the runner (§1.3),
so a missing fixture breaks one attempt, not the whole registry.

### 0.12 Skipped-task classification (F4 — `evals/src/types.ts` + runner + WP-C UI)

The swarm API cascade-fails dependents of a failed/cancelled/timed-out dependency
(§9.1). The runner classifies those records as **skipped** with one frozen regex,
applied to `task.failureReason` when `task.status === "failed"`:

```ts
/** Matches root src/be/db.ts cascadeFailDependents(): `Blocked dependency <uuid8> was <status>` */
export const CASCADE_SKIP_RE = /^Blocked dependency [0-9a-f]{8} was /;
```

`SwarmTask` (`evals/src/types.ts`) gains two optional fields. This is additive:
the interface already carries `[key: string]: unknown` and `normalizeTask`
spreads the raw record, so `failureReason` already flows through to `tasks.json`
today — the change merely types it and adds the runner-computed flag:

```ts
export interface SwarmTask {
  // ...existing fields unchanged
  failureReason?: string | null;  // NEW (typed; server-populated on failed tasks)
  /** Runner-computed: status === "failed" && CASCADE_SKIP_RE.test(failureReason ?? ""). */
  skipped?: boolean;              // NEW (F4, set right after waitForTask resolves)
}
```

`skipped` is persisted verbatim into the `tasks.json` artifact (judges and the
UI both read it). The UI duplicates the frozen `CASCADE_SKIP_RE` source string
in `RunDetailsPage` as a fallback for rows whose tasks.json predates the flag.

### 0.13 Infra-failure signatures (F7 — `evals/src/runner/index.ts`)

```ts
export interface InfraFailureSignature {
  id: string;       // stable slug; appears in attempt error messages
  pattern: RegExp;  // tested against task.failureReason of terminal "failed" tasks ONLY
  hint: string;     // appended to the attempt error message
}

export const INFRA_FAILURE_SIGNATURES: InfraFailureSignature[] = [
  {
    id: "opencode-spawn-timeout",
    pattern: /Spawn failed: Timeout waiting for server/i,
    hint:
      "opencode server failed to start inside the worker sandbox (cold-start flake; " +
      "the root-repo OPENCODE_SERVER_TIMEOUT_MS fix reaches sandboxes only with the " +
      "next release's worker-template publish — this net is the interim + permanent insurance).",
  },
];

export class InfraTaskFailureError extends Error {
  constructor(
    public readonly signatureId: string,
    public readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = "InfraTaskFailureError";
  }
}
```

Frozen error-message shape (becomes the attempt's stored error text when retries
are exhausted): `infra failure (<signatureId>): task <taskId> failed with
"<failureReason, clipped to 300 chars>". <hint>`

**Precedence (frozen):** the signature check runs BEFORE skip classification
(§0.12) — an infra-failed dependency must retry the whole attempt, never produce
a scored attempt with skipped dependents. Full semantics in §12.

### 0.14 Harness-config catalog contract (F5 — `evals/configs/index.ts`)

- **Naming (frozen):** `<provider>-<short>[-<variant>]`, lowercase, matching
  `/^(claude|pi|opencode|codex)-[a-z0-9][a-z0-9.-]*$/`. `<short>` drops the
  vendor path (`deepseek-pro`, not `deepseek-deepseek-v4-pro`); version dots
  allowed (existing `codex-5.4` precedent).
- **Credentials (frozen):** catalog entries carry NO `env` block — provider
  creds are injected at boot exclusively by `credentialsForConfig` in
  `evals/src/swarm/sandbox.ts` (claude → CLAUDE_CODE_OAUTH_TOKEN, else
  ANTHROPIC_API_KEY; codex → OPENAI_API_KEY; pi/opencode → key chosen by the
  model's provider prefix, `openrouter/...` → OPENROUTER_API_KEY). Therefore
  `serializeConfig(...).envKeys` stays `[]` for every catalog entry; never put
  a secret value in `config.env`.
- **isDefault (frozen):** `DEFAULT_CONFIG_IDS` stays exactly
  `["claude-haiku", "pi-deepseek-flash", "opencode-gemini-flash"]` — a small
  curated trio; the catalog growing does NOT grow the defaults.
- **Models (frozen):** catalog entries pin concrete `model` strings
  (`openrouter/<cache-id>` for pi/opencode); `modelTier` stays unset in the
  catalog — tier-resolved configs would grade a moving target.

### 0.15 ConfigMultiSelect component contract (F6 — `evals/ui/src/components/ConfigMultiSelect.tsx`, NEW)

```ts
export function ConfigMultiSelect(props: {
  configs: ConfigJson[];               // full /api/configs catalog (isDefault included)
  selected: Set<string>;               // selected config ids
  onChange: (next: Set<string>) => void;
}): ReactNode;
```

Interaction contract frozen in §11.2. ALL new styles go in NEW
`evals/ui/src/pages/new-run.css` — `runs.css` is NOT touched (§11.4).

---

## 1. Feature 1 — `seed.sqlDump`: pre-boot SQL import into the API sandbox DB

Per research Q3 recommendation: import between API-sandbox creation and API server
start, so the server's first boot forward-applies any missing migrations onto the
seeded DB and boot-time re-embed/caches see the seeded rows.

### 1.1 bootStack signature change

`bootStack(opts)` gains one optional field:

```ts
/** SQL text dump imported into /app/data/agent-swarm-db.sqlite BEFORE the API entrypoint starts. */
preBootSql?: { fixture: string; text: string };
```

The **runner** reads the fixture host-side and passes `{ fixture, text }`; bootStack
never touches the host filesystem.

### 1.2 Exact bootStack flow (anchored to existing step names, not line numbers)

Inside `bootStack`, between *"createSandbox(API template, apiRuntimeEnv, …)"* and
*"startDetachedProcess({ command: '/api-entrypoint.sh', role: 'api', cwd: '/app' })"*,
insert when `opts.preBootSql` is set:

1. `log("importing SQL seed <fixture> (<n> bytes)")`.
2. Upload via the E2B files API (avoids shell-quoting megabyte heredocs). Add a
   module-local helper next to `sandboxExec`:
   ```ts
   async function sandboxWriteFile(sandboxId: string, path: string, content: string): Promise<void> {
     const { Sandbox } = await import("e2b");
     const sandbox = await Sandbox.connect(
       sandboxId,
       e2bSdkConnectionOptions(e2bControllerKey(), {}, e2bApiBase()),
     );
     await sandbox.files.write(path, content);
   }
   ```
   (`e2bSdkConnectionOptions` is already exported from `src/e2b/dispatch.ts`.)
   Write to `/tmp/eval-seed.sql` on the **API** sandbox.
3. Import with the image's bun (multi-statement `db.exec` is supported by `bun:sqlite`;
   a full `.dump` includes its own `BEGIN TRANSACTION`/`COMMIT`/PRAGMAs):
   ```ts
   const IMPORT_CMD =
     `mkdir -p /app/data && bun -e '` +
     `const { Database } = require("bun:sqlite");` +
     `const db = new Database("/app/data/agent-swarm-db.sqlite");` +
     `db.exec(require("fs").readFileSync("/tmp/eval-seed.sql", "utf8"));` +
     `db.close();` +
     `' && rm -f /tmp/eval-seed.sql`;
   const t0 = Date.now();
   const res = await sandboxExec(apiSandbox.sandboxID, IMPORT_CMD);
   ```
   (`sandboxExec` already runs `bash -lc` as root with a 60 s cap and never throws on
   non-zero exit — works pre-entrypoint because envd is independent of the entrypoint.)
4. **Failure = boot failure.** If `res.exitCode !== 0`, throw
   `new Error(\`sql-seed import failed (exit ${res.exitCode}) for fixture ${fixture}: ${redacted stderr/stdout, clipped to 2000 chars}\`)`.
   The existing `catch` in bootStack kills all created sandboxes; the attempt surfaces
   the message via the existing attempt-error path. (The runner's infra-retry may
   retry once; a deterministic dump failure fails again with the same clear message —
   acceptable.)
5. On success, set `stackHandle.sqlSeed = { fixture, exitCode: 0, durationMs, stdout, stderr }`
   (stdout/stderr clipped to 20 000 chars each, matching `SEED_OUTPUT_CLIP`).
6. Continue with `startDetachedProcess(/api-entrypoint.sh)` → health wait → version
   capture exactly as today. Migrations forward-apply on the seeded DB at first boot.

Timing: the import is part of the **boot** phase (`timings.bootMs`); no new
AttemptPhase.

### 1.3 Runner-side flow (in `runAttemptOnce`, before calling `bootStack`)

When `scenario.seed?.sqlDump` is set:

1. Resolve `evals/scenarios/fixtures/<sqlDump>` relative to the evals package root
   (use `import.meta` -relative resolution consistent with how scenarios are loaded,
   NOT `process.cwd()`).
2. Read with `Bun.file(...).text()`. Missing file → attempt error
   `sql-seed fixture not found: scenarios/fixtures/<name>` (thrown before any sandbox
   is created — zero E2B cost).
3. **Content validation (frozen rules):**
   - must match `/CREATE TABLE\s+(IF NOT EXISTS\s+)?["'\`]?_migrations/i` **and**
     `/INSERT INTO\s+["'\`]?_migrations/i` — i.e. the dump carries the `_migrations`
     table with applied rows. Rationale (research Q3): a dump with tables but no
     `_migrations` rows makes the migration bootstrapper re-apply 002+ onto
     already-migrated tables → breakage. A full `sqlite3 ... .dump` always satisfies this.
   - size cap: 5 MB (attempt error above it — fixtures are reference data, not prod DBs).
   Violation → attempt error `sql-seed fixture invalid: <reason>` (again pre-sandbox).
4. Pass `preBootSql: { fixture: scenario.seed.sqlDump, text }` to `bootStack`.
5. In the **artifacts** phase, when `stack.sqlSeed` is non-null, persist artifact
   kind `meta`, name `sql-seed-output.json`, content
   `stack.redact(JSON.stringify(stack.sqlSeed, null, 2))`.

### 1.4 Fixture conventions (`evals/scenarios/fixtures/` — NEW directory, WP-B owns)

Documented in a `fixtures/README.md` (short) plus the evals README "Defining
scenarios" section:

- Fixtures are **full text dumps**: `sqlite3 <db> .dump > fixture.sql` — reviewable in
  git, include schema + data + `_migrations`.
- **Seed reference data only** (historical tasks, scripts, pricing, workflows,
  memories-as-rows are discouraged — see below). Do NOT seed live operational state:
  no `agents` rows (workers self-register at boot; a pre-seeded agent row with a
  colliding ID would be silently reused), no in-flight tasks (`pending`/`running`
  rows would be claimed by the booting worker), no sessions/locks.
- Do NOT hand-seed `agent_memory` rows via SQL — embeddings live in a sqlite-vec
  virtual table and dumps of it are not portable; use `seed.memories` (F2) instead.
- Dumps older than the image are safe (forward-only migrations apply the rest at
  boot). Dumps **newer** than the image (created on a later branch) are NOT supported
  — regenerate against `main`'s migration set.
- Regeneration recipe (commit alongside any scenario change that needs new data):
  ```bash
  rm -f /tmp/fixture-src.sqlite
  DATABASE_PATH=/tmp/fixture-src.sqlite bun run start:http   # fresh DB, migrations apply
  # ... curl the API to create the reference rows you need ...
  sqlite3 /tmp/fixture-src.sqlite .dump > evals/scenarios/fixtures/<name>.sql
  ```
- Keep < 1 MB where possible (hard cap 5 MB, §1.3).

### 1.5 Demo fixture + scenario (WP-B)

**Fixture `seeded-history.sql`** — full dump of a fresh dev DB plus exactly one
completed historical task with the distinctive title
`Calibrate the flux capacitor` (status `completed`, a short result text). Built with
the recipe above (create the task via `POST /api/tasks`, complete it via the
store-progress endpoint or direct status update curl — whatever the API allows; the
exact rows just need `tasks.status = 'completed'`).

**Scenario `sql-seeded-history`** (`evals/scenarios/sql-seeded-history.ts`):

- `seed: { sqlDump: "seeded-history.sql" }`
- one task: *"Query the swarm API at `$MCP_BASE_URL/api/tasks` (your `API_KEY` env var
  is the bearer token) and find the completed task about a flux capacitor. Write its
  exact title to `/workspace/seeded-task.txt`, then report completion via
  store-progress."*
- checks:
  - custom check `seeded-task-visible`: `ctx.apiGet("/api/tasks")` and pass iff some
    task title matches `/flux capacitor/i` — proves the import itself worked even if
    the agent flubs the task.
  - `fileContains("/workspace/seeded-task.txt", /flux capacitor/i)` — proves the agent
    consumed seeded data.
- `passThreshold` and judge: deterministic-only (no LLM judge needed); `timeoutMs: 8 * 60_000`.
- Register in `evals/scenarios/index.ts`.

---

## 2. Feature 2 — `seed.memories`: wire the typed field to `/api/memory/index`

### 2.1 Semantics

Each string in `scenario.seed.memories` becomes one swarm-scope memory in the freshly
booted stack, indexed via the API (NOT via SQL — embeddings must be computed by the
server's embedding provider). Because scope is `swarm`, every worker (multi-worker
included) can retrieve them; the server's automatic memory-injection into task prompts
and the worker-side memory MCP tools both work once embeddings exist.

### 2.2 Where it runs (frozen ordering)

Inside the existing **seed** phase of `runAttemptOnce` (`setAttemptPhase(attempt.id, "seed")`),
which currently only handles `seed.exec`. The phase now runs when
`seed?.exec?.length || seed?.memories?.length` and executes **in this order**:

1. **Memories first** — index all, then the readiness gate (§2.3).
2. **Then `seed.exec`** — unchanged behavior (exec runs in **worker 0's** sandbox:
   `sandboxExec(stack.workers[0].sandbox.sandboxID, cmd)`). Rationale: exec scripts may
   want to assert on the seeded environment.

Both complete before the first `createTask` — required, since memory injection happens
at task-prompt build time on the server.

### 2.3 Payload mapping + readiness gate (frozen)

For each `memories[i]` (0-based), the runner calls
`client.indexMemory({ content: memories[i], name: \`seed-memory-${i + 1}\`,
scope: "swarm", source: "manual", tags: ["eval-seed"] })` and collects the returned
`memoryIds` (union across all entries).

**Readiness gate** (new runner helper, suggested name `awaitSeededMemoriesSearchable`):
embedding is async (202-queued), so poll until every collected memoryId is retrievable:

- For each seeded entry, every 3 s call
  `client.searchMemory({ agentId: stack.workers[0].agentId, query: <first 120 chars of that entry's content>, limit: 5, scope: "all" })`
  and check that at least one of that entry's memoryIds appears in `results[].id`.
- Overall deadline **90 s** (wall clock, shared across entries; check `signal` each
  iteration). All entries found → record `readinessMs` and proceed.
- **Timeout or any index call non-2xx → attempt error** (not a silent continue):
  `seed.memories failed: <detail> — memories never became searchable; check
  EMBEDDING_API_KEY / OPENAI_API_KEY in evals/.env (the API sandbox needs an embedding
  key for memory scenarios)`.
  Rationale: a memory scenario without working embeddings would fail mysteriously at
  judging time; fail loudly at seed time instead.

### 2.4 Artifact

In the artifacts phase, when memories were seeded, persist kind `meta`, name
`seed-memories.json`:

```jsonc
{ "requested": 2, "memoryIds": ["...", "..."], "readinessMs": 8412 }
```

(redacted via `stack.redact`, like every artifact).

### 2.5 Demo scenarios (WP-B)

**Primary — `memory-pipeline`** (`evals/scenarios/memory-pipeline.ts`) — the headline
"knowledge flows between tasks via memory" proof. No `seed.memories`; two tasks
chained with an explicit dependency — task 2 declares `dependsOn: [0]` (native
swarm-API dependency, §9), which puts the scenario in DAG creation mode: both
tasks are created upfront and the server holds task 2 `pending` until task 1
completes:

- Task 1 (worker default 0) — *"Establish deploy knowledge"*: description states the
  fact and instructs the agent to persist it as a memory:
  *"The production deploy host for project Nightjar is `nightjar-prod.internal`, port
  `8422`. Store this fact in swarm memory using your memory tools (index a memory
  containing the host and port) so other agents can find it later, then report
  completion via store-progress."*
- Task 2 (`dependsOn: [0]`) — *"Recall deploy knowledge"*: description deliberately omits the value:
  *"Another agent previously recorded the production deploy host and port for project
  Nightjar. Retrieve that knowledge from memory (search your memories; do not guess
  and do not invent a value) and write exactly `<host>:<port>` to
  `/workspace/nightjar-deploy.txt`, then report completion via store-progress."*
- Checks: `fileContains("/workspace/nightjar-deploy.txt", /nightjar-prod\.internal:8422/)`
  (+ implicit tasks-completed).
- Agentic judge rubric: verify the file content AND that task 2's transcript shows the
  value came from memory retrieval (a memory search/injection), not from guessing.
- `timeoutMs: 12 * 60_000` (two sequential tasks).
- Note in the scenario comment: task 1's session summary is itself auto-indexed
  (source `session_summary`) — either retrieval path (explicit tool-stored memory or
  the summary) counts as "memory works".

**Variant — `memory-seeded-recall`** (`evals/scenarios/memory-seeded-recall.ts`) —
the simpler plumbing proof, exercises F2 directly:

- `seed: { memories: ["The production deploy host for project Nightjar is nightjar-prod.internal, port 8422. This is the canonical deploy target recorded by the platform team."] }`
- One task: same wording as `memory-pipeline` task 2.
- Same deterministic check; LLM judge optional. `timeoutMs: 8 * 60_000`.
- This one is the F2 E2E gate (it fails fast at seed time if embeddings are broken).

Register both in `evals/scenarios/index.ts`.

---

## 3. Feature 3 — multi-worker v1 (homogeneous N, explicit per-task worker index)

Per research Q2 recommendation: N identical workers (same `HarnessConfig`), each task
explicitly routed to one worker by index. Heterogeneous configs and lead orchestration
are out of scope (Non-goals §7).

### 3.1 Schema + validation

`Scenario.workers?: number` (default 1, cap 3) and `TaskSpec.worker?: number`
(default 0) — shapes in §0.1, validation in §0.11.

### 3.2 bootStack changes (`evals/src/swarm/sandbox.ts`)

Current flow boots one worker inline. New flow:

1. Generate `workerAgentIds: string[]` — one `crypto.randomUUID()` per worker.
   (UUIDs are required anyway — the memory API's `agentId` is `z.string().uuid()`,
   and the existing `waitForAgentRegistration`/`waitForAgentReady` polls are keyed by
   this id. The worker receives it via the **`AGENT_ID` env var** in `workerRuntimeEnv`
   — `docker-entrypoint.sh` self-registers against the API with `X-Agent-ID: $AGENT_ID`
   headers, creating one agent row per unique id. This is exactly why a shared id is
   rejected by `e2b start-stack --workers N` in the root repo: duplicate AGENT_ID
   collapses N workers into one agent row.)
2. API sandbox boot: unchanged (plus the optional §1.2 SQL import).
3. Boot N workers **in parallel** (`Promise.all` over a per-worker async closure) —
   sequential boots add ~1–3 min each (registration + idle waits). Each closure runs
   today's exact single-worker steps:
   - `createSandbox` with `workerRuntimeEnv({ swarmKey, apiUrl, agentId: workerAgentIds[i], config })`
     and metadata as today **plus `workerIndex: String(i)`** (metadata `swarm: opts.swarmSlug`
     stays identical across all sandboxes → `sweepRunSandboxes` needs NO change).
   - push the sandbox into the shared `created[]` array immediately after creation
     (synchronous push — safe under concurrency; the existing catch-all `kill()` then
     covers partially-booted stacks).
   - `startDetachedProcess({ command: <timestamp-wrapped entrypoint, §5>, role: "worker", cwd: "/workspace", env: workerEnv })`.
   - `waitForAgentRegistration(apiUrl, workerAgentIds[i], swarmKey, waitMs)` →
     `waitForAgentReady({ agentId: workerAgentIds[i], ... })`.
   - per-worker version capture (`sandboxExec(sandbox.sandboxID, "agent-swarm version")`,
     best-effort → null).
   - resolve to a `WorkerHandle { index: i, sandbox, agentId, version }`.
4. `redact`: merge **every** worker's env into the secret set —
   `const secretEnv = Object.assign({}, ...allWorkerEnvs, apiEnv, { E2B_API_KEY: e2bKey })`.
5. Return `StackHandle` per §0.2; `kill()` tears down API + all workers (iterate
   `created[]` as today).

Worker boot timeout note: `Promise.all` rejects on the first failure; the catch kills
everything created so far — same failure semantics as today, now covering N sandboxes.

### 3.3 Runner changes (`evals/src/runner/index.ts` — ⚠ parallel-edit file; anchor to function names)

All inside `runAttemptOnce` unless noted:

- **sandboxJson write** (right after `bootStack` returns): build the v2 `SandboxInfo`
  (§0.3) from `stack`; `updateAttempt(db, attempt.id, { sandboxId: stack.workers[0].sandbox.sandboxID, apiUrl: stack.apiUrl, sandboxJson: JSON.stringify(sandboxInfo) })`.
- **markAttemptStart**: call for EVERY worker —
  `await Promise.all(stack.workers.map((w) => markAttemptStart(w.sandbox.sandboxID)))`.
- **Task creation loop** (the `for (const spec of scenario.tasks)` loop): resolve
  `const w = stack.workers[spec.worker ?? 0]`. Defensive guard: if `w` is undefined,
  throw an attempt error (`task "<title>" references worker <n> but only <N> booted`).
  Then `client.createTask({ task: \`${spec.title}\n\n${spec.description}\`, agentId: w.agentId })`.
  **`agentId` must NEVER be omitted** — an unassigned task routes to a lead, and eval
  stacks have no lead (the task would rot unclaimed until timeout). Update the log line
  to include the worker index: `[task] creating "<title>" → worker <i> (<agentId>)`.
  The loop stays **sequential** (create → await → next) for scenarios with no
  `dependsOn`; when ANY task declares `dependsOn`, the runner switches to the DAG
  creation mode of §9.3 (create all upfront with native deps, await in index
  order). Cross-worker task parallelism is still not a graded feature (Non-goals).
- **Log capture / cost capture: NO CHANGE** (verified): `client.getStableSessionLogs(taskId)`
  and `client.waitForSessionCostRows(taskId)` are per-*task* API calls against the swarm
  API — worker-count-agnostic. The `recomputeCost({ ..., sessionFiles })` fallback
  receives the union of all workers' session files (see next bullet) — correct at
  attempt granularity, since each task ran on exactly one worker and files are disjoint
  across sandboxes.
- **Harness session files**: loop workers —
  `collectHarnessSessionFiles(w.sandbox.sandboxID, config.provider)` per worker (it is
  already per-sandbox parameterized). Keep the in-memory union (raw `file.path`) for
  `recomputeCost`; when persisting artifacts, prefix names per §0.5:
  harness-session name = `worker-${w.index}/${file.path}` (+ existing " (truncated)"
  suffix rule), and the listing artifact name prefixed the same way. Per-worker
  collection failures stay non-fatal (log + continue), as today.
- **JudgeContext**: build `workers: stack.workers.map((w) => ({ index: w.index, agentId: w.agentId, exec: (cmd) => sandboxExec(w.sandbox.sandboxID, cmd), readFile: (p) => sandboxReadFile(w.sandbox.sandboxID, p) }))`;
  keep `exec`/`readFile` pointing at worker 0 (alias of `workers[0]`).
- **Entrypoint log artifacts** (artifacts phase): API log unchanged
  (`tail -n 500 /tmp/agent-swarm-e2b-api.log` → `api.log`). Worker logs: loop workers,
  `tail -n 2000 /tmp/agent-swarm-e2b-worker.log` **in each worker sandbox** (the path
  is per-sandbox, computed from role by `sandboxLogPath("worker")` — identical inside
  every worker) → artifact kind `sandbox-log`, name `worker-${w.index}.log`.
  **Always indexed naming**, even for 1 worker (§0.5).
- **Teardown / sweep / live-progress / phases**: no changes. `sweepRunSandboxes`
  matches `metadata.swarm`, shared by all sandboxes of the attempt.

### 3.4 UI changes (WP-C — `RunDetailsPage.tsx`, `ui/src/types.ts`, new `ui/src/lib/sandbox.ts`)

All consumption goes through `normalizeSandboxInfo` (§0.4).

- **SandboxPanel** (the `SandboxPanel`/`SandboxView` components using `SANDBOX_LABELS`
  + `PrettyView`): render one API block (apiSandboxId, apiTemplate, apiUrl, swarmKey,
  apiVersion, apiStartedAt) and one block per `workers[]` entry titled `Worker` when
  there's exactly one, `Worker 0` / `Worker 1` / … otherwise (sandboxId, agentId,
  template, version, startedAt, expiresAt). Keep the Raw-JSON toggle showing the
  stored blob verbatim (v1 or v2 — useful for debugging).
- **LogsTab** (the `LogsTab` component + `findLogArtifact` helper): the `LogSource`
  union becomes dynamic — `"runner" | "api" | \`worker-${number}\``. Sub-tab list:
  `Runner`, then one worker tab per worker (label `Worker` if one, `Worker 0…N-1`
  otherwise), then `API`. Worker count = `normalizeSandboxInfo(attempt.sandbox)?.workers.length`,
  falling back to the distinct `worker(-\d+)?\.log` artifact names when sandbox info is
  absent. `findLogArtifact` rules (frozen):
  - `runner` → kind `log` name `runner.log` (fallback: any kind `log`) — unchanged.
  - `api` → kind `sandbox-log` name `api.log` — unchanged.
  - `worker-<i>` → kind `sandbox-log` name `worker-<i>.log`; **for i === 0 only**,
    fall back to legacy name `worker.log`.
  Live runner stream behavior unchanged.
- **Transcript / task views: confirm-only, no change.** They are keyed per task
  (session logs, transcript rows, task records) and never reference a worker sandbox;
  per-task data is already correct under multi-worker.
- **ScenariosPage** (optional polish): render `workers`, per-task `worker`, and the
  extended `seed` from SerializedScenario v2.

### 3.5 Demo scenario (WP-B) — `two-workers`

`evals/scenarios/two-workers.ts`:

```ts
export const twoWorkers: Scenario = {
  id: "two-workers",
  name: "Two workers",
  description: "Boots one API + two workers; routes one marker-file task to each worker and verifies both the side effects and the sandbox isolation (each file exists ONLY on its own worker).",
  workers: 2,
  tasks: [
    { title: "Create marker A", worker: 0,
      description: "Create /workspace/eval-worker-a.txt containing exactly one line:\n\nworker-a-ok\n\nThen report completion via store-progress." },
    { title: "Create marker B", worker: 1,
      description: "Create /workspace/eval-worker-b.txt containing exactly one line:\n\nworker-b-ok\n\nThen report completion via store-progress." },
  ],
  outcome: {
    checks: [
      fileContainsOnWorker(0, "/workspace/eval-worker-a.txt", /worker-a-ok/),
      fileContainsOnWorker(1, "/workspace/eval-worker-b.txt", /worker-b-ok/),
      // isolation proof: the cross files must NOT exist
      fileAbsentOnWorker(0, "/workspace/eval-worker-b.txt"),
      fileAbsentOnWorker(1, "/workspace/eval-worker-a.txt"),
    ],
    passThreshold: 1,
  },
  timeoutMs: 10 * 60 * 1000,
};
```

(Tasks execute sequentially in v1 — the scenario proves **routing + isolation +
per-worker artifacts/logs/versions**, not concurrency.) Register in
`evals/scenarios/index.ts`.

---

## 4. Fold-in A — timestamped detached-process stdout (API + worker entrypoint logs)

Today `startDetachedProcess` (root `src/e2b/dispatch.ts`) wraps the command via
`buildTrackedShell(command, logPath)` = `set -o pipefail; <command> 2>&1 | tee <logPath>`
— no timestamps. **Do NOT modify dispatch.ts** (shared with the root e2b CLI; broader
blast radius). Instead, wrap the command string evals passes in, in
`evals/src/swarm/sandbox.ts`:

```ts
/**
 * Pipe each output line through a pure-bash ISO-8601 UTC timestamper.
 * - stdbuf -oL -eL line-buffers the producer (both images ship coreutils).
 * - printf '%(...)T' is a bash builtin (no per-line fork); second precision.
 * - `|| [ -n "$line" ]` flushes a trailing unterminated line at EOF.
 * - Composes with buildTrackedShell's pipefail: the entrypoint's non-zero exit still
 *   propagates through the pipeline, so startDetachedProcess's 2s liveness poll and
 *   launch-failure detection keep working.
 */
function withLineTimestamps(cmd: string): string {
  return (
    `stdbuf -oL -eL ${cmd} 2>&1 | ` +
    `while IFS= read -r line || [ -n "$line" ]; do ` +
    `TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T %s\\n' -1 "$line"; ` +
    `done`
  );
}
```

Apply at BOTH `startDetachedProcess` call sites in `bootStack`:
`command: withLineTimestamps("/api-entrypoint.sh")` and
`command: withLineTimestamps("/docker-entrypoint.sh")`.

Resulting log-line shape (frozen, consumed by §6's timestamp parser):
`2026-06-11T21:30:05Z <original line>` — ISO-8601 UTC, one space, raw line (which may
itself contain ANSI codes; stripping happens at render, §6).

*Implementation notes:* `tee` then receives already-timestamped lines, so both the
sandbox file (`/tmp/agent-swarm-e2b-{api,worker}.log`) and the captured
`worker-<i>.log` / `api.log` artifacts carry per-line timestamps. The early-liveness
window (2 s) is unaffected — the wrapper itself cannot fail at launch unless `stdbuf`
is missing; both images are Debian-based with coreutils. If an image ever drops
coreutils, the visible failure is an instant non-zero exit caught by the liveness
poll with a clear `stdbuf: command not found` in the captured detail.

## 5. Fold-in B — Logs-tab display contract (runner / worker / api alike)

UI-only (WP-C). Today `LogsTab` renders runner lines via `RUNNER_LINE_RE`
(`/^(\S+) \[(info|warn|error)\] (.*)$/`) and pino-ish JSON via `jsonLogRow`; plain
worker/api lines render flat. New contract — a shared line model + renderer used by
all three sources AND the live runner stream (suggested: extract
`evals/ui/src/components/LogLines.tsx`, or keep the helpers inside RunDetailsPage —
implementer's choice, but ONE shared path):

```ts
interface ParsedLogRow {
  ts: string | null;                       // ISO string when parseable, else null
  level: "error" | "warn" | "info" | "banner";
  text: string;                            // ANSI-stripped, ts prefix removed
}
```

Per-line pipeline (frozen order):

1. **ANSI strip** (render-time only; stored artifacts keep raw bytes):
   `line.replace(/\[[0-9;?]*[A-Za-z]/g, "")`.
2. **Structured parses first** (existing behavior preserved): runner lines via
   `RUNNER_LINE_RE` (ts + level + text already explicit); JSON lines via `jsonLogRow`
   (pino levels: ≥50 → error, 40 → warn, else info; extract `time`/`ts` field when
   present).
3. **Timestamp extraction** (worker/api + any unstructured line): leading
   `/^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+/`
   → `ts`, remainder → text. (Matches §4's `<iso>Z <line>` prefix.)
4. **Severity heuristics** on the remaining text (first match wins):
   - `error`: `/\b(error|err|fatal|panic|unhandled|exception|traceback)\b/i` or text
     starts with `✗`
   - `warn`: `/\b(warn|warning|deprecated|retry(ing)?|timed?\s?out)\b/i`
   - `banner`: text is only separator/box characters or whitespace
     (`/^[\s=\-_*#~+|│┌┐└┘─]+$/`) or starts with `===` / `--->`
   - else `info`.

Row rendering (frozen):
- **Timestamp column**: dim monospace, fixed width, `HH:MM:SS` (full ISO on hover
  `title`); blank when `ts === null`. Only show the column at all when ≥ 1 row in the
  current log has a parseable ts (legacy artifacts stay full-width).
- **Level flag**: 1-character colored flag per row — `E` (red) / `W` (amber) / `·`
  (default dim) ; banner rows get no flag.
- **Text tinting**: error rows red-tinted, warn amber-tinted, banner dim, info default.
- Applies identically to Runner (live + artifact), every `Worker <i>`, and API
  sub-tabs.

---

## 6. Ownership matrix (parallel, blind implementation)

File sets are strictly disjoint. Frozen contracts in §0 are the only coupling.

| WP | Agent | Files (exclusive ownership) | Delivers |
|----|-------|------------------------------|----------|
| **WP-A core** | 1 agent | `evals/src/types.ts`, `evals/src/swarm/sandbox.ts`, `evals/src/swarm/client.ts` ⚠, `evals/src/runner/index.ts` ⚠, `evals/src/registry.ts`, `evals/src/judge/deterministic.ts` | F1 boot flow + runner validation/artifact, F2 client methods + seed-phase wiring + readiness gate, F3 StackHandle/bootStack/runner/JudgeContext/check-helpers, SerializedScenario v2, validateScenario, `withLineTimestamps` (§4), F4 dependsOn DAG mode + `createTask` dependsOn passthrough + skip classification (§9), F7 infra-failure net (§12) |
| **WP-B scenarios** | 1 agent | `evals/scenarios/index.ts`, `evals/scenarios/sql-seeded-history.ts` (new), `evals/scenarios/memory-pipeline.ts` (new), `evals/scenarios/memory-seeded-recall.ts` (new), `evals/scenarios/two-workers.ts` (new), `evals/scenarios/relay-handoff.ts` (new, §13 S1), `evals/scenarios/build-verify-fix.ts` (new, §13 S2), `evals/scenarios/fixtures/**` (new dir: `seeded-history.sql`, `README.md`), `evals/README.md` (the "Defining scenarios" section additions + §13 backlog/tier-ladder notes) | 6 demo scenarios + fixture + authoring docs; memory-pipeline declares `dependsOn: [0]` (§9.6) |
| **WP-C UI** | 1 agent | `evals/ui/src/pages/RunDetailsPage.tsx`, `evals/ui/src/types.ts`, `evals/ui/src/lib/sandbox.ts` (new), optional `evals/ui/src/components/LogLines.tsx` (new), optional `evals/ui/src/pages/ScenariosPage.tsx` (SerializedScenario v2 rendering only) | sandbox-panel worker list, Logs-tab worker sub-tabs + legacy fallback, normalizer, display contract (§5), skipped-task badge in the task list (§9.5) |
| **WP-D config UX** | 1 agent | `evals/configs/index.ts`, `evals/ui/src/pages/NewRunDialog.tsx`, `evals/ui/src/pages/new-run.css` (new), `evals/ui/src/components/ConfigMultiSelect.tsx` (new) | F5 26-entry config catalog (§10), F6 searchable grouped multi-config picker (§11) |

**WP-C / WP-D disjointness (frozen):** WP-D never touches `evals/ui/src/types.ts`,
`RunDetailsPage.tsx`, or `runs.css` (its styles live in the new `new-run.css`;
`ConfigJson` already carries everything it needs — `isDefault`, `envKeys`); WP-C
never touches `NewRunDialog.tsx` or `evals/configs/index.ts`. If either package
discovers it needs the other's file, STOP and come back to Taras.

⚠ = file concurrently edited by the parallel workflow — WP-A must rebase onto its
result and anchor by function name (`runAttemptOnce`, `bootStack`, `SwarmClient.request`,
`createTask` loop), not by line.

NOT touched by any WP: `evals/src/api/server.ts` (pass-through of sandboxJson +
artifacts; protected by the §0.3 top-level-key invariant; `/api/configs` and the
run-create body are registry-driven, so the bigger catalog needs no server change),
`evals/src/judge/agentic.ts` (worker-0-bound in v1), all root-repo `src/**`
(memory endpoints + dispatch primitives + native task dependsOn used as-is),
`evals/ui/src/pages/runs.css` (shared with RunsPage, which the parallel workflow
edits — WP-D's styles go in the new `new-run.css`), `evals/src/db/client.ts`
(no schema change — sandbox_json is opaque TEXT; `skipped` lives inside the
tasks.json artifact, not a column).

Compile-order note: WP-B, WP-C and WP-D compile against WP-A's types and §0 —
written blind in parallel, **merged in order A → B → C → D**, with a single
`cd evals && bunx tsc --noEmit` (or the package's check script) + `bun test` after each
merge.

## 7. Verification plan

### 7.1 Static / unit (no E2B cost)

```bash
cd evals && bun install
bun test                              # existing pricing/progress tests + new ones below
bun src/cli.ts registry               # loads + validates all scenarios (incl. the 6 new ones) + the 26-entry config catalog
cd .. && bun run lint && bun run tsc:check
```

New unit tests (WP-A, colocated like `src/runner/progress.test.ts`):
- `validateScenario`: workers bounds, task.worker out of range, sqlDump filename shape,
  memories caps.
- sqlDump content validation: accepts a minimal real `.dump` string containing
  `_migrations` DDL+INSERT; rejects one without `_migrations` rows; rejects > 5 MB.
- `withLineTimestamps`: run the generated shell locally
  (`Bun.spawn(["bash", "-lc", withLineTimestamps("printf 'a\\nb'")])`) and assert every
  output line matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z .+$/` and that a
  non-zero inner command propagates a non-zero exit under `set -o pipefail`.
- sandboxJson v2 builder: snapshot the JSON written for a 2-worker StackHandle.
- `validateScenario` dependsOn rules (§0.11): out-of-range index, forward
  reference, self-reference, duplicates each rejected; a valid 3-task chain accepted.
- `CASCADE_SKIP_RE` (§0.12): matches the exact server format
  (`Blocked dependency 1a2b3c4d was failed`, `... was cancelled`,
  `... was failed (cascade)`); does NOT match ordinary failureReasons.
- Infra net (§0.13/§12): a fabricated terminal task with
  `failureReason: "Spawn failed: Timeout waiting for server to start after 5000ms"`
  → `InfraTaskFailureError` with signatureId `opencode-spawn-timeout`; signature
  precedence over skip classification when both could apply; non-matching failed
  tasks untouched; non-"failed" statuses never trigger.
- `createTask` passthrough: `dependsOn` UUID array appears verbatim in the POST
  body (mock fetch).
- Catalog invariants (§0.14): ids unique and matching the naming regex;
  `DEFAULT_CONFIG_IDS` ⊆ catalog and exactly 3 entries; no catalog entry sets `env`.
- (WP-C and WP-D have no UI test infra by repo convention — normalizer and picker
  correctness are covered by the manual E2E below.)

### 7.2 Manual E2E (real E2B + LLM spend)

Prereqs — `evals/.env` must contain: `E2B_API_KEY` (sandboxes), `OPENROUTER_API_KEY`
(judge, default `deepseek/deepseek-v4-pro`), `CLAUDE_CODE_OAUTH_TOKEN` **or**
`ANTHROPIC_API_KEY` (claude worker config), and `OPENAI_API_KEY` **or**
`EMBEDDING_API_KEY` (API-sandbox embeddings — REQUIRED for runs 2–3). All keys already
present in the current `evals/.env`.

Run from `evals/` with the cheapest claude config (`claude-haiku` per `configs/index.ts`;
substitute the current cheap config id if renamed):

```bash
# 1. SQL seeding
bun src/cli.ts run --scenarios sql-seeded-history --configs claude-haiku --attempts 1
# Asserts: runner log shows "[boot] importing SQL seed seeded-history.sql";
# attempt passes; artifacts include sql-seed-output.json (exitCode 0);
# check `seeded-task-visible` passed (proves import), file check passed (proves use).

# 2. Memory plumbing (seed.memories → embed → retrieval)
bun src/cli.ts run --scenarios memory-seeded-recall --configs claude-haiku --attempts 1
# Asserts: seed phase logs memory indexing + "searchable in <N>ms" (readiness gate);
# artifacts include seed-memories.json; file check passes with nightjar-prod.internal:8422.
# Negative probe: temporarily unset OPENAI_API_KEY/EMBEDDING_API_KEY and re-run —
# attempt must ERROR at seed phase with the embedding-key message (fail-loud check).

# 3. Headline memory pipeline (task 1 stores → task 2 retrieves) — now also the
#    dependency-chain (DAG mode) gate, since task 2 declares dependsOn: [0] (§9.6)
bun src/cli.ts run --scenarios memory-pipeline --configs claude-haiku --attempts 1
# Asserts: runner log shows "[task] dependency mode: creating 2 task(s) upfront"
# and "deps=[<uuid8>]" on task 2; task 2 sits `pending` until task 1 completes
# (visible in the waitForTask status transitions); both tasks complete in order;
# file check passes; agentic judge verdict references memory retrieval in task 2.

# 4. Multi-worker
bun src/cli.ts run --scenarios two-workers --configs claude-haiku --attempts 1
# Asserts: 3 sandboxes boot (1 api + 2 workers, parallel boot visible in runner log);
# both tasks route to distinct agentIds; all 4 deterministic checks pass (incl. the
# two isolation file-absent checks); artifacts include worker-0.log AND worker-1.log,
# harness-session names prefixed worker-0/ and worker-1/; sandboxJson has v:2 with 2
# workers (distinct versions captured); `bun src/cli.ts show <runId>` renders.

# 5. UI pass (after run 4): bun src/cli.ts serve  → http://localhost:4801
# - Run-details for run 4: Sandbox panel lists Worker 0 + Worker 1; Logs tab shows
#   Runner | Worker 0 | Worker 1 | API; worker/api rows show timestamp column +
#   colored level flags; ANSI codes not visible.
# - Back-compat: open ANY pre-change attempt in the same evals.db — Sandbox panel
#   renders from the v1 blob; Logs tab "Worker" maps legacy worker.log; no console errors.

# 6. Sweep hygiene: after each run, `bun ../src/cli.tsx e2b list` (or e2b dashboard)
#   shows no leaked `evals-*` sandboxes.

# 7. Cross-worker handoff chain (dependsOn × workers × memory — §13 S1)
bun src/cli.ts run --scenarios relay-handoff --configs claude-haiku --attempts 1
# Asserts: 3 sandboxes (1 api + 2 workers); task 0 → worker 0, task 1 (deps) →
# worker 1; fileContainsOnWorker(1, relay-received) passes and
# fileAbsentOnWorker(0, relay-received) passes.
# Optional negative probe (skip semantics): kill worker 0's sandbox mid-task-0 —
# task 0 cancels/fails → server cascade-fails task 1; attempt grades "failed"
# (NOT "error"); tasks.json marks task 1 skipped:true with the
# "Blocked dependency ... was ..." reason; UI task list shows the skipped badge;
# runner log shows the cost/log waits ran for 1 task only (skipped excluded).

# 8. Deterministic chain (build → verify/fix — §13 S2)
bun src/cli.ts run --scenarios build-verify-fix --configs claude-haiku --attempts 1
# Asserts: both tasks complete; `bun-test-green` deterministic check passes.

# 9. Config catalog + picker (no E2B cost)
bun src/cli.ts registry      # validates scenarios AND the 26-entry catalog
curl -s localhost:4801/api/configs | bun -e 'const r=await new Response(Bun.stdin).json(); console.log(r.length, r.filter(c=>c.isDefault).map(c=>c.id).sort().join(","))'
# Asserts: 26 rows; isDefault exactly the frozen trio. Then UI-verify-only
# (bun src/cli.ts serve → new-run dialog): typing "deepseek" filters rows and
# hides empty provider groups; a provider group's select-all toggles only the
# visible rows; "Defaults" chip resets selection to the trio; removing a selected
# chip updates the count badge; dialog stays within the viewport with 26 rows;
# ConfigsPage DataTable renders all rows. No automated UI test (repo convention).

# 10. Infra net (opportunistic — only fires on the real opencode cold-start flake)
# Any opencode run that hits "Spawn failed: Timeout waiting for server" must show:
# immediate attempt abort (no log-stability/cost waits, no judge spend on the
# failed try), one fresh-sandbox retry, and on double-flake an attempt with
# status "error" whose message starts "infra failure (opencode-spawn-timeout)".
# The deterministic coverage lives in the §7.1 unit tests.
```

Cost estimate: runs 1–4 ≈ 5 attempts total on a haiku-class model — roughly **$0.5–2
LLM spend** (incl. judges) plus **~50–70 E2B sandbox-minutes** (run 4 uses 3 sandboxes
for ~15 min). Well under typical daily dev budget; no Turso needed (local `evals.db`).
Extension runs 7–8 add ≈ 2 attempts ≈ **$0.2–0.5 LLM** plus **~45–60 sandbox-minutes**
(run 7 boots 3 sandboxes); runs 9–10 are LLM-free.

## 8. Non-goals (round 6)

- **Heterogeneous per-worker harness configs** — an attempt cell stays
  `scenario × ONE HarnessConfig`; all N workers are identical (research Q2: per-worker
  configs break the matrix semantics; revisit with a dedicated cell-definition design).
- **Lead orchestration / unassigned-task routing** — no lead sandbox; every eval task
  is explicitly agent-assigned. Unassigned tasks would rot (no lead to claim them).
- **Parallel task execution as a graded feature** — the runner still awaits tasks
  one at a time in index order. In DAG mode (§9) the *server* may dispatch
  dependency-independent tasks to different workers concurrently; that is an
  accepted side effect, not something scenarios should grade. `two-workers`
  proves routing/isolation, not concurrency.
- **Multi-worker-aware agentic judge tools** — `run_command`/`read_file` stay bound to
  worker 0; multi-worker scenarios should grade via deterministic
  `*OnWorker` checks (the `workers` JudgeContext array exists, so extending the
  agentic toolset later is additive).
- **Memory raters** (`MEMORY_RATERS`, rating assertions) — ranking stays
  similarity+recency; no rater envs are forwarded.
- **SQL seeding of worker sandboxes** — `sqlDump` targets only the API DB; worker FS
  seeding remains `seed.exec`.
- **Live streaming of worker/api logs in the UI** — they remain post-mortem artifacts
  (only the runner log streams live, as today).
- **YAML scenario authoring / richer memory objects** — scenarios stay TS modules;
  `seed.memories` stays `string[]` (name/scope/tags are fixed by §2.3).
- **UI authoring of dependencies / scenarios** — `dependsOn` is TS-scenario-only;
  the new-run dialog selects scenarios and configs, it does not edit them.
- **Generic flake retry** — the infra net (§12) retries ONLY exact
  signature-matched failureReasons (`INFRA_FAILURE_SIGNATURES`); every other task
  failure stays a scored model failure. No fuzzy/heuristic infra detection.
- **Catalog credential plumbing** — no per-config secrets in `config.env`; new
  providers/keys go through `credentialsForConfig` only. The whole §10 catalog
  runs on the already-required keys (claude OAuth/Anthropic, OPENAI_API_KEY,
  OPENROUTER_API_KEY) — zero new env vars this round.
- **Per-worker heterogeneous configs (restated)** — the bigger catalog widens the
  run-level config axis only; all workers within one attempt still share one config.

---

## 9. Feature 4 — task dependencies (`TaskSpec.dependsOn`)

### 9.1 Decision: NATIVE swarm-API dependencies (verified in the root repo)

The swarm API supports task dependencies natively, end-to-end — runner-side
deferred-creation chaining is **rejected** (it would re-implement server
semantics and lose the failure cascade). Verified surface (root repo, none of it
modified):

- **Create**: `POST /api/tasks` accepts `dependsOn: z.array(z.string()).optional()`
  (task UUIDs) — `src/http/tasks.ts` (create-route body), wired through to
  `createTaskInDb`. The evals client just forwards it (§0.7).
- **Dispatch gate**: `getPendingTaskForAgent` (`src/be/db.ts`) hands an agent
  only pending tasks whose dependencies are ALL `completed`
  (`checkDependencies`; only `completed` counts as met). The `task-action`
  claim/accept paths enforce the same. An assigned task with unmet deps sits in
  `pending`, invisible to its worker — exactly the gating evals needs.
- **Failure cascade**: `failTask` / `cancelTask` / `supersedeTask` each call
  `cascadeFailDependents(id, <status>)`, which transitively marks all live
  dependents `failed` with
  `failureReason = "Blocked dependency <uuid8> was <status>"` (the §0.12 regex
  matches this format exactly). Eval-relevant corollary: the runner's
  `waitForTask` timeout path POSTs `/api/tasks/:id/cancel` → same cascade. So a
  failed, cancelled, **or timed-out** dependency resolves every dependent to a
  terminal `failed` without any runner involvement.

### 9.2 Schema + validation

§0.1: `TaskSpec.dependsOn?: number[]` (indices into `scenario.tasks`). §0.11
rule: integer entries, no duplicates, each `0 <= d < taskIndex` — strictly
earlier tasks only, so self/forward references and cycles are impossible by
construction (no graph traversal needed; the earlier-index rule IS the cycle
check). Composition with F3 is free: `worker ?? 0` resolves per task
independently of deps, so a chain may hop workers — dependsOn + `worker` +
swarm-scope memory is the cross-worker handoff case (§13 S1).

### 9.3 Runner: two creation modes (frozen)

Inside `runAttemptOnce`'s task phase (`setAttemptPhase(attempt.id, "tasks")`):

- **Sequential mode** — no task in the scenario has `dependsOn`: today's loop,
  byte-for-byte unchanged (create task i → `waitForTask` → create i+1). Zero
  behavior change for every existing scenario.
- **DAG mode** — any task has `dependsOn`:
  1. Log `[task] dependency mode: creating <N> task(s) upfront`.
  2. Create ALL tasks in index order (sequential `createTask` calls), resolving
     dependsOn indices against already-created UUIDs:
     `dependsOn: spec.dependsOn?.map((d) => createdIds[d])`. Worker routing and
     the never-omit-`agentId` rule per §3.3. The per-task log line gains
     ` deps=[<uuid8>, …]` when present.
  3. `updateAttempt(... { taskIds })` immediately after creation (ids are all
     known upfront; the existing post-loop write stays — idempotent).
  4. Await tasks in index order with the same per-task `taskTimeoutMs` budget.
     Validation guarantees deps point at earlier indices, so when task i is
     awaited its deps are already terminal: a dependent of a failed dep returns
     ~instantly as cascade-failed.

  Concurrency note: in DAG mode, tasks with no mutual dependency assigned to
  DIFFERENT workers may execute concurrently (the server dispatches each
  worker's ready pending tasks independently). Accepted — see the amended §8
  bullet. Same-worker tasks still serialize (MAX_CONCURRENT_TASKS=1 + the
  priority/createdAt FIFO in `getPendingTaskForAgent`). *Implementation note:*
  `timings.perTask` then measures await-wall, which may undercount execution
  that overlapped an earlier await — acceptable.

### 9.4 Failure semantics: skipped tasks (frozen)

Right after EVERY `waitForTask` resolves (both modes, uniform code path):

1. **Infra check first** (§0.13 precedence): if the terminal task matches an
   `INFRA_FAILURE_SIGNATURES` entry → throw `InfraTaskFailureError` (§12).
2. **Skip classification** (§0.12): `status === "failed" &&
   CASCADE_SKIP_RE.test(failureReason ?? "")` → set `skipped: true`, log
   `[task] <id> skipped (failed dependency)`.

Scoring (frozen):

- The attempt is **graded normally** — status `passed`/`failed` per
  checks+judges, NOT an infra `"error"`. A failed dependency is a real model
  failure; its skipped dependents are fallout, not independent evidence.
- The implicit `tasks-completed` check still fails, but its detail separates the
  two populations: `"<n> failed: <titles> · <m> skipped (failed dependency): <titles>"`.
- Custom checks run unchanged (a check on a skipped task's artifact fails —
  correct: the work never happened; the attempt was failing anyway).
- Judges receive `tasks.json` with `skipped: true` + the raw failureReason.
  Advisory for WP-B rubric authors: tell judges to grade the root failure and
  treat skipped tasks as consequences.
- **Cost/log waits exclude skipped tasks** (frozen): filter
  `tasks.filter((t) => !t.skipped)` at BOTH the `getStableSessionLogs` fan-out
  and the `waitForSessionCostRows`/`getSessionCosts` fan-out — a skipped task
  never produced a session, and the empty-budget waits would just burn wall
  clock. Skipped tasks STAY in `tasks` / `taskIds` / `tasks.json`.

### 9.5 UI (WP-C — RunDetailsPage, small)

In the task list, render a dim `skipped` tag (StatusBadge styling family) next
to a failed task when tasks.json has `skipped === true`, falling back to testing
`failureReason` against the frozen `CASCADE_SKIP_RE` source for legacy rows.
Tooltip = the raw failureReason. No other change (a skipped task's transcript is
naturally empty).

### 9.6 Demo update (WP-B)

`memory-pipeline` (§2.5) declares the dependency explicitly — task 2 carries
`dependsOn: [0]` — making it the DAG-mode E2E gate (upfront creation,
server-held `pending`, completion-gated dispatch). Scenario semantics otherwise
unchanged. `relay-handoff` (§13 S1) covers the cross-worker chained case;
`two-workers` stays dep-free on purpose (it gates the unchanged sequential mode
under multi-worker).

---

## 10. Feature 5 — harness-config catalog seeding (`evals/configs/index.ts`)

### 10.1 Catalog (frozen ids + model strings; labels advisory)

The existing 12 entries stay untouched (claude-haiku/sonnet/opus/opus-4.6/4.7/
4.8/fable, pi-deepseek-flash, opencode-gemini-flash, codex-5.4-mini/5.4/5.5).
**14 new entries** bring the catalog to **26**. Prices are OpenRouter $/1M
in/out from `src/be/modelsdev-cache.json` (snapshot 2026-06-11), quoted here for
review only — not encoded in configs. All picks are `tool_call: true` in the
cache, so the pricing-recompute path prices them.

pi (pi-mono over OpenRouter):

| id | model | $in / $out per 1M |
|---|---|---|
| `pi-deepseek-pro` | `openrouter/deepseek/deepseek-v4-pro` | 0.435 / 0.87 |
| `pi-gemini-flash` | `openrouter/google/gemini-3-flash-preview` | 0.50 / 3.00 |
| `pi-glm-flash` | `openrouter/z-ai/glm-4.7-flash` | 0.06 / 0.40 |
| `pi-qwen-coder` | `openrouter/qwen/qwen3-coder-next` | 0.11 / 0.80 |
| `pi-minimax-m2.5` | `openrouter/minimax/minimax-m2.5` | 0.15 / 0.90 |
| `pi-kimi-k2.5` | `openrouter/moonshotai/kimi-k2.5` | 0.40 / 1.90 |
| `pi-gpt-oss-120b` | `openrouter/openai/gpt-oss-120b` | 0.039 / 0.18 |

opencode:

| id | model | $in / $out per 1M |
|---|---|---|
| `opencode-deepseek-flash` | `openrouter/deepseek/deepseek-v4-flash` | 0.098 / 0.197 |
| `opencode-deepseek-pro` | `openrouter/deepseek/deepseek-v4-pro` | 0.435 / 0.87 |
| `opencode-glm-flash` | `openrouter/z-ai/glm-4.7-flash` | 0.06 / 0.40 |
| `opencode-qwen-coder` | `openrouter/qwen/qwen3-coder-next` | 0.11 / 0.80 |
| `opencode-minimax-m2.5` | `openrouter/minimax/minimax-m2.5` | 0.15 / 0.90 |
| `opencode-kimi-k2.5` | `openrouter/moonshotai/kimi-k2.5` | 0.40 / 1.90 |
| `opencode-gemini-flash-lite` | `openrouter/google/gemini-3.1-flash-lite` | 0.25 / 1.50 |

Rationale: pi and opencode share a 6-model OpenRouter core (deepseek v4
flash+pro — harness-vs-harness on identical models, incl. the repo-convention
default; glm-4.7-flash, qwen3-coder-next, minimax-m2.5, kimi-k2.5 as strong
cheap agentic models). `gpt-oss-120b` (~$0.04/M) goes on pi only as the
bargain-basement probe; `gemini-3.1-flash-lite` on opencode only
(gemini-3-flash is already the opencode default). claude stays on the existing
OAuth cred (haiku/sonnet are the workhorses; opus/fable entries already exist);
codex keeps the existing three on OPENAI_API_KEY.

### 10.2 Credentials, tiers, naming

All frozen in §0.14: naming regex, NO `env` blocks (creds flow only through
`credentialsForConfig` — every new entry is `openrouter/`-prefixed, so only
`OPENROUTER_API_KEY` is forwarded to those workers; the claude OAuth token never
leaks into a pi/opencode/codex sandbox), `DEFAULT_CONFIG_IDS` trio unchanged,
`modelTier` unset.

### 10.3 Impact notes

- Registry load is shape-only validation — a missing host key surfaces at boot
  per attempt via the existing `need()` throw with a clear
  `config "<id>" (<provider>) requires <KEY>` message. No registry-time key checks.
- `/api/configs` returns 26 rows (+ `isDefault`) with zero server change.
  ConfigsPage is a DataTable — fine as-is. The new-run dialog is NOT fine at 26
  flat checkboxes → §11.
- Analytics/matrix pages only grow columns for configs actually selected in a
  run; the default dialog flow (trio preselected) is unchanged.

Owner: WP-D (§6). Unit tests: §7.1 catalog invariants.

---

## 11. Feature 6 — multi-config new-run picker (`ConfigMultiSelect`)

### 11.1 Problem

`NewRunForm`'s config picker is a flat `.check-list` of checkboxes — designed
for ~12 rows; at 26+ it has no search, no grouping, and pushes the dialog past
the viewport. Scenario picker stays a check-list (small cardinality, unchanged).

### 11.2 Interaction contract (frozen)

`ConfigMultiSelect` (§0.15 props) replaces the configs `.check-list` block:

1. **Trigger row** (inside the existing `.form-field`): a search input
   (placeholder `Search configs…`), a `Defaults` quick-chip button, and a
   selected-count badge (`<n> selected`).
2. **Dropdown** — portal-positioned with the same MenuPos/EDGE viewport-clamping
   pattern as the dialog's judge model-select; max-height ≈ 320 px, scrollable.
   Configs grouped by provider in fixed order `claude, codex, pi, opencode`
   (future providers appended alphabetically).
   - **Group header**: HarnessIcon + provider name + `selected/total` count +
     tri-state select-all checkbox (checked = all VISIBLE rows of the group
     selected; indeterminate = some) + collapse chevron. Groups default
     expanded; collapse state resets on each dialog open. Select-all toggles
     ONLY the rows visible under the active search filter (frozen).
   - **Row**: checkbox + the existing `ConfigChip` (its hover card already
     carries id/label/model/tier/envKeys/isDefault). The whole row is clickable.
3. **Fuzzy search**: `fuzzyMatch` (already exported from
   `ui/src/components/DataTable.tsx`) against
   `id + " " + (label ?? "") + " " + (model ?? "")`. Non-matching rows hidden,
   empty groups hidden, and a non-empty query force-expands the remaining groups.
4. **Defaults chip**: REPLACES the selection with exactly the `isDefault` set
   (not a union) — one click back to the curated trio.
5. **Selected chips**: under the trigger, the selection renders as removable
   chips (ConfigChip + `×`), wrapping, in catalog order — the always-visible
   record of the selection while the dropdown is closed. Removing one updates
   the set and the badge.
6. Submit rule unchanged (≥1 scenario AND ≥1 config). Selection state stays in
   `NewRunForm`'s existing `configSel: Set<string> | null` (null → defaults
   derive from `isDefault`, as today).
7. Esc closes the dropdown without clearing the search; reopening preserves the
   selection. (Arrow-key list navigation: advisory, nice-to-have.)

### 11.3 Data

No new endpoints: `listConfigs` already returns `ConfigJson[]` with `isDefault`.
No `ui/src/types.ts` change (that file is WP-C's — frozen disjointness, §6).

### 11.4 Files + collision rules

- `evals/ui/src/components/ConfigMultiSelect.tsx` — NEW.
- `evals/ui/src/pages/NewRunDialog.tsx` — replace the configs `.check-list`
  block only; the judge model-select and the rest of the form are untouched.
- `evals/ui/src/pages/new-run.css` — NEW; ALL new styles live here (imported by
  NewRunDialog). `runs.css` is NOT modified: it is shared with `RunsPage`, which
  the parallel workflow edits concurrently (drift warning at the top of this doc).

Owner: WP-D (§6). Verification: §7.2 run 9 (UI-verify-only).

---

## 12. Feature 7 — opencode spawn-failure infra net (runner-side)

### 12.1 Background (verified investigation)

Tasks that reach terminal `failed` with a `failureReason` matching
`/Spawn failed: Timeout waiting for server/` are **infrastructure** failures,
not model failures: the opencode server inside the worker sandbox missed its 5 s
default boot window, so the model never got a turn. Today such an attempt grades
as a scored "failed" AND still pays the full post-mortem — log-stability wait,
cost-row wait, deterministic checks, LLM + agentic judges — **~140 s of wall
clock plus judge spend on a corpse**. The root-repo fix
(`OPENCODE_SERVER_TIMEOUT_MS`, `src/providers/opencode-adapter.ts`, already in
tree) reaches sandboxes only after the next release's worker-template publish;
this net is the interim mitigation AND the permanent insurance for the failure
class.

### 12.2 Behavior (frozen)

Detection point: in the task loop, immediately after `waitForTask` returns a
terminal task — both creation modes, and BEFORE skip classification (§0.13
precedence):

```ts
const reason = String(final.failureReason ?? "");
if (final.status === "failed") {
  const sig = INFRA_FAILURE_SIGNATURES.find((s) => s.pattern.test(reason));
  if (sig) throw new InfraTaskFailureError(sig.id, final.id, /* frozen message §0.13 */);
}
```

Consequences:

1. **Short-circuit** — the throw abandons the attempt body at once: remaining
   task creates/awaits, the log-stability wait, the cost wait, harness-session
   collection, deterministic checks, and BOTH judges are all skipped (zero judge
   spend on a corpse). `runAttemptOnce`'s existing `finally` still runs (sandbox
   teardown, live-registry cleanup) exactly as for any other error.
2. **Retry** — the existing per-attempt retry wrapper (`DEFAULT_MAX_RETRIES = 1`,
   fresh sandboxes each try) catches ANY error thrown out of `runAttemptOnce`;
   the infra error rides that path unchanged (`[retry] attempt <id> retrying (1/1)`).
3. **Retries exhausted** → attempt `status: "error"` with the frozen §0.13
   message (starts `infra failure (opencode-spawn-timeout): …`). **Never a
   scored "failed"** — pass-rate analytics stay clean. Error attempts remain
   resettable via the existing `resetErrorAttempts` + re-execute endpoint.

Interaction with F4 (frozen): if a dependency fails with an infra signature, the
attempt retries before any dependents would be classified skipped — an infra
flake never produces a scored attempt with skipped tasks. Cascade-failed
dependents themselves (`Blocked dependency …`) never match an infra signature.
Timed-out (`timedOut: true`, non-terminal) tasks never trigger the net.

### 12.3 Extensibility rules

`INFRA_FAILURE_SIGNATURES` (§0.13) is the single registry; a future net entry is
a one-element diff. Rules: match on `failureReason` ONLY (verified persisted on
task records and therefore in `tasks.json` artifacts); patterns must be specific
enough to never match a model-caused failure — when in doubt, don't add (a
scored failure is recoverable by analysis; a silently retried model failure
poisons the eval).

Owner: WP-A (`evals/src/runner/index.ts`). Tests: §7.1; opportunistic E2E: §7.2 run 10.

---

## 13. Complex scenario proposals (new-machinery showcase)

### 13.1 Ship in round 6 (WP-B — cheap, deterministic)

**S1 `relay-handoff`** — cross-worker producer/consumer through swarm memory
(dependsOn × workers × runtime memory write):

- `workers: 2`; `seed.exec` writes `/workspace/relay-token.txt` containing the
  fixed line `relay-7f3a9c` (seed.exec runs on worker 0 — §2.2).
- Task 0 (worker 0): read the token file, store a swarm memory containing the
  exact token, include the token in the completion report.
- Task 1 (worker 1, `dependsOn: [0]`): "a previous agent recorded a relay token;
  retrieve it from memory (search — do not guess, do not invent) and write
  exactly the token to `/workspace/relay-received.txt`".
- Checks: `fileContainsOnWorker(1, "/workspace/relay-received.txt", /relay-7f3a9c/)`,
  `fileAbsentOnWorker(0, "/workspace/relay-received.txt")` + implicit
  tasks-completed. Deterministic-only — no LLM judge.
- Requires an embedding key (§0.6 prereq). `timeoutMs: 12 * 60_000`.
  Cost ≈ $0.1–0.3 (2 haiku tasks) + 3 sandboxes × ~12 min.

**S2 `build-verify-fix`** — deterministic build → verify/fix chain (dependsOn,
single worker, compile-grade check):

- `seed.exec` writes `/workspace/calc/calc.test.ts` (bun test, ~8 strict cases
  including one edge a first-pass implementation plausibly misses, e.g.
  negative-exponent integer pow).
- Task 0: implement `/workspace/calc/calc.ts` exporting what the test imports;
  the test file must not be modified.
- Task 1 (`dependsOn: [0]`): run `cd /workspace/calc && bun test`; if red, fix
  the implementation (never the tests) until green; report the final summary.
- Checks: custom `bun-test-green` — `ctx.exec("cd /workspace/calc && bun test")`
  exitCode 0 (worker 0 = default ctx.exec binding) + implicit tasks-completed.
  Deterministic-only. `timeoutMs: 12 * 60_000`. Cost ≈ $0.1–0.2 + 2 sandboxes.

### 13.2 Backlog (designs validated, not built this round)

| id | sketch (tasks / seed / workers / deps / grading) | machinery | est. cost/attempt | why backlog |
|---|---|---|---|---|
| `sql-audit-history` | sqlDump fixture seeds ~30 historical tasks (mixed statuses, exactly two failed "deploy" tasks); one task: query `/api/tasks` via the swarm API, count failed deploy tasks, write the number to `/workspace/audit.txt`; fileContains the exact count | sqlDump + apiGet-style check | ~$0.05 + 2 sandboxes | needs a richer generated fixture (recipe §1.4) |
| `memory-distractor` | `seed.memories` carries the true fact; the task prompt embeds a plausible wrong default ("assume port 9000 if not recorded"); agent must trust memory over the distractor; deterministic file check + judge rubric "retrieved, not guessed" | memories + agentic judge | ~$0.1 + 2 sandboxes | wants an anti-gaming pass on the prompt wording |
| `cross-worker-invent` | like S1 but task 0 INVENTS the value (uuid) — no seeded ground truth; agentic judge cross-checks task 0's reported output vs worker 1's file via `ctx.workers` | deps + workers + judge `workers[]` tools | ~$0.3 + 3 sandboxes | agentic judge is worker-0-bound in v1 (§8) — needs the workers[] toolset extension first |
| `chain-depth-3` | plan → implement → review chain on one worker; task 2 must approve-or-reject with cited reasons; judge grades review specificity | 3-deep dependsOn | ~$0.3–0.5 | marginal new signal over S2 until judge spend drops |
| `tier-ladder` (run recipe, NOT a scenario) | run `build-verify-fix` across `{claude-haiku, claude-sonnet, opencode-deepseek-flash, opencode-deepseek-pro, pi-glm-flash, pi-kimi-k2.5}` × 3 attempts → analytics cost-vs-pass scatter for the same task across price tiers | §10 catalog + existing analytics page | ~$2–5 per sweep | nothing to build — document the recipe in `evals/README.md` after the catalog merges (WP-B note) |

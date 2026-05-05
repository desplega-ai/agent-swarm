---
date: 2026-05-04
brainstormer: taras
git_commit: cf553c1d
branch: main
repository: agent-swarm
topic: "MemoryRater abstraction — pressure-testing the interface sketch from the Bayesian-learning research"
exploration_type: idea_to_develop
status: complete
last_updated: 2026-05-04
last_updated_by: taras
related:
  - thoughts/taras/research/2026-05-04-bayesian-learning-memory.md
autonomy: critical
---

# MemoryRater abstraction — pre-PRD brainstorm

## Context

Goal: pressure-test the `MemoryRater` interface sketch from
`thoughts/taras/research/2026-05-04-bayesian-learning-memory.md` (section 3.A
+ Open Questions table) before anyone writes a plan. Aiming for a sharp
enough pre-PRD that `/desplega:create-plan` after this is mechanical.

Five areas Taras flagged for digging in:

1. **Placement** — server vs worker for each rater (DB-boundary invariant:
   `src/be/db.ts` is API-server-only, enforced by
   `scripts/check-db-boundary.sh`).
2. **Event lifecycle** — when raters fire (retrieval / completion / both)
   and whether we need a `memory_retrieval` table to bridge the two.
3. **Implicit citation detector** — the actual algorithm. ID grep?
   N-gram match? Both? How to test it without the whole pipeline.
4. **Backward compatibility** — default = NoopRater, and the rollout
   shape (env var? per-agent config? feature flag?).
5. **Concurrency on swarm-scope shared posteriors** — many workers
   updating the same row's `(alpha, beta)` simultaneously.

Pushback on the research doc's interface sketch is invited.

## Codebase facts already confirmed (relevant to placement)

- `session_logs` (`src/be/migrations/001_initial.sql:168-177`) stores raw
  worker output keyed by `taskId`, scrubbed at write
  (`src/be/db.ts:3500-3527`). The API server already has every tool call
  and every final-text line a worker emits.
- `POST /api/memory/search` (`src/http/memory.ts:185-229`) knows
  `myAgentId` from `X-Agent-ID` and the returned memory IDs — but does
  **not** know `taskId`. That's a gap if we want to correlate retrievals
  with task outcomes server-side.
- `agent_memory` schema today has no `alpha`/`beta` columns
  (`src/be/migrations/001_initial.sql:271-287`).
- DB-boundary check (`scripts/check-db-boundary.sh`, pre-push + CI) blocks
  any `bun:sqlite` or `src/be/db` import from worker-side paths.

## Implications for placement

Because session_logs already carries everything tool-call and output
related, **the implicit-citation rater can be a pure server-side function
over (memory_retrieval rows, session_logs rows for that taskId)**. No new
worker endpoint required for the cheap-rater baseline. The only raters
that genuinely need worker → server traffic are:

- **Explicit agent self-rating** (an MCP tool the agent calls; this is a
  worker-side write going through the existing tool/HTTP path anyway).
- Anything that needs runtime context the server can't reconstruct
  post-hoc (probably none of the rater set listed in the research doc).

This collapses "Placement" — almost everything is server-side, the
question becomes whether a worker-side surface even ships in v1.

## Exploration

### Q1: Given session_logs already carries all the data the post-hoc raters need, what's the v1 surface area?

**Answer:** Naive ImplicitCitation + auto rater (the LLM one piggybacked on
the existing session-summary flow) + the explicit MCP tool. Interface is
non-negotiable — pluggable backends are a core swarm principle (parallels
LLM provider pluggability and embedding provider pluggability). Default
must be NoopRater for backward compatibility.

**Insights:**
- v1 ships THREE raters, not one. Forces multi-rater composition to be real
  in the framework on day 1 (not deferred).
- LlmRater specifically piggybacks on the existing session-summary LLM call
  in `src/hooks/hook.ts:1080-1115` — that flow already shells out to
  `claude -p --model haiku` to summarize a session. Extending it to also
  emit ratings is near-free (a few extra output tokens).
- BackCompat answer is structural: `NoopRater` default = behavior identical
  to today. New endpoint absent on older servers → worker silently drops
  rating events on 404.

### Q2: Auto rater clarification — which 'auto thingy'?

**Answer:** LlmRater piggybacked on the existing session-summary flow. Use
**Zod schemas** for structured output (matches the rest of the codebase's
typing convention). User also flagged that there's "something that does
auto memory on research tasks" — confirmed:

- `src/tools/store-progress.ts:295-359` — server-side; on task completion
  indexes task content as memory; auto-promotes `research`/`knowledge`/
  `shared`-tagged completions to swarm scope.
- `src/hooks/hook.ts:1080-1145` — worker-side; at session shutdown, makes
  an LLM call (`claude -p --model haiku`) to summarize the session and
  POSTs to `/api/memory/index`. **This is the LLM call the LlmRater
  piggybacks on.**

**Insights:**
- Placement is now precise per rater:
  | Rater | Side | Why |
  |---|---|---|
  | `ImplicitCitationRater` | Server | Pure post-hoc grep; data already in session_logs |
  | `LlmRater` (Zod) | Worker | Piggybacks worker-side summary call → near-free LLM cost |
  | `ExplicitSelfRatingRater` (MCP) | Worker | New tool, existing tool/HTTP path |
- A `POST /api/memory/rate` endpoint IS needed (worker → server) for the
  LLM and explicit raters. Server-side raters call an internal function;
  no endpoint round-trip.

### Q3: How does the system bridge 'memory was retrieved' → 'rater fires later'?

**Answer:** New `memory_retrieval` table + `X-Source-Task-ID` header on
`/api/memory/search` (using the existing `RequestInfo.sourceTaskId`
extraction in `src/tools/utils.ts:18-44` — not a new header convention).
Single source of truth.

```sql
CREATE TABLE memory_retrieval (
  id TEXT PRIMARY KEY,
  taskId TEXT,
  agentId TEXT NOT NULL,
  sessionId TEXT,
  memoryId TEXT NOT NULL,
  similarity REAL,
  retrievedAt TEXT NOT NULL
);
CREATE INDEX idx_memret_task ON memory_retrieval(taskId);
CREATE INDEX idx_memret_agent ON memory_retrieval(agentId);
```

**Insights:**
- `/api/memory/search` already has `X-Agent-ID`. Adding `X-Source-Task-ID`
  (existing convention) is a tiny change — see the "Header plumbing"
  section under Resolved during file-review for the precise codebase
  surfaces (one line in `runner.ts`, one parameter on `store.search()`).
- Server-side ImplicitCitationRater fires from
  `src/tools/store-progress.ts` at the same point that already triggers
  task-completion memory indexing (~line 298) — natural co-location.
- Worker-side LlmRater (in `hook.ts`) GETs `/api/memory/retrievals?taskId=`
  at shutdown to know which memories the LLM should rate.
- New endpoints required:
  - `POST /api/memory/rate` — RatingEvent ingestion (worker → server).
  - `GET  /api/memory/retrievals` — query retrievals for a task/session.

### Q4: Implicit-citation algorithm + posterior storage

**Answer:**
- **Detector:** ID-grep only. Pure function `(memoryIds[],
  logContent: string) → RatingEvent[]`. Hit at intent_weight 0.5; miss at
  half (0.25, since negatives carry less info in IR). Trivially
  unit-testable. Content-substring / n-gram ships later as a separate
  `MemoryRater` if recall data warrants it.
- **Storage:** `alpha REAL DEFAULT 1, beta REAL DEFAULT 1` columns added
  to `agent_memory`. One row = one posterior. Swarm-scope memories share
  the row naturally. Naive `UPDATE … SET alpha=alpha+?, beta=beta+?
  WHERE id=?` per event — atomic in WAL mode.

**Insights:**
- **Concurrency is a non-issue at projected rates.** Worst case ≈ 8
  events/sec swarmwide (50 workers × 1 task/min × 10 retrieved memories ×
  1 rater) vs. SQLite's ~10k UPDATE/sec capacity. No batching, no
  in-memory accumulator, no flush schedule. Naive UPDATE wins on
  simplicity and audit-ability. If rates 100× later, revisit with a
  batched-flush adapter inside `MemoryStore` — interface stable.
- The reranker integration is the multiplicative factor from the research
  doc: `score = similarity × recency_decay × access_boost × usefulness`
  where `usefulness = alpha / (alpha + beta)`.
- ID-grep + intent_weight semantics formalize the framework's
  `RatingEvent`: `{ memoryId, signal: -1..+1, weight: 0..1, source }`. The
  store does one `UPDATE` per event: `alpha += max(0, signal) × weight;
  beta += max(0, -signal) × weight`. Intent_weight per-rater (config-tunable).

### Q5: Config shape for raters + LLM client

**Answer:** Env-var driven, mirrors existing `HARNESS_PROVIDER` /
embedding-provider conventions. `MEMORY_RATERS` unset → NoopRater only →
behaviour identical to today (backward compatibility is structural, not
flag-gated).

```bash
MEMORY_RATERS=implicit-citation,llm,explicit-self
MEMORY_LLM_RATER_PROVIDER=claude-cli   # default; matches hook.ts pattern
MEMORY_LLM_RATER_MODEL=haiku
# Optional weight overrides
# MEMORY_RATER_WEIGHTS=implicit-citation:0.5,llm:0.8
```

**Insights:**
- `LlmRaterClient` is its own interface (sibling of `EmbeddingProvider`,
  `MemoryStore`, `MemoryRater`). Default impl shells to `claude` CLI —
  same pattern as `src/hooks/hook.ts:1097`, zero new SDK deps in v1.
- Anthropic SDK / OpenRouter / OpenAI impls drop in behind env later
  without touching rater logic.
- Older servers (pre-`/api/memory/rate`) → worker POSTs return 404 →
  worker silently swallows. Older workers (pre-LlmRater patch) → server
  endpoint exists but receives nothing → no rows update → reranker
  multiplies by `Beta(1,1).mean() = 0.5`. Need to confirm: is 0.5 the
  right neutral or should NoopRater set columns to make
  `usefulness == 1` (multiplicatively neutral)? Decision in Synthesis.

## Synthesis

### Key Decisions

**Placement (per rater)**
| Rater | Side | Trigger | Why this side |
|---|---|---|---|
| `NoopRater` | n/a | n/a | Default. No behaviour. |
| `ImplicitCitationRater` | Server | Task completion (in `src/tools/store-progress.ts`) | All inputs already on server; pure function; no endpoint needed |
| `LlmRater` | Worker | Session shutdown (in `src/hooks/hook.ts`) | Piggybacks existing summary LLM call → marginal cost is rating output tokens only |
| `ExplicitSelfRatingRater` | Worker | New MCP tool `memory_rate(id, useful)` | Agent intent signal; uses existing MCP/HTTP path |

**Storage**
- `agent_memory.alpha REAL DEFAULT 1, agent_memory.beta REAL DEFAULT 1`
  (one new migration in `src/be/migrations/NNN_memory_posteriors.sql`).
- New table `memory_retrieval(id, taskId, agentId, sessionId, memoryId,
  similarity, retrievedAt)` (same migration).
- **Reranker correction:** to keep "no learning" multiplicatively neutral,
  define `usefulness = 0.5 + 0.5 × (alpha / (alpha + beta))` so
  `Beta(1,1) → 0.75` baseline and proven memories climb to ≤ 1.0. Avoids
  halving every score the moment we ship the new factor with no data yet.
  *(Or: skip the factor entirely when `alpha == 1 && beta == 1`. Equivalent;
  pick during plan based on which is easier to test.)*

**Endpoints (new)**
- `POST /api/memory/rate` — accepts `RatingEvent[]`. Auth: `X-Agent-ID` +
  Bearer. Idempotency: not required for v1 (Beta updates are commutative;
  duplicates just shift the posterior slightly).
- `GET  /api/memory/retrievals?taskId=&sessionId=` — read for worker-side
  raters. Already-authed via existing pattern.
- Both must use `route()` factory (`src/http/route-def.ts`) and be added
  to `scripts/generate-openapi.ts`. Run `bun run docs:openapi` and commit
  `openapi.json` + `docs-site/.../api-reference/**`.

**Search-call change**
- Add `X-Source-Task-ID` header (optional) to `POST /api/memory/search`
  from `src/commands/runner.ts:1544-1548`. When present, server inserts
  `memory_retrieval` rows. When absent, behaviour is identical to today
  (no lifecycle bridge → no rater fires for that retrieval).
- For the in-process MCP-tool path (`src/tools/memory-search.ts:71`),
  thread `requestInfo.sourceTaskId` (already extracted in
  `src/tools/utils.ts:18-44`) into `store.search()` — no header changes,
  the data is already in scope.

**Rater interface (unchanged from research doc, with one tightening)**
```ts
interface MemoryRater {
  name: string;
  rate(ctx: RatingContext): Promise<RatingEvent[]>;
}
type RatingEvent = {
  memoryId: string;
  signal: number;     // -1..+1
  weight: number;     // 0..1
  source: string;     // = rater.name; populated by store, not rater
};
```
The `source: string` field is set by the framework (= the rater's `name`),
not the rater itself. Removes a footgun where two raters could spoof each
other.

**LLM-rater client interface**
```ts
interface LlmRaterClient {
  rate(input: { query: string; memory: Memory; response: string }):
    Promise<{ score: number; reasoning: string }>;
}
```
Zod schema for structured output:
```ts
const LlmRatingSchema = z.object({
  score: z.number().min(0).max(1),       // 0 = useless, 1 = decisively useful
  reasoning: z.string().min(1).max(500), // why; captured for telemetry
});
```
The `reasoning` string is captured per `RatingEvent` for telemetry,
debugging, and a future fine-tuning corpus. Stored on a new
`memory_rating(id, memoryId, source, signal, weight, reasoning, createdAt)`
audit table — separate from the `(alpha, beta)` columns so the hot-path
`UPDATE agent_memory` stays narrow. The `useful: boolean` field is
dropped (it's redundant with `score >= 0.5` and adds a second source of
truth).

Default impl `ClaudeCliLlmRaterClient` shells to
`claude -p --model $MEMORY_LLM_RATER_MODEL --output-format json` exactly
like `hook.ts:1097`.

**Concurrency**
- Naive `UPDATE agent_memory SET alpha=alpha+?, beta=beta+? WHERE id=?`
  per `RatingEvent`. Atomic under SQLite WAL.
- Projected worst case ≈ 8 events/sec swarmwide, vs. SQLite's
  ~10k UPDATEs/sec. No batching, no in-memory accumulator, no flush.
- If rates 100×, swap the per-event UPDATE for a batched-flush adapter
  inside `MemoryStore` — interface stable; zero rater changes.

**Backward compatibility (rollout)**
- Env-var driven, no feature flag service.
- `MEMORY_RATERS` unset/empty → `NoopRater` only → no rater fires →
  `(alpha,beta)` stay at `Beta(1,1)` → `usefulness(1,1) = 1.0` →
  reranker score identical to pre-change. Strict no-op.
- Older servers without `/api/memory/rate` → workers POST → 404 → caught,
  swallowed. Older workers without LlmRater patch → server endpoint
  exists, receives nothing → no rows update → no behavioural change.
- Bump version + regenerate OpenAPI per CLAUDE.md.

### Constraints Identified

- **DB-boundary invariant** (`scripts/check-db-boundary.sh`) means NO
  worker-side rater can `import` from `src/be/db` or `bun:sqlite`. All
  worker-side raters POST to `/api/memory/rate`.
- **No new SDK deps in v1.** LlmRater default reuses `claude` CLI
  shell-out. Anthropic-SDK / OpenRouter impls deferred.
- **Forward-only migration.** Adding columns to `agent_memory` is an
  `ALTER TABLE ADD COLUMN`. No down migration. Test against fresh DB
  AND existing DB (per CLAUDE.md migration rule).
- **OpenAPI freshness.** Two new endpoints + one header on `/search` →
  must regenerate `openapi.json` and the api-reference MDX.
- **Secret-scrubbing.** Any rater that logs RatingEvents (e.g., LlmRater
  capturing query+response context) must route through `scrubSecrets`
  before persistence.
- **Test isolation.** ImplicitCitationRater is a pure function; LlmRater
  needs a `MockLlmRaterClient` for tests. Concurrency story is
  testable via N parallel writes against a temp DB.

### Core Requirements (lightweight PRD)

**R1 — Schema**
- `agent_memory.alpha REAL NOT NULL DEFAULT 1.0`,
  `agent_memory.beta REAL NOT NULL DEFAULT 1.0`.
- New `memory_retrieval` table with indexes on `taskId`, `agentId`.
- Single forward-only migration file.

**R2 — Endpoints**
- `POST /api/memory/rate` accepting `{ events: RatingEvent[] }`. Validates
  via Zod, applies `UPDATE` per event in one transaction.
- `GET /api/memory/retrievals?taskId=&sessionId=` returning retrieval rows
  for worker-side raters.
- `POST /api/memory/search` optionally accepts `X-Source-Task-ID`
  (existing convention via `RequestInfo.sourceTaskId`); when present,
  inserts `memory_retrieval` rows for returned memories.

**R3 — Reranker**
- Multiply existing `score` by `usefulness(alpha, beta) =
  clamp(2 × posterior_mean, 1.0, 2.0)`. Returns `1.0` at the default
  `Beta(1,1)` prior — exact no-op vs. today. Proven memories get up to
  a 2× boost. Floor at `1.0` (no demotion) until telemetry justifies it.
  See "Resolved during file-review §1" for rationale.

**R4 — Rater framework**
- `MemoryRater` interface in `src/be/memory/raters/`.
- `RatingEvent` shape with framework-set `source`.
- `NoopRater` (default), `ImplicitCitationRater` (server),
  `LlmRater` + `LlmRaterClient` (worker), `ExplicitSelfRatingRater`
  (worker, MCP tool `memory_rate`).
- Composition: comma-separated `MEMORY_RATERS` env var; per-rater weight
  override via `MEMORY_RATER_WEIGHTS`.

**R5 — LlmRater piggyback**
- Extend `src/hooks/hook.ts` summary call to ALSO emit a Zod-validated
  rating array, parsed alongside the existing summary text.
- Worker GETs `/api/memory/retrievals?taskId=` to know which memories to
  rate. Worker POSTs ratings to `/api/memory/rate`.
- Default LLM client = `claude -p` shell-out (zero new deps).

**R6 — MCP tool `memory_rate`**
- Args: `{ id: string, useful: boolean, note?: string }`. Tool description
  encourages explicit rating mid-task. Worker tool handler POSTs to
  `/api/memory/rate` with intent_weight 1.0, source `"explicit-self"`,
  reasoning = `note` (or empty string).
- **Spam guards** (settled):
  - **At most one `memory_rate` per (taskId, memoryId) for source =
    `explicit-self`.** Enforced via SQLite partial unique index:
    ```sql
    CREATE UNIQUE INDEX idx_memory_rating_explicit_unique
    ON memory_rating(taskId, memoryId)
    WHERE source = 'explicit-self';
    ```
    DB-owned invariant, no race window. Other raters
    (`implicit-citation`, `llm`) can still emit independently for the
    same `(task, memory)` pair — uniqueness is scoped to
    `source = 'explicit-self'`.
  - **Reject IDs not present in `memory_retrieval` for that task.**
    Server-side lookup before insert.
  - **Second call returns 409 Conflict** with a clear error. Agent that
    wants to override gets a separate `memory_rerate(id, useful)` tool in
    a follow-up release — that one owns the replace + undo
    `(alpha, beta)` math. Keeps `memory_rate` semantically pure.
- **Conditional system-prompt mention** in `src/prompts/memories.ts`:
  appended only when `MEMORY_RATERS` includes `explicit-self` —
  preserves prompt parity when the rater is off. See "Resolved during
  file-review §3" for the exact prompt snippet.

**R7 — Tests**
- Unit: pure-function tests for ID-grep detector and Beta-update math;
  unit test for `usefulness(α, β)` returning exactly `1.0` at `(1, 1)`.
- Integration: full lifecycle (search w/ `X-Source-Task-ID` →
  store-progress with cited ID in session_logs → ImplicitCitation fires →
  posterior moves → reranker picks up).
- Concurrency: N parallel POSTs to `/api/memory/rate` against the same
  swarm-scope memory → final `(alpha, beta)` matches sum of inputs.
- Backward-compat: `MEMORY_RATERS=` unset → reranker output identical to
  pre-change snapshot.

**R8 — Documentation**
- `runbooks/memory-system.md` updated with the rater section.
- `MCP.md` updated for `memory_rate`.
- `BUSINESS_USE.md` event flow updated for retrieval / rating events
  (per `<important>` block in CLAUDE.md).

### Resolved during file-review

These were originally Open Questions; the file-review pass collapsed them
into decisions or concrete sketches. Plan can implement directly.

#### 1. Reranker baseline → settled formula

Taras was right: a formula that's `1.0` when `α == β == 1` is the natural
no-op — no special-case branch needed. Adopt:

```ts
// Beta(1,1) → 1.0 (today's behaviour), proven memories climb up to 2.0,
// demoted memories floored at 1.0 (never penalize below today's score).
function usefulness(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta);    // 0..1, 0.5 at default prior
  return Math.max(1.0, Math.min(2.0, 2 * mean));
}
```

Why `Math.max(1.0, …)` (no demotion below 1.0)? Until we have evidence the
LlmRater + ImplicitCitation produce reliable *negative* signal at scale,
demoting memories below baseline is the bigger regression risk. Plan can
revisit once telemetry shows posteriors converge sensibly.

Drops the "skip factor on default priors" alternative entirely.

#### 2. memory_retrieval GC → settled

`FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE`. Rows are
useless once the task is gone; cascade keeps the table self-cleaning.
No background job, no TTL.

#### 3. Explicit MCP tool — shape + conditional prompt addition

**Tool definition** (`src/tools/memory-rate.ts`, new file):

```ts
import { z } from "zod";
import { tool } from "./registrar";

export const memoryRate = tool({
  name: "memory_rate",
  description:
    "Rate a memory you used in the current task. Call this when a " +
    "retrieved memory was clearly useful (or actively misleading) so " +
    "the swarm learns to surface better memories next time.",
  inputSchema: z.object({
    id: z.string().describe("Memory ID returned by memory_search."),
    useful: z.boolean().describe(
      "true = this memory helped solve the task; false = misled or wasted time.",
    ),
    note: z.string().max(280).optional().describe(
      "Short reason. Captured for telemetry; not surfaced to other agents.",
    ),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string() }),
}, async ({ id, useful, note }, requestInfo) => {
  // POSTs a single RatingEvent to /api/memory/rate with:
  //   { memoryId: id, signal: useful ? +1 : -1, weight: 1.0,
  //     source: "explicit-self", reasoning: note ?? "" }
  // Per the rater framework's "framework sets source" rule, the worker
  // posts source="explicit-self"; server validates rater is registered.
  // ...
});
```

**Conditional system-prompt addition** (`src/prompts/memories.ts`):

```ts
// Existing memories prompt:
let prompt = renderMemoriesSection(memories);

// NEW: only add rate-tool encouragement when the rater is enabled
const ratersEnabled = (process.env.MEMORY_RATERS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (ratersEnabled.includes("explicit-self")) {
  prompt += `

When a memory above genuinely helps you solve this task — or actively
misleads you — call \`memory_rate\` with the memory id and useful=true/false.
This trains the swarm to surface better memories next time. Use sparingly:
2-5 ratings per task is plenty.`;
}
```

The `if (ratersEnabled.includes("explicit-self"))` gate keeps the prompt
identical to today when the rater is off — strict backward compatibility.

#### 4. LlmRater Zod schema → settled (with reasoning)

Output of the piggybacked summary call:

```ts
const SummaryWithRatingsSchema = z.object({
  summary: z.string(),
  ratings: z.array(
    z.object({
      id: z.string(),                          // memory id from /retrievals
      score: z.number().min(0).max(1),         // 0..1
      reasoning: z.string().min(1).max(500),   // captured for audit
    }),
  ).default([]),
});
```

Worker maps each rating to a `RatingEvent` via:
```ts
{ memoryId: r.id,
  signal: 2 * r.score - 1,         // 0..1 → -1..+1
  weight: 0.8,                     // research doc's LLM intent_weight
  source: "llm" /* set by framework */,
  reasoning: r.reasoning }
```
`score: 0..1` (not -1..+1) because LLMs handle "rate 0 to 1" prompts
better than signed scales; the worker maps to the framework's internal
`signal: -1..+1` shape on the way to `/api/memory/rate`.

#### 5. Header plumbing → confirmed (with one correction)

**Header name correction:** the existing convention is `X-Source-Task-ID`,
not `X-Task-ID`. Use the existing header — no new convention. Source:
`src/tools/utils.ts:18-44` (`RequestInfo.sourceTaskId` already extracts
`x-source-task-id`).

**Two distinct call paths to memory search:**

| Path | File | Has taskId? | Plumbing |
|---|---|---|---|
| In-process MCP tool | `src/tools/memory-search.ts:71` | Yes — `requestInfo.sourceTaskId` already exists | Pass `sourceTaskId` into `store.search()` so it inserts `memory_retrieval` row. Tool handler unchanged externally. |
| HTTP endpoint | `/api/memory/search` from `src/commands/runner.ts:1550` | No — only `X-Agent-ID` set today | Add `X-Source-Task-ID: ${taskId}` header in runner.ts. `src/http/memory.ts:185` reads it via the same `requestInfo` extraction. |

So the gap is *one* line in `runner.ts:1544-1548` (add header) and one
parameter on `store.search()` for the MCP-tool path. Genuinely small.

`/api/memory/search` (HTTP) needs the `X-Source-Task-ID` header to be
**optional** — third-party callers without a task context still work
(no retrieval row inserted; behaviour identical to today).

### Remaining truly-open question

None at brainstorm exit. All five Open Questions and the post-synthesis
spam-guard concern were resolved during file-review (see §1–§5 above and
R6). Plan can proceed to mechanical translation.


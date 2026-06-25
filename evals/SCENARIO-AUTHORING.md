# Authoring, operating, and maintaining eval scenarios

This is the durable rulebook for the `agent-swarm` evals subproject. It is written for two audiences:

1. **Claude Code sessions** authoring or maintaining scenarios in this repo.
2. **The deployed swarm's own agents**, asked to propose new scenarios or rubric changes.

Read it before you write a check, design a rubric, or run a pilot. It encodes lessons that cost real money and several wrong turns to learn — do not re-derive them. Every claim below is grounded in the code; file:line refs point at the source of truth (line numbers drift — grep the symbol if a ref is off).

> **TL;DR of the non-negotiables** (each expanded below):
> 1. **Deterministic-first.** A judge is the last resort, and never the discriminator.
> 2. **Never penalize mandatory behavior.** Audit every negative check: can a *correct* run trip it?
> 3. **Grade artifacts the MODEL controls, not SYSTEM emissions.** Child tasks, merged reports — not config/timing-dependent side-effects.
> 4. **De-risk before you build.** Prove discrimination on ONE dimension × TWO tiers (~$4) before authoring a whole axis.
> 5. **Grade BEHAVIOR, not just OUTCOME.** Correctness saturates across tiers; behavior separates them.

The canonical worked example referenced throughout is **`scenarios/delegation-probe.ts`** (+ `delegation-probe.test.ts`). When in doubt, read it.

---

## 1. What an eval scenario is

The harness runs a **scenario × harness-config matrix** against real swarm stacks in E2B sandboxes, then grades each attempt (`README.md`). A *cell* is one `(scenario, config)` pair; each cell runs `--attempts N` times. One attempt:

1. **Boot** a fresh API sandbox + one worker sandbox per roster member (plus the lead if `scenario.lead` is set).
2. **Seed** (optional): a SQL dump imported before the API boots, `exec` shell commands, indexed `memories`, and `workerFailures` injection.
3. **Run**: create the scenario's task(s), poll to terminal status or timeout.
4. **Grade** with the scenario's `OutcomeSpec`.
5. **Persist artifacts** (redacted), then **tear down** both sandboxes.

### OutcomeSpec v2 (the scoring contract — v8.0)

`OutcomeSpec` (`src/types.ts:224`) has two halves:

- **`gates: DeterministicCheck[]`** — binary must-pass. A single failed gate forces `passed = false` regardless of score (`src/scoring.ts:97` `finalizeScore`). The runner also **prepends a synthetic `tasks-completed` gate** (`allTasksCompleted`) so every spec gates on all tasks reaching terminal status.
- **`dimensions: DimensionSpec[]`** — weighted graded dimensions, each scored in `[0,1]`.

**The score formula** (`src/scoring.ts:82` `aggregateScore`, `:97` `finalizeScore`):

```
score  = Σ(wᵢ · dimᵢ) / Σ wᵢ           # weighted mean over dimensions
passed = allGatesPass && score >= passThreshold   # default passThreshold = 0.75
```

`passThreshold` defaults to `DEFAULT_PASS_THRESHOLD = 0.75` (`src/scoring.ts:17`) and gates the **weighted aggregate**, not each judge individually.

**Each dimension is checks XOR judge — never both** (`DimensionSpec`, `src/types.ts:214`; validated in `src/registry.ts:120` `validateDimensions`):

- `checks: DeterministicCheck[]` → the dimension sub-score is the **weighted mean of per-check values** (`dimensionScoreFromChecks`, `src/scoring.ts:61` — `Σ wᵢ·valueᵢ / Σ wᵢ`). A check supplies its value via `CheckResult.score ∈ [0,1]`; when omitted it falls back to the binary `pass` (1/0) (`src/types.ts:159`).
- `judge: JudgeSubSpec` → an LLM or agentic judge grades that one dimension.
- Setting **both** is a load-time error: the runner short-circuits on checks, so a co-set judge would be dead code. Split into a check-fed dimension and a judge-only dimension.

**The special deterministic `efficiency` dimension** (`src/scoring.ts:41`, runner `isDeterministicEfficiencyDimension` / `efficiencyDimensionScore` ~`src/runner/index.ts:828`): a dimension **named exactly `efficiency` with no checks and no judge** is scored by the runner from the attempt's **real** cost/duration vs `scenario.budgetUsd` / `scenario.budgetMs`. It scores 1.0 at or under budget, decaying linearly to 0 at `EFFICIENCY_DECAY_FACTOR` (= 3) × budget. With both budgets set, the sub-score is `MIN(cost, time)` (worst-case discipline). An **unpriced** attempt drops the cost term (re-normalized out — never scored 0). Such a dimension **requires** a budget or the registry rejects it (the weight would be dead).

### Five canonical dimension names (and custom names)

`CoreDimension` (`src/types.ts:185`): `correctness`, `completeness`, `efficiency`, `instruction-following`, `communication`. **Custom names are allowed** (`DimensionName = CoreDimension | (string & {})`); the registry validates *structure* (weight > 0, source present, unique name), never the name set — so `delegation` is a legal dimension name (delegation-probe uses it). Core names just drive validation messaging and UI grouping (`CORE_DIMENSIONS`, `src/registry.ts:22`).

---

## 2. Anatomy of a scenario module

A scenario is a `Scenario` object (`src/types.ts:302`) exported from `scenarios/<id>.ts`. Fields:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable slug, e.g. `"delegation-probe"`. Used everywhere. |
| `name` | `string` | Human label. |
| `description?` | `string` | Free text. |
| `workers?` | `number \| WorkerSpec[]` | `N` homogeneous default workers, OR one configured worker per entry. Default 1, **max 3**. `WorkerSpec` (`src/types.ts:290`): `name` / `template` / `systemPrompt` / `configId` / `model` / `env`. Reserved env keys (`API_KEY`, `MCP_BASE_URL`, `AGENT_ID`, …) are rejected. |
| `lead?` | `WorkerSpec` | Boots one extra sandbox with `AGENT_ROLE=lead`. Does **not** count toward the 3-worker cap. Required if any task uses `worker: "lead"`. |
| `seed?` | `ScenarioSeed` | `exec` (shell in worker 0), `memories` (indexed via memory API), `sqlDump` (fixture filename), `workerFailures` (failure injection). See §3. |
| `tasks` | `TaskSpec[]` | The initial task(s). `TaskSpec` (`src/types.ts:81`): `title`, `description`, `worker?` (index, or `"lead"` → unassigned, routed to the lead), `dependsOn?` (indices of prerequisite tasks; cycles/self-refs/out-of-range rejected at load). |
| `outcome` | `OutcomeSpec` | Gates + dimensions (§1). |
| `timeoutMs?` | `number` | Per-attempt wall-clock budget. Default 10 min. delegation-probe uses `15 * 60_000`. |
| `budgetUsd?` / `budgetMs?` | `number` | Feed the deterministic `efficiency` dimension. Must be > 0 when present. |

The task `description` is **scenario data** — author it inline in the module (like delegation-probe and distributed-audit do). This is NOT the `src/prompts/` template-registry rule (that governs runner/hook/provider prompts in the main repo, not eval scenario text).

### Registration — two places, both required

1. Import + append to the `scenarios` array in **`scenarios/index.ts`**.
2. Add the `id` to **`EXPECTED_IDS`** in `scenarios/scenarios.test.ts` (line ~40). `scenarios.test.ts` asserts the registry keys exactly equal `EXPECTED_IDS` — forget step 2 and the suite fails.

Every scenario is **shape-validated at registry load** (`validateScenario`, `src/registry.ts`): bad definitions fail `bun src/cli.ts registry` / server boot with the full violation list. Run `bun src/cli.ts registry` as your first sanity check after authoring.

---

## 3. Seed fixtures

When a scenario needs pre-existing DB state (historical tasks to audit, seeded scripts), reference an INSERT-only SQL seed via `seed.sqlDump` (bare filename, e.g. `"delegation-probe-history.sql"`). Files live in `scenarios/fixtures/`. Full conventions: `scenarios/fixtures/README.md`.

The seed is **INSERT-only** — just the reference rows. The schema is **not** in the fixture: it is built **pre-boot** from the **real migrations** in the API image. Before the API boots, `bootStack` (`src/swarm/sandbox.ts`) applies the migration `.sql` files in `MIGRATIONS_DIR` (`/app/migrations`) exactly the way `src/be/migrations/runner.ts` does — same filename sort, same `_migrations` bookkeeping (`version`, `name`, `applied_at`, `checksum`) — then applies the INSERT-only seed on top. The booting API then finds `_migrations` fully populated and applies zero further migrations. This eliminates the schema-drift footgun of the old full-dump fixtures.

### Format & hard rules

- **INSERT-only text.** Just `INSERT INTO …` rows (comments are fine). NO `CREATE TABLE`, NO `_migrations`, NO PRAGMAs/`BEGIN`/`COMMIT`. `validateSqlDumpText` (`src/runner/index.ts`) rejects, pre-sandbox, any fixture that contains `CREATE TABLE` or references `_migrations` (a stale full dump) or that carries no INSERT rows. 5 MB hard cap.
- **Reference data only — enforced by the validator.** NO `agents` rows (workers self-register; a colliding id is silently reused), NO in-flight (`'pending'`/`'running'`) tasks (the booting worker would claim them), NO sessions/locks, NO `agent_memory` rows (sqlite-vec embeddings aren't portable — use `seed.memories` instead). Every seeded task must be **terminal** (`completed`/`failed`/`cancelled`).
- **Filename**: bare, ending `.sql`, no path separators — enforced by `SQL_DUMP_NAME_RE = /^[A-Za-z0-9._-]+\.sql$/` (`src/registry.ts:56`) at load.
- The schema is always the image's migration set, so a seed is never "too old/new". The only constraint: the rows must match the columns the migrations create (a column a future migration removes would make the INSERT fail loudly at seed time).

### Generators — fixtures are generated, not hand-edited

Each non-trivial fixture has a `scenarios/fixtures/generate-*.ts` companion (e.g. `generate-delegation-probe-history.ts`). The generator:
- Holds the answer-key rows in a deterministic `TASKS` array (no randomness → reproducible) and emits an INSERT-only seed (no base dump, no schema).
- Calls `validateSqlDumpText` on its own output before writing.
- **Prints the answer key** at the end. Regenerate with `bun scenarios/fixtures/generate-<name>.ts`, then **mirror the printed answer-key constants into the scenario module**. Commit the regenerated `.sql` alongside the scenario change.

### THE answer-key rule: the answer lives ONLY in the seeded DB, never in the prompt

The facts a config must discover (counts, the top-priority title, …) must exist **only** in the seeded rows. If the task prompt names them, you are grading reading comprehension, not capability — and every tier saturates.

Enforce it with a **leak test** (pattern from `delegation-probe.test.ts:222`):

```ts
it("the lead task prompt does NOT leak the answer-key facts", () => {
  const prompt = delegationProbe.tasks[0]?.description ?? "";
  expect(prompt).not.toMatch(/\b11\b/);                 // completed count
  expect(prompt).not.toMatch(/analytics warehouse/i);   // top-priority title
  expect(prompt).not.toMatch(/\bcompleted tasks?:?\s*11\b/i);
});
```

When you change the dataset, regenerate the fixture, update the answer-key constants in the scenario, AND update the leak-test patterns.

---

## 4. Writing deterministic checks

A `DeterministicCheck` (`src/types.ts:171`) is `{ name, fn: (ctx) => Promise<CheckResult>, weight? }`. `CheckResult` (`src/types.ts:159`) is `{ pass: boolean, detail?: string, score?: number }` — set `score ∈ [0,1]` for graded partial credit; omit it for binary pass/fail.

### The `ctx` object (`JudgeContext`, `src/types.ts:374`)

| Field | What it gives you |
|---|---|
| `ctx.tasks: SwarmTask[]` | Completed task records from the swarm API — **including runtime-spawned children and follow-ups** (see below). |
| `ctx.workers: JudgeWorkerContext[]` | One per booted worker, ascending index. Each has `index`, `agentId`, `isLead`, `role`, `name`, `template`, `exec(cmd)`, `readFile(path)` (`src/types.ts:357`). |
| `ctx.readFile(path)` / `ctx.exec(cmd)` | Aliases of `workers[0]`. For a multi-worker scenario, prefer `ctx.workers[i].readFile`. Returns `null` for a missing file. |
| `ctx.apiGet(path)` | **Authenticated GET against the attempt's swarm API.** Use for anything not in `ctx.tasks`, e.g. `apiGet("/api/tasks/<id>/session-logs?limit=500")`, `apiGet("/api/tasks/<id>")`. This is `client.get` under the hood (`src/runner/index.ts:1515`). |

**Runtime-spawned tasks are merged into `ctx.tasks` for you** (`src/runner/index.ts:1279`). The scenario's upfront tasks are the only ones awaited, but agents spawn more at runtime — lead-delegated child tasks, the `taskType="follow-up"` tasks a worker completion triggers, resume tasks. Because each attempt gets a **fresh DB**, `client.listAllTasks()` returns exactly this attempt's tasks, and the runner merges any not already tracked into `ctx.tasks` (read-only, best-effort — a list failure degrades scoring to the upfront set, never fails the attempt). So your checks can read child/follow-up tasks **directly from `ctx.tasks`**.

`SwarmTask` (`src/types.ts:397`) is normalized (`normalizeTask`, `src/swarm/client.ts:318`): the API's `output`→`result`, `task`→`description`, `taskPreview`→`title`. It carries `id`, `title`, `description`, `status`, `result`, plus an index signature, so delegation fields the API returns (`agentId`, `creatorAgentId`, `parentTaskId`, `source`, `taskType`, `priority`) are readable directly.

### Reusable helpers (`src/judge/deterministic.ts`)

- `allTasksCompleted()` — gate: every task in `ctx.tasks` is `done`/`completed`.
- `fileContainsOnWorker(worker, path, /regex/)` — gate/check: `ctx.workers[worker]` has a file matching the regex.
- `fileAbsentOnWorker(worker, path)` — inverse.

Promote a check here **only if it is cleanly reusable**; otherwise keep it in the scenario module (delegation-probe keeps its delegation-specific checks local).

### Inspecting session logs

Pull a task's session logs with `apiGet("/api/tasks/<taskId>/session-logs?limit=N")`, then `parseToolUses(rows)` (`src/judge/session-log-parse.ts:64`) → `ToolUse[]` (`{ taskId?, toolName, input, isError? }`). Match tool names with `toolUseMatches(name, patterns)` (substring or regex). This is how you grade *who ran which tool* — e.g. "did the lead query the tasks API itself?".

### The single-composite-check-per-dimension pattern (and why)

delegation-probe scores its `delegation` dimension with **one** check (`delegationDimensionCheck`, `src/scenarios/delegation-probe.ts:294`) that internally computes P1/P2/P4/Q1/Q4 and the N-penalties and returns one `score`. This is deliberate. `dimensionScoreFromChecks([{value, weight:1}])` returns `value`, so a single composite check **lets you fully control aggregation inside one function** — in particular it lets one sub-check **hard-zero** the whole dimension before any positive credit is computed:

```ts
// N1 short-circuit (delegation-probe): the lead audited the history itself →
// return score 0 BEFORE summing any positive credit, so a solo lead that ALSO
// delegated cannot dilute the zero back up.
const soloQuery = leadQueriedTasksApi(leadTools);
if (soloQuery) {
  return { pass: false, score: 0, detail: "N1 violated: lead queried tasks API itself — dimension zeroed" };
}
```

If you instead split P1/P2/N1 into separate checks within the dimension, the framework's weighted mean would let positive checks partially offset the N1 failure — you could not express "this disqualifies the whole behavior." The composite gives you that lever. The trade-off: the composite is a single point of failure, so it must be unit-tested hard (§10).

---

## 5. Rubric-design principles (the hard-won rules)

Each rule below has a war-story from the delegation-probe arc. Internalize them; they are why the rubric looks the way it does.

### Rule 1 — Deterministic-first; a judge is the last resort

The entire swarm-mechanics redesign exists because **a soft agentic judge was too noisy to discriminate model tiers**. Correctness saturated and the judge's vibe score had too much variance to separate a frontier model from a budget anchor. The fix was to grade the **observable paper-trail** (child tasks created, worker tasks completed, whether the report's facts trace back to worker output, who ran which tool) deterministically.

If you genuinely must grade un-deterministic quality (prose, judgment), make it a **separate, tightly-anchored dimension** (`checks XOR judge`), with low-variance 0/1 anchored criteria — never a free-form vibe score. Keep it off the discriminating axis.

### Rule 2 — Never penalize MANDATORY behavior

A retired check (the old `N2`) penalized the lead for `Write`-ing the merged report — but writing the report was **required** by the report-exists gate. Every competent run tripped it, so the dimension pinned to a **constant 0.50** with zero discrimination. **Audit every negative check: can a correct run trip it?** If yes, it is broken. There is a regression test for exactly this (`delegation-probe.test.ts` case `(a2)`: "a delegator that Wrote/Edited but never audited solo scores 1.0").

### Rule 3 — Grade artifacts the MODEL controls, not SYSTEM emissions

A retired check (the old `P3`) required a `taskType='follow-up'` **system** task to exist. But a lead can legitimately set `followUpConfig.disabled` and emit none, scoring 0 on a perfect run (it managed the merge itself). System side-effects are config/timing-dependent and brittle. **Measure things the model directly produced** — the child tasks it created, its merged report, whether the report's facts trace back to worker output. P3's intent ("lead used worker output") is now carried, more robustly, by Q4. The follow-up count survives only as an observability `detail` string, never affecting the score.

### Rule 4 — Strong checks measure fidelity and are hard to game; weak checks are proxies

**Q4 "facts-flow-through-workers"** (the merged report's answer-key facts must *also* appear in the WORKER task output, else the lead re-derived solo) is robust: it catches delegate-then-solo even when P1/P2 pass. It became the dimension's heaviest positive sub-check (weight 4). Contrast with **gameable proxies** — keyword/length heuristics like "child description ≥ 80 chars with status keywords" — which over-fit the prompt and reward shape over substance. Defer proxies; prefer fidelity checks that trace one artifact back to another.

### Rule 5 — Enumerate gaming routes

For every "don't do X" check, list **every tool/route that does X**. A lead audited the seeded DB itself via the `db-query` MCP tool, dodging a "no-solo-research" check that only watched `Bash`. delegation-probe's N1 detection now matches the `get-tasks`/`list-tasks` MCP tools **and** a raw `GET /api/tasks?...status=...` via Bash/curl/fetch (`leadQueriedTasksApi` + `STATUS_FILTER_RE`, `src/scenarios/delegation-probe.ts:158`), and N2 separately watches the `db-query` path. Test the anti-gaming routes explicitly (`delegation-probe.test.ts` case `(a3)`).

### Rule 6 — Watch weight concentration & accidental domination

A composite check that can hard-zero a dimension (N1 → 0) is powerful — make sure it is **intentional**, not an accident of how partial credit sums. Equally, folding most of the weight into one sub-check (Q4 at ~36% of positive weight) creates a single point of failure: **validate it does not misfire on faithful runs**. Both directions need a unit test asserting the aggregate behaves on a clean, correct run.

### Rule 7 — Grade BEHAVIOR, not just OUTCOME

Correctness/answer-key checks **saturate** across tiers — both a frontier and a budget model can audit a 20-row DB. So correctness does not discriminate. The **behavioral axis** (did the lead actually delegate, and how well) is what separates tiers. delegation-probe weights `delegation` at 5 and keeps `correctness` at 2. Keep correctness as a small gate/dimension; put the discriminating weight on behavior.

---

## 6. Reliability metric — mean ± CI, not best@n

The headline for a cell is the **mean per-attempt dimension score with a bootstrap confidence interval** (`CellSummary`, `src/results.ts:17`):

- `meanScore` — mean of the cell's per-attempt scores (`src/results.ts:90`).
- `scoreCI` — `bootstrapCI(scores, { seed })` (`src/stats.ts:89`). The bootstrap is **seeded** so the CI is deterministic for a given set of scores.
- `passRate` + `passRateCI` — the companion: fraction passing the threshold, with a **Wilson interval** (`wilsonInterval`, `src/stats.ts:124`).

Read mean ± CI as the headline, pass-rate (Wilson) as the companion. The **✓/~/✗ indicator** compares the threshold against the CI: clearly above, overlapping, or clearly below. **`n` (attempts) is your confidence dial** — more attempts tighten the CI; a wide CI means "run more attempts before concluding," not "the result is bad."

For tier comparison (calibration), use the **gap + significance** (`scripts/calibration-report.ts`): `frontierAvg − budgetAvg`, with a bootstrap CI on the difference (`bootstrapDiffCI`, `src/stats.ts:158`). The gap is **significant** when its CI **excludes 0** (`GapCI.significant`). Ship gate: `gap >= SHIP_GATE_GAP` (0.2); borderline `[0.1, 0.3]` → run +2 attempts/anchor before a verdict.

**Do NOT use best@n** as the headline. best@n ("any attempt passed") rewards lucky variance and hides unreliability — a model that passes 1-in-5 looks identical to one that passes 5-in-5. Mean ± CI and pass-rate make reliability visible. (Note: the legacy `README.md` text and some per-cell stats still mention "best@n" — that is stale relative to the v8.0 mean±CI headline; see §11.)

---

## 7. The de-risk pilot pattern

**Before building a whole axis, prove it discriminates.** A pilot is the cheapest possible test that a *dimension* separates a strong model from a weak one.

1. Pick **ONE dimension** and **TWO configs**: a frontier anchor (e.g. `claude-opus-4.8`) vs a deliberately-weak budget anchor (e.g. `pi-deepseek-flash` or `claude-haiku`). Anchors live in `scripts/calibration-report.ts` (`FRONTIER_ANCHORS`, `BUDGET_ANCHORS`) and the config roster in `configs/index.ts`.
2. Run a handful of attempts each (≈$4/pilot).
3. **Read the DIMENSION gap, not the total score** — total score is contaminated by saturating dimensions (correctness). Check whether the dimension's frontier−budget gap is positive and whether its CI **excludes 0**.
4. **Iterate cheaply.** A pilot that shows no gap (or a constant score) is telling you the rubric is broken, not the models — fix the rubric and re-pilot.

### Worked example — the delegation-probe 4-pilot arc

1. **Pilot 1 (0.50-constant):** the dimension scored a flat 0.50 for every config — zero discrimination. Root cause: a negative check (old N2) penalized **mandatory** report-writing (Rule 2), so every competent run lost exactly that weight. The constant was the tell.
2. **Fix + re-pilot → GO:** removed the mandatory-behavior penalty; delegation gap opened to **0.60**, CI excluding 0 at n=5. Discrimination proven.
3. **Quality refinement:** added the Q4 fidelity check (facts-flow-through-workers, Rule 4) to grade *how well* the lead delegated, not just *whether*.
4. **P3 fix:** dropped the brittle system-follow-up check (Rule 3) that zeroed perfect runs with follow-ups disabled; folded its weight into Q4.

The lesson: a **constant** score across tiers, or a gap whose CI includes 0, means iterate on the rubric — do not scale up attempts hoping the gap appears.

---

## 8. Running pilots & reading results

From `evals/` (after `bun install` and copying secrets into `evals/.env`):

```bash
bun src/cli.ts registry                       # list scenarios + configs; validates every spec
bun src/cli.ts run --scenarios delegation-probe \
  --configs claude-opus-4.8,pi-deepseek-flash --attempts 5
bun src/cli.ts resume <runId>                 # re-run unfinished/errored attempts
bun src/cli.ts show <runId>                   # terminal result matrix
bun src/cli.ts serve                          # dashboard (default http://localhost:4801)
```

### The `EVALS_DB_*` override gotcha

DB selection precedence (`src/db/client.ts:18`):

1. `EVALS_DB_SYNC_URL` set → Turso embedded replica (needs `EVALS_DB_AUTH_TOKEN`). **This wins.**
2. else `EVALS_DB_PATH` set → plain local file, no sync.
3. else → throws (never silently creates an empty DB).

So **`EVALS_DB_PATH` is ignored whenever `EVALS_DB_SYNC_URL` is set** (it usually is, via `evals/.env`). To force a local/offline DB for a one-off, clear BOTH sync vars on the command:

```bash
EVALS_DB_SYNC_URL='' EVALS_DB_AUTH_TOKEN='' EVALS_DB_PATH=/tmp/evals.db \
  bun src/cli.ts run --scenarios delegation-probe --configs claude-haiku --attempts 2
```

### Fresh-DB-per-attempt

Every attempt boots a fresh API DB, which is **why `client.listAllTasks()` returns exactly that attempt's tasks** and the runtime-spawned-task merge (§4) is sound. Don't write checks that assume tasks from other attempts exist.

### Post-hoc analysis via the `artifacts` table

When a score lands somewhere surprising, debug from the persisted per-attempt artifacts (one row per `kind`, written in `src/runner/index.ts`):

| `kind` | Contents |
|---|---|
| `task` | The full task records (upfront + runtime-spawned). |
| `raw-session-logs` | `session-logs.jsonl` — the swarm session events your checks parse. |
| `harness-session` | The harness's own raw session files (Claude `~/.claude/projects/**`, codex, pi, opencode, ai-sdk-agent when available). |
| `transcript` | Flattened transcript. |
| `sandbox-log` | Worker + API entrypoint log tails. |
| `meta` / `deterministic` / `llm` | Judgment rows + seed/roster/cost metadata. |

Read these to see *what the model actually did* — e.g. open `raw-session-logs` for the lead task to confirm whether N1 fired correctly, or `task` to see which child tasks were spawned.

---

## 9. Gotchas

- **Evals talk to the API over HTTP only.** Never import `src/be/db` or `bun:sqlite` from `evals/`. Checks read state via `ctx.apiGet` / `client.listAllTasks` — never a direct DB handle.
- **Session logs are provider-shape-dependent.** `parseToolUses` normalizes Claude / pi / codex / opencode / ai-sdk-agent envelopes (`src/judge/session-log-parse.ts`). Claude/pi share the `{type:"assistant", message.content[].type==="tool_use"}` shape; codex mirrors raw SDK ThreadEvents; opencode and ai-sdk-agent emit native `tool_start`/`tool_end` events. Don't assume a single shape.
- **opencode tool-error caveat.** The swarm opencode adapter only fires `tool_end` on a `completed` part and **never propagates an error flag**, so MCP-error results read as `completed` → opencode's tool-error *rate* reads artificially low. Don't build a discriminating check on opencode error-rate alone.
- **Match Biome style.** Use Bun APIs (`Bun.file`, `Bun.$`), not Node. Match surrounding formatting.
- **Before commit, run** (from `evals/` unless noted):
  ```bash
  bun run tsc:check
  bun test                         # full suite must stay green
  bun src/cli.ts registry          # every spec validates, fixtures load
  bun run lint                     # from repo ROOT (read-only); lint:fix if it reformats
  bash scripts/check-db-boundary.sh   # from repo root — no src/be/db imports
  ```

---

## 10. Validating a rubric without spending money — the unit-test pattern

You can fully unit-test a rubric against a **synthetic `JudgeContext`** — no E2B, no cost. This is mandatory for any composite check (it is a single point of failure). Pattern from `delegation-probe.test.ts`:

1. Build a `makeCtx({...})` helper that constructs a `JudgeContext` with a stubbed task list, a stubbed `apiGet` that returns per-task session-logs keyed by `taskId`, and per-worker `readFile`s:

   ```ts
   const apiGet = async (path: string): Promise<unknown> => {
     const m = /\/api\/tasks\/([^/]+)\/session-logs/.exec(path);
     if (m) return { logs: sessionLogsByTask[m[1]] ?? [] };
     return {};
   };
   ```
   (`apiGet` in checks is a newer pattern — older fixtures stub `apiGet: async () => ({})`; you need the richer stub above to exercise N1/P4/Q4.)

2. Write one test per behavior you must distinguish. delegation-probe asserts the aggregate score **and** `passed` for: (a) clean delegation → high; (a2) write-the-report-but-don't-audit-solo → 1.0 (Rule 2 regression); (a3) audit-via-db-query → N2 trips (Rule 5 anti-gaming); (a4) research-after-delegating → N4 only; (b) solo-but-correct → `delegation === 0` though `correctness` high; (b') solo-that-also-delegated → still 0 (N1 dominates, Rule 6).
3. Add the **leak test** (§3) asserting the prompt doesn't contain the answer-key facts.

Run with `bun test scenarios/<id>.test.ts`.

---

## 11. For the deployed swarm — proposing scenarios / rubric changes

If you are a swarm agent asked to propose or improve a scenario:

1. **Read this rulebook first.** Apply the §5 rules and the §1 scoring contract.
2. **Draft the scenario module + rubric**, deterministic-first (§4, §5). Add a fixture + generator if you need seeded state (§3), and a leak test.
3. **Validate locally — but do NOT run E2B yourself (it costs real money).** What you CAN run without spending:
   - `bun src/cli.ts registry` — confirms your spec validates and the fixture loads.
   - `bun run tsc:check`, `bun test` — confirms the module + rubric unit tests pass.
   - A **rubric unit test against a synthetic `JudgeContext`** (§10) — this is how you prove the rubric discriminates *without* a real run.
4. **Propose, don't pilot.** Open a PR comment (or a `thoughts/` doc) describing the scenario, the dimension(s), the discrimination hypothesis (which tiers it should separate and why), and your synthetic-test evidence. **Request a de-risk pilot** (§7) — the human/orchestrator runs the ~$4 frontier-vs-budget pilot and reads the dimension gap.
5. **Ground every proposal in evidence.** "This should discriminate because correctness saturates but delegation behavior doesn't" + a passing synthetic test is a proposal. A vibe is not. Prefer deterministic checks over judges; prefer behavioral discrimination over saturating correctness.

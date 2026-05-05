---
id: step-7
name: Docs + BUSINESS_USE flows + cross-cutting end-to-end test
depends_on: [step-4, step-6]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: Docs + BUSINESS_USE flows + cross-cutting end-to-end test

## Overview

Capstone integration step. Update the three documentation surfaces called out in R8 (`runbooks/memory-system.md`, `MCP.md`, `BUSINESS_USE.md`), regenerate `BUSINESS_USE.md` via the auto-generator (it's not hand-edited), instrument the business-use events at the rating-write and retrieval-write call sites, regenerate `openapi.json` once more for freshness, and run the cross-cutting e2e test that exercises all three raters + the v1.5 edge path together.

This step depends on step-4 (LlmRater) and step-6 (edges) — between them they transitively cover step-2, step-3, and step-5.

## Changes Required:

#### 1. `runbooks/memory-system.md` — rater section

**File**: `runbooks/memory-system.md`

**Changes**:

- After the existing "Architecture" section, add a "Memory raters (v1.5)" section covering:
  - The three raters: `ImplicitCitationRater` (server, ID-grep over session_logs), `LlmRater` (worker, piggybacks `hook.ts` summary call), `ExplicitSelfRatingRater` (worker, MCP tool `memory_rate`).
  - The `MEMORY_RATERS` env variable + the `MEMORY_RATER_WEIGHTS` override + the `MEMORY_DEMOTION_FLOOR` env variable (default `1.0` = no demotion; lower per deployment when telemetry shows reliable negative signal — Q1 resolution).
  - The reranker `usefulness(α, β)` formula = `clamp(2 × α/(α+β), MEMORY_DEMOTION_FLOOR, 2.0)`.
  - The two new endpoints: `POST /api/memory/rate`, `GET /api/memory/retrievals`.
  - The `references-source` edge feature: table schema, optional `referencesSource` field on `memory_rate`, `GET /api/memory/edges`.
  - **Q2/Q3 free-form `to_id` contract**: `to_id` is a free-form string with the convention `<source>:<identifier>` (e.g. `github:owner/repo#N`, `linear:KEY-N`, `customer:<slug>`, `slack:<channel>:<ts>`, `agentmail:<thread-id>`). No closed enum, no parser, no `CHECK` constraint on prefixes — adding a new integration requires zero swarm-side code change. Validation = non-empty + ≤512 chars + control-char strip + no NUL. Storage = plain `TEXT`, indexed by plain B-tree. Reference but contrast with `src/tasks/context-key.ts` (which uses a closed enum because tasks are core scheduling primitives — `references-source.to_id` is deliberately the opposite).
  - Out-of-scope (v2) callouts: edge-aware reranking, edge GC, multi-type edges, supersedes/contradicts.
- Add the four new test files to the existing "Tests" block.

#### 2. `MCP.md` — `memory_rate` tool

**File**: `MCP.md`

**Changes**:

- Add `memory_rate` to the tools reference, mirroring the existing `memory_search` / `memory_store` entries. Cover the input schema (id, useful, note?, referencesSource?), the spam-guard semantics (one explicit-self per (taskId, memoryId)), and the return shape.

#### 3. Business-use instrumentation at rating + retrieval write sites

**File**: `src/be/memory/raters/store.ts` (touched in step-1, step-6)

**Changes**:

- After each successful `applyRating` transaction, call `ensure(...)` from the business-use SDK to emit a `memory_rated` event in the `task` flow. Per `CLAUDE.md`'s `<important>` BU block:
  - Place the call after the successful state mutation, OUTSIDE the transaction.
  - Validator (if any) is self-contained — references only `data` and `ctx` params.
  - Use `runId = taskId` per the `task` flow convention.
- Event payload: `{ memoryId, source, signal, weight, hasReferencesSource: boolean }`.

**File**: `src/be/memory/raters/retrieval.ts` (created in step-2)

**Changes**:

- After `recordRetrievals` writes, emit a `memory_retrieved` event in the same flow.
- Payload: `{ count, taskId, agentId }`.

#### 4. Regenerate `BUSINESS_USE.md`

**Commands**:

- `bun run docs:business-use` (requires the BU backend running locally; see `<important>` block in `CLAUDE.md`). Commit the regenerated `BUSINESS_USE.md`.
- The regenerated file should include `memory_retrieved` and `memory_rated` events in the `task` flow diagram.

#### 5. Final OpenAPI freshness check

**Commands**:

- `bun run docs:openapi` — confirm no diff after step-6's commit. If a diff appears (e.g., a description text was tweaked), commit it as part of step-7.

#### 6. Cross-cutting end-to-end test

**File**: `src/tests/memory-rater-e2e.test.ts` (new)

**Changes**:

- Spin a fresh DB, set `MEMORY_RATERS=implicit-citation,llm,explicit-self`, run the API server in-process.
- Insert two synthetic memories `mem-A`, `mem-B` (one agent-scope, one swarm-scope).
- Create a synthetic task `task-X` with a fake agent.
- Step A — retrieval bridge:
  - `POST /api/memory/search` with `X-Source-Task-ID: task-X` returning both memories. Assert two `memory_retrieval` rows.
- Step B — explicit rating with edge:
  - Call `memory_rate({id: mem-A, useful: true, referencesSource: "github:desplega-ai/agent-swarm#999"})`. Assert `agent_memory.alpha[mem-A] = 2.0` and one `agent_memory_edge` row.
- Step C — implicit citation:
  - Insert a synthetic `session_logs` row whose content cites `mem-A` but NOT `mem-B`.
  - Call `store-progress` with `status=completed` for `task-X`.
  - Assert: `agent_memory.alpha[mem-A] = 2.5` (was 2.0 from explicit, +0.5 from implicit-citation hit), `agent_memory.beta[mem-B] = 1.25` (was 1.0, +0.25 from implicit-citation miss).
- Step D — LlmRater piggyback:
  - Mock the `claude -p` shell-out to return `{ summary: "...", ratings: [{ id: mem-A, score: 0.9, reasoning: "...", referencesSource: "linear:DES-294" }, { id: mem-B, score: 0.2, reasoning: "..." }] }`.
  - Trigger the session-summary hook for `task-X`.
  - Assert: `mem-A.alpha` += `(2*0.9-1) > 0 ? 0.8*0.8 : 0`, `mem-B.beta` += `0.8 * (1-(2*0.2-1)) / 2` (or whatever the documented mapping yields — capture exact expected values from the implementation in step-4).
  - Assert: a second `agent_memory_edge` row exists with `to_id="linear:DES-294"`.
- Step E — read endpoints:
  - `GET /api/memory/retrievals?taskId=task-X` returns both memories.
  - `GET /api/memory/edges?memoryId=mem-A` returns both edges (`github:...#999` and `linear:DES-294`) with their respective `(alpha, beta, usefulness)`.
- Step F — reranker:
  - Re-issue the same query as step A (no `X-Source-Task-ID`). `mem-A`'s ranked similarity should now be strictly greater than its similarity in step A (because `usefulness(α, β)` > 1 after the positive ratings).
- Step G — backward compat snapshot:
  - Restart the server with `MEMORY_RATERS=` unset. Re-issue a search against a separate fresh DB. Assert reranker output matches the pre-change snapshot byte-for-byte.

#### 7. Final lint + type + DB-boundary + test gate

**Commands** (all owned by step-7):

- `bun run lint:fix`
- `bun run tsc:check`
- `bash scripts/check-db-boundary.sh`
- `bun test`
- `cd new-ui && pnpm exec tsc --noEmit` (only if `new-ui/` was touched — should not be in v1.5).

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Cross-cutting e2e passes: `bun test src/tests/memory-rater-e2e.test.ts`.
- [ ] Full test suite passes: `bun test`.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh`.
- [ ] OpenAPI freshness: `bun run docs:openapi` produces no diff.
- [ ] BUSINESS_USE freshness: `bun run docs:business-use` produces no diff after step-7's commit.
- [ ] `runbooks/memory-system.md` includes the new "Memory raters (v1.5)" section, the four new test file names, and the v2 out-of-scope callouts.
- [ ] `MCP.md` includes the `memory_rate` entry with all four input fields documented.
- [ ] Pre-PR checklist from CLAUDE.md passes end-to-end.

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs `MEMORY_RATERS=implicit-citation,llm,explicit-self bun run pm2-start`, executes a synthetic full-lifecycle scenario via `curl` + MCP equivalent to the cross-cutting e2e test (without mocking the `claude -p` shell-out — let real Haiku run), and confirms:
  1. All three rater sources appear in `memory_rating` for the same `taskId`.
  2. `agent_memory.alpha` for the cited memory has moved.
  3. At least one `agent_memory_edge` row exists if the LLM chose to attach a `referencesSource` (this part is non-deterministic — assert "≥ 0 rows" rather than "≥ 1").
  4. `GET /api/memory/edges?memoryId=…` returns the edge if it exists.
  5. Re-search after completion shows the cited memory ranks higher than baseline.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball the regenerated `BUSINESS_USE.md` mermaid graph for the `task` flow to confirm `memory_retrieved` and `memory_rated` nodes appear in the right place (after `started`, before `completed`).
- [ ] Skim the `runbooks/memory-system.md` rater section for clarity — would a new contributor understand how to add a fourth rater after reading it?

### QA Spec (optional):

For the cross-cutting v1.5 verification — generate a separate QA report capturing the homepage-demo scenario (memory references PR #377, edge readable via API). Useful for marketing / docs site, but not on the critical path.

**QA Doc**: `thoughts/taras/qa/2026-05-05-memory-rater-v1.5.md` (generate via `desplega:qa`; scenarios live in the doc, not here).

**Implementation Note**: This is the capstone. After completion, the entire v1.5 feature is shippable. No commit-per-step: this branch ships as one PR per Lead's call (the plan branch is `taras/memory-rater-v1.5-plan`; the implementation branch will be opened separately by `/v-implement`).

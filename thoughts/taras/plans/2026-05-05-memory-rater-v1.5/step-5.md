---
id: step-5
name: `memory_rate` MCP tool + `ExplicitSelfRatingRater` + conditional system prompt
depends_on: [step-2, step-3]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: `memory_rate` MCP tool + ExplicitSelfRatingRater + conditional system prompt

## Overview

Light up the third live rater. Add a new MCP tool `memory_rate(id, useful, note?)` (with `referencesSource?` field arriving in step-6), plus the `ExplicitSelfRatingRater` registry entry. Server-side validation enforces the spam guards from R6: (a) at most one explicit-self rating per `(taskId, memoryId)` via the partial unique index from step-1, (b) reject IDs not present in `memory_retrieval` for that task. Conditionally append a short usage hint to the memories system prompt — only when `MEMORY_RATERS` includes `explicit-self`, preserving prompt parity when the rater is off.

## Changes Required:

#### 1. New MCP tool `memory_rate`

**File**: `src/tools/memory-rate.ts` (new)

**Changes**:

- Use the existing `tool({...})` registration pattern from `src/tools/registrar.ts` (see other memory tools: `src/tools/memory-search.ts`, `src/tools/memory-store.ts`).
- Definition (verbatim from brainstorm R6 §3 to preserve file-reviewed wording):
  ```ts
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
    // POST one RatingEvent to /api/memory/rate
  });
  ```
- The handler POSTs a single `RatingEvent`:
  ```ts
  {
    memoryId: id,
    signal: useful ? +1 : -1,
    weight: 1.0,
    source: "explicit-self",
    reasoning: note ?? "",
    taskId: requestInfo.sourceTaskId,
  }
  ```
- Surface 409 (server returned conflict) as a tool-output `{ success: false, message: "Memory already rated for this task. Use a follow-up memory_rerate tool (coming soon) to override." }`. The tool's contract returns success flag + message; it does not throw.
- Surface 400 (memory not in retrievals for task) similarly with a clear message.
- The `referencesSource?: string` optional field is **NOT added in step-5**. Step-6 extends both the tool input schema and the server's `RatingEvent` schema to accept it. step-5 ships the tool with the brainstorm-canonical 3-field input only.

#### 2. Register the tool

**File**: wherever the existing memory tools register (likely `src/tools/index.ts` or `src/server.ts` — match the pattern of `memorySearch`, `memoryStore`).

**Changes**:

- Import and add `memoryRate` to the tools array. Confirm it appears in the MCP tool list during a manual `curl /mcp` handshake.

#### 3. `ExplicitSelfRatingRater` (registry-only)

**File**: `src/be/memory/raters/explicit-self.ts` (new)

**Changes**:

- `class ExplicitSelfRatingRater implements MemoryRater` with `name = "explicit-self"`.
- `rate(ctx) → []` — this rater never auto-fires. Its events come exclusively from the MCP tool's POST. The class exists so `MEMORY_RATERS=explicit-self` can register it (unlocking the system-prompt addition below) without any auto-rating side effects.

#### 4. Register `ExplicitSelfRatingRater` in the registry

**File**: `src/be/memory/raters/registry.ts`

**Changes**:

- Add `explicit-self: () => new ExplicitSelfRatingRater()` to the registry map.
- Stays out of `SERVER_RATERS`.

#### 5. Conditional system-prompt addition

**File**: `src/prompts/memories.ts`

**Changes**:

- After the existing memories prompt rendering, conditionally append the brainstorm-verbatim hint (R6 §3):
  ```ts
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
- The `if (ratersEnabled.includes("explicit-self"))` gate keeps the prompt identical to today when the rater is off — strict backward compatibility.
- DB-boundary: this file is in `src/prompts/` (worker-side). The change is pure string manipulation — no DB imports.

#### 6. Server-side validation reuse

**File**: `src/http/memory.ts` (validation logic added in step-3)

**Changes**:

- Step-3 already enforces "memoryId must be in memory_retrieval for taskId when source='explicit-self'". step-5 adds NO new validation here — just relies on the existing chain.

#### 7. Unit + integration tests for the tool

**File**: `src/tests/memory-rate-tool.test.ts` (new)

**Changes**:

- Direct invocation of `memoryRate` (in-process) with a valid `id` from a `memory_retrieval` row → `success: true`, `agent_memory.alpha` moved by `1.0`.
- With `useful=false` → `agent_memory.beta` moved by `1.0`.
- Second call for the same `(taskId, memoryId)` → returns `{ success: false, message: <409-mapped> }`. Tool does not throw.
- With an `id` not in `memory_retrieval` for the task → returns `{ success: false, message: <400-mapped> }`.
- `note` longer than 280 chars → Zod input validation rejects (caller surface; assert via the tool's error path).
- System-prompt parity test:
  - With `MEMORY_RATERS` unset, `renderMemoriesPrompt(memories)` output matches a snapshot from `main`.
  - With `MEMORY_RATERS=explicit-self`, the prompt includes the brainstorm-verbatim hint.

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*

- [ ] Tests pass: `bun test src/tests/memory-rate-tool.test.ts`.
- [ ] All other memory tests still pass.
- [ ] Linting passes: `bun run lint:fix`.
- [ ] Typecheck passes: `bun run tsc:check`.
- [ ] DB-boundary check passes: `bash scripts/check-db-boundary.sh` — `src/tools/memory-rate.ts` and `src/prompts/memories.ts` MUST NOT import `bun:sqlite` or `src/be/db.ts`.
- [ ] OpenAPI spec is fresh: `bun run docs:openapi` produces no diff (the tool talks to the existing `/api/memory/rate` endpoint, no new HTTP surface).
- [ ] `MCP.md` updates wait for step-7 (per "all docs land in step-7" sequencing).

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it.)*

- [ ] Agent runs `MEMORY_RATERS=explicit-self bun run pm2-start`, opens the dashboard or hits MCP directly:
  1. Creates a task that retrieves one memory.
  2. From within the task, calls `memory_rate({id, useful: true})`.
  3. Verifies `agent_memory.alpha` moved by `1.0` and one `memory_rating` row exists with `source='explicit-self'`.
  4. Calls `memory_rate({id, useful: true})` again with the same id → tool returns `{ success: false, message: <conflict-message> }`.
  5. Calls `memory_rate({id: "<random-uuid-not-in-retrievals>", useful: true})` → tool returns `{ success: false, message: <not-in-retrievals> }`.
- [ ] Agent inspects the rendered system prompt for a task with retrieved memories AND `MEMORY_RATERS=explicit-self` set, confirms the rate-tool hint is present.
- [ ] With `MEMORY_RATERS` unset, the same prompt rendering does NOT contain the hint.

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*

- [ ] Eyeball the rendered prompt one time to confirm the hint formatting reads naturally next to the existing memories section.

**Implementation Note**: This step is sibling to step-4 — both depend on step-2 + step-3 and touch disjoint files. Step-6 builds on step-5 (extends `memory_rate` input with `referencesSource?`) and step-3/4 (extends Zod schemas).

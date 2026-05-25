---
date: 2026-05-25
author: taras
status: completed
autonomy: critical
commit-per-phase: yes
---

# Hot-reload skills per-task across all local harnesses

## Overview

Workers currently load skills once at boot and never refresh them, so any skill added/updated via API after worker start is invisible until restart. Add a signature-gated per-task refresh path that re-fetches, re-syncs the harness skill directories, and rebuilds the system prompt only when the installed set changes — across **claude**, **pi**, **codex**, and **opencode**. The `claude-managed` cloud sandbox is excluded (it reads skills from the uploaded Agent definition).

- **Motivation**: User-reported friction — adding a skill via the API or UI today silently no-ops on running workers. `bun run pm2-restart` shouldn't be the answer for an operation that's supposed to feel live.
- **Related**: `src/commands/runner.ts:3514`, `src/commands/runner.ts:3652`, `src/be/skill-sync.ts`, `docker-entrypoint.sh:922-955`, `src/http/skills.ts`.

## Current State Analysis

### Skill load points (worker-side)

Worker startup hits **two** independent skill paths, both **before** the main polling loop:

- **System-prompt summary** — `src/commands/runner.ts:3514-3540` fetches `GET /api/agents/:id/skills`, filters `isActive && isEnabled`, projects to `{ name, description }[]`, stores in `agentSkillsSummary` (declared `let` at `src/commands/runner.ts:3083`). Used by `buildSystemPrompt()` (`src/commands/runner.ts:3094+`) and baked into `resolvedSystemPrompt` at `src/commands/runner.ts:3576-3578`.
- **Filesystem sync** — `src/commands/runner.ts:3652-3681` POSTs `/api/skills/sync-filesystem`, which calls `syncSkillsToFilesystem(agentId)` at `src/be/skill-sync.ts:28`. Default `harnessType = "both"` writes to `~/.claude/skills/<name>/SKILL.md` and `~/.pi/agent/skills/<name>/SKILL.md` (`src/be/skill-sync.ts:40-45`).
- Main polling loop at `src/commands/runner.ts:3885` (`while (true)`) **never** revisits either path.

### Entrypoint behavior (`docker-entrypoint.sh:919-960`)

Boot-time skill priming runs once before the runner spawns, and writes to **three** harness dirs:

- `~/.claude/skills/<name>/SKILL.md` (line 938-939)
- `~/.pi/agent/skills/<name>/SKILL.md` (line 941-942)
- `~/.codex/skills/<name>/SKILL.md` (line 944-945)

…then runs `npx skills add <repo> -a claude-code -a pi -g -y` for complex skills (line 953) — no codex/opencode flag.

Guard at line 921: `[ "$HARNESS_PROVIDER" = "claude-managed" ]` skips the entire sync with the message "Skipping skill sync (claude-managed reads skills from agent definition)" (line 924). This is the existing canonical exclusion predicate.

### Per-harness skill discovery

| Provider | On-disk discovery? | Path | Notes |
|---|---|---|---|
| `claude` | yes | `~/.claude/skills/<name>/SKILL.md` | Native discovery on session start |
| `pi` | yes | `~/.pi/agent/skills/<name>/SKILL.md` | Native discovery on session start |
| `codex` | yes | `~/.codex/skills/<name>/SKILL.md` | Written by entrypoint, **not** by `syncSkillsToFilesystem()` |
| `opencode` | **no** | n/a | Adapter at `src/providers/opencode-adapter.ts:445-614` writes a per-task agent file `<cwd>/.opencode/agents/swarm-<taskId>.md` (line 455). Skills only reach the model via `config.systemPrompt`. Fresh server + session per task (`canResume()` returns `false` at line 617). |
| `devin` | n/a | n/a | Remote sessions; `src/providers/devin-adapter.ts:5-7`. Entrypoint still syncs to the devin worker container — leave as-is. |
| `claude-managed` | n/a | n/a | Cloud sandbox; skills come from the uploaded Agent definition. Excluded by entrypoint and must be excluded here too. |

### `getAgentSkills` row shape (for signature hashing)

Defined `src/be/db.ts:8318-8342` returning `SkillWithInstallInfo[]` (`src/types.ts:1568-1572`). Mutation-tracking fields available without recomputing content hashes:

- `id`, `name`, `version`, `isEnabled` (from `skills`)
- `isActive`, `installedAt` (from `agent_skills` join, `src/be/db.ts:8025-8033`)
- `lastUpdatedAt` — bumped by `updateSkill` whenever content/metadata changes (re-parse at `src/http/skills.ts:449-460`)
- `sourceHash` — sha256 of `content` for remote-synced skills (`src/http/skills.ts:291`)
- All three mutation-points (`installSkill`, `uninstallSkill`, `toggleAgentSkill`) are single-statement atomic (`src/be/db.ts:8294-8349`)

Existing hash idiom is inline `new Bun.CryptoHasher("sha256")…digest("hex")` (e.g. `src/http/skills.ts:291`). No shared helper to reuse.

### Provider naming and live reconciliation

- `ProviderName` enum: `["claude", "codex", "pi", "devin", "claude-managed", "opencode"]` at `src/types.ts:78-86`.
- Runner resolves `bootProvider` once at `src/commands/runner.ts:3008-3015`. **Currently no `claude-managed` branch anywhere in `runner.ts`** — all special-casing lives in adapters / entrypoint.
- `state.harnessProvider` is reconciled live inside the polling loop (`src/commands/runner.ts:3355-3361`, `3892+`), so when an operator flips `HARNESS_PROVIDER` mid-flight the new provider is in effect on the next tick.

### Route registration pattern

`src/http/skills.ts:16` imports `route()` from `./route-def`. Existing routes (e.g. `getAgentSkillsRoute` at lines 183-194) follow the pattern: declare `route({ method, path, pattern, summary, tags, auth, params, responses })`, then dispatch `if (theRoute.match(req.method, pathSegments))` inside the handler. OpenAPI registration auto-flows from `import "../src/http/skills"` at `scripts/generate-openapi.ts:29` — no extra entry needed, but `bun run docs:openapi` must regenerate and be committed (also bumps `docs-site/.../api-reference/**`).

## Desired End State

- A skill installed/uninstalled/enabled/toggled/updated via API or UI on a worker's owning agent is reflected on the **very next task** that worker picks up, with no restart, across `claude`, `pi`, `codex`, and `opencode` local harnesses.
- `claude-managed` workers untouched (cloud sandbox owns skill delivery).
- Per-task overhead in the steady state: one ~80-byte HTTP GET (the signature endpoint). FS writes and prompt rebuild only fire when the signature changes.
- Verifiable via the Manual E2E section at the bottom of this plan: install a skill mid-flight, enqueue a task, observe both the harness picking up the SKILL.md (claude/pi/codex) and/or the system-prompt summary listing the new skill (opencode).

## What We're NOT Doing

- Mid-session reload (active harness session keeps the SKILL.md set it saw at process spawn; refresh applies to the *next* task)
- Boot-time skill sync (entrypoint already does that — runner refresh layers *on top*)
- `claude-managed` cloud sandbox (skills come from uploaded Agent definition)
- New transport (no SSE/WS push; polling a hash is enough)

## Implementation Approach

- **Signature-gated polling, not push.** Cheap `GET /api/agents/:id/skills/signature` returns a sha256 over per-row mutation fields. Worker caches the last hash; only when it changes does it pay for the full skill list + FS sync. Avoids inventing SSE/WS for a low-frequency event.
- **Single-round-trip on mismatch.** To avoid a stale-hash race between the signature call and the list call, the `GET /api/agents/:id/skills` response gains a `signature: string` field computed from the same logic as the dedicated endpoint. The worker stores that signature (not the one from the standalone endpoint), so the hash always corresponds exactly to the list snapshot it acted on.
- **Two existing boot-time blocks become one helper.** Extract `runner.ts:3514-3540` (system-prompt fetch) and `runner.ts:3652-3681` (FS sync POST) into `refreshSkillsIfChanged(ctx, lastHashRef)`. Boot calls it once (same effect as today). The polling loop calls it once per claimed task.
- **Don't rebuild the system prompt in the helper.** `buildSystemPrompt()` already runs per task at `src/commands/runner.ts:4174` (as `taskBasePrompt`) and reads `agentSkillsSummary` via closure. The per-task refresh only needs to mutate `agentSkillsSummary` (and re-sync FS); the existing line 4174 picks up the new summary on its own. Saves a redundant `buildSystemPrompt()` call.
- **Exclude `claude-managed` with the same predicate the entrypoint uses.** `state.harnessProvider !== "claude-managed"` — safe to read since `state` is initialized at `src/commands/runner.ts:3214` (well before any skill-load call site). Read it live so the loop honors runtime adapter swaps at `src/commands/runner.ts:3263-3271`. Mirrors `docker-entrypoint.sh:921`.
- **Codex joins `syncSkillsToFilesystem()` to match the entrypoint.** Today `src/be/skill-sync.ts` writes claude+pi only; the entrypoint additionally writes codex (`docker-entrypoint.sh:944-945`). Bring the runner's sync into parity by widening `harnessType` to include `"codex"` and changing the default to write all three. Devin keeps the entrypoint's current behavior — out of scope for this plan to change.
- **Opencode needs no FS sync.** No native skill-discovery path exists (`src/providers/opencode-adapter.ts` confirmed). Its per-task system prompt is written at session start (line 455) — refreshing `agentSkillsSummary` + rebuilding `resolvedSystemPrompt` before the next task gives opencode hot-reload for free.
- **Signature stays stable per worker:** the runner reuses the last-known summary when the hash hasn't moved, so `resolvedSystemPrompt` doesn't churn. Logging at refresh time names the diff (count delta) for E2E observability.
- **Atomic FS sync.** Existing `syncSkillsToFilesystem()` already writes per-skill `mkdirSync + writeFileSync`, then cleans up directories not in `writtenNames` (`src/be/skill-sync.ts:82-103`). Extension to codex is additive — same loop, same cleanup behavior.

## Quick Verification Reference

- `bun run tsc:check`
- `bun run lint`
- `bun test src/tests/skill-sync.test.ts src/tests/skills-*.test.ts`
- `bash scripts/check-db-boundary.sh`
- `bash scripts/check-api-key-boundary.sh`
- `bun run docs:openapi` (after adding the signature route)

---

## Phase 1: Extend `syncSkillsToFilesystem()` to write codex skill paths

### Overview

`syncSkillsToFilesystem()` widens to write `~/.codex/skills/<name>/SKILL.md` alongside claude and pi, bringing the runner's FS sync into parity with what `docker-entrypoint.sh:944-945` already writes at boot. Concrete deliverable: an updated `src/be/skill-sync.ts` that supports `harnessType: "claude" | "pi" | "codex" | "all"`, with `"all"` as the default writing all three, plus a `src/tests/skill-sync.test.ts` that exercises the codex path and verifies cleanup of stale codex dirs.

### Changes Required:

#### 1. `syncSkillsToFilesystem` signature + branches
**File**: `src/be/skill-sync.ts`
**Changes**: Update the union at line 30 to `"claude" | "pi" | "codex" | "all"`, default `"all"`. Replace the two-branch `if (harnessType === "claude" || ...)` block at lines 40-45 with three branches (one per concrete harness), with `"all"` pushing all three dirs onto `skillDirs`. Add the codex base: `join(home, ".codex", "skills")`. No other logic changes — the for-loop at line 66 and the cleanup at line 84 already iterate `skillDirs`.

#### 2. Tests for the codex branch + `"all"` default
**File**: `src/tests/skill-sync.test.ts`
**Changes**: Mirror the existing claude / pi / both cases — add a `"codex"` case that asserts only `<fakeHome>/.codex/skills/<name>/SKILL.md` is written, and an `"all"` case asserting all three. Extend the existing cleanup test to cover codex (a stale `.codex/skills/old/` is removed). Keep the test DB / `FAKE_HOME` plumbing pattern from `src/tests/skill-sync.test.ts:9-12`.

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] Unit tests pass: `bun test src/tests/skill-sync.test.ts`
- [x] DB boundary holds: `bash scripts/check-db-boundary.sh`
- [x] API key boundary holds: `bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [x] A new test case `syncSkillsToFilesystem(agentId, "codex", FAKE_HOME)` writes the file at `<FAKE_HOME>/.codex/skills/<name>/SKILL.md` and does **not** write `~/.claude/` or `~/.pi/` paths
- [x] A new test case `syncSkillsToFilesystem(agentId, "all", FAKE_HOME)` writes to all three harness dirs
- [x] Cleanup test removes a stale codex directory when the corresponding skill is uninstalled

#### Manual Verification:
- [ ] None — fully covered by unit tests

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] add codex target to syncSkillsToFilesystem` once verification passes.

---

## Phase 2: Add `GET /api/agents/:id/skills/signature` endpoint

### Overview

A cheap signature endpoint the worker can poll once per task to decide whether anything changed. Concrete deliverable: a new route handler in `src/http/skills.ts` returning `{ hash, count, generatedAt }` over the agent's current installed-and-enabled skill set, with sha256 over per-row mutation-tracking fields, plus a unit test asserting the hash moves on install/uninstall/toggle/update and a regenerated `openapi.json`.

### Changes Required:

#### 1. Pure signature helper in `src/be/skill-sync.ts`
**File**: `src/be/skill-sync.ts`
**Changes**: Add a sibling export `computeAgentSkillsSignature(agentId: string): { hash: string; count: number }` that calls `getAgentSkills(agentId)`, sorts by `id`, and hashes with the existing `Bun.CryptoHasher("sha256")` idiom (`src/http/skills.ts:291`). Hash inputs:

```ts
const canonical = JSON.stringify(
  sorted.map((s) => [
    s.id, s.name, s.version, s.isEnabled, s.isActive,
    s.lastUpdatedAt, s.sourceHash ?? "", s.installedAt,
  ])
);
```

Pure function — no HTTP, no I/O beyond the DB query. Trivially unit-testable the same way `syncSkillsToFilesystem()` is tested in `src/tests/skill-sync.test.ts:9-16` (sqlite test DB, no HTTP server).

#### 2. New route declaration + handler
**File**: `src/http/skills.ts`
**Changes**: Declare `getAgentSkillsSignatureRoute` next to `getAgentSkillsRoute` at line 183. Pattern: `["api", "agents", null, "skills", "signature"]`, method `get`, auth `{ apiKey: true }`, summary "Compute a stable signature over installed skills". Dispatch it **before** `getAgentSkillsRoute` at the handler entry (line 206) since `pathSegments[4]` would otherwise match `null`. Handler calls `computeAgentSkillsSignature()` from Phase 2 step 1 and returns `{ hash, count, generatedAt: new Date().toISOString() }`.

#### 3. Include signature in the existing list response
**File**: `src/http/skills.ts`
**Changes**: Update the `getAgentSkillsRoute` handler at lines 206-212 to also include `signature: computeAgentSkillsSignature(parsed.params.id).hash` in the response. The signature is computed from the same `getAgentSkills(agentId)` snapshot the response is built from, so the worker can store this value and avoid the signature-then-list race.

#### 4. Unit test for the signature computation
**File**: `src/tests/skills-signature.test.ts` (new)
**Changes**: New test file mirroring the `initDb(TEST_DB_PATH)` + direct-function-call pattern of `src/tests/skill-sync.test.ts:9-16`. **No HTTP server stubs** — test `computeAgentSkillsSignature(agentId)` directly. Cases:
- Baseline hash for an agent with N installed skills is stable across two calls
- Installing a new skill changes the hash
- Uninstalling changes the hash
- `toggleAgentSkill(agentId, skillId, isActive=false)` changes the hash
- `updateSkill(...)` on a personal skill changes the hash (via `lastUpdatedAt` bump at `src/http/skills.ts:449-460`)
- A different agent's signature is independent

#### 3. Regenerate OpenAPI artifacts
**File**: `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: Run `bun run docs:openapi` after the route is registered. No manual edits to either file — the script is the source of truth. `scripts/generate-openapi.ts:29` already imports `../src/http/skills` so the new route auto-flows.

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] New tests pass: `bun test src/tests/skills-signature.test.ts`
- [x] Existing skills tests still pass: `bun test src/tests/skill-sync.test.ts src/tests/skills-*.test.ts`
- [x] OpenAPI regen produces no unintended diff beyond the new route: `bun run docs:openapi && git diff --stat openapi.json docs-site/content/docs/api-reference`
- [x] DB boundary holds: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] Test asserts hash changes on install, uninstall, toggle-inactive, and `updateSkill` mutations
- [x] Test asserts hash is byte-for-byte identical across two no-op calls (deterministic, no time-based input in the hashed canonical)
- [x] Test asserts agent A's signature is unaffected by mutations on agent B's installed skills

#### Manual Verification:
- [ ] `curl -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" $MCP_BASE_URL/api/agents/$AGENT_ID/skills/signature` returns `{ hash, count, generatedAt }` against a running dev server

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] add /api/agents/:id/skills/signature endpoint` once verification passes. Commit **must** include the regenerated `openapi.json` and `docs-site/content/docs/api-reference/**` — CI's `OpenAPI Spec Freshness Check` fails otherwise.

---

## Phase 3: Wire `refreshSkillsIfChanged()` into the worker

### Overview

Extract the boot-time skill load into a single `refreshSkillsIfChanged()` helper inside `src/commands/runner.ts`, then call it both at boot (replacing the existing two blocks) and at the top of each task pickup inside the polling loop. The helper hits the new signature endpoint first; on a hit it returns `{ changed: false }` and the caller short-circuits. On a miss it fetches `/api/agents/:id/skills`, calls `/api/skills/sync-filesystem`, rebuilds `agentSkillsSummary`, and signals the caller to recompute `basePrompt` + `resolvedSystemPrompt`. Skip the whole helper for `state.harnessProvider === "claude-managed"`.

Concrete deliverable: a worker that picks up skill additions/removals/toggles on the *next* task — verified for claude, pi, codex, and opencode in the Manual E2E section below.

### Changes Required:

#### 1. Extract `refreshSkillsIfChanged()` helper
**File**: `src/commands/runner.ts`
**Changes**: Define a top-level helper (file-scope, near other helpers like `fetchResolvedEnv` at line 238):

```ts
type SkillsRefreshContext = {
  apiUrl: string;
  swarmUrl: string;
  apiKey: string;
  agentId: string;
  role: string;
};

type SkillsRefreshResult = {
  changed: boolean;
  summary?: { name: string; description: string }[];
};

async function refreshSkillsIfChanged(
  ctx: SkillsRefreshContext,
  lastHashRef: { current: string | null },
): Promise<SkillsRefreshResult> {
  // 1. GET /api/agents/:id/skills/signature — if hash matches, return { changed: false }
  // 2. Else GET /api/agents/:id/skills (now also returns { signature }) — build summary (current logic at runner.ts:3522-3533)
  // 3. POST /api/skills/sync-filesystem (current logic at runner.ts:3660-3681)
  // 4. Update lastHashRef.current = <signature from step 2 response>, return { changed: true, summary }
}
```

Store the signature from the list response (Phase 2 step 3), not the one from step 1's standalone signature endpoint. This keeps the cached hash in sync with the actual list snapshot used.

The helper swallows non-fatal errors the same way the existing blocks do (try/catch with warn-log; treat as `{ changed: false }` so the worker doesn't churn the prompt on transient API failures).

#### 2. Replace the boot-time blocks with one call
**File**: `src/commands/runner.ts`
**Changes**: Delete lines 3514-3540 (fetch summary block) and lines 3652-3681 (FS sync block). Replace with a single boot-time call **before** `buildSystemPrompt()` at line 3575:

```ts
const lastSkillHash: { current: string | null } = { current: null };
if (state.harnessProvider !== "claude-managed") {
  const skillResult = await refreshSkillsIfChanged(ctx, lastSkillHash);
  if (skillResult.changed && skillResult.summary) {
    agentSkillsSummary = skillResult.summary;
    console.log(`[${role}] Loaded ${agentSkillsSummary.length} skills for system prompt`);
  }
}
```

Hoist `lastSkillHash` to function scope (alongside `agentSkillsSummary` at line 3083) so the polling loop can mutate it. Note: at boot, the `state.harnessProvider` field is set just after adapter creation; confirm it's populated before the call site or use `bootProvider !== "claude-managed"` as the boot-time predicate.

#### 3. Per-task refresh inside the polling loop
**File**: `src/commands/runner.ts`
**Changes**: Inside `while (true)` at line 3885, **before** the existing per-task `taskBasePrompt = await buildSystemPrompt()` at line 4174, add:

```ts
if (state.harnessProvider !== "claude-managed") {
  const skillResult = await refreshSkillsIfChanged(ctx, lastSkillHash);
  if (skillResult.changed && skillResult.summary) {
    agentSkillsSummary = skillResult.summary;
    console.log(
      `[${role}] Skills changed — refreshing system prompt (${agentSkillsSummary.length} skills)`,
    );
  }
}
```

That's the **entire** per-task hook. The existing `taskBasePrompt = await buildSystemPrompt()` at line 4174 reads `agentSkillsSummary` via closure (`src/commands/runner.ts:3113`), so the next prompt build automatically reflects the refreshed summary. **Do not** rebuild `basePrompt`/`resolvedSystemPrompt` here — that's already the per-task path's job, and duplicating it would discard `cwdWarning` (line 4178) and the per-task `repoContext`/`slackContext` updates baked into `buildSystemPrompt()` via `currentRepoContext` (line 3110) and `currentTaskSlackContext` (line 3111).

`agentSkillsSummary` is already `let` at function scope (`src/commands/runner.ts:3083`). Read `state.harnessProvider` live so a runtime adapter swap (`src/commands/runner.ts:3263-3271`) is honored.

#### 4. Unit-level coverage for the helper
**File**: `src/tests/runner-skills-refresh.test.ts` (new)
**Changes**: Mock the three HTTP calls (signature, list, sync-filesystem) via `Bun.serve()` stub on an ephemeral port. Cases:
- First call (no cached hash) → returns `{ changed: true }`, populates summary
- Second call with same server-side hash → returns `{ changed: false }`, no list fetch, no sync POST
- Second call after server hash changes → returns `{ changed: true }`, new summary
- Transient signature-endpoint 5xx → swallow, return `{ changed: false }`

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] New helper test passes: `bun test src/tests/runner-skills-refresh.test.ts`
- [x] Full skills test suite passes: `bun test src/tests/skill-sync.test.ts src/tests/skills-*.test.ts src/tests/runner-skills-refresh.test.ts`
- [x] Full unit suite passes: `bun test`
- [x] DB boundary holds: `bash scripts/check-db-boundary.sh`
- [x] API key boundary holds: `bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [x] Helper test asserts only one HTTP call is made when the signature is unchanged (no list fetch, no sync POST)
- [x] Helper test asserts a fresh summary is returned on hash mismatch
- [x] Helper test asserts `claude-managed` predicate skips the helper entirely (verified by call site, not the helper itself)

#### Manual Verification:
- [ ] Boot logs show the existing line "Loaded N skills for system prompt" (boot path still works)
- [ ] Polling-loop logs show "Skills changed — system prompt rebuilt (N skills)" the **first** time a skill is added mid-flight, and stay silent on subsequent tasks until the next change

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] per-task skill hot-reload in runner` once verification passes. The Manual E2E section below is the final acceptance gate.

---

## Manual E2E

Run against a local dev swarm. Pre-flight:

```bash
# Terminal 1 — server
bun run start:http
# Terminal 2 — wait for `[startup] API server listening on :3013`

export MCP_BASE_URL=http://localhost:3013
export AGENT_SWARM_API_KEY=${AGENT_SWARM_API_KEY:-123123}
export AGENT_ID=<paste-your-agent-id>     # from `bun run src/cli.tsx my-agent-info`
```

For each provider (`claude`, `pi`, `codex`, `opencode`), repeat the same flight:

### Step 1 — start a worker on that provider

```bash
HARNESS_PROVIDER=<provider> bun run pm2-restart   # or full Docker compose path per LOCAL_TESTING.md
bun run pm2-logs | head -40   # observe "Loaded N skills for system prompt" at boot
```

### Step 2 — observe baseline skill set

```bash
curl -sS -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  $MCP_BASE_URL/api/agents/$AGENT_ID/skills | jq '.skills | length'
curl -sS -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  $MCP_BASE_URL/api/agents/$AGENT_ID/skills/signature
```

Record the `hash`.

### Step 3 — add and install a probe skill mid-flight

```bash
SKILL_ID=$(curl -sS -X POST -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"hotreload-probe","description":"per-task hot-reload smoke test","content":"# hotreload-probe\nTrigger: never. This is an E2E probe.\n","isEnabled":true}' \
  $MCP_BASE_URL/api/skills | jq -r '.skill.id')

curl -sS -X POST -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d "{\"agentId\":\"$AGENT_ID\"}" \
  $MCP_BASE_URL/api/skills/$SKILL_ID/install

curl -sS -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  $MCP_BASE_URL/api/agents/$AGENT_ID/skills/signature | jq -r '.hash'
```

Confirm the signature hash changed.

### Step 4 — enqueue a trivial task and observe pickup

Pick the smallest task the harness will accept (e.g. via UI or `cli.tsx`). Once the worker claims it, watch the logs:

```bash
bun run pm2-logs | grep -E "Skills changed|hotreload-probe"
```

Expected:

- `claude`, `pi`, `codex`: log line `[worker] Skills changed — system prompt rebuilt (<N+1> skills)` AND the file `~/.claude/skills/hotreload-probe/SKILL.md` (or `.pi/agent/skills/...`, `.codex/skills/...`) exists inside the worker container:
  ```bash
  docker exec -it <worker-container> ls /home/worker/.claude/skills/hotreload-probe
  docker exec -it <worker-container> ls /home/worker/.pi/agent/skills/hotreload-probe
  docker exec -it <worker-container> ls /home/worker/.codex/skills/hotreload-probe
  ```
- `opencode`: log line `[worker] Skills changed — system prompt rebuilt (<N+1> skills)`. The skill must NOT appear on disk (opencode has no FS discovery). Verify the skill name + description landed in the rendered system prompt by inspecting `<cwd>/.opencode/agents/swarm-<taskId>.md` for the running task:
  ```bash
  docker exec -it <worker-container> sh -c 'cat /workspace/.opencode/agents/swarm-*.md | grep -A1 hotreload-probe'
  ```

### Step 5 — uninstall mid-flight, observe disappearance on next task

```bash
curl -sS -X DELETE -H "Authorization: Bearer $AGENT_SWARM_API_KEY" -H "X-Agent-ID: $AGENT_ID" \
  $MCP_BASE_URL/api/skills/$SKILL_ID/install/$AGENT_ID
```

Enqueue another trivial task. On pickup, expect:
- claude/pi/codex: skill directory is **removed** by `syncSkillsToFilesystem()` cleanup (`src/be/skill-sync.ts:82-103`)
- opencode: skill no longer appears in the per-task agent file
- Log line `Skills changed — system prompt rebuilt`

### Step 6 — `claude-managed` regression check

```bash
HARNESS_PROVIDER=claude-managed bun run pm2-restart
bun run pm2-logs | grep -E "Skills changed|Skipping skill sync"
```

Expected: zero `Skills changed` log lines after boot. The boot-time path runs but is skipped by predicate; the polling loop never enters the refresh block. The entrypoint still prints "Skipping skill sync (claude-managed reads skills from agent definition)" exactly once.

### Pass criteria

All four local providers (`claude`, `pi`, `codex`, `opencode`) show:
- ✅ Hash changes on install/uninstall/toggle
- ✅ Next-task pickup reflects the change (FS for claude/pi/codex; system prompt for opencode)
- ✅ Steady-state polling loop logs no `Skills changed` line when nothing mutates
- ✅ `claude-managed` is fully bypassed

---

## Appendix

- **Follow-up plans**:
  - Devin: decide whether remote-sandbox devin agents need skill sync at all (today entrypoint syncs to the local container, but no devin process reads it). Out of scope here.
  - Opencode: if/when opencode grows native skill discovery, extend `syncSkillsToFilesystem()` with an `"opencode"` branch and rebuild the harness target table. The current plan deliberately keeps opencode out of the FS write path because there's nothing on disk to read it.
- **Derail notes**:
  - The entrypoint's `npx skills add` for complex skills (`docker-entrypoint.sh:953`) runs only at boot. Hot-reload of *complex* skills mid-flight is **not** covered by this plan — only simple in-DB skills with `content` set. Flag if Taras wants complex hot-reload as a follow-up.
  - `business-use` instrumentation: consider adding a `skills.refresh` event in the helper (`changed` + `count` + `provider` fields) so we can observe how often hot-reload actually fires in prod. Not blocking.
- **References**:
  - Research findings inlined in Current State Analysis (no separate research doc — three sub-agent reports synthesized above)
  - `runbooks/local-development.md` — for the Manual E2E env setup
  - `LOCAL_TESTING.md` — for the per-provider boot recipes

---

## Review Errata

_Reviewed: 2026-05-25 by Claude (autopilot, output=append, applied)._

### Applied

- [x] **Per-task prompt rebuild was redundant.** The plan originally had Phase 3's per-task hook call `buildSystemPrompt()` and reassign `resolvedSystemPrompt`. But `runner.ts:4174` already calls `buildSystemPrompt()` per task as `taskBasePrompt`, and `buildSystemPrompt()` reads `agentSkillsSummary` via closure (`runner.ts:3113`). Duplicating it inside the helper hook would have discarded `cwdWarning` and per-task `repoContext`/`slackContext`. **Fix applied**: Phase 3 step 3 now only updates `agentSkillsSummary`; the existing line 4174 picks it up automatically.
- [x] **Stale-hash race between signature endpoint and list endpoint.** Original plan made two HTTP calls (signature → list) with the worker storing the hash from the signature call. If a mutation lands between the two, the cached hash points at a state newer than the list the worker acted on, causing the worker to miss the next change for one task. **Fix applied**: Phase 2 step 3 adds `signature` to the existing `GET /api/agents/:id/skills` list response; the worker stores the list-response signature (Phase 3 step 1 comment updated). The standalone signature endpoint stays for the cheap-poll path.
- [x] **Phase 2 test plan assumed an HTTP-server stub pattern that doesn't exist here.** Existing skills tests (`src/tests/skill-sync.test.ts:9-16`, `src/tests/skill-update-scope.test.ts`) call DB-layer functions directly via `initDb(TEST_DB_PATH)` — no `Bun.serve()` stub. **Fix applied**: Phase 2 split into two steps — a pure `computeAgentSkillsSignature()` helper in `src/be/skill-sync.ts` is the test target; the route handler is a thin wrapper.
- [x] **Self-flag #1 (boot-time `state.harnessProvider` may be unpopulated) was incorrect.** `state` is initialized at `runner.ts:3214` (with `harnessProvider: bootProvider`), well before the existing skill-load blocks at 3514 / 3652. **Fix applied**: Implementation Approach now states this explicitly so the implementor doesn't second-guess it.

### Acknowledged (no plan change needed)

- Self-flag #3 (complex-skill hot-reload out of scope) — acceptable; `npx skills add` runs only at boot, and complex skills mutate much less frequently. Captured in Appendix derail notes.
- Self-flag #4 (`business-use` instrumentation as nice-to-have) — leave in Appendix; Phase 3's log lines provide enough observability for the first ship. Promote in a follow-up if hot-reload misbehaves in prod.
- Self-flag #5 (Devin retains entrypoint's FS sync) — fine; devin is fully remote, the local writes are wasted but harmless and matching existing behavior keeps blast radius small.

### Remaining

_(none)_

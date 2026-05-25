---
date: 2026-05-25
author: Taras
topic: "Skills hot-reload — signature endpoint, per-task refresh, foreign-skill protection"
tags: [qa, skills, hot-reload, http-api, runner]
status: pass
related_pr: https://github.com/desplega-ai/pull/555
environment: local
last_updated: 2026-05-25
last_updated_by: Taras
---

# Skills Hot-Reload — QA Report

## Context

Branch `hot-reload-skills` (commits `5fa6abfe`..`ae247ea5`) introduces:

1. **Phase 1** — `codex` target in `syncSkillsToFilesystem` (`~/.codex/skills/<name>/SKILL.md`).
2. **Phase 2** — `GET /api/agents/:id/skills/signature` returning `{ hash, count, generatedAt }`.
3. **Phase 3** — Per-task skill hot-reload in the runner via `refreshSkillsIfChanged()` (boot + every iteration); helper extracted to `src/utils/skills-refresh.ts`.
4. **PR #555 review** — Cleanup only removes directories carrying a `.swarm-managed` marker; sync-filesystem failure leaves the cached hash unchanged so the next poll retries.

Branch was rebased onto latest `main` (`bdc8d26c`) before QA — merge was clean (only `openapi.json` had a trivial auto-merge).

## Scope

### In Scope
- Signature endpoint contract (shape, auth, hash stability, agent-skill mutation sensitivity).
- `GET /api/agents/:id/skills` returns matching `signature` field.
- Filesystem sync writes `.swarm-managed` marker; cleanup only removes marked dirs.
- Codex target writes to `~/.codex/skills/<name>/`.
- `refreshSkillsIfChanged()` contract (boot path, hash drift, transient errors, sync-failure retry).
- Static checks: `bun run lint`, `bun run tsc:check`, `scripts/check-db-boundary.sh`.

### Out of Scope
- Live worker→leader hot-reload over a real harness boot (would need a worker container) — exercised indirectly via the helper's unit tests.
- UI changes (no UI in this branch).
- Performance / load testing.

## Test Cases

### TC-1: Pre-flight — lint, typecheck, boundary, targeted unit tests
**Steps:**
1. `bun run lint`
2. `bun run tsc:check`
3. `bash scripts/check-db-boundary.sh`
4. `bun test src/tests/skills-signature.test.ts src/tests/runner-skills-refresh.test.ts src/tests/skill-sync.test.ts`

**Expected Result:** All four green.
**Actual Result:**
- `lint` exit=0 (25 pre-existing warnings, no errors)
- `tsc:check` clean
- `Worker/API DB boundary check passed.`
- **24/24 unit tests pass** across the three files (77 expect() calls)

**Status:** ✅ pass

### TC-2: Signature endpoint shape + auth
**Steps:**
1. `GET /api/agents/<agentId>/skills/signature` with bearer auth.
2. Same URL without `Authorization` header.

**Expected:** `200` with `{ hash: string, count: number, generatedAt: ISO }`; no-auth → `401`.
**Actual:**
- `status=200 hash=4f53cda18c2b.. count=0 generatedAt: string` ✓
- `status=401` without auth ✓

**Status:** ✅ pass

### TC-3: Signature stability + mutation sensitivity
**Steps:**
1. Two consecutive signature calls on an empty agent.
2. Create a skill (`POST /api/skills`), install via `POST /api/skills/:id/install`.
3. Re-fetch signature.

**Expected:** Calls (1) match; call (3) differs and `count` increments by 1.
**Actual:**
- Both empty-agent calls returned `hash=4f53cda18c2b... count=0` (stable) ✓
- After install: `hash=a553697e9913... count=1` (drifted) ✓

**Status:** ✅ pass

### TC-4: List endpoint includes matching signature
**Steps:**
1. `GET /api/agents/:id/skills`.
2. `GET /api/agents/:id/skills/signature`.
3. Compare `response.signature` vs `response.hash`.

**Expected:** Both equal — race-avoidance contract the runner depends on.
**Actual:** `list.signature=a553697e9913` matches `sig.hash=a553697e9913`. ✓

**Status:** ✅ pass

### TC-5: Codex sync writes SKILL.md + `.swarm-managed` marker
**Steps:**
1. Server booted with `HOME=/tmp/qa-skills-hotreload/fake-home`.
2. With one installed skill, `POST /api/skills/sync-filesystem`.
3. Inspect `<HOME>/.codex/skills/<skillName>/`.

**Expected:** Both `SKILL.md` and `.swarm-managed` present; SKILL.md content matches the skill body.
**Actual:**
- sync response: `{synced:3, removed:0, errors:[], message:"Synced 3 skills, removed 0 stale entries"}` (3 = claude + pi + codex)
- `<HOME>/.codex/skills/qa-probe-skill-1779725821180/SKILL.md` exists ✓
- `<HOME>/.codex/skills/qa-probe-skill-1779725821180/.swarm-managed` exists ✓
- Content matches `A test skill written for QA E2E.` ✓

**Status:** ✅ pass

### TC-6: Foreign-skill protection — unmarked dirs survive cleanup
**Steps:**
1. Pre-create `<HOME>/.codex/skills/user-personal/SKILL.md` (no marker file).
2. Uninstall the swarm skill (`DELETE /api/skills/:id/install/:agentId`).
3. Re-trigger `POST /api/skills/sync-filesystem`.
4. Inspect both dirs.

**Expected:** `user-personal/` survives; swarm-marked dir is removed.
**Actual:**
- uninstall: `{"success":true}` ✓
- second sync: `{synced:0, removed:3, ...}` — removed 3 swarm-managed dirs across claude/pi/codex ✓
- `user-personal/SKILL.md` still present ✓
- swarm skill's `.codex/skills/qa-probe-skill-...` dir gone ✓

Final FS state:
```
fake-home/.claude/skills/                          (empty)
fake-home/.pi/agent/skills/                        (empty)
fake-home/.codex/skills/user-personal/SKILL.md     (preserved, foreign)
```

**Status:** ✅ pass

### TC-7: `refreshSkillsIfChanged()` contract (unit tests)
**Steps:** `bun test src/tests/runner-skills-refresh.test.ts`

**Expected & Actual:** All six cases pass:
- first call populates summary, caches hash ✓
- unchanged hash short-circuits — no list/sync calls ✓
- hash drift refetches list + re-syncs, cache → list's snapshot ✓
- inactive/disabled skills filtered from the summary ✓
- 5xx on signature endpoint swallowed → `changed:false`, no churn ✓
- sync-filesystem 503 does NOT advance cached hash (next poll retries) ✓

**Status:** ✅ pass

### TC-8: Runner integration — two call sites, claude-managed gating
**Steps:** grep `refreshSkillsIfChanged(` + `harnessProvider !== "claude-managed"` in `src/commands/runner.ts`; `bun run tsc:check`.
**Expected:** Two call sites (boot + per-task), both gated; types compile.
**Actual:**
- Line 45 — import
- Line 3630 — boot-time `if (state.harnessProvider !== "claude-managed")` gate
- Line 4145 — per-task `if (state.harnessProvider !== "claude-managed")` gate
- `tsc:check` clean ✓

**Status:** ✅ pass

## Edge Cases & Exploratory Testing

- **4xx (legacy server fallthrough)**: helper falls through to the list call instead of erroring — confirmed via code reading (`src/utils/skills-refresh.ts`: "4xx falls through (e.g. fresh worker hitting a legacy server without the signature endpoint yet)").
- **Race avoidance**: `/skills` list endpoint returns the signature it actually computed, so the cached hash always matches the snapshot the worker just acted on. TC-4 confirms the contract.
- **`/api/skills/sync-filesystem` body**: The endpoint ignores body params (`harnessType`, `homeOverride`) and uses `homedir()` directly — confirmed by reading the handler. Not a regression; the runner doesn't pass those fields either.

## Evidence

### Probe Output

`/tmp/qa-skills-hotreload/probe-results.txt`:

```
PASS Setup/createAgent: status=201 agentId=db720bcd-0e17-4828-a460-6390f4c08381
PASS TC-2/shape+200: status=200 hash=4f53cda18c2b.. count=0
PASS TC-2/noAuth401: status=401
PASS TC-3/stable: hash1=4f53cda18c2b hash2=4f53cda18c2b count=0/0
PASS TC-3/createSkill: status=201 skillId=3a8c603a-f6f3-470c-8b5b-ca8802576b58
PASS TC-3/installSkill: status=200
PASS TC-3/hashDrift: before=4f53cda18c2b after=a553697e9913 count 0→1
PASS TC-4/listSignatureMatches: list.signature=a553697e9913 sig=a553697e9913 total=1
PASS TC-5/syncCallReturns200: status=200 body={"synced":3,"removed":0,...}
PASS TC-5/codexSkillMdExists
PASS TC-5/swarmMarkerExists
PASS TC-5/contentMatches
PASS TC-6/uninstall: status=200 body={"success":true}
PASS TC-6/secondSync200: status=200 body={"synced":0,"removed":3,...}
PASS TC-6/foreignDirSurvives
PASS TC-6/swarmDirRemoved
```

### Unit Test Output

`bun test src/tests/skills-signature.test.ts src/tests/runner-skills-refresh.test.ts src/tests/skill-sync.test.ts`:

```
24 pass
 0 fail
77 expect() calls
Ran 24 tests across 3 files. [172.00ms]
```

### External Links
- [PR #555](https://github.com/desplega-ai/pull/555)
- Plan: `thoughts/taras/plans/2026-05-25-hot-reload-skills.md`

## Issues Found

_None._

## Verdict

**Status**: ✅ **PASS**

**Summary**: All 17 E2E probes + 24 targeted unit tests pass against the rebased branch. The signature endpoint contract holds (shape, auth, stability, mutation sensitivity, list/signature parity); the `.swarm-managed` marker correctly protects foreign skill directories during cleanup; the runner integrates the helper at boot and per-task, gated for `claude-managed`. No regressions or issues found.

## Appendix

- **Plan**: `thoughts/taras/plans/2026-05-25-hot-reload-skills.md`
- **Probe script**: `/tmp/qa-skills-hotreload/probe.ts`
- **Probe output**: `/tmp/qa-skills-hotreload/probe-results.txt`
- **Server log**: `/tmp/qa-skills-hotreload/server.log`
- **Test fake-home**: `/tmp/qa-skills-hotreload/fake-home/`
- **Notes**:
  - `/api/skills/sync-filesystem` ignores body params — the endpoint always syncs against the server process's real `homedir()`. QA used `HOME=/tmp/.../fake-home` on the spawned API server to redirect writes to an inspectable location.
  - QA ran against an isolated server instance on `:3019` with a fresh DB at `/tmp/qa-skills-hotreload/agent-swarm-db.sqlite` — Taras's production DB and dev server on `:3013` were untouched.

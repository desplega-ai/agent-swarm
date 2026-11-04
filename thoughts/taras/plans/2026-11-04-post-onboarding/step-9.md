---
id: step-9
name: "Key plumbing: schedule + page inherit key, runs visible in group"
track: D
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: Key plumbing: schedule + page inherit key, runs visible in group

## Overview
A use case becomes one Sessions group by data alone. `create-schedule` and `create-page` default their `key` to the calling task's key when that key is a real group key. Schedule runs show inside their group view and count in the sidebar tree even though the Mine rule and the default source filter hide `source='schedule'` elsewhere. The schedules UI can send a `key`. After this step, a task created in `shared/competitor-research/` that calls `create-schedule` yields a schedule and runs that all appear under `/sessions?view=shared/competitor-research/`.

## Changes Required:

#### 1. Key inheritance in tools
**Files**: `src/tools/schedules/create-schedule.ts:26-28, 298-326`, `src/tools/create-page.ts:205-221`, `src/assets/key.ts`
**Changes**: Add `isGroupKey(key)` to `src/assets/key.ts`: true when the key is not `shared/`, not `personal/<user>/`, and its last segment is not a resource leaf (`task|thread|schedule|workflow|page:<id>/`, `SESSION_LEAF_KINDS` at `:92` plus `page`). In both tools, when `input.key` is undefined, resolve the source task the way `resolveTaskAuditUserId` does (`src/be/audit-user.ts:28-45`: `sourceTaskId`, else the agent's current task, only when `task.agentId === callerAgentId`) and use `task.key` if `isGroupKey(task.key)`, then `authorizeAssetKeyWrite(key, createdBy)`. Otherwise keep today's default. Update the `key` input descriptions ("Defaults to the calling task's group key when it has one, else `shared/schedule:<id>/`"). `create-page` update path (`:231`) stays unchanged.

#### 2. Schedule runs visible inside a group
**Files**: `src/be/db/session-tree.ts:277-288, 301-308, 672-679, 738`, `src/http/sessions.ts:1036-1064`, `src/be/db/session-visibility.ts:56-79`
**Changes**: Add `includeScheduleRuns` to the root filter options, set when `groupKey` is present. When set: (a) the Mine condition becomes `(<mine> OR r.scheduleId IS NOT NULL)`; (b) the `showSource` condition becomes `(<shown> OR r.scheduleId IS NOT NULL)`; (c) the tree owner filter `requestedByUserId IS NOT NULL` is skipped for `scheduleId IS NOT NULL` rows. Apply the same rule in `getSessionTree` so per-group `total`/`running` counts match the list (a group that holds only schedule runs then gets a sidebar node). Triage and viewer-scope rules stay. The list cache key already derives from `filterOpts` (`sessions.ts:1078`).

#### 3. UI sends `key` for schedules
**Files**: `apps/ui/src/api/hooks/use-schedules.ts:6-12, 33-51`, `apps/ui/src/pages/schedules/page.tsx:315,336`, `apps/ui/src/pages/schedules/[id]/page.tsx:572-616`
**Changes**: `useScheduledTasks` filters accept `key`/`keyPrefix` (the client already supports them, `apps/ui/src/api/client.ts:1359-1389`). `useCreateSchedule` accepts `key`. The create dialog gets a "Start in" row using `StartInPicker` (`apps/ui/src/components/sessions-v2/start-in-picker.tsx:28`). `EditScheduleDialog` shows the key read-only with a hint that moves happen in Sessions.

#### 4. Tests
**Files**: `src/tests/asset-key-invariants.test.ts:73-136`, `src/tests/create-page*.test.ts` and `src/tests/create-schedule*.test.ts` (create if missing), `src/tests/sessions-tree.test.ts`, `src/tests/sessions.test.ts`, `src/tests/session-source-keys.test.ts`, new `scripts/e2e/scenarios/core-use-case-group.ts`, `scripts/e2e/coverage-manifest.json`
**Changes**: Tool-level: inherits a group key; does not inherit `shared/task:<id>/`; explicit key wins; `personal/` authorization still enforced. Tree/list: a schedule run under a group key appears in `GET /api/sessions?scope=tree&groupKey=<key>` with default `show`/`showSource`, counts in `GET /api/session-tree` groups, and stays hidden in the Inbox list. E2E: agent-sim task with key → `create-schedule` via MCP → `POST /api/schedules/{id}/run` → run listed in the group.

#### 5. Docs
**Files**: `runbooks/workflows.md` or `MCP.md` tool table (whichever lists `create-schedule`/`create-page`), `templates/skills/asset-namespaces/content.md`
**Changes**: One line each on the new default. `bun run build:skill-md` if a `SKILL.md` exists beside the skill.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/asset-key-invariants.test.ts src/tests/sessions-tree.test.ts src/tests/sessions.test.ts src/tests/session-source-keys.test.ts` plus the tool test files touched
- [ ] `bun run e2e --strict`
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- schedules`
- [ ] `bun run check:local && bun run tsc:check:tsc && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] `bun run check:skill-md && bun run check:skill-sources`

#### Automated QA:
- [ ] API walkthrough on a local API (`DESPLEGA_TELEMETRY_ENV=test`): `POST /api/tasks` with `key: "shared/po-qa/"` and `requestedByUserId`; as the assigned agent call the `create-schedule` MCP tool with no `key` (use the e2e agent-sim or `curl` to the MCP endpoint); `GET /api/schedules?key=shared/po-qa/` returns it; `POST /api/schedules/{id}/run`; `GET /api/sessions?scope=tree&groupKey=shared/po-qa/` lists the run; `GET /api/session-tree` shows the group with `total >= 2`.
- [ ] Same walkthrough with a task whose key is the default `shared/task:<id>/`: the schedule keeps `shared/schedule:<id>/`.
- [ ] `GET /api/sessions?scope=tree` (Inbox, no groupKey) does not list the run.

#### Manual Verification:
- [ ] None. The UI header that exposes this is step-10.

**Implementation Note**: This step is a vertical slice, QA-able on its own through the API and the existing Sessions group view. Backend-heavy: routes to Codex `gpt-6.1-sol` (high) per `desplega:delegate-work`, with the UI dialog part to Opus. After completing this step, pause for manual confirmation. Commit as `[step-9] Key plumbing: schedule + page inherit key, runs visible in group` after verification passes.

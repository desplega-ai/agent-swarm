---
date: 2026-03-27T20:00:00Z
topic: "Deprecate & Remove Epics Feature"
status: completed
autonomy: autopilot
---

# Plan: Deprecate & Remove Epics Feature

**Date:** 2026-03-27
**Status:** Draft
**Autonomy:** Autopilot

## Summary

Complete removal of the epics feature from agent-swarm. Epics are an unused project-management abstraction layered on top of tasks. Removing them simplifies the codebase, reduces MCP tool surface, and eliminates dead UI pages.

## Scope of Removal

### Files to DELETE entirely
| # | File | Description |
|---|------|-------------|
| 1 | `src/tools/epics/assign-task-to-epic.ts` | MCP tool |
| 2 | `src/tools/epics/create-epic.ts` | MCP tool |
| 3 | `src/tools/epics/delete-epic.ts` | MCP tool |
| 4 | `src/tools/epics/get-epic-details.ts` | MCP tool |
| 5 | `src/tools/epics/index.ts` | MCP tool barrel |
| 6 | `src/tools/epics/list-epics.ts` | MCP tool |
| 7 | `src/tools/epics/unassign-task-from-epic.ts` | MCP tool |
| 8 | `src/tools/epics/update-epic.ts` | MCP tool |
| 9 | `src/tools/tracker/tracker-link-epic.ts` | Tracker MCP tool |
| 10 | `src/http/epics.ts` | HTTP endpoint handler |
| 11 | `new-ui/src/pages/epics/page.tsx` | UI list page |
| 12 | `new-ui/src/pages/epics/[id]/page.tsx` | UI detail page |
| 13 | `new-ui/src/api/hooks/use-epics.ts` | UI data hook |
| 14 | `src/tests/epics.test.ts` | Unit tests |
| 15 | `docs-site/content/docs/api-reference/epics.mdx` | API docs page |
| 16 | `docs-site/content/docs/(documentation)/concepts/epics.mdx` | Concepts doc |
| 17 | `thoughts/shared/research/2026-01-16-epics-feature-research.md` | Old research |
| 18 | `thoughts/shared/plans/2026-01-16-epics-feature-implementation.md` | Old plan |

### Files to EDIT (remove epic references)

#### Backend Core
| # | File | What to change |
|---|------|---------------|
| 1 | `src/types.ts` | Remove `epicId` from task schema (~L125), remove `EpicStatusSchema`, `EpicSchema`, `EpicWithProgressSchema` and their types (~L487-540) |
| 2 | `src/be/db.ts` | Remove: `epicId` from task row types/mappings, epic filter from `getTasks`/`getTasksForAgent`, `epicId` from `createTaskExtended`. Remove all epic functions (~L4234-4734): `rowToEpic`, `getEpics`, `getEpicById`, `getEpicByName`, `createEpic`, `updateEpic`, `deleteEpic`, `getEpicTaskStats`, `getEpicWithProgress`, `getTasksByEpicId`, `assignTaskToEpic`, `unassignTaskFromEpic`, `getEpicsWithProgressUpdates`, `markEpicProgressNotified`, `markEpicsProgressNotified`. Remove `Epic`/`EpicStatus`/`EpicWithProgress` imports |
| 3 | `src/be/db.ts` (initDb) | In the legacy CHECK-constraint migration (~L87-199): remove `epicId` from CREATE TABLE column list (~L137), both INSERT column lists (~L157, L168), and the `idx_agent_tasks_epicId` index recreation (~L182) |

#### MCP Tools & Server
| # | File | What to change |
|---|------|---------------|
| 4 | `src/server.ts` | Remove epic imports (~L12-19), remove `epics` from default capabilities string (~L125), remove epic tool registration block (~L232-240), remove `registerTrackerLinkEpicTool` call (~L253) |
| 5 | `src/tools/tool-config.ts` | Remove 7 epic tool names from array (~L60-67), remove `tracker-link-epic` (~L103) |
| 6 | `src/tools/send-task.ts` | Remove `epicId` parameter, remove epic validation/lookup logic (~L51, L114, L159-174), remove epic tag building (~L208-209), remove `epicId` from task creation calls (~L220, L272, L298) |
| 7 | `src/tools/store-progress.ts` | Remove epic imports (~L12, L15), remove epic-linked promotion logic (~L277-283), remove epic context enrichment in follow-up (~L345-382) |
| 8 | `src/tools/tracker/index.ts` | Remove `registerTrackerLinkEpicTool` export |

#### Artifact SDK
| # | File | What to change |
|---|------|---------------|
| 8b | `src/artifact-sdk/browser-sdk.ts` | Remove `listEpics` method and any epic-related API methods |

#### HTTP & Polling
| # | File | What to change |
|---|------|---------------|
| 9 | `src/http/index.ts` | Remove `handleEpics` import (~L26) and handler call (~L113) |
| 10 | `src/http/tasks.ts` | Remove `epicId` from query params (~L36), filter logic (~L226), and response mapping (~L271) |
| 11 | `src/http/poll.ts` | Remove epic imports (~L11, L17), remove `epic_progress_changed` trigger block (~L184-196) |

#### Worker / Runner
| # | File | What to change |
|---|------|---------------|
| 12 | `src/commands/runner.ts` | Remove `epic_progress_changed` from trigger type union (~L1102), remove `epics` from trigger interface (~L1126), remove entire `case "epic_progress_changed"` handler (~L1283-1365), remove `fetchEpicNameAndGoal` function (~L1442-1458), remove `fetchEpicTaskContext` function (~L1461-1490), remove epic context enrichment in task_assigned (~L2849-2897) |
| 13 | `src/commands/templates.ts` | Remove `task.trigger.epic_progress` template definition (~L75-97) |

#### Prompt Templates
| # | File | What to change |
|---|------|---------------|
| 14 | `src/prompts/session-templates.ts` | Remove epic reference (~L110) |

#### Tracker
| # | File | What to change |
|---|------|---------------|
| 15 | `src/tracker/types.ts` | Change `entityType: "task" \| "epic"` to `entityType: "task"` (~L31) |
| 16 | `src/be/db-queries/tracker.ts` | Change all `"task" \| "epic"` types to `"task"` (~L8, L18, L28, L113) |
| 17 | `src/tools/tracker/tracker-sync-status.ts` | Remove `"epic"` from entityType enum (~L16) |

#### Dashboard UI
| # | File | What to change |
|---|------|---------------|
| 18 | `new-ui/src/app/router.tsx` | Remove epic route entries |
| 19 | `new-ui/src/components/layout/app-sidebar.tsx` | Remove Epics nav item |
| 20 | `new-ui/src/components/layout/breadcrumbs.tsx` | Remove epic breadcrumb entries |
| 21 | `new-ui/src/api/types.ts` | Remove Epic types |
| 22 | `new-ui/src/api/client.ts` | Remove epic API methods |
| 23 | `new-ui/src/api/hooks/index.ts` | Remove epic hook re-exports |
| 24 | `new-ui/src/api/hooks/use-tasks.ts` | Remove epicId from task query params if present |
| 25 | `new-ui/src/components/shared/status-badge.tsx` | Remove epic status variants |
| 26 | `new-ui/src/components/shared/stats-bar.tsx` | Remove epic stats if present |
| 27 | `new-ui/src/components/shared/command-menu.tsx` | Remove epic commands |
| 28 | `new-ui/src/hooks/use-keyboard-shortcuts.ts` | Remove epic keyboard shortcut |

#### Scripts & Seed
| # | File | What to change |
|---|------|---------------|
| 29 | `scripts/seed.ts` | Remove `EpicSeed`, `generateEpic()`, `seedEpics()`, `--epics` flag, epic in `seedTasks()` |
| 30 | `scripts/seed.default.json` | Remove `"epics"` section |
| 31 | `scripts/generate-openapi.ts` | Remove epic import |

#### Templates (official)
| # | File | What to change |
|---|------|---------------|
| 32 | `templates/official/*/CLAUDE.md` (8 files) | Remove `- epics` from capabilities list |
| 33 | `templates/official/lead/IDENTITY.md` | Remove "epics" from capabilities description |
| 34 | `templates/official/lead/config.json` | Remove "epics" from description string |

#### Documentation
| # | File | What to change |
|---|------|---------------|
| 35 | `MCP.md` | Remove entire Epics Tools section, remove `epicId` param from send-task, remove TOC entries |
| 36 | `plugin/commands/work-on-task.md` | Remove epic reference (~L19) |
| 36b | `plugin/skills/artifacts/skill.md` | Remove `listEpics` documentation |
| 36c | `DEPLOYMENT.md` | Remove epic references from database description |
| 37 | `docs-site/content/docs/api-reference/meta.json` | Remove epics entry |
| 38 | `docs-site/content/docs/(documentation)/concepts/meta.json` | Remove epics entry |
| 39 | Various docs-site files | Remove epic references from getting-started, deployment, architecture, agents, memory, linear-integration |

#### Tests to EDIT
| # | File | What to change |
|---|------|---------------|
| 40 | `src/tests/tool-annotations.test.ts` | Remove epic tool entries |
| 41 | `src/tests/prompt-template-remaining.test.ts` | Remove `epic_progress` template test |
| 42 | `src/tests/tracker-tools.test.ts` | Remove epic entity type references |
| 43 | `src/tests/db-queries-tracker.test.ts` | Remove epic entity type references |
| 44 | `src/tests/runner-polling-api.test.ts` | Remove epic trigger references |
| 45 | `src/tests/http-api-integration.test.ts` | Remove epic endpoint tests |
| 46 | `src/tests/gitlab-vcs-db.test.ts` | Remove epicId references |
| 47 | `src/tests/self-improvement.test.ts` | Remove epic references if any |
| 48 | `src/tests/artifact-sdk.test.ts` | Remove epic references if any |

#### Landing page (cosmetic)
| # | File | What to change |
|---|------|---------------|
| 49 | `landing/src/components/features.tsx` | Remove/replace epic mentions |
| 50 | `landing/src/components/architecture.tsx` | Remove/replace epic mentions |
| 51 | `landing/src/app/blog/swarm-metrics/page.tsx` | Remove/replace epic mentions |
| 52 | `landing/src/app/blog/page.tsx` | Remove/replace epic mentions |

---

## Phases

### Phase 1: Database Migration

**Goal:** Drop the `epics` table and remove `epicId` FK from `agent_tasks`.

Create `src/be/migrations/026_drop_epics.sql`:

```sql
-- Remove epic feature entirely

-- 1. Null out epicId on tasks before table recreation
UPDATE agent_tasks SET epicId = NULL WHERE epicId IS NOT NULL;

-- 2. Recreate agent_tasks without epicId (12-step pattern per codebase convention)
PRAGMA foreign_keys=off;

CREATE TABLE agent_tasks_new (
  id TEXT PRIMARY KEY,
  agentId TEXT,
  creatorAgentId TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api', 'github', 'agentmail', 'system', 'schedule', 'linear', 'workflow')),
  taskType TEXT,
  tags TEXT DEFAULT '[]',
  priority INTEGER DEFAULT 50,
  dependsOn TEXT DEFAULT '[]',
  offeredTo TEXT,
  offeredAt TEXT,
  acceptedAt TEXT,
  rejectionReason TEXT,
  slackChannelId TEXT,
  slackThreadTs TEXT,
  slackUserId TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  finishedAt TEXT,
  failureReason TEXT,
  output TEXT,
  progress TEXT,
  notifiedAt TEXT,
  mentionMessageId TEXT,
  mentionChannelId TEXT,
  githubRepo TEXT,
  githubEventType TEXT,
  githubNumber INTEGER,
  githubCommentId INTEGER,
  githubAuthor TEXT,
  githubUrl TEXT,
  parentTaskId TEXT,
  claudeSessionId TEXT,
  agentmailInboxId TEXT,
  agentmailMessageId TEXT,
  agentmailThreadId TEXT,
  model TEXT,
  scheduleId TEXT,
  dir TEXT,
  vcsRepo TEXT,
  outputSchema TEXT,
  wasPaused INTEGER DEFAULT 0
);

INSERT INTO agent_tasks_new (
  id, agentId, creatorAgentId, task, status, source, taskType, tags,
  priority, dependsOn, offeredTo, offeredAt, acceptedAt, rejectionReason,
  slackChannelId, slackThreadTs, slackUserId, createdAt, lastUpdatedAt,
  finishedAt, failureReason, output, progress, notifiedAt,
  mentionMessageId, mentionChannelId, githubRepo, githubEventType,
  githubNumber, githubCommentId, githubAuthor, githubUrl,
  parentTaskId, claudeSessionId,
  agentmailInboxId, agentmailMessageId, agentmailThreadId,
  model, scheduleId, dir, vcsRepo, outputSchema, wasPaused
)
SELECT
  id, agentId, creatorAgentId, task, status, source, taskType, tags,
  priority, dependsOn, offeredTo, offeredAt, acceptedAt, rejectionReason,
  slackChannelId, slackThreadTs, slackUserId, createdAt, lastUpdatedAt,
  finishedAt, failureReason, output, progress, notifiedAt,
  mentionMessageId, mentionChannelId, githubRepo, githubEventType,
  githubNumber, githubCommentId, githubAuthor, githubUrl,
  parentTaskId, claudeSessionId,
  agentmailInboxId, agentmailMessageId, agentmailThreadId,
  model, scheduleId, dir, vcsRepo, outputSchema, wasPaused
FROM agent_tasks;

DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

-- Recreate indexes (without epicId index)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId);

PRAGMA foreign_keys=on;

-- 3. Remove tracker links for epics
DELETE FROM tracker_links WHERE entityType = 'epic';

-- 4. Drop the epics table
DROP TABLE IF EXISTS epics;
```

**Important:** The column list in the migration must match the current `agent_tasks` schema at implementation time. Verify with `sqlite3 agent-swarm-db.sqlite ".schema agent_tasks"` before finalizing.

Also update `src/be/db.ts` `initDb()` legacy CHECK-constraint migration (lines 87-199): remove `epicId` from the CREATE TABLE column list (L137), both INSERT column lists (L157, L168), and the `idx_agent_tasks_epicId` index recreation (L182).

**Note on migration 005:** Leave `005_epic_next_steps.sql` in place. It runs before the drop migration on fresh DBs, and the drop migration then removes the table. This is correct behavior — never modify applied migrations.

**Verification:**
```bash
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
sleep 3
sqlite3 agent-swarm-db.sqlite ".tables" | grep epic        # Expected: no output
sqlite3 agent-swarm-db.sqlite ".schema agent_tasks" | grep epic  # Expected: no output
kill $(lsof -ti :3013)
```

### Phase 2: Backend — Types, DB Queries, and Core Logic

**Goal:** Remove all epic types, DB query functions, and core references.

1. **`src/types.ts`**: Remove `epicId` from `AgentTaskSourceSchema`, remove `EpicStatusSchema`, `EpicSchema`, `EpicWithProgressSchema` and type exports
2. **`src/be/db.ts`**: Remove all epic functions (~500 lines), remove `epicId` from task row types/creation/filters, remove epic imports
3. **`src/be/db-queries/tracker.ts`**: Change `"task" | "epic"` to `"task"` everywhere
4. **`src/tracker/types.ts`**: Change `entityType` union to just `"task"`

**Verification:**
```bash
bun run tsc:check
```

### Phase 3: MCP Tools & HTTP Endpoints

**Goal:** Remove all epic MCP tools, the HTTP handler, and update server registration.

1. **Delete** entire `src/tools/epics/` directory (8 files)
2. **Delete** `src/tools/tracker/tracker-link-epic.ts`
3. **Delete** `src/http/epics.ts`
4. **Edit** `src/server.ts`: Remove epic imports, capability, and registration
5. **Edit** `src/tools/tool-config.ts`: Remove 7 epic tool names + `tracker-link-epic`
6. **Edit** `src/tools/tracker/index.ts`: Remove tracker-link-epic export
7. **Edit** `src/http/index.ts`: Remove epic handler import + call
8. **Edit** `src/http/tasks.ts`: Remove `epicId` from query/filter/response
9. **Edit** `src/http/poll.ts`: Remove epic progress trigger
10. **Edit** `src/tools/send-task.ts`: Remove `epicId` param, validation, tag logic
11. **Edit** `src/tools/store-progress.ts`: Remove epic enrichment and follow-up logic
12. **Edit** `src/tools/tracker/tracker-sync-status.ts`: Remove `"epic"` from entity type enum
13. **Edit** `src/artifact-sdk/browser-sdk.ts`: Remove `listEpics` method and epic-related API methods

**Verification:**
```bash
bun run tsc:check
bun run lint:fix
```

### Phase 4: Worker / Runner / Prompts

**Goal:** Remove epic trigger handling and prompt templates from the runner.

1. **Edit** `src/commands/runner.ts`: Remove `epic_progress_changed` type, handler, `fetchEpicNameAndGoal`, `fetchEpicTaskContext`, epic context enrichment in `task_assigned`
2. **Edit** `src/commands/templates.ts`: Remove `task.trigger.epic_progress` template
3. **Edit** `src/prompts/session-templates.ts`: Remove epic reference

**Verification:**
```bash
bun run tsc:check
```

### Phase 5: Dashboard UI

**Goal:** Remove all epic pages, hooks, types, and navigation from the UI.

1. **Delete** `new-ui/src/pages/epics/` directory
2. **Delete** `new-ui/src/api/hooks/use-epics.ts`
3. **Edit** router, sidebar, breadcrumbs, types, client, hooks/index, use-tasks, status-badge, stats-bar, command-menu, keyboard-shortcuts

**Verification:**
```bash
cd new-ui && pnpm lint && pnpm exec tsc --noEmit && cd ..
```

### Phase 6: Scripts, Seeds, Templates

**Goal:** Remove epic from seed data, official templates, and OpenAPI generation.

1. **Edit** `scripts/seed.ts`: Remove all epic-related code
2. **Edit** `scripts/seed.default.json`: Remove `"epics"` section
3. **Edit** `scripts/generate-openapi.ts`: Remove epic import
4. **Edit** 8 template CLAUDE.md files: Remove `- epics` from capabilities
5. **Edit** `templates/official/lead/IDENTITY.md` and `config.json`

**Verification:**
```bash
bun run tsc:check
bun run docs:openapi
```

### Phase 7: Tests

**Goal:** Remove/update all test files that reference epics.

1. **Delete** `src/tests/epics.test.ts`
2. **Edit** remaining test files to remove epic references

**Verification:**
```bash
bun test
```

### Phase 8: Documentation

**Goal:** Update all docs to remove epic references.

1. **Edit** `MCP.md`: Remove Epics Tools section, epicId from send-task, TOC entries
2. **Edit** `plugin/commands/work-on-task.md`: Remove epic line
3. **Edit** `plugin/skills/artifacts/skill.md`: Remove `listEpics` documentation
4. **Edit** `DEPLOYMENT.md`: Remove epic references from database description
5. **Delete** docs-site epic pages
6. **Edit** docs-site meta.json files
7. **Edit** other docs-site pages referencing epics
8. **Edit** landing page files to remove epic mentions
9. **Regenerate** `openapi.json` — this is a generated artifact that must be committed with the changes

**Verification:**
```bash
bun run docs:openapi
# Confirm openapi.json has no epic references
grep -i epic openapi.json | wc -l
# Expected: 0
```

### Phase 9: Final Validation

**Goal:** Full project check to ensure nothing is broken.

```bash
# Root project
bun run lint:fix
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh

# UI
cd new-ui && pnpm lint && pnpm exec tsc --noEmit && cd ..

# Verify no remaining epic references in source (excluding historical)
grep -ri "epic" --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.json" \
  --exclude-dir=thoughts --exclude-dir=.git --exclude-dir=node_modules --exclude=CHANGELOG.md \
  --exclude-dir=landing \
  src/ new-ui/src/ scripts/ templates/ plugin/

# Fresh DB test
rm -f agent-swarm-db.sqlite*
bun run start:http &
sleep 3
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks | head -5
kill $(lsof -ti :3013)
```

### Manual E2E Verification

```bash
# 1. Clean slate
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# 2. Start API
bun run start:http &
sleep 3

# 3. Verify epic endpoints are gone (should 404)
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer 123123" http://localhost:3013/api/epics
# Expected: 404

# 4. Verify tasks work without epicId
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"task": "Test task", "source": "api"}' | jq .id
# Expected: valid task ID

# 5. Verify OpenAPI spec has no epic references
grep -i epic openapi.json | wc -l
# Expected: 0

# 6. Cleanup
kill $(lsof -ti :3013)
```

### Phase 10: Version Bump

**Goal:** Bump the package version to mark this breaking change.

1. Update `version` in `package.json` from `1.54.1` to `1.55.0` (minor bump — feature removal)
2. Update `CHANGELOG.md` with a new entry documenting the epic removal

**Verification:**
```bash
grep '"version"' package.json
# Expected: "version": "1.55.0"
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Existing tasks in production have `epicId` set | Migration NULLs them before table recreation |
| Tracker links reference epics | Migration deletes epic tracker links |
| Agents mid-flight reference epic tools | Tools disappear on restart — agents get clean tool list on reconnect |
| Migration 005 references epics table | Left in place — runs before drop migration, then drop cleans up |
| Landing page mentions epics | Replace with generic task/project references |

## Out of Scope

- **CHANGELOG.md**: Historical entries mentioning epics are left as-is (they're history)
- **thoughts/ directory**: Old research/plans mentioning epics are left (historical context), except the two epic-specific docs which are deleted
- **Git history**: No rewriting

---

## Review Errata

_Reviewed: 2026-03-28 by Claude — all findings addressed, plan updated_

### Resolved

- [x] **Migration SQL rewrote to use 12-step table recreation pattern** (was `ALTER TABLE DROP COLUMN` which breaks codebase convention)
- [x] **Phase 1 verification commands fixed** (`grep -v epic` → `grep epic` expecting no output)
- [x] **`db.ts initDb()` description corrected** — now accurately describes legacy CHECK-constraint migration edits at L137, L157, L168, L182
- [x] **Added `src/artifact-sdk/browser-sdk.ts`** to edit list and Phase 3 (has `listEpics` method)
- [x] **Added `plugin/skills/artifacts/skill.md`** to edit list and Phase 8
- [x] **Added `DEPLOYMENT.md`** to edit list and Phase 8
- [x] Migration number set to `026` (highest existing: `025_workflow_run_cancelled_status.sql`)
- [x] All 18 deletion targets verified to exist
- [x] Line number claims in edit targets verified as approximately correct
- [x] Migration 005 handling is correct — leave in place, drop migration cleans up after it
- [x] `docs-site/.source/` auto-generated files will regenerate after changes, no manual edits needed
- [x] Version bump assumption (1.54.1) should be verified at implementation time

### Note on migration column list

The `026_drop_epics.sql` migration includes a full `agent_tasks` column list based on the schema as of 2026-03-28. **If new columns are added before this plan is implemented**, the migration must be updated to include them. Verify with `sqlite3 agent-swarm-db.sqlite ".schema agent_tasks"` before finalizing.

---

## Post-Implementation Verification (2026-03-28)

_Verified by Claude via `/verify-plan` — autopilot mode_

### Verification Summary

| Check | Result |
|-------|--------|
| All 18 file deletions | **PASS** — all confirmed absent |
| All ~52 file edits | **PASS** — 13 key files spot-checked, all epic refs removed |
| Migration 026 structure | **PASS** — correct 12-step table recreation |
| Migration 005 preserved | **PASS** — old migration left in place as planned |
| `bun run tsc:check` | **PASS** |
| `bun run lint:fix` | **PASS** |
| `new-ui tsc --noEmit` | **PASS** |
| `new-ui pnpm lint` | **PASS** |
| `bash scripts/check-db-boundary.sh` | **PASS** |
| `bun test` (tracker) | **PASS** (after fix) |
| `openapi.json` epic-free | **PASS** (0 matches after regen) |
| `package.json` version | **PASS** — `1.55.0` |

### Blocking Issues Found & Resolved

1. **`src/be/migrations/runner.ts:22`** — `"epics"` was still in `BASELINE_TABLES` array. This is live runtime code used to detect pre-migration databases. Leaving it would cause the runner to fail baseline detection on DBs where 026 already dropped the epics table, potentially re-running 001_initial.sql and creating a zombie table. **Fix:** removed `"epics"` from the array.

2. **`openapi.json`** — Had 27 epic references (endpoints, tags, parameters). Plan Phase 8 required regeneration but it hadn't been done. **Fix:** ran `bun run docs:openapi`, confirmed 0 epic matches.

3. **`src/tests/db-queries-tracker.test.ts:124`** — `getAllTrackerSyncs filters by provider` expected `linear.length >= 2`, but the removed "same externalId for different entityTypes" test was the one creating the second linear sync (with entityType `"epic"`). Only 1 linear sync remains. **Fix:** changed assertion to `>= 1`.

### Non-Blocking Notes

- **12 channel test failures** in `http-api-integration.test.ts`: Pre-existing — channel HTTP handler was never registered in `src/http/index.ts`. Unrelated to epic removal.
- **Plan item #50** (`landing/src/components/architecture.tsx`): File does not exist. No action needed.
- **Old migrations** (001, 004, 005, 006, 009): Contain epic references as expected — checksum-protected, cannot/should not be modified.

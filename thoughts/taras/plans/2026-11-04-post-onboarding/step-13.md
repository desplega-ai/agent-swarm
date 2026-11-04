---
id: step-13
name: "Post-onboarding checklist (state, signals, edit, Home widget)"
track: E
depends_on: [step-5, step-9]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-13: Post-onboarding checklist (state, signals, edit, Home widget)

## Overview
One checklist that outlives `/setup`: default items "Connect a chat channel" and "Connect work tools" (swarm-wide) and "First use case, planned" (per user). Items auto-check from real signals, can be removed (with who and why), re-added or repeated (a second channel), and are stored in a new table. Admins edit swarm items, each user edits their own, and anyone sees the list on Home with deep links into the Connect hub and Sessions. Step-14 reads the same state for Lead nudges. After this step, saving a Telegram token flips "Connect a chat channel" to done on Home on the next poll.

**Existing swarms (review question, Taras 2026-11-04): yes, auto-seed.** Defaults are seeded on the first `GET /api/checklist` of any swarm, old or new. Signals compute on read, so a swarm that already has Slack and GitHub sees those items done at once. A user who already runs a schedule under a group key and has opened a run sees "First use case" done. When every visible item is done the Home card collapses to one line ("Setup complete · 3 of 3") with a disclosure, so existing swarms are not nagged. Step-14 nudges only open items, so a connected swarm gets no nudge.

## Changes Required:

#### 1. Migration 284
**File**: `src/be/migrations/284_checklist_items.sql` (new)
**Changes**: Table `checklist_items`:
- identity: `id TEXT PRIMARY KEY`, `scope TEXT NOT NULL CHECK (scope IN ('swarm','user'))`, `userId TEXT` (null for swarm), `kind TEXT NOT NULL CHECK (kind IN ('channel','tool','use_case','custom'))`, `label TEXT NOT NULL`, `href TEXT`, `meta TEXT` (JSON, e.g. `{"adapter":"telegram"}` for a repeated channel), `sortOrder INTEGER NOT NULL`
- status: `status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','removed'))`, `statusChangedAt TEXT`, `statusChangedBy TEXT` (swarm user id, or `lead:<agentId>` when the Lead acted on request), `statusReason TEXT` (free text, optional; the UI asks "Why?" on remove, the Lead passes the user's words)
- nudges: `nudgedAt TEXT`, `nudgedTaskId TEXT`
- audit: `createdAt`, `lastUpdatedAt`, `created_by`, `updated_by`
Index on `(scope, userId, status)`. `status='done'` is the manual done (custom items, or a user marking an auto item done by hand); auto kinds also report `done` when their signal is true. Re-check the ordinal with `scripts/check-migration-conflicts.sh`.

#### 2. Service: defaults + signals
**File**: `src/be/checklist.ts` (new)
**Changes**: `listChecklist(userId)` seeds the three defaults on first read (two swarm rows, one user row per user), then returns items with computed `done` (`status === 'done' || signal === true`) and `signal`:
- `channel`: Slack configured (`getAutomationSetupStates().slack === "configured"`, `src/be/automation-preflight.ts:288-291`) OR any Chat SDK adapter `configured && enabled && health === "ok"` (`getChatSdkStatus`, `src/integrations/chat-sdk/status.ts:113-165`). A repeated channel item with `meta.adapter` checks only that adapter.
- `tool`: any of the `buildSignals().integrations` flags (`src/http/onboarding.ts:143-150`) OR `getOAuthTokens("google"|"microsoft")` present.
- `use_case` (per user): a `scheduled_tasks`, `pages`, `apps` or `workflows` row whose `key` passes `isGroupKey` (step-9) and was created by the user (`created_by`/`createdBy`), AND at least one root task under that key prefix has read state `read` for this user (`getSessionReadState`, `src/be/db/session-tree.ts:503`).
- `custom`: `status === 'done'`.
`mutateChecklist(actor, action)` with actions `add` (kind, label, href, scope, meta), `remove` (reason optional), `restore`, `done` (reason optional), `reorder`. Every status change writes `statusChangedAt`, `statusChangedBy`, `statusReason`. Scope rules: `swarm` needs `config.write.any`; `user` needs the acting user to be the row owner (new verb `checklist.write.own`, registered in `src/rbac/permissions.ts` and `src/rbac/legacy-policy.ts`, granted to every role like `favorite.write.own`). Expose `firstOpenItem(userId)` for step-14 (status `open`, signal false, `nudgedAt` null) and `markNudged(itemId, taskId)`.

#### 3. Routes
**Files**: `src/http/checklist.ts` (new), `src/http/all-routes.ts`
**Changes**: `GET /api/checklist` (typed `schema`: items with `done`, `signal`, `scope`, `status`, `statusChangedBy`, `statusReason`, `editable`). `POST /api/checklist/items` (`rbac: { permission: "checklist.write.own" }`; the handler escalates to `can("config.write.any")` for `scope: "swarm"`). `PATCH /api/checklist/items/{id}` (same posture) for `remove|restore|done|reorder` with optional `reason`. `bun run docs:openapi`. E2E scenario `scripts/e2e/scenarios/platform-checklist.ts` (new) + manifest entry.

#### 4. Home widget
**Files**: `apps/ui/src/components/checklist/post-onboarding-checklist-card.tsx` (new), `apps/ui/src/api/hooks/use-checklist.ts` (new), `apps/ui/src/pages/home/unified-home.tsx:51`
**Changes**: Mount next to `SetupChecklistCard` (which still shows while onboarding is open for admins). The new card shows for every user once `isOnboardingFinished(data)` (`apps/ui/src/api/hooks/use-onboarding.ts:124-126`) or when the user is not an admin (they never see the setup card). Rows: status icon, label, "Open" link (`/integrations?tab=channels`, `/integrations?tab=tools`, the new-session tab in `/sessions`), overflow menu with Remove (asks for an optional reason), Restore, Mark done (custom), Add another channel. Removed items sit under "Show removed (n)" with who removed them and the reason. All-done state collapses to one line. Follow `apps/ui/DESIGN.md` and the `dashboard-ui` skill (status icons, empty states). Match the checklist widget in the approved `mockups/post-onboarding/r3-home.html` (title "Get the swarm working", "1 of 3" progress, one action button per open row); step-15 later wraps it in the shared `HomeWidget` chrome.

#### 5. Tests
**Files**: `src/tests/checklist.test.ts` (new), `apps/ui/src/components/checklist/post-onboarding-checklist-card.test.tsx` (new), `packages/ui-e2e/specs/home.spec.ts` (extend)
**Changes**: Signals per kind with fixtures; seeding is idempotent and runs for a DB with existing data; scope enforcement (member cannot remove a swarm item, admin can); `statusChangedBy`/`statusReason` recorded on remove and done; `use_case` requires both the asset and a read task. UI: rows, menu actions call the API with the reason, removed disclosure shows who and why, all-done collapse. Playwright: Home shows the three defaults for the seeded owner.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/checklist.test.ts src/tests/rbac-admission.test.ts`
- [ ] `bun run e2e --strict`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json && bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [ ] `bash scripts/check-migration-conflicts.sh && bash scripts/check-audit-columns.sh && bash scripts/check-db-boundary.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- checklist`
- [ ] `bun run e2e:ui -- --grep "home"`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] Existing DB upgrade: copy a pre-plan DB (`cp agent-swarm-db.sqlite /tmp/po-s13.sqlite`), boot with `DATABASE_PATH=/tmp/po-s13.sqlite`, `curl <api>/api/checklist` returns 3 seeded items with `done` reflecting the swarm's real integrations.

#### Automated QA:
- [ ] Local API: `GET /api/checklist` as the owner returns 3 items. `PUT /api/config` with a Chat SDK Telegram adapter enabled (or `SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`) → the channel item shows `done: true, signal: true`.
- [ ] As a Requester-role user (`aswt_`): `PATCH /api/checklist/items/<swarm item>` with `remove` → 403; `PATCH` on their own `use_case` item with `{"action":"remove","reason":"not now"}` → 200 and the row shows `statusChangedBy` = that user, `statusReason` = "not now". As admin: remove the swarm `tool` item → 200, then `restore` → 200.
- [ ] Run the step-9 walkthrough (schedule under `shared/po-qa/` by the owner) and open one task in the group in the UI → `use_case` flips to `done: true`.
- [ ] `AGENT_BROWSER_SESSION=po-step13`: Home shows the card with three rows; remove one with a reason; "Show removed (1)" lists who and why; restore. Mark all done → the card collapses to one line. Screenshots `/tmp/po-step13-*.png` and a recording.

#### Manual Verification:
- [ ] Taras judges the default labels, the "Open" targets and the remove-reason prompt.

**Implementation Note**: This step is a vertical slice, QA-able on its own. Backend to Codex `gpt-6.1-sol` (high), the Home card to Opus. After completing this step, pause for manual confirmation. Commit as `[step-13] Post-onboarding checklist (state, signals, edit, Home widget)` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.

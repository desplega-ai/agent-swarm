---
id: step-10
name: "Use-case Overview tab (next run, schedules, outputs, Ask the Lead)"
track: D
depends_on: [step-9, step-2, step-16]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-10: Use-case Overview tab (next run, schedules, outputs, Ask the Lead)

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r3-overview.html`. Decision: `root.md § Design decisions (step-16)`, "Group header brainstorm" and "Round 3 decisions".

## Overview
Opening a use-case group in Sessions opens two tabs in the existing tab strip: a pinned **Overview** tab (first) and the session list tab, which stays exactly as today. The Overview answers three questions for a use case at a glance: when it runs next and what it does, what it produced, and how to talk to the Lead about it. Groups with no schedule and no files under their key get no Overview tab, so plain thread groups look as today. After this step, a user opens their use case group, sees the next run, clicks Run now, previews the latest report and asks the Lead a follow-up, all without leaving Sessions.

Layout (from the approved mockup): a next-run bar across the top (next run time, schedule name, last run status, enabled toggle, Run now split button); left column Schedules then Outputs; right column the selected file's preview then Ask the Lead. Single column on phone, with the two tabs as underline tabs.

## Changes Required:

#### 1. Overview tab in the session shell
**Files**: `apps/ui/src/components/sessions-v2/sessions-v2-shell.tsx:320-322` (tab rendering), the tab model it uses (`TabStrip` and the tab state module next to it), `apps/ui/src/components/sessions-v2/group-tab.tsx:90-145`, `apps/ui/src/components/sessions-v2/mobile/mobile-group-screen.tsx:63-79`
**Changes**: A new tab kind `overview` keyed by group key, pinned (a pin glyph replaces the close button). Opening `/sessions?view=<groupKey>` opens Overview first when the group qualifies, else the list tab as today. Qualification: `useScheduledTasks({ keyPrefix: groupKey })` returns at least one schedule, or `useAgentFsLs` on the key path returns at least one file. Section tabs (inbox, later, done, no group) never qualify. The URL carries the active tab (`?view=<key>&tab=overview|list`) so links and reloads land on the right one.

#### 2. Next-run bar
**Files**: `apps/ui/src/components/sessions-v2/overview/next-run-bar.tsx` (new), `apps/ui/src/api/hooks/use-schedules.ts`
**Changes**: The earliest `nextRunAt` among enabled schedules under the key; schedule name, cadence in words, assignee, last run status and age (latest `source='schedule'` root in the group), enabled toggle (`useUpdateSchedule`), `Run now` via `useRunScheduleNow` (`apps/ui/src/pages/schedules/[id]/page.tsx:136`; the route 400s when disabled, show the message) with a caret menu to run any other schedule in the group. After Run now, invalidate `["sessions"]` and `SESSION_TREE_KEY` (`apps/ui/src/api/hooks/session-query-keys.ts:62`).

#### 3. Schedules widget
**File**: `apps/ui/src/components/sessions-v2/overview/schedules-widget.tsx` (new)
**Changes**: Compact table: name, cadence · assignee · "Template ›" disclosure (renders `taskTemplate` read-only; `fields=full` comes back when a key filter is present, `apps/ui/src/api/client.ts:1359-1389`), next run, enabled toggle; Run now on row hover. Search field from 8 schedules up; sticky header and a scroll area with `scrollbar-gutter: stable` so 50+ schedules stay usable. Footer: "N enabled · M paused" and "Open in Schedules". "New schedule" opens the existing create dialog prefilled with the group key (step-9 added `key` to it).

#### 4. Outputs widget and preview
**Files**: `apps/ui/src/components/sessions-v2/overview/outputs-widget.tsx`, `file-preview.tsx` (new), `apps/ui/src/api/hooks/use-agent-fs.ts:143,172`, `apps/ui/src/components/comb/viewers/file-viewer.tsx:35`
**Changes**: `useAgentFsLs({ orgId, driveId, path: groupKey })` on the default drive from `status.agent_fs.comb` (`apps/ui/src/contexts/agent-fs-context.tsx:183-184`); newest first by `modifiedAt`; name, author, age; a dot for files newer than the user's last visit. Selecting a row renders it in the right column with `FileViewer` (the light viewer, not `FileView` with the comment rail), a header with "Open in Files", and a footer "<agent> wrote it in <session link>" when the file maps to a task (task attachment). "Open folder" links to `/file/~/<org>/<drive>/<key>`. Empty state: "No outputs yet. Results land here when a run writes under <key>." Comb off → the widget is hidden. Relies on the auto-mint client from step-2.

#### 5. Ask the Lead
**Files**: `apps/ui/src/components/sessions-v2/overview/ask-lead-widget.tsx` (new), `apps/ui/src/components/sessions/use-start-session.ts:96-131`
**Changes**: A one-row composer that grows on focus, with an "attach the open file" toggle, wired to `useStartSession({ key: groupKey, onStarted: open the new session tab })`. Above it, the last two Lead replies in this group as one-line links. The created task carries `key = groupKey` and `source = "ui"`, so it lands in the same group.

#### 6. Tests
**Files**: `apps/ui/src/components/sessions-v2/overview/*.test.tsx` (new), `packages/ui-e2e/specs/sessions-overview.spec.ts` (new)
**Changes**: Unit: qualification rule; next-run selection across schedules; Run now calls the mutation and handles the disabled 400; search appears from 8 schedules; outputs sorted newest first; preview renders markdown; composer starts a session with the key. Playwright: fixture seeds a task with key `shared/e2e-usecase/` and two schedules under it via the API, opens `/sessions?view=shared/e2e-usecase/`, asserts Overview is the active pinned tab, clicks Run now, switches to the list tab and waits for the new run row; a plain thread group opens straight on the list tab.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- overview`
- [ ] `bun run e2e:ui -- --grep "overview"`
- [ ] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step10`, local stack with agent-fs: seed as in step-9's walkthrough, write `shared/po-qa/report-2026-11-04.md` to the shared drive with the agent-fs CLI, open `/sessions?view=shared/po-qa/`. Screenshots at 1440 light and dark next to `mockups/post-onboarding/shots/r3-overview-1440-light.png` (`/tmp/po-step10-*.png`).
- [ ] Seed 50 schedules under the key via the API; the Schedules widget shows search and scrolls without the row width changing. Screenshot.
- [ ] Click Run now → switch to the list tab → the run row appears within the poll interval; screenshot.
- [ ] Type in Ask the Lead and send → a new session tab opens; `GET /api/tasks/<id>` shows `key: "shared/po-qa/"`.
- [ ] A thread group with no schedule and no files opens on the list tab with no Overview tab. Screenshot.
- [ ] Phone viewport (390×844) screenshots of Overview and list tabs.
- [ ] Recording of Run now + preview + Ask the Lead for the PR.

#### Manual Verification:
- [ ] Taras compares the built Overview tab with the approved mockup.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-10] Use-case Overview tab` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.

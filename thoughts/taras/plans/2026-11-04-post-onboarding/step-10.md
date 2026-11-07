---
id: step-10
name: "Use-case Overview tab (next run, schedules, outputs, Ask the Lead)"
track: D
depends_on: [step-9, step-2, step-16]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-10
claimed_at: 2026-11-04T16:59:57Z
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
- [x] `bun run e2e:ui -- --grep "overview"`
- [x] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [x] `AGENT_BROWSER_SESSION=po-step10`, local stack with agent-fs: seed as in step-9's walkthrough, write `shared/po-qa/report-2026-11-04.md` to the shared drive with the agent-fs CLI, open `/sessions?view=shared/po-qa/`. Screenshots at 1440 light and dark next to `mockups/post-onboarding/shots/r3-overview-1440-light.png` (`/tmp/po-step10-*.png`).
- [x] Seed 50 schedules under the key via the API; the Schedules widget shows search and scrolls without the row width changing. Screenshot.
- [x] Click Run now → switch to the list tab → the run row appears within the poll interval; screenshot.
- [x] Type in Ask the Lead and send → a new session tab opens; `GET /api/tasks/<id>` shows `key: "shared/po-qa/"`.
- [x] A thread group with no schedule and no files opens on the list tab with no Overview tab. Screenshot.
- [x] Phone viewport (390×844) screenshots of Overview and list tabs.
- [x] Recording of Run now + preview + Ask the Lead for the PR.

#### Manual Verification:
- [ ] Taras compares the built Overview tab with the approved mockup.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-10] Use-case Overview tab` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.

## Implementation notes

- Commit `726720556` on `po/step-10`. All by Opus (UI only, no backend change, no Codex round).
- Tab model: the Overview is a virtual tab (`OVERVIEW_TAB = "overview"` in `lib/sessions-v2.ts`). It never goes in `?tabs=` or the split. The shell shows it before the tabs while the group tab is open and the group qualifies. `?tab=overview|list` picks the face (`focusGroupPane` in `use-sessions-url-state.ts`). A new `?view=` and closing the list tab drop `?tab=`. With no `?tab=`, the group tab waits (skeleton) until it knows whether the group qualifies, so the list never flashes before the Overview. Pinned: a pin glyph, no close button, Delete and middle-click do nothing. The status bar tab count includes it (as in the mockup).
- Qualification: `canHaveOverview` mirrors the server's `showsScheduleRuns` (user groups only; sections, namespace roots, source groups and resource groups never qualify). Then at least one schedule (a `keyPrefix` read cut to schedules whose `groupKeyOf(key)` is the group) or at least one file in `ls /<key>` on the shared drive. A missing folder, Comb off, or a key that cannot be minted counts as "no files".
- `useAutoConnect` gained `{ enabled }`. The Overview mints this browser's agent-fs key (step-2 flow) only while a user group is open, not on every Sessions view.
- "New schedule": `ScheduleDialog` and the create mapping moved from `pages/schedules/page.tsx` to `components/schedules/schedule-dialog.tsx` (a move, plus `initialKey`). The Overview opens it in place with Start in = the group key.
- Run now: `useRunScheduleNow` now also invalidates `["sessions"]` and `SESSION_TREE_KEY` (all callers benefit). A paused schedule's Run now is `aria-disabled` with a tooltip ("Turn the schedule on to run it now."); any server error toasts its message.
- Last run in the bar = newest `source=schedule` root in the group (as planned), not per schedule.
- Cadence: `compactCron` gives "Mon, Thu 09:00", "Daily 07:30", else cronstrue. A schedule zone other than the browser's is named ("Mon, Thu 09:00 UTC"), because the next-run time is shown in local time.
- Outputs: authors through Comb's `useAuthorLabel` (member name or email, "Swarm" for the service account). The "new" dot compares `modifiedAt` with this browser's last visit to that group's Overview (localStorage, per connection and key). First visit marks none.
- Preview footer: "<writer> wrote it in <session>" when one of the group's 5 newest sessions has an agent-fs attachment with that path (new client call `fetchTaskFiles`, `GET /api/fs/tasks/{id}/files`). Else "<author> wrote it".
- Ask the Lead: "attach the open file" appends `About the file \`<path>\` in the shared drive.` to the task text (no attachment row). Its two "Lead replies" are the newest `source=ui` sessions in the group, showing the session preview or title. The box stays grown while it holds text: a shrink on blur moved Send under the pointer and swallowed the first click (found in QA).
- Deviations: widget lists are compact `ul` lists, not `DataGrid` (mockup density; same as Home widgets). Phone: underline tabs Overview / Sessions under the existing top bar (the bar still says "Sessions", not the group name). QA files were written through the agent-fs ops API with the human's key, not the agent-fs CLI. No sidebar click opens a group with 10 or fewer sessions ("View all" shows above 10 only), so the recording opens the group by URL.
- Verification:
  - Box 1 left unticked: `bun run lint` pass (3 pre-existing warnings), `bunx tsc -b` pass, but `bun run test -- overview` is a no-op that exits 0 (apps/ui has no `test` script, same as steps 2, 9, 11). Equivalent `cd apps/ui && bun test overview`: 21 pass (`lib/use-case-overview.test.ts` 14, `overview/overview-widgets.test.tsx` 7). Also `bun test --parallel=4 apps/ui/src/components/sessions-v2 apps/ui/src/lib`: 1672 pass.
  - `bun run e2e:ui -- --grep "overview"`: 2 passed. Regression run of `sessions-v2`, `favorites`, `smoke` specs: 48 passed.
  - `bun run check:local`: first run had 1 fail in `src/tests/mcp-input-caps.test.ts` (10 s timeout under load; 8/8 pass alone; no backend file changed), rerun green. `tsc:check:tsc` pass.
- QA artifacts (`/tmp/po-step-10-*`): overview-1440-light, overview-1440-dark, overview-50-schedules-light (search "pricing" 48 of 50, template open, row hover; row width 483 px before scroll, after scroll and after filtering), run-now-list-light, ask-lead-new-tab-light (task key `shared/po-qa/`, source `ui`), plain-group-light, phone-overview-light, phone-overview-scrolled-light, phone-list-light, phone-overview-dark, new-schedule-dialog-dark, recording overview-flow.webm (23 s).
- Follow-ups: a sidebar entry that opens a group's Overview for small groups (today only "View all" above 10 sessions, or a link such as a Home favorite); show the group name in the phone top bar.

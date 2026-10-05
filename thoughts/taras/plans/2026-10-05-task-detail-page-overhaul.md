---
date: 2026-10-05
status: in-progress
autonomy: critical
last_updated: 2026-10-05
last_updated_by: claude (phase 3 agent, hero implemented)
commit_per_phase: true
---

# Task Detail Page Overhaul (desktop + mobile) Implementation Plan

## Overview

Rework the task detail page (`apps/ui/src/pages/tasks/[id]/page.tsx`) so it shows what the agent did and what the operator can do next, on desktop and on mobile. The scope is the 11 proposals that Taras approved in the 2026-10-05 wireframe review.

- **Motivation**: the 2026-10-05 UI audit scored the page 20/40 (Nielsen) and 12/20 (technical). The session log gets 19 to 301 px on desktop. The heading is raw Slack syntax. Finished tasks have no next action. The mobile hero pins half the screen.
- **Related**:
  - Critique snapshot: `.impeccable/critique/2026-10-05T10-22-58Z__apps-ui-src-pages-tasks-id-page-tsx.md`
  - Wireframe spec and review page: `/tmp/task-audit/wireframes/SPEC.md`, `/tmp/task-audit/wireframes/index.html`
  - Decisions: `/tmp/task-audit/wireframes/decisions.json`. All 11 approved. P3 note: "yes but we need to ensure to re-use all the input box from sessions".
  - Evidence screenshots: `/tmp/task-audit/A/`, `/tmp/task-audit/B/`

## Current State Analysis

All UI paths are under `apps/ui/src/`. Line numbers are from `main` at `0b93a949a`.

### Layout and scrolling
- The app shell does not scroll at `lg+`. `<main id="main-content">` is `overflow-y-auto lg:overflow-hidden` (`components/layout/root-layout.tsx:77-84`). The shell also has a second, outer `<main>` from `SidebarInset` (`components/ui/sidebar.tsx:295-307`). No skip link points at `#main-content`.
- The page root is `flex flex-col flex-1 min-h-0 overflow-hidden` (`pages/tasks/[id]/page.tsx:1271`). Two layout trees are always in the DOM: `lg:hidden` tabs (1289-1314) and a `hidden lg:grid` 3-column grid `[280px_1fr_280px|36px]` (1324-1443). The page hand-rolls this grid. It does not use `DetailPageBody` (`components/ui/detail-page-layout.tsx:52-76`, fixed `lg` + 280 px).
- Center column order (1345-1387): Failure card, Output card (`max-h-48` when logs exist), attachments, citations, log viewer (`flex-1 min-h-0`), steer composer. The hero and Output are `shrink-0`, so the log gets the remainder: 301 px at 1440x900, 178 px at 1280x800, 19 px at 1024x768 (audit B).
- Content width depends on more than the viewport. The nav is 256 px (48 px in icon mode), main padding is 24 px per side, and the docked `ContextSessionPanel` takes 380 to 420 px from 1280 px up (`components/context-panel/context-session-panel.tsx:29,126-134`). At a 1280 px window with the panel docked, content is about 804 px.
- Breakpoint switching is CSS only. `useIsMobile` exists (`hooks/use-mobile.ts`, 767 px) but the page does not use it. Tailwind has no custom screens (`xl` = 1280 px).

### Session log viewer (`components/shared/session-log-viewer.tsx`)
- Props: `logs`, `compactionSnapshots`, `className`, `isRunning`, `steeringMessages` (2145-2163). No mode prop and no external scroll element.
- It owns its scroller (`parentRef`, 2761-2764). The virtualizer (above 120 rows, 2136, 2336-2342), the stick-to-bottom logic (2344-2446), the "N new" pill (2811-2824) and `jumpTo` (2462-2478) all depend on that scroller. If the page scrolled instead, these break silently: `atBottomRef` stays true and every `scrollTop` write is a no-op.
- `visibleRows` (2230-2236) is the single filter choke point. Today it only applies the text query. Rows come from `buildStream` (`StreamRow` union, 86-132): `agent`, `steering`, `thinking`, `meta`, `toolgroup`, `subagent`, `compaction`. Thinking-token rows merge into one helper row (532-559). Tool calls merge into `toolgroup` rows (745-794).
- The RESULT card (`ResultMetaBubble`, 1613-1675) repeats the run's final output as markdown, with 8 stat chips.
- The toolbar is a `TabsList` with a lone "Logs" trigger, plus "Agents (n)" when subagents exist (2729-2752).

### Hero, title, metadata
- `taskListTitle` (`lib/task-title.ts:10-20`) returns the first non-tag line. For Slack thread tasks this is often a context line with a raw `<@U…|Name>` token. No Slack mention parsing exists in the UI. The backend helper `rewriteSlackMentions` (`src/slack/enrich.ts:175-196`) imports `be/db`, so the UI cannot import it. The stored shapes are `<@ID|Name>`, `<@ID> (unknown user)`, `<@BOT> (that's you)`, and the `<thread_context>…</thread_context>` wrapper (`src/slack/templates.ts:57-61`).
- `CollapsibleDescription` shows `text.split("\n")[0]` when collapsed (`components/shared/collapsible-description.tsx:37`). The page dedupes it only when the whole prompt equals the title (`page.tsx:1204`).
- Chips (1112-1201): `StatusBadge`, a provider badge with harness variant text, a raw model id badge, and a `+N` popover with unlabeled routing chips. `ModelLabel` (`components/shared/model-logo.tsx:29-47`) already renders "Claude Opus 5.5" with the maker mark.
- The left rail is 18 `MetaRow`s (`page.tsx:212-233`, label column `w-24` truncates "Requested by"), `TaskContextSection` (472-594) and `TaskCostSection` (348-470). Cost uses Space Grotesk, tokens use mono.
- The Slack channel name and workspace are not available to the UI. The task carries `slackChannelId` and `slackThreadTs` only (`api/types.ts:265-267`), so a Slack permalink cannot be built.

### Actions, composer, follow-up
- Hero actions are Pause, Resume and Cancel only (`page.tsx:1210-1266`). Finished tasks get none.
- `canSteer` is true only for `in_progress` and `pending` (688-691). The page mounts `CollapsibleComposerDock` > `SteerComposer` > `ComposerDock` twice, once per layout tree (1035-1058, 1311, 1386). The draft is page-owned (618-623).
- The Sessions "input box" is `ComposerDock` (`components/sessions/composer-dock.tsx:100-146`). It has slots (`modeControl`, `extraActions`, `decoration`), copy props, opt-in attachments, `fullWidth`, and Enter-to-send. `SessionComposer` (`components/sessions/session-composer.tsx:59-183`) switches between two branches. The steer branch is `SteerComposer`, gated to lead tasks (135-141). The follow-up branch (73-118) calls `api.createTask({ task, parentTaskId, requestedByUserId, source: "ui" })` and uploads attachments after creation. Its copy and query invalidations are session-shaped.
- `SteerComposer` passes no attachment props. It discards `SteerResult.promotedTaskId` (`components/steering/steer-composer.tsx:73-84,128-145`).
- Server follow-up paths. `POST /api/tasks` with `parentTaskId` (`src/http/tasks.ts:870-1015`) routes to the Lead when `agentId` is missing (903-913). `createTaskExtended` inherits the Slack channel and thread, `contextKey`, VCS, `dir` and `requestedByUserId` from the parent (`src/be/db.ts:2438-2632`), so a follow-up of a Slack task answers in the same thread. `POST /api/tasks/{id}/steer` on a non-live task promotes the message to a same-agent `taskType: "follow-up"` child (`src/be/steering.ts:122-137,286-298`).
- No task retry exists, in the API or the UI. Workflow runs have one. `supersede` works only for `in_progress`. `CreateTaskDialog` is page-local (`pages/tasks/page.tsx:75-306`).
- Children: `GET /api/tasks` has no `parentTaskId` filter. `GET /api/sessions/{id}` returns `{ root, chain }` (all descendants) for any task id (`src/http/sessions.ts:171-291`, `useSession` in `api/hooks/use-sessions.ts:50-59`, gate 1.76.0).
- Failed tasks: Failure Reason has no `defaultOpen` on desktop (`page.tsx:1346-1358`), while mobile opens it (948-961). `TaskFailureHelpDialog` opens on every visit when lead credentials are fine. It dismisses only in component state (`components/support/task-failure-help-dialog.tsx:29-35`, `lib/task-support.ts:41-47`).
- RBAC is server-side only. The UI has no `can()`. A 403 surfaces as a mutation error toast.

### Status semantics
- `TASK_STATUS_TEXT.active` is `text-status-info-strong` and `RING_TONE.active` is `text-status-info-solid` (`components/shared/task-status-icon.tsx:72-114`). So every in-progress `StatusBadge` in the app is blue. Activity (`lib/status-tone.ts:16-18`, `page.tsx:124-143`) and the log footer orb use amber. DESIGN.md says live = amber.
- `draft` renders as "UPLOADING" (`components/shared/status-badge.tsx:37`). In this product `draft` is the transient "attachments still uploading" state (`components/sessions/use-start-session.ts:75-92`), so the label is accurate for that flow.
- Activity prints raw values (`in_progress → completed`, `page.tsx:149-158`). Pre-start states say "No session logs were recorded for this task" (1027-1029).

### Polling
- `useTaskSessionLogs` polls every 5 s with no options (`api/hooks/use-tasks.ts:80-87`). The response is about 300 KB for a 48-event task, and the page polls it even for finished tasks. `useTask` uses the 10 s default (66-78). `useTaskContext` polls every 10 s (109-116).
- Stop-when-terminal precedent: `components/sessions/chain-of-thought.tsx:41-50,101-117` (`refetchInterval: isActive ? 4000 : false`). Terminal sets: `lib/task-activity.ts:3-8,41-46`.

### Tests that touch this page
- Playwright: `packages/ui-e2e/specs/tasks.spec.ts` checks the "IN PROGRESS" label (12), the tab `name="Session Logs"` (31-35), and visible log text. `codex-logs.spec.ts` checks the "Session Logs" tab (124-125), "191.5K / 1.1M", "18%" twice, and "Unavailable" (209-240). `smoke.spec.ts` uses `page.locator("main").first()` (11).
- Unit (run by `bun run test:root -- <path>`): `lib/task-title.test.tsx`, `lib/task-support.test.tsx`, `lib/task-activity.test.tsx`, `components/shared/task-status-icon.test.tsx`, `components/shared/status-badge.test.tsx`, `components/sessions/session-composer.test.tsx`, `components/steering/steering-message-chips.test.tsx`, `src/tests/ui-logs-parser.test.ts`.

## Desired End State

All of the following hold on the QA stack (`thoughts/taras/qa/2026-10-05-task-detail-qa-stack.md`) in light and dark:

- **Layout follows content width, not viewport width.** At 64rem (1024 px) of content width or more, the page has two columns: a scrolling center column and a 300 px details rail. Below that, it uses the tabs layout.
- **Desktop log.** The center column is the only scroller. The log flows inside it with no inner scroller, and its toolbar sticks under a compact sticky bar. The sticky bar (title, status, model, primary action) appears once the hero leaves the view. (Phase 2b, after the phase 2 review.)
- **Readable heading.**
  - The heading, the breadcrumb and the task lists show the Slack question with mentions turned into names. No `<@`, `(that's you)` or `<thread_context>` text appears anywhere.
  - A source line shows where the task came from.
  - "View full prompt" opens the raw prompt, with the thread context shown as quoted messages.
- **Every status has a next action.**
  - Completed: Follow up, Copy answer, and a "..." menu with Retry and Copy task id.
  - Failed or cancelled: Retry.
  - Live: Pause or Cancel, plus the message box.
  - Spawned child tasks are listed under the answer and linked. Task ids in the answer are links.
- **One input box.** The task page and the Sessions page use one shared composer component, with attachments.
  - On a finished task it creates a follow-up child task for the same agent (`routingReason: "continuity"`). A Slack task answers in the same thread.
  - On a live task it steers, as today.
- **Failed tasks** show an open error callout with the reason and Retry. The "Need help?" dialog opens only from a "Get help" action.
- **Mobile and narrow widths.**
  - The hero scrolls away and the tabs (Outcome, Log, Details) stay sticky.
  - Running tasks open on Log and finished tasks on Outcome.
  - A bottom bar on every tab holds the message box or Follow up.
  - Page controls are at least 44 px tall.
- **Log views.** The log has a Messages and Everything switch. Finished tasks default to Messages.
  - Messages shows agent messages, with tool and thinking runs folded into one line each.
  - The final result is a one-line end marker. The answer is not repeated.
- **Status semantics.**
  - In progress is amber everywhere, as DESIGN.md says.
  - Activity reads in words.
  - Pre-start states say what the task waits for and offer one action.
- **Data and accessibility.**
  - A finished task makes no session-log or context requests after the first load.
  - The page has one `<main>`, a skip link, an h1 to h2 heading order, and a visible focus ring on the log.
  - No text style on the page is under 4.5:1 contrast. No page text is under 11 px, except 10 px uppercase status chips.

## What We're NOT Doing

- **No new backend endpoints.** No task retry endpoint, no `parentTaskId` filter on `GET /api/tasks`, and no Slack permalink or channel-name exposure. The plan uses `POST /api/tasks` and `GET /api/sessions/{id}`.
- **Dropped from the approved wireframes**, each with its reason:
  - "Open Slack thread": the API never sends the Slack workspace to the dashboard.
  - "Retry with changes": the Follow up box covers it. Taras chose this on 2026-10-05.
  - The channel name in the source line: the task has only `slackChannelId`.
  - The "Reassign" action on offered tasks: the UI has no reassign path, so it gets Cancel.
- **No change to `draft` status semantics.** In this product, `draft` means "attachments still uploading", so its label stays "UPLOADING" and its waiting text says so. The wireframe's "Draft. Not sent yet." is wrong for this product.
- **No change to the Sessions page behavior.** Follow-ups there still route to the Lead.
- ~~No "true single scroll" rewrite of the log viewer.~~ Reversed 2026-10-05 after the phase 2 review: Taras chose a single scroll (phase 2b). Only the task page uses it. Other viewer callers keep their own scroller.
- **No app-wide type changes.** Badge `size="tag"` stays 9 px, and other pages keep their sizes.
- **No keyboard shortcuts or draft persistence across reloads.**

## Implementation Approach

- **One branch and one PR, with a commit per phase** (`[phase N] <description>`). Taras chose this. Each phase leaves the page working and green.
- **Order is foundations first, then layout, then content:** helpers and data (1), desktop frame (2), hero (3), actions and composer (4), narrow and mobile (5), log views (6), accessibility and type (7).
- **Layout switches by container width.** The page root gets a Tailwind v4 `@container`. The `lg:hidden` and `hidden lg:grid` pair becomes `@min-[64rem]:hidden` and `hidden @min-[64rem]:grid`. This handles the docked context panel, which a viewport breakpoint cannot.
- **One scroller on the task page (phase 2b).** The viewer takes an external `scrollElement`. The virtualizer, stick-to-bottom, the "N new" pill and the minimap use it. Other callers keep the viewer's own scroller. (Phase 2 first shipped a fixed-height log card with its own scroller. The review found the double scroll, so phase 2b replaces it.)
- **One composer component.** Generalize `SessionComposer` in place into a shared `TaskComposer`, with two callers: Sessions and the task page. The caller decides the steer gate (lead-only versus any assignee) and the follow-up target (the Lead versus the same agent). No wrapper layers.
- **Pure helpers get unit tests.** These are Slack text parsing, retry input, task-id linkify, and the messages-view row transform. Visual behavior is proven by agent-browser measurements on the QA stack, with screenshots under `/tmp/task-detail-qa/phase-N/`.
- **Implementation routing** (per `desplega:delegate-work`): Opus sub-agents for UI phases, and Claude reviews every phase with screenshots. Codex is not used, because this is taste-heavy UI work.

## Quick Verification Reference

- UI typecheck: `cd apps/ui && bunx tsc -b` (CI uses `-b`).
- UI lint: `cd apps/ui && bun run lint` and `cd apps/ui && bun run check:tokens`.
  - If root `bun run lint` exits 0 without a "Checked N files" line, Biome crashed locally (memory `project_local_biome_crash`). Use the scratch-dir recipe from that memory.
- Unit tests: `bun run test:root -- apps/ui/src/lib apps/ui/src/components/shared apps/ui/src/components/sessions apps/ui/src/pages/tasks`, plus `bun run test:root -- src/tests/ui-logs-parser.test.ts`.
- Playwright (Node 22+): `bun run e2e:ui -- specs/tasks.spec.ts specs/codex-logs.spec.ts specs/smoke.spec.ts specs/composer-enter-key.spec.ts specs/prompt-attachments.spec.ts`.
- QA stack: `thoughts/taras/qa/2026-10-05-task-detail-qa-stack.md` (seeded API, grafted real logs, vite on 5275, `connect.sh`).
- No em dashes in changed files: `git diff --name-only main | xargs grep -n "$(printf '\342\200\224')"` prints nothing.

---

## Phase 1: Helpers, status color, waiting states, polling

### Overview

Shared pure helpers and data fixes land without any layout change:
- Slack text parsing.
- Title formatting, which also fixes the breadcrumb and the lists.
- Amber in-progress status.
- Activity in words.
- Waiting states.
- No polling for finished tasks.

### Changes Required:

#### 1. Slack text helper
**File**: `apps/ui/src/lib/slack-text.ts` (new), `apps/ui/src/lib/slack-text.test.ts` (new)
**Changes**:
- `formatSlackMentions(text)` turns the tokens into readable text:
  - `<@ID|Name>` becomes `@Name`.
  - `<@ID> (that's you)` is removed.
  - `<@ID> (unknown user)` and a bare `<@ID>` become `@someone`.
  - `<#C…|name>` becomes `#name`.
  - `<url|label>` becomes `label`.
- `parseSlackPrompt(text)` returns `{ ask, speaker?, thread: { speaker?, text }[] }`:
  - It splits the `<thread_context>…</thread_context>` block (`src/slack/templates.ts:57-61`).
  - It strips a leading `<@ID|Name>: ` speaker prefix from the ask.
  - It handles both orders: message before the context, and context before the message.
- Pure, with no imports from `src/slack` (that code imports `be/db`).
- Tests cover the prod shape from the QA stack, an unknown user, a bot mention, a channel link, a URL label, and text with no Slack tokens (returned unchanged).

#### 2. Title
**File**: `apps/ui/src/lib/task-title.ts`, `apps/ui/src/lib/task-title.test.tsx`
**Changes**:
- The fallback path (when there is no `task.title`) uses `parseSlackPrompt(...).ask` passed through `formatSlackMentions`.
- Capitalize the first letter.
- Keep the `repo:` preamble strip and the `BARE_TAG` rule.
- Add Slack cases to the test.
- This also fixes the breadcrumb (`components/layout/breadcrumbs.tsx:201-202`) and every list that uses `taskListTitle`.

#### 3. In-progress is amber
**File**: `apps/ui/src/components/shared/task-status-icon.tsx`, `apps/ui/src/styles/globals.css` (only if a solid amber stop is missing), `apps/ui/src/components/shared/task-status-icon.test.tsx`
**Changes**:
- `TASK_STATUS_TEXT.active` becomes `text-status-active-strong`.
- `RING_TONE.active` (both surfaces) becomes an amber token. If a solid stop is needed, add `--color-status-active-solid` in light and dark next to `--color-status-info-solid` (`globals.css:76,207`).
- This is app-wide (StatusBadge in lists, kanban and sessions). It is intended: DESIGN.md says live is amber.

#### 4. Activity in words
**File**: `apps/ui/src/lib/task-events.ts` (new, with a test), `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- `describeTaskEvent(log, agentName?)` returns a sentence-case label and a tone. Examples: "Created", "Started by Lead", "Completed", "Offered to worker-b", "Progress: …".
- Status values use sentence-case labels from one exported map, derived from `status-badge.tsx` LABELS, so raw `in_progress` never shows.
- `renderLogContent` and `logDotColor` (`page.tsx:124-183`) use it.

#### 5. Waiting states
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx` (the `sessionLogsContent` empty branch, 1015-1033)
**Changes**:
- Replace the past-tense box with one line and at most one action, by status:
  - `pending`, `unassigned`: "Waiting for {agent | an agent} to pick this up. Queued {age}." [Cancel]
  - `offered`: "Offered to {agent}. Waiting for an answer." [Cancel]
  - `backlog`: "In the backlog."
  - `paused`: "Paused." [Resume]
  - `draft`: "Uploading attachments…"
  - Running with no logs yet: "Waiting for the first session log."
  - Terminal with no logs: "This task finished without a session log."
- Text only. The hero owns Cancel and Resume (Taras, 2026-10-05: no duplicate action in the waiting line).

#### 6. Stop polling finished tasks
**File**: `apps/ui/src/api/hooks/use-tasks.ts`, `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- `useTaskSessionLogs(id, { refetchInterval? })` and `useTaskContext(id, { refetchInterval? })` take an options object. Copy the `useTask` pattern at `use-tasks.ts:66-78`: spread the key only when it is set.
- The page passes `false` when the task is terminal, using `TERMINAL_STATUSES` from `lib/task-activity.ts`. It passes the same for `useTaskSteeringMessages`.
- Precedent: `components/sessions/chain-of-thought.tsx:101-117`.

### Success Criteria:

#### Automated Verification:
- [x] Unit tests pass: `bun run test:root -- apps/ui/src/lib/slack-text.test.ts apps/ui/src/lib/task-title.test.tsx apps/ui/src/lib/task-events.test.ts apps/ui/src/components/shared/task-status-icon.test.tsx apps/ui/src/components/shared/status-badge.test.tsx`
- [x] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [x] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [x] Playwright task specs pass: `bun run e2e:ui -- specs/tasks.spec.ts specs/smoke.spec.ts`

#### Automated QA:
- [x] QA stack, completed route, 1440x900: the h1 and breadcrumb read "What are the events we support via the extensions of the swarm?". `document.body.innerText` contains no `<@` and no `that's you`.
- [x] QA stack, in-progress route: the computed color of the status badge label equals the computed color of an element with `text-status-active-strong`, in light and dark.
- [x] QA stack, pending and offered routes: the waiting line and its single action render. Screenshot both to `/tmp/task-detail-qa/phase-1/`.
- [x] QA stack, completed route: over 15 s after load, `agent-browser network requests` shows 0 requests to `/session-logs` and `/context`.

#### Manual Verification:
- [x] Taras glances at the Tasks list and kanban: in-progress chips are amber and nothing else changed color.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 1] task page helpers, amber status, waiting states, no polling when finished`.

---

## Phase 2: Desktop frame: two columns, log fills the view, details rail

### Overview

The page switches layout by container width. The wide layout is a scrolling center column, whose log card fills the view under a compact sticky bar, and a single 300 px details rail. The old left rail and the Activity rail are merged into it.

### Changes Required:

#### 1. Container-width layout switch
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- The page root gets `@container`. Replace `lg:hidden` and `hidden lg:grid` (1289, 1328) with `@min-[64rem]:hidden` and `hidden @min-[64rem]:grid`.
- Remove the 3-column grid, the Activity rail collapse toggle, the `?rail=` param and its localStorage key (118-122, 632-664, 1390-1442).
- Remove the "Back to Tasks" button (1273-1282). The breadcrumb links to Tasks.

#### 2. Center column scroll and log sizing
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- Wide grid: `grid-cols-[minmax(0,1fr)_300px]`.
- The center column is the scroll container (`overflow-y-auto`, `[scrollbar-gutter:stable]`). Order: hero, outcome block (failure, then output), attachments, citations, log card, live composer.
- Remove the Output `max-h-48` cap (1376).
- The log card height equals the scroll container height minus the sticky bar height. Measure both into CSS variables with one `ResizeObserver`, or use `container-type: size` on the column with `100cqh`. Then the log fills the view once it is scrolled to. The viewer keeps `className="flex-1 min-h-0"` inside a card of that fixed height.

#### 3. Compact sticky bar
**File**: `apps/ui/src/pages/tasks/[id]/task-sticky-bar.tsx` (new, page-local)
**Changes**:
- An `IntersectionObserver` sentinel at the end of the hero shows a `sticky top-0` bar once the hero leaves the view. The bar holds a one-line title, the status icon, the model, and a primary action slot (filled in phase 4).
- Animate opacity and transform at 150 ms `ease-snappy`. Under reduced motion it is instant.
- Keep the bar mounted and toggle it. Never remount it on poll (dashboard-ui motion rules).

#### 4. Details rail
**File**: `apps/ui/src/pages/tasks/[id]/task-details-rail.tsx` (new, page-local), `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- Sections in order:
  - Summary: Agent, Requested by, Source, "Started {age} · ran {duration}", "Cost $1.21 · 26 turns".
  - Source control: the existing VCS card, when present.
  - Dependencies, when present.
  - Context: the bar plus "86.7K of 1M tokens" and "peak N%".
  - Activity: phase 1 words.
  - Technical details: a `CollapsibleSection`, `persistKey="tasks:technical-details-open"`, collapsed by default.
- Technical details contains Task id and Session (each with a copy button, using `hooks/use-copy-to-clipboard.ts`), Version, API key, Harness (provider · variant · version · transport), the token and cache breakdown, the context formula, Parent, Dir, Workflow, type, priority, source and effort.
- Labels are 12 px. Values are 13 px mono with `tabular-nums`.
- Cost uses one format: `formatCost(x, { precision: 2 })`, with a 4-decimal tooltip.
- The narrow layout's Details tab renders the same component.
- Delete the page-local `MetaRow`, `RailHeading`, `TaskCostSection` and `TaskContextSection` once they are unused.

#### 5. Playwright updates
**File**: `packages/ui-e2e/specs/codex-logs.spec.ts`
**Changes**:
- Update the context assertions (209-240): "191.5K / 1.1M" becomes the new "of … tokens" text.
- Update the "18%" count to match the new rail.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [x] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [x] Unit tests pass: `bun run test:root -- apps/ui/src/lib apps/ui/src/components/shared`
- [x] Playwright passes: `bun run e2e:ui -- specs/tasks.spec.ts specs/codex-logs.spec.ts specs/smoke.spec.ts`

#### Automated QA:
- [x] QA stack, completed route, 1440x900 and 1366x768: after the center column is scrolled to the log card, the log scroll viewport is at least 70% of the window height. Record the numbers next to the audit baseline (301 px and 169 px). Measured: 681 px (75.7%) at 1440x900, 549 px (71.5%) at 1366x768.
- [x] At scroll 0 the answer card is fully above the fold at 1440x900. The sticky bar is hidden at scroll 0 and visible after scrolling past the hero.
- [x] 1280x800 (content under 64rem) renders the tabs layout. 1440x900 renders two columns.
- [x] No document horizontal overflow at 1024, 1280, 1366, 1440 and 1920 widths.
- [x] In-progress route: the log still sticks to the bottom when new rows arrive. Post 5 lines with `POST /api/session-logs` (see `graft.ts`) while the page is open. Then scroll up and confirm the "N new" pill appears.
- [x] The rail shows "Requested by" in full. Technical details starts collapsed and contains Session, Version and API key.
- [x] Screenshots of completed, in-progress and failed at 1440 and 1366, light and dark, in `/tmp/task-detail-qa/phase-2/`.

#### Manual Verification:
- [x] Taras reviews the 1440 light and dark screenshots for feel: rail density, sticky bar, scroll handoff from the column to the log. (2026-10-05: the review found a double scroll, column plus log card. Phase 2b replaces the nested scroll. Taras approved phase 2b.)

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 2] task page two-column frame, log fills the view, details rail`.

---

## Phase 2b: Single scroll: the log flows in the page scroller

### Overview

Added 2026-10-05 after the phase 2 review. Taras saw two scrollers on the desktop page: the center column and the log card. Wheeling over the log moved the log first, so getting back to the hero meant scrolling the whole log. Taras chose a true single scroll. This reverses the original "the viewer keeps its own scroller" decision.

The center column (wide) and the narrow root (phase 5) are the only scrollers. The log card has no inner scroller on the task page. Other viewer callers keep their own scroller.

### Changes Required:

#### 1. External scroller mode in the viewer
**File**: `apps/ui/src/components/shared/session-log-viewer.tsx`
**Changes**:
- New optional prop `scrollElement?: HTMLElement | null`. Without it, the viewer behaves exactly as today (`components/sessions/task-detail-sheet.tsx` and any other caller).
- With it ("page mode"):
  - The body has no `overflow-y-auto` and no fixed height. Rows flow at their natural height inside the page scroller.
  - The card uses `overflow-clip`, not `overflow-hidden`. `overflow-hidden` makes the card the containing block for `sticky` children, so the sticky toolbar would not stick.
  - The virtualizer uses `getScrollElement: () => scrollElement` and a `scrollMargin` equal to the content top's offset inside the scroller. Re-measure the offset with a `ResizeObserver` on the scroller content, because the hero and the outcome block change height. Rows translate by `vi.start - scrollMargin`.
  - "At the end" means the bottom of the log content is within 72 px of the scroller's visible bottom. Compute it from bounding rects on the scroller's `scroll` event. The pill, the follow mode and the stagger all read this.
  - No initial pin. The page opens at the top, with the hero and the answer in view. Follow mode starts only when the user reaches the end of the log.
  - `stickToBottom` scrolls the page scroller to its bottom. The virtualized path keeps its `scrollToIndex` step first.
  - `jumpTo` (minimap) keeps `scrollToIndex` and `scrollIntoView`. Both work with the external scroller.
  - The toolbar (view tabs and filter) is `sticky` under the page's sticky bar. The page passes the offset as a CSS variable (`--log-sticky-top`).
  - The minimap rail is `sticky` at the same offset, with a height of the scroller's visible height minus that offset.
  - The "N new" pill is `sticky bottom-4` and shows only while the log is in view and not at the end.
  - The footer ("Agent is working…") is `sticky bottom-0` while the task runs.

#### 2. Task page wiring
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`, `apps/ui/src/pages/tasks/[id]/task-sticky-bar.tsx`
**Changes**:
- Pass the center column element (wide tree) to the viewer as `scrollElement`. Use a callback ref held in state, so the viewer re-renders once the element exists.
- Remove the phase 2 log sizing: the `[container-type:size]` / `100cqh` card height and the fixed-height log region.
- The live steer composer sits after the log, `sticky bottom-0` in the column.
- The sticky bar publishes its height as `--log-sticky-top` on the column.
- Clicking the sticky bar title scrolls the column to the top.
- The narrow tree keeps its phase 2 behavior until phase 5 wires it to the narrow root scroller.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [x] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [x] Unit tests pass: `bun run test:root -- --parallel=4 apps/ui/src/lib apps/ui/src/components/shared apps/ui/src/components/sessions`
- [x] Playwright passes: `bun run e2e:ui -- specs/tasks.spec.ts specs/codex-logs.spec.ts specs/smoke.spec.ts`

#### Automated QA:
- [x] Completed and in-progress routes at 1440x900 and 1366x768: inside `main`, the center column is the only element with `scrollHeight > clientHeight` and `overflow-y: auto|scroll`. The log card has no inner scroller. Measured (2026-10-05): the log card has 0 inner scrollers in all 4 cases, before and after a wheel scroll. The column is the only scroller in 3 of 4 cases. At 1366x768 on the in-progress route, the details rail (`aside`, phase 2) also overflows by 8 px (720 vs 712), so it scrolls on its own. Taras accepted the rail's own scroll on 2026-10-05: it is a sibling column, not nested in the content.
- [x] Completed route at 1440x900: at scroll 0, the answer card is fully above the fold. After scrolling to the end of the column, the last log row and the footer are visible. Wheel events over the log scroll the column (dispatch `agent-browser scroll` with the pointer over the log, then compare `scrollTop` on the column). Measured: answer card 250..362 px of 900. At the end, the last row ends at 791 px and the footer is at 791..831 of 844. A trusted CDP wheel of 600 px at (676, 650) over the log moved the column from 0 to 600 (agent-browser 0.38.1 `mouse wheel` fires at (0, 0), so the QA used CDP `Input.dispatchMouseEvent`).
- [x] The log toolbar stays under the sticky bar while the log scrolls past. Typing in the filter keeps the toolbar in place. Measured: bar 0..44 px, toolbar 44..97 px mid-log and at the end (1440 and 1366). Typing "thought" one key at a time, and filtering to 5 rows, kept the toolbar at 44 px.
- [x] Virtualized path: post 100 lines to the in-progress task, so it passes `VIRTUALIZE_THRESHOLD` (120 rows). Scroll the column through the whole log: no blank gaps and no overlapping rows. A minimap jump lands on the row and flashes it. Measured: 163 rows, 29 to 52 rendered. 0 gaps, 0 overlaps and full coverage of the visible band at 31 forward steps, 8 backward steps and 7 wheel steps. Jumps to rows 120 and 100 landed centered (row center 422 of 844 px) with `sl-flash`.
- [x] Live tail on the in-progress route: at the end of the column, 5 new lines keep the view at the end. Scrolled up, 5 new lines show the "5 new messages" pill, and clicking it lands at the end. Passed on the non-virtualized (53 rows) and the virtualized (163 rows) log, with the steer composer on (stats mocked in the QA session).
- [x] The Sessions page detail sheet (`task-detail-sheet.tsx`) still uses its own inner log scroller. Measured: the viewer body keeps `overflow-y-auto overflow-x-hidden [overflow-anchor:none]` and the card keeps `overflow: hidden`. As on main, that body grows to its content inside the sheet's own scroller.
- [x] Screenshots and a short recording of scrolling from the hero through the log and back in `/tmp/task-detail-qa/phase-2b/`.

#### Manual Verification:
- [x] Taras scrolls the completed and in-progress routes at 1440: one scroll, the toolbar sticks, and the way back to the hero is easy.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 2b] task page single scroll: the log flows in the page scroller`.

---

## Phase 3: Hero: readable title, source line, full prompt dialog, chips

### Overview

The hero shows the question, where it came from, and three chips. The raw prompt moves into a "View full prompt" dialog.

### Changes Required:

#### 1. Title and source line
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx` (`TaskHeading`), `apps/ui/src/pages/tasks/[id]/task-source-line.tsx` (new, page-local)
**Changes**:
- The title is the phase 1 `taskListTitle`, styled `text-lg font-semibold text-balance line-clamp-2`. Show the full text in a tooltip when it is clamped.
- The source line shows one of:
  - Slack: the `BrandLogo` Slack mark (`public/integration-logos/slack.svg`), the speaker from `parseSlackPrompt` (fallback: the requester's name), and "{n} earlier messages" when there is thread context.
  - GitHub or GitLab: the provider icon, the repo, and the `#number` link (from the VCS fields).
  - Schedule, workflow, API or UI: an icon and a label.
- A "View full prompt" ghost button opens a `Dialog`. It shows the thread messages as a quoted list (bold speaker, formatted text), the ask as `MarkdownView`, and "Copy prompt".
- Remove `CollapsibleDescription` from the hero (1202-1209).

#### 2. Chip row
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx` (1112-1201)
**Changes**:
- Chips: `StatusBadge`, then `ModelLabel` in an outline chip, then an agent chip (initial avatar and name, linked to `/agents/{id}`).
- The model chip is focusable. Its tooltip shows `describeModelResolution` lines plus the exact model id.
- The model chip and the sticky bar show the effort signal icon (`ReasoningEffortIcon`) when the task sets an effort other than "off". The tooltip names the level. (Taras, 2026-10-05.)
- Tags render as plain muted text with a tag icon, not chips.
- Remove the provider badge and the `+N` popover. Their fields are already in Technical details (phase 2).

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [x] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [x] Unit tests pass: `bun run test:root -- apps/ui/src/lib/slack-text.test.ts apps/ui/src/lib/task-title.test.tsx`
- [x] Playwright passes: `bun run e2e:ui -- specs/tasks.spec.ts specs/codex-logs.spec.ts`

#### Automated QA:
- [x] Completed route: the source line reads "Taras · 3 earlier messages" with the Slack mark. "View full prompt" opens a dialog with 3 quoted thread messages and the ask. Escape closes it and returns focus to the button. Measured (2026-10-05): visible line "Taras · 3 earlier messages · View full prompt", mark `integration-logos/slack.svg`. Screen readers also get "Slack:" (sr-only), because the mark is decorative. The dialog has 3 `blockquote`s (Taras, Lead, Taras), a "Taras asked" section with the ask, and no Slack tokens. After Escape, `document.activeElement` is the visible "View full prompt" button.
- [x] No visible text contains `<@`, `(that's you)` or `<thread_context>` (check `document.body.innerText`) on the completed, in-progress and failed routes. Measured: false for all three tokens on all three routes. Also clean on pending, offered and draft.
- [x] Tabbing to the model chip shows the tooltip with `claude-opus-5-5`. Measured: one Tab from "View full prompt" focuses the chip (visible ring). The tooltip reads "claude-opus-5-5 / Requested: opus / Chosen by: agent".
- [x] At 390x844 the hero (title, chips and source line) is at most 220 px tall on the completed route. Screenshot to `/tmp/task-detail-qa/phase-3/`. Measured: 150 px (title 50, source line 24, chips 56 on two rows), light and dark. The tab list now starts at 259 px (audit baseline: 410). No horizontal overflow.

#### Manual Verification:
- [x] Taras checks the hero against the P2 wireframe in `/tmp/task-audit/wireframes/index.html`.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 3] task page hero: readable title, source line, full prompt dialog`.

---

## Phase 4: Next actions: shared composer, Retry, spawned tasks, failed state

### Overview

Every status gets its actions:
- Finished tasks get Follow up through the shared Sessions composer (same agent, with attachments), Copy answer, Retry, and a spawned-tasks list.
- Failed tasks get an open error callout with Retry instead of the auto-opening dialog.

### Changes Required:

#### 1. One shared composer
**File**: `apps/ui/src/components/sessions/session-composer.tsx` becomes `apps/ui/src/components/shared/task-composer.tsx`, its test moves with it, and `apps/ui/src/components/sessions/session-conversation.tsx` updates its import
**Changes**:
- Generalize `SessionComposer` in place into `TaskComposer`. There is one component and no wrapper. New props:
  - `targetTask`: the task to steer or follow up.
  - `canSteer: boolean`: the caller decides. Sessions keeps the lead-only, live-status rule (`session-composer.tsx:135-141`). The task page uses any assignee with status `in_progress`, `pending` or `paused`.
  - `followUpAgentId?: string`: Sessions passes nothing, so it still routes to the Lead. The task page passes `task.agentId` and sends `routingReason: "continuity"`, which `POST /api/tasks` requires with `agentId` (`src/http/tasks.ts:295-303`).
  - `placeholder?`.
  - `onCreated?(task)`.
  - Optional controlled `value` and `onValueChange`, so the page keeps one draft across its two layout trees (`page.tsx:618-623`).
- Attachments stay on for both callers, using the existing upload-after-create path.
- Query invalidation adds `["task", targetTask.id]` and `["session", targetTask.id]` next to the session keys.
- In `SteerComposer`, a "promoted" result toast gets an "Open" action that links to `promotedTaskId`. Today that id is dropped (`steer-composer.tsx:73-84`).

#### 2. Task page actions
**File**: `apps/ui/src/pages/tasks/[id]/task-actions.tsx` (new, page-local), `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- Status-aware actions, rendered in the hero and in the sticky bar's primary slot:
  - `completed`: Follow up (primary; scrolls to and focuses the composer), Copy answer (ghost; copies the structured `output` field or the raw output), and a "..." `DropdownMenu` with Retry and Copy task id.
  - `failed`, `cancelled`, `superseded`: Retry (primary). Failed also gets Copy diagnostics (reuse `buildDiagnostics` from `components/support/task-failure-help-dialog.tsx`). The "..." menu has Copy task id, plus Get help for failed tasks.
  - `in_progress`: Pause, Cancel (the existing `AlertDialog`), and a "..." menu with Copy task id.
  - `pending`, `unassigned`, `offered`, `backlog`: Cancel, and a "..." menu.
  - `paused`: Resume and Cancel.
- On finished tasks, the `TaskComposer` renders right under the outcome block. On live tasks it renders under the log, inside the existing `CollapsibleComposerDock`.

#### 3. Retry
**File**: `apps/ui/src/lib/task-retry.ts` (new) with `apps/ui/src/lib/task-retry.test.ts`, `apps/ui/src/api/hooks/use-tasks.ts`
**Changes**:
- `buildRetryInput(task, userId)` returns `{ task: task.task, agentId, routingReason: agentId ? "continuity" : undefined, parentTaskId: task.id, taskType, tags, priority, model, modelTier, effort, requestedByUserId: userId, source: "ui" }`.
  - It uses the requested `model` and `modelTier`, not `resolvedModel`, so the server resolves them the same way.
- `useRetryTask()` calls `api.createTask(buildRetryInput(...))`. On success it navigates to the new task and shows a toast.
- No confirm dialog: Retry does not destroy anything.

#### 4. Spawned tasks and links in the answer
**File**: `apps/ui/src/pages/tasks/[id]/spawned-tasks.tsx` (new, page-local), `apps/ui/src/lib/task-links.ts` (new) with `apps/ui/src/lib/task-links.test.ts`, `apps/ui/src/components/sessions/session-timeline.tsx`
**Changes**:
- `useSession(task.id)` (`api/hooks/use-sessions.ts:50-59`, behind `useFeatureGate("1.76.0")`) gives `chain`. Show the direct children (`parentTaskId === task.id`) and hide auto-review follow-ups.
  - Move `isAutoReview` (`session-timeline.tsx:39-41`) into `lib/task-links.ts` and import it in both places.
- Each row shows `TaskStatusIcon`, the title (`taskListTitle`), the agent and the age, and links to `/tasks/{id}`. Render the section only when it is not empty.
- `linkTaskIds(markdown, ids)` rewrites known task id prefixes (8 or more hex characters, with or without `#`, inside or outside inline code) into markdown links to `/tasks/{fullId}`. The known ids are the chain plus the parent. The answer renders through it.

#### 5. Failed state
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx` (948-962, 1346-1359), `apps/ui/src/components/support/task-failure-help-dialog.tsx`, `apps/ui/src/lib/task-support.ts` and its test
**Changes**:
- Replace both Failure Reason `CollapsibleSection`s with one open `AlertCallout tone="error"`:
  - Title: "Failed after {duration}". Use `createdAt` to `finishedAt`, or the cost duration.
  - Body: `MarkdownView` in `text-foreground`.
  - An action row with Retry, Copy diagnostics and Get help.
- `TaskFailureHelpDialog` becomes controlled (`open`, `onOpenChange`). It never opens on its own. `shouldShowTaskFailureHelp` decides only whether "Get help" shows.

### Success Criteria:

#### Automated Verification:
- [ ] Unit tests pass: `bun run test:root -- apps/ui/src/lib/task-retry.test.ts apps/ui/src/lib/task-links.test.ts apps/ui/src/lib/task-support.test.tsx apps/ui/src/components/shared/task-composer.test.tsx`
- [ ] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [ ] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [ ] Sessions composer specs still pass: `bun run e2e:ui -- specs/composer-enter-key.spec.ts specs/prompt-attachments.spec.ts specs/tasks.spec.ts`

#### Automated QA:
- [ ] QA stack, with `STEERING_ENABLED` turned on for the throwaway API (see the QA doc):
  - Completed route: type a follow-up, attach a small text file, and Send.
  - `GET /api/tasks/{newId}` shows `parentTaskId` = the completed id, `agentId` = the completed task's agent, and the attachment.
  - The toast's Open link navigates to the new task.
  - The spawned list shows the new task within 10 s.
- [ ] Failed route: no dialog opens on load. The reason is visible. Get help opens the dialog.
  - Retry creates a task with the same prompt, agent, model and `parentTaskId` = the failed id, then navigates to it.
- [ ] In-progress route: a queued steer message still appears in the log as a steering row.
- [ ] Sessions page: start a session, send a follow-up. The new task has no `agentId` override (it routes to the Lead), the same as before.
- [ ] Screenshots of completed (actions and composer), failed, and in-progress at 1440 in `/tmp/task-detail-qa/phase-4/`, plus a recording of the follow-up flow (`agent-browser record start ... --cursor`, sped up 1.5x per LOCAL_TESTING.md).

#### Manual Verification:
- [ ] Taras, in the real dev swarm: a follow-up on a Slack-sourced task answers in the same Slack thread (see Manual E2E).

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 4] task page actions, shared composer follow-up, retry, spawned tasks, failed state`.

---

## Phase 5: Narrow and mobile layout

### Overview

Below 64rem of content width:
- The hero scrolls away and the tabs stay sticky.
- Running tasks open on Log and finished tasks on Outcome.
- A bottom bar on every tab holds the composer or Follow up.
- Page controls are at least 44 px tall.

### Changes Required:

#### 1. One scroll for the narrow tree
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx` (1289-1314)
**Changes**:
- The narrow root is its own scroll container. `<main>` does not scroll at `lg+`, but the narrow layout can show at `lg+` widths when the context panel is docked.
- The compact hero contains:
  - A back arrow to `/tasks`.
  - The title, 2 lines.
  - Status and model.
  - The source line.
  - A "..." `DropdownMenu` (44 px trigger) with Pause, Cancel, Retry and Copy task id, by status.
- `TabsList` is `sticky top-0` with a background.
- All panels flow with no inner overflow. The Log tab passes the narrow root scroller to the viewer as `scrollElement` (phase 2b), so the log has no inner scroller. The log toolbar sticks under the sticky tabs.

#### 2. Tabs
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`, `packages/ui-e2e/specs/tasks.spec.ts`, `packages/ui-e2e/specs/codex-logs.spec.ts`
**Changes**:
- Tabs are "Outcome", "Log", "Details", in that order. The `?tab=` values stay `outcome`, `logs`, `details` for URL compatibility.
- Default tab: terminal opens Outcome, `in_progress` and `paused` open Log, pre-start opens Details.
- Update the specs: `getByRole("tab", { name: "Session Logs" })` becomes `getByRole("tab", { name: "Log", exact: true })`.

#### 3. Bottom bar
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- A `sticky bottom-0` bar with `pb-[env(safe-area-inset-bottom)]` shows on every tab.
  - Finished: the `TaskComposer` collapsed to one line, which expands on focus.
  - Live: the steer `TaskComposer`.
  - Pre-start: hidden when there is no action.
- It uses the page-owned draft (phase 4), so switching tabs keeps the text.

#### 4. Touch targets
**File**: `apps/ui/src/pages/tasks/[id]/*.tsx`, `apps/ui/src/components/shared/session-log-viewer.tsx`
**Changes**:
- On the narrow layout, tab triggers, bottom-bar buttons, the "..." trigger and the hero actions are `min-h-11`.
- Add `hit-area` to the small log controls (Raw, Copy, row toggles, "View full prompt"). Check that `hit-area`'s `position: relative` does not fight `absolute` or `sticky` elements (`globals.css:263-276`).

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [ ] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [ ] Playwright passes: `bun run e2e:ui -- specs/tasks.spec.ts specs/codex-logs.spec.ts specs/smoke.spec.ts`

#### Automated QA:
- [ ] QA stack at 390x844, 768x1024 and 1280x800:
  - Completed route: the tab list top is at most 260 px at scroll 0 (audit baseline: 410). After scrolling, the tabs stay at the top.
  - Log tab: the narrow root is the only scroller, and the log rows start right under the sticky tabs (baseline: the log viewport was 30% of the window).
  - In-progress route: it opens on Log, and the bottom-bar composer is visible on all three tabs.
  - A draft typed on Log survives a switch to Details and back.
- [ ] Every interactive element in the page content outside log rows is at least 44 px tall at 390 (eval `getBoundingClientRect`).
- [ ] No horizontal overflow at 390, including the Details tab (audit found 8 px from the sticky Activity heading).
- [ ] Screenshots and a recording of tab switching and the bottom bar at 390 in `/tmp/task-detail-qa/phase-5/`.

#### Manual Verification:
- [ ] Taras on a real phone (iOS Safari): the bottom bar clears the home indicator, and the keyboard does not hide the composer.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 5] task page narrow layout: sticky tabs, bottom composer, 44px targets`.

---

## Phase 6: Log views: Messages and Everything

### Overview

The log viewer gets a Messages and Everything switch. Messages folds tool and thinking runs into one line each and ends with a one-line result marker. Finished tasks default to Messages.

### Changes Required:

#### 1. View switch
**File**: `apps/ui/src/components/shared/session-log-viewer.tsx` (toolbar 2729-2752, props 2145-2163)
**Changes**:
- New props `view?: "messages" | "everything"` and `onViewChange?`.
- A `SegmentedControl size="sm"` (Messages, Everything) replaces the lone "Logs" tab trigger. Keep the `Tabs` wrapper only when subagents exist ("Agents (n)").
- The filter input stays.

#### 2. Messages transform
**File**: `apps/ui/src/components/shared/session-log-messages.ts` (new) with `apps/ui/src/components/shared/session-log-messages.test.ts`, `apps/ui/src/components/shared/session-log-viewer.tsx`
**Changes**:
- `toMessageRows(rows)` is a pure post-build pass over `StreamRow[]`, applied before the text filter in `visibleRows` (2230-2236):
  - It keeps `agent`, `steering`, `subagent` and `compaction` rows.
  - It collapses each run of other rows into one `activity` row: "Ran {n} tools · {duration}", plus thinking time when present. The row expands to render the original rows with their existing renderers.
  - It turns a `result` meta row into one `end` row: "Finished · {cost} · {duration} · {turns} turns", or "Ended with an error · …".
- Stable ids derive from the first collapsed row id. Everything view is unchanged.

#### 3. Defaults and footer
**File**: `apps/ui/src/components/shared/session-log-viewer.tsx` (footer 2933-2962), `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**:
- The page holds the view in the URL param `logView`, through `useUrlSearchState`. Default: terminal opens Messages, otherwise Everything.
- The viewer takes `status`: failed shows "Session ended · failed" with the error tone, and cancelled shows "Session ended · cancelled" with the neutral tone. The green check stays for completed only.
- Other viewer callers (`components/sessions/task-detail-sheet.tsx:167-171`) keep today's behavior through the defaults.

#### 4. Playwright updates
**File**: `packages/ui-e2e/specs/codex-logs.spec.ts`
**Changes**:
- The spec clicks the `e2e-mcp.inspect` tool button. On a finished task, tool rows are folded in Messages. Switch to Everything first, or expand the activity row.

### Success Criteria:

#### Automated Verification:
- [ ] Unit tests pass: `bun run test:root -- apps/ui/src/components/shared/session-log-messages.test.ts src/tests/ui-logs-parser.test.ts`
- [ ] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [ ] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [ ] Playwright passes: `bun run e2e:ui -- specs/codex-logs.spec.ts specs/tasks.spec.ts`

#### Automated QA:
- [ ] QA stack, completed route (48 events): Messages shows at most 14 rows. The final answer text appears once on the page (in the answer card). Expanding an activity row shows its tools.
- [ ] Everything shows the same row count as before this phase (48).
- [ ] In-progress route: it defaults to Everything, and live tailing still works (post lines as in phase 2).
- [ ] `?logView=everything` survives a reload.
- [ ] Screenshots of both views in `/tmp/task-detail-qa/phase-6/`.

#### Manual Verification:
- [ ] Taras reads one real finished task in Messages and confirms nothing important is hidden.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 6] session log Messages and Everything views`.

---

## Phase 7: Accessibility and type scale, then the PR

### Overview

The page gets:
- One `<main>` and a skip link.
- An h1 to h2 heading order.
- A visible focus ring on the log.
- Live status announcements.
- A named 5-step type scale with no arbitrary pixel sizes, and no faded text.

Then the PR goes up with screenshots and a recording.

### Changes Required:

#### 1. Landmarks and skip link
**File**: `apps/ui/src/components/layout/root-layout.tsx`, `apps/ui/src/components/ui/sidebar.tsx` (295-307)
**Changes**:
- Add a "Skip to content" link, visible on focus, that targets `#main-content`.
- `SidebarInset` renders a `<div>` instead of a `<main>`, so the page has one `<main>`. `smoke.spec.ts` uses `locator("main").first()`, which still matches.

#### 2. Headings, focus, live status
**File**: `apps/ui/src/pages/tasks/[id]/*.tsx`, `apps/ui/src/components/shared/session-log-viewer.tsx`
**Changes**:
- The title is the only h1. Use h2 for Outcome, Spawned tasks, Log and the rail sections, with the same visual style. No h4 remains.
- The log scroller gets `tabIndex={0}`, `aria-label="Session log"` and a `focus-visible` ring. Fix the `outline-none` Logs tab panel.
- The footer state text gets `role="status" aria-live="polite"`.

#### 3. Type scale
**File**: `apps/ui/src/styles/globals.css` (`@theme`), `apps/ui/src/pages/tasks/[id]/*.tsx`, `apps/ui/src/components/shared/session-log-viewer.tsx`, `apps/ui/src/components/steering/collapsible-composer-dock.tsx`, `apps/ui/DESIGN.md`
**Changes**:
- Add `--text-data` (0.8125rem, 13 px) and `--text-meta` (0.6875rem, 11 px) to `@theme`. This creates the utilities `text-data` and `text-meta`.
- Replace every `text-[Npx]` in these files with `text-lg`, `text-sm`, `text-data`, `text-xs` or `text-meta`.
  - The status chip on this page may stay 10 px uppercase.
- Remove the opacity modifiers on text (`/60`, `/75`, `/80`, `/85`). Use `text-muted-foreground`.
- Numbers use `font-mono tabular-nums`.
- Document the named scale in DESIGN.md §3 Typography.

#### 4. PR
**Changes**:
- Push the branch.
- Write the PR body from `.github/pull_request_template.md` and check it with `bun scripts/check-pr-body.ts --title "<title>" --body-file /tmp/pr-body.md`.
- Attach screenshots (1440 and 390, light and dark: completed, in-progress, failed) and recordings (follow-up flow, mobile tabs), uploaded with `agent-fs write` and linked with `agent-fs signed-url --expires-in 604800`.

### Success Criteria:

#### Automated Verification:
- [ ] No arbitrary font sizes remain: `grep -n "text-\[[0-9.]*px\]" apps/ui/src/pages/tasks/\[id\]/*.tsx apps/ui/src/components/shared/session-log-viewer.tsx apps/ui/src/components/steering/collapsible-composer-dock.tsx` prints nothing.
- [ ] Typecheck passes: `cd apps/ui && bunx tsc -b`
- [ ] Lint and token gate pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [ ] All unit tests pass: `bun run test:root -- --parallel=4`
- [ ] Full Playwright suite passes: `bun run e2e:ui`
- [ ] The PR body check passes: `bun scripts/check-pr-body.ts --title "<title>" --body-file /tmp/pr-body.md`

#### Automated QA:
- [ ] Contrast sweep (the method from audit B) over the page in light and dark, on the completed, in-progress and failed routes: no text style is under 4.5:1.
- [ ] No visible page text is under 11 px, except status chips at 10 px.
- [ ] Keyboard from page load: the first Tab focuses "Skip to content", and Enter moves focus to `#main-content`. The log scroller shows a visible ring on focus.
- [ ] The heading list in DOM order starts with the h1 title, with no level skip. The page has exactly one `main` landmark.
- [ ] Re-run `/impeccable critique apps/ui/src/pages/tasks/[id]/page.tsx` and `/impeccable audit` and record the scores. Baseline: 20/40 and 12/20.

#### Manual Verification:
- [ ] Taras reviews the PR screenshots and recordings, then merges.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 7] task page a11y and type scale`, and open the PR.

---

## Manual E2E

Run this against a real local swarm with a real worker after phase 7.

```bash
# 1. Stop anything on 3013/5274 that is not this branch first (another worktree may hold them).
lsof -nP -iTCP:3013 -sTCP:LISTEN; lsof -nP -iTCP:5274 -sTCP:LISTEN

# 2. Real stack (API 3013, UI 5274, lead 3201, worker 3202)
bun run docker:build:worker && bun run pm2-start

# 3. UI task: create from the dashboard, then open /tasks/<id>
open http://localhost:5274/tasks
```

- **Live task:**
  - Watch the log fill the view at 1440 and at 390.
  - Send a queued steer message.
  - Pause and resume.
- **After it completes:**
  - Follow up with one attachment. The new child task goes to the same agent and shows under "Spawned tasks".
  - Run Retry and check the clone.
- **Failed task:** kill the worker mid-task (`bun run pm2-stop`, or stop the worker container). The failure callout shows with Retry, and no dialog opens.
- **Slack:** trigger a task from the dev Slack channel with the Slack MCP:
  - Send `slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> what events do extensions support?")`.
  - Open the task. The title shows the question without mention tokens.
  - Send a follow-up from the dashboard. The answer posts in the same Slack thread.
- **Cleanup:** `bun run pm2-stop`.

---

## Appendix

- **Follow-up plans (not in scope)**:
  - A server task-retry endpoint (MCP and agent use).
  - Expose a Slack permalink and channel name for "Open Slack thread".
  - A `parentTaskId` filter on `GET /api/tasks`.
  - Raise Badge `size="tag"` from 9 px app-wide.
  - Keyboard shortcuts on the task page.
- **Derail notes**:
  - `useSession` keeps polling every 10 s after a chain settles, by design (`use-sessions.ts:55-57`). The spawned list inherits this, which is fine because children can join late.
  - `cancelled` is error-red in Activity but neutral in `TaskStatusIcon`. Phase 1's label map should pick neutral, matching the badge.
  - `.impeccable/` is untracked and not ignored. Decide whether to gitignore it.
- **References**:
  - Critique snapshot: `.impeccable/critique/2026-10-05T10-22-58Z__apps-ui-src-pages-tasks-id-page-tsx.md`
  - Wireframes and decisions: `/tmp/task-audit/wireframes/` (`SPEC.md`, `index.html`, `decisions.json`)
  - Audit evidence: `/tmp/task-audit/A/` (design review), `/tmp/task-audit/B/` (measurements)
  - QA stack: `thoughts/taras/qa/2026-10-05-task-detail-qa-stack.md`
  - Rules: `apps/ui/CLAUDE.md`, `apps/ui/DESIGN.md`, `.claude/skills/dashboard-ui/SKILL.md`

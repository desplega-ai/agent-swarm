---
id: step-9
name: UI steer composer + status rendering
depends_on: [step-1]
status: done
completed_at: 2026-07-27
---

# step-9: UI — task-detail steer composer + SessionComposer toggle

## Overview

Adds the first free-text input affordance to the task detail page, extends `SessionComposer` with an explicit Queue/Interrupt toggle, and renders steering-message lifecycle status off the existing REST polling. Decision 14: the toggle is explicit with **Queue preselected**; decision 6: the composer steers when the session's latest **lead** task is `in_progress`, otherwise falls back to today's chained-task behavior.

**This step owns `apps/ui/**`.** Consumes step-1's `POST /api/tasks/{id}/steer`, `GET /api/tasks/{id}/steering-messages`, and the derived `isLeadTask` field.

## Changes Required:

#### 1. API client + hook
**Files**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/hooks/use-tasks.ts`, `apps/ui/src/api/types.ts`
**Changes**:
- `client.ts`: add `steerTask(id, { message, mode, requestedByUserId })` following the `cancelTask` template (`:365-377`) — `POST /api/tasks/:id/steer` with a JSON body, reusing `getHeaders()` (`:182-191`) and `getBaseUrl()` (`:193-199`), non-ok → parse `{error}` → throw. Add `getTaskSteeringMessages(id)` for the read side.
- `use-tasks.ts`: add `useSteerTask` modelled on `usePauseTask` (`:322-358`) — same `onMutate` / `onError` / `onSuccess` / `onSettled` structure with `snapshotTaskQueries` (`:194-202`) and `rollbackTaskQueries`. **No `patchTaskStatus`**: steering does not change task status, so there's no optimistic status transition — invalidate the steering-messages query instead. Add `useTaskSteeringMessages(id)` with a 5s `refetchInterval`, matching `useTaskSessionLogs` (`:63-70`).
- `types.ts`: add `SteeringMessage`, `SteerMode`, `SteerOutcome`, and `isLeadTask` on the task type (`:128-172`).

#### 2. Segmented Queue/Interrupt control
**File**: `apps/ui/src/components/ui/` + a shared steer-composer component
**Changes**: There is **no `ToggleGroup` or `RadioGroup` primitive** in `apps/ui/src/components/ui/` today. Do **not** add a new dependency — build the control from two `Button`s toggling `default` / `outline` variants (or `Tabs`/`TabsList`/`TabsTrigger`, both already present), following the existing variant conventions. **Queue is preselected.**

**Decision 16 — never offer a mode the target can't honor.** Read `supportedSteerModes` off the task (step-1 derives it from `PROVIDER_STEER_CAPABILITIES`):
- `"steer"` absent (claude) → render Interrupt **disabled** with a short reason on hover/beneath, e.g. *"Interrupt isn't supported on claude — this will queue."* Do not silently accept the click and downgrade.
- `supportedSteerModes` empty (codex) → hide the toggle entirely and label the send action as queuing a follow-up task, since that's what will actually happen.

Extract the composer (textarea + mode toggle + send) into one shared component used by both surfaces so behavior can't drift.

#### 3. Task detail composer
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx`
**Changes**: The action row is a `<div className="flex items-center gap-1.5 shrink-0">` at `:970`, holding Pause (`:972-980`), Resume (`:983-991`), and an `AlertDialog`-wrapped Cancel (`:994-1020`). Visibility booleans are at `:555-557` (`canPause = task.status === "in_progress"`).

Add a steer composer gated on the **same** `task.status === "in_progress"` condition. Render the steering-message list as its **own section** with per-row status badges (`pending` / `delivered` / `handled` / `promoted` / `cancelled`) — **not** through `SessionLogViewer`, which consumes the shared `src/logs-parser/` normalized IR. Folding steering into that IR is a deliberate non-goal (see root.md derail notes).

#### 4. SessionComposer
**Files**: `apps/ui/src/components/sessions/session-composer.tsx`, `apps/ui/src/pages/sessions/[rootTaskId]/page.tsx`
**Changes**: The composer today takes only `{ rootTaskId, latestLeafTaskId }` (`:20-24`), reads `userId` from `useCurrentUser()` (`:28`), and **always** calls `api.createTask({ parentTaskId: latestLeafTaskId ?? rootTaskId, source: "ui" })` (`:43-48, :70-79`). It has no awareness of task status at all.

- In the page, `latestLeafTaskId` is derived at `:61-65` as the chain entry with max `createdAt`. Extend that derivation to also produce the task's `status` and `isLeadTask`, and thread both down as new props.
- In the composer: when the latest leaf is **both** `isLeadTask` and `in_progress`, show the mode toggle and route `submit()` to `steerTask`. Otherwise keep the existing `createTask` path unchanged (decision 6). Attachment upload (`:49-53`) stays on the `createTask` path only — steering carries no attachments.
- Preserve the existing `disabled={!userId}` behavior (`:98`) and the cache invalidations (`:60-64`), adding the steering-messages key.

#### 5. Version gate
**File**: the new composer entry points
**Changes**: Gate with `useFeatureGate("1.122.0")` (root `package.json` is currently `1.121.1`), following the pattern at `pages/sessions/[rootTaskId]/page.tsx:39, 100-108` — `if (!gate.supported) return <UpgradeRequired ... />`, or simply hide the composer. Bumping `package.json` is **not** part of this step.

### Success Criteria:

#### Automated Verification:
- [ ] UI lint passes: `cd apps/ui && bun run lint`
- [ ] UI typecheck passes (CI uses `tsc -b`, not `--noEmit`): `cd apps/ui && bunx tsc -b`
- [ ] Frozen lockfile install works (UI deps resolve from the root lock): `cd apps/ui && bun install --frozen-lockfile`
- [ ] Root typecheck still passes: `bun run tsc:check`
- [ ] Root suite green: `bun test`

#### Automated QA:
*(Per project convention, skip UI unit-test infrastructure — verify through the browser.)*
- [ ] Agent starts the API and `cd apps/ui && bun run dev` (port 5274; `--port 5275` if taken — check `lsof -i :5274`), creates a long-running task, and captures a screenshot of `/tasks/<id>` while `in_progress` showing the composer with **Queue preselected**
- [ ] Agent sends in Queue mode and captures the status badge progressing `pending → delivered → handled` across the 5s poll
- [ ] Agent sends in Interrupt mode on a supporting provider and captures the result
- [ ] Agent captures a **claude** task showing Interrupt rendered **disabled** with the "will queue" reason, and a **codex** task showing the toggle hidden with the send action labelled as queuing a follow-up task (decision 16)
- [ ] Agent captures `/tasks/<id>` for a `completed` task showing the composer is **absent**
- [ ] Agent captures `/sessions/<rootTaskId>` showing the toggle present when the latest lead task is `in_progress`, and absent (plain send → new chained task) otherwise
- [ ] Agent verifies the feature gate: with a server reporting `< 1.122.0`, the composer does not render

#### Manual Verification:
- [ ] Taras manual-QAs the composer visually — placement, toggle affordance, and whether the steering section reads well next to the activity timeline
- [ ] **Merge-gate requirement**: a `qa-use` session with screenshots is mandatory for any PR touching `apps/ui/`

**Implementation Note**: Vertical slice — two UI surfaces over one shared composer component. Do not touch `src/` (server) — step-1 owns the API. Commit `[step-9] UI steer composer on task detail and sessions`.

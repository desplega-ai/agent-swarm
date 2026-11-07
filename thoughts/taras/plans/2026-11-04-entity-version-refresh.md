# Entity Version Refresh Implementation Plan

## Overview

Show new entity versions in open dashboard views. Default to a notice when a refresh can interrupt active work. Offer a browser-local automatic reload setting. Commit each phase after verification and manual confirmation.

Input: `thoughts/taras/plans-yolo/2026-11-04-entity-version-refresh.md`.

## Current State Analysis

- The page viewer holds metadata indefinitely to avoid interrupting iframe interaction and password unlock (`apps/ui/src/pages/pages/[id]/page.tsx:475`). Its metadata includes a version (`apps/ui/src/api/types.ts:3625`).
- Workflow detail polls through the global query default and renders its own graph (`apps/ui/src/api/hooks/use-workflows.ts:13`, `apps/ui/src/app/providers.tsx:16`). The workflow record has `lastUpdatedAt`, not a version field (`src/types.ts:2739`).
- Comb polls file stat and keys text by revision (`apps/ui/src/api/hooks/use-agent-fs.ts:148`). Its HTML preview remounts on version changes (`apps/ui/src/components/comb/viewers/html-viewer.tsx:65`). Preserve the existing live path and check whether it can interrupt work.
- App definitions poll every 30 seconds (`apps/ui/src/api/hooks/use-apps.ts:20`). Runtime state is dashboard-global and must survive app navigation and definition changes (`thoughts/taras/design-docs/swarm-apps.md:65`).
- `useLocalToggle` provides per-deployment browser persistence and cross-tab updates (`apps/ui/src/hooks/use-local-toggle.ts`).

## Desired End State

A viewer can see that a newer version exists and apply it without a full browser reload. A local setting enables automatic application. Protect unsaved work and preserve authentication. Existing refresh paths continue to work. Do not treat routine runtime data changes as new entity versions.

## Implementation Approach

- Audit each supported surface and its version identity before changing behavior. Identify other versioned detail views and include those with the same interruption problem.
- Reuse existing polling and live events. Separate the latest detected version from the displayed version where a reload can discard interaction.
- Keep the notice and setting accessible and small. Default automatic reload to off. Use a local per-deployment preference, not server configuration.
- Preserve local drafts even when automatic reload is enabled. When a safe application cannot be guaranteed, show the notice until the viewer acts.
- Preserve the app design document invariants, especially app state and definition lifecycle.

## Phase 1: Audit and shared preference

### Overview

Document the actual version source and interruption behavior for pages, workflows, Comb, apps, and other versioned detail views. Add a reusable local preference and update notice only where the audit shows they are needed.

### Changes Required

- Inspect entity hooks, views, version history APIs, and local editing state. Do not use timestamps blindly if they change for unrelated events.
- Reuse `apps/ui/src/hooks/use-local-toggle.ts` where possible. Make the preference available to all affected surfaces and synchronize mounted consumers and browser tabs.
- Add a notice with a manual apply action. Handle repeated updates, route changes, request failures, and unavailable local storage.

### Verification

#### Automated Verification

- [ ] `cd apps/ui && bunx tsc -b`
- [ ] `cd apps/ui && bun run lint`
- [ ] `cd apps/ui && bun run check:tokens`

#### Automated QA

- [ ] Verify preference persistence, cross-tab behavior, and notice behavior in the browser.

#### Manual Verification

- [ ] Taras confirms the setting and notice wording. Commit this phase after confirmation.

## Phase 2: Page and file viewers

### Overview

Apply detected page and file versions without losing protected-page access or uncommitted viewer work.

### Changes Required

- Separate page head detection from the displayed HTML or JSON. Preserve session cookies, password unlock, query parameters, and feedback state. Apply the latest version on demand or automatically when safe.
- Verify Comb text, media, and HTML against external writes. Keep existing live updates where safe. Apply the preference to interruptible content only when the audit establishes a need.
- Cover multiple updates, failed fetches, content type and auth changes, and viewer navigation.

### Verification

#### Automated Verification

- [ ] `cd apps/ui && bunx tsc -b`
- [ ] `cd apps/ui && bun run lint`
- [ ] `cd apps/ui && bun run check:tokens`
- [ ] `bun run e2e:ui`

#### Automated QA

- [ ] Write a page version externally while its viewer is open. Verify notice, manual apply, automatic mode, and protected-page access.
- [ ] Write new Comb text and HTML file versions. Verify content and iframe behavior without a browser reload.

#### Manual Verification

- [ ] Taras confirms the viewer behavior. Commit this phase after confirmation.

## Phase 3: Workflows, apps, and remaining surfaces

### Overview

Show or apply definition changes in workflow and app views while retaining local work and app state. Cover other relevant surfaces found in phase 1.

### Changes Required

- Verify a stable workflow change identity and distinguish local writes from external changes. Preserve graph selections and unsaved inputs.
- Detect app definition changes without conflating them with data refresh. Preserve dashboard-global app state and borrowed definitions.
- Apply the same behavior to other versioned views only when their data and interaction model support it.

### Verification

#### Automated Verification

- [ ] `cd apps/ui && bunx tsc -b`
- [ ] `cd apps/ui && bun run lint`
- [ ] `cd apps/ui && bun run check:tokens`
- [ ] `bun run e2e:ui`

#### Automated QA

- [ ] Change a workflow and an app externally while each view is open. Verify both modes and preservation of local state.
- [ ] Exercise any additional affected view found in phase 1.

#### Manual Verification

- [ ] Taras confirms the interactions. Commit this phase after confirmation.

Include an interaction recording in the PR, uploaded according to `LOCAL_TESTING.md`.

## Manual E2E

Use an isolated local API and test data. Follow `LOCAL_TESTING.md` for credentials and fixture creation. Run these commands from the repository root in separate terminals:

```bash
DESPLEGA_TELEMETRY_ENV=test bun run start:http
cd apps/ui && bun run dev
agent-browser skills get core
AGENT_BROWSER_SESSION=entity-version-refresh agent-browser open http://localhost:5274/pages
AGENT_BROWSER_SESSION=entity-version-refresh agent-browser snapshot
AGENT_BROWSER_SESSION=entity-version-refresh agent-browser close
```

Open a test page, workflow, app, and Comb file. Update each from a second client. Verify the notice and apply action. Enable automatic reload and repeat. Check unsaved work, protected pages, and browser-local persistence. Stop the servers and remove task-owned temporary files after verification.

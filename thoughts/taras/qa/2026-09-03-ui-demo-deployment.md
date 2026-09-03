---
date: 2026-09-03
author: Codex
topic: "Fixed UI demo deployment"
tags: [qa, ui, demo, deployment]
status: pass
environment: local
last_updated: 2026-09-03
last_updated_by: Codex
---

# Fixed UI demo deployment: QA report

## Context

This report validates the fixed API connection, fixed user identity, and demo labeling in the dashboard UI.

The browser checks used the `agent-browser` session `demo-ui-pr` against a local Vite server and isolated API database.

## Scope

### In scope

- Desktop and mobile demo labeling
- Fixed connection and user identity
- Read-only connection settings
- Rejection of URL query overrides

### Out of scope

- Production infrastructure and credential policies
- Server behavior outside the existing HTTP API

## Test cases

### TC-1: Desktop demo presentation

**Steps:**

1. Open the dashboard at a 1280 by 800 viewport.
2. Confirm the diagonal `Live demo` ribbon appears in the upper-left corner.
3. Confirm the ribbon does not obscure the Swarm logo.

**Expected result:** The desktop ribbon remains visible without covering app controls or branding.

**Actual result:** The final ribbon and shifted sidebar brand remain clear and readable.

**Status:** pass

### TC-2: Mobile demo presentation

**Steps:**

1. Open the dashboard at a 390 by 844 viewport.
2. Confirm the sidebar button remains visible and usable.
3. Confirm a compact `Demo` badge identifies the environment.

**Expected result:** Demo labeling remains visible without covering the mobile header.

**Actual result:** The mobile badge replaces the diagonal ribbon and leaves every header control visible.

**Status:** pass

### TC-3: Fixed connection and identity

**Steps:**

1. Open `/settings/connections` with conflicting `apiUrl`, `apiKey`, and `email` query parameters.
2. Inspect the resulting URL and connection card.
3. Inspect connection and identity actions.

**Expected result:** The app removes overrides, retains the deployment values, and exposes no switch or mutation controls.

**Actual result:** The URL returned to `/settings/connections`. `Demo swarm` and `Demo Visitor` remained active.

The page contained zero add, edit, delete, and user-switch buttons. The connection health test remained available.

**Status:** pass

## Edge cases and exploratory testing

- The first desktop capture showed that the ribbon covered the Swarm logo. Demo mode now shifts the expanded sidebar brand right.
- The first mobile capture showed that the ribbon covered header controls. Mobile now uses a compact badge.
- The final browser session reported no page errors.

## Evidence

### Screenshots

- [Initial desktop overlap](./2026-09-03-ui-demo-deployment/screenshots/01-home-demo-left.png)
- [Initial connection page overlap](./2026-09-03-ui-demo-deployment/screenshots/02-readonly-connections.png)
- [Final desktop demo](./2026-09-03-ui-demo-deployment/screenshots/03-home-demo-left-clear.png)
- [Initial mobile overlap](./2026-09-03-ui-demo-deployment/screenshots/04-home-mobile.png)
- [Final mobile demo](./2026-09-03-ui-demo-deployment/screenshots/05-home-mobile-clear.png)
- [Final read-only connection settings](./2026-09-03-ui-demo-deployment/screenshots/06-readonly-connections-final.png)

### Browser assertions

```text
URL: http://127.0.0.1:4698/settings/connections
connectionVisible: true
userVisible: true
lockNoticeVisible: true
addButtons: 0
editButtons: 0
deleteButtons: 0
userSwitchButtons: 0
```

## Issues found

- [x] Desktop ribbon obscured the Swarm logo. Fixed during QA.
- [x] Mobile ribbon obscured header controls. Fixed during QA.

## Verdict

**Status:** PASS

**Summary:** The fixed demo deployment works across desktop and mobile. The UI keeps connection and identity controls locked.

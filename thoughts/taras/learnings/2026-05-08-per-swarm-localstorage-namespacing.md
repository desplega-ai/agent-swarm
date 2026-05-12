---
date: 2026-05-08
topic: "Per-swarm localStorage namespacing for self-hosted apps"
type: pattern
tags: [self-hosted, localstorage, ui, identity, multi-deployment]
captured-during: thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md
---

# Per-swarm localStorage namespacing

## Lesson

Self-hosted apps where one browser may point at multiple deployments (local + staging + prod, or multiple customer instances) must namespace their per-user localStorage state by a **server-issued stable id**, not by URL or hardcoded constants.

Concrete failure mode: a user picks identity `taras` on `localhost:5274`. Then they switch the API URL to a different deployment (different DB, different users table). Without namespacing, `localStorage["agent-swarm-current-user"]` still says `taras` — but `taras` doesn't exist in this swarm's `users` table, so the app misroutes audit/inbox state, or 500s on FK violations.

## Pattern

1. **Server**: extend the existing health endpoint (`/health`) to return a `swarmId: string` field. Backed by a one-row `swarm_metadata` table seeded with `lower(hex(randomblob(8)))` on first migration apply. Allow `process.env.SWARM_ID` override for ops who want a meaningful identifier (e.g. `prod-us-east`).
2. **Client**: namespace every per-user localStorage key by swarmId: `agent-swarm-current-user:${swarmId}`, `agent-swarm-dashboard-view:${swarmId}`, etc.
3. **State machine**: `<CurrentUserProvider>` exposes `state: "pending" | "needs-pick" | "ready"`. `pending` while `useHealth()` is loading. `needs-pick` when no entry for the current swarmId exists (or the stored userId is stale — covers the deleted-user race). `ready` when both resolved.
4. **Multi-tab cohesion**: provider attaches `window.addEventListener("storage", ...)` to react to cross-tab writes without a reload.
5. **Switch detection**: `useHealth` `staleTime` is `30_000` (NOT `Infinity`), so a mid-session URL switch is detected within 30s and the provider re-derives state.

## Precedence rule

`process.env.SWARM_ID` > `swarm_metadata` row. State this explicitly in the docs:
- All replicas pointing at the same DB MUST set the same `SWARM_ID` (or none — they'll all see the same row).
- Changing `SWARM_ID` mid-deployment invalidates all per-swarm localStorage identities (acceptable; users re-pick once).

## When to apply

- Any UI state that's per-user AND meaningful only within a single deployment (identity, inbox-dismiss state, view preferences tied to entity ids, etc.).
- Apps where the API URL can change without a full page reload.

## When NOT to apply

- Truly global UI prefs (theme, language) — namespace by user-account, not deployment.
- Single-tenant SaaS where there's only one deployment per user — overkill.

## Source

`thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md` Phase 1 (`/health` swarmId addition) + Phase 3 (`<CurrentUserProvider>` namespacing).

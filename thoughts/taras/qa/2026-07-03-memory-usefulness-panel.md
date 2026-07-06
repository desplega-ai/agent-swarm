---
date: 2026-07-03T12:45:00Z
topic: "QA — /memory Usefulness panel (Phase 2, memory-retrieval-v2)"
tags: [qa, memory, dashboard, usefulness, DES-639]
status: passed
---

# QA — /memory Usefulness panel (Phase 2, memory-retrieval-v2)

Agent-browser session against a fresh local stack; evidence for the frontend-PR merge gate. Screenshots in `2026-07-03-memory-usefulness-panel/`.

## Setup

- Fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` (port 3013).
- UI: `cd apps/ui && bunx vite --port 5274 --strictPort` (the `dev` script now routes through portless; vite invoked directly to pin 5274).
- Seed (all via API, `Authorization: Bearer 123123` + `X-Agent-ID`):
  - `POST /api/tasks` → task `73edde25-…` (FK target for retrievals/ratings).
  - `POST /api/memory/index` × 3 (sources `manual` / `session_summary` / `task_completion`).
  - `POST /api/memory/search` × 3 with `X-Source-Task-ID` → 3 `memory_retrieval` rows (arm `fts`; no embedding key locally).
  - `POST /api/memory/rate` × 2 (`source: "llm"`) → posterior movement (2/3 moved, 1 above 0.6).
  - `implicit-citation` rating rows × 3 inserted directly via sqlite3 (test fixture — the rater source is deliberately not exposed through the rate API): signals +1, +1, −0.25.
- `GET /api/memory/usefulness?days=7` sanity: volume 3/3/3, byArm `fts` 3 retrievals / 2 cited (67%), citationBySource `manual` 1.0 / `session_summary` 1.0 / `task_completion` −0.25.

## Evidence

- `01-memory-page-usefulness-panel.png` — 1600×1000, panel expanded: 4 tiles (Retrievals 3, Citation rate 67%, Posteriors moved 2/3, Above-0.6 count 1), both charts populated, memory grid + pagination intact below.
- `02-memory-page-full.png` — full-page capture, same state.
- `03-usefulness-collapsed.png` — header toggle collapsed; state persists via `localStorage["memory-usefulness-open"]` (verified `"true"` after re-expand).

## Graceful degradation (observed live)

Before the browser connection was configured, `/api/memory/usefulness` returned 401 → `fetchMemoryUsefulness` returned `null` → the page rendered without the panel and without errors (grid + filters unaffected). This is the same path an older API server (404) takes.

Note: the app's react-query localStorage persister (`agent-swarm-query-cache-v1`) can hydrate a stale `null` for up to the 60s `staleTime` after a server upgrade — the panel then appears on the next refetch. Cosmetic, self-healing.

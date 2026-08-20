# Agent runtime-instances UI QA — 2026-08-19

Branch: `feat/multi-runtime-agent-ui` (issue #1188, follow-up to #1184)
Base: `upstream/main` @ `c85d70b22`

Live run against an isolated stack: scratch DB in `/tmp/agent-swarm-qa-1188`,
API on port 3113 (integrations and the background heartbeat disabled so stale
runtime rows stay visible instead of being swept), Vite dev server on port
5280 proxying to it. All state was created over real HTTP — registration with
runtime identity, agent-scoped `AGENT_MAX_TASKS` via `PUT /api/config`, and
per-runtime credential reports via `PUT /api/agents/{id}/credential-status`
with `X-Runtime-Instance-ID`. The only direct SQLite touch was backdating one
runtime's `last_seen_at` to stage the stale case.

## Automated verification

| Check | Result |
|---|---|
| `bun run test:root` | 7773 pass, 7 skip, 2 fail (pre-existing) |
| `src/tests/multi-runtime-registration.test.ts` | 140 pass (9 new for the read API) |
| `apps/ui` runtime-instances tests (2 files) | 22 pass |
| `bun run lint` | pass (pre-existing internal warning) |
| `bun run tsc:check` | pass |
| `bash scripts/check-db-boundary.sh` | pass |
| `bash scripts/check-api-key-boundary.sh` | pass |
| `bash scripts/check-audit-columns.sh` | pass (50 audited tables) |
| `bun run check:rbac-coverage` | pass (200 non-GET routes) |
| `bun run check:openapi-response-coverage` | pass (351 routes) |
| `bun run check:dep-graph` | pass (0 errors, 12 pre-existing warnings) |
| `bun run docs:openapi` | regenerated, committed |
| `apps/ui`: `lint`, `tsc -b`, `check:tokens` | pass |

The 2 `test:root` failures are the `resource ulimits actually apply…` tests in
`script-workflows-runtime-e2e` and `workflow-executors`; they fail identically
on a pristine `upstream/main` checkout on macOS and touch nothing in this
branch.

## Scenario data

Agent `qa-multi-runtime` with `AGENT_MAX_TASKS = 4` and four runtimes:

| Runtime | reportedSlots | credential report | state |
|---|---|---|---|
| A | 1 | ready | live |
| B | 2 | ready | live |
| C | 1 | waiting | live |
| D | 1 | none (NULL) | stale (`last_seen_at` backdated 10 min, threshold 5) |

Plus agent `qa-zero-runtime` registered before enabling multi-runtime mode, so
it has zero runtime rows.

## 1. Read API

`GET /api/agents/{id}/runtime-instances` returned all four runtimes with the
expected `reportedSlots`, tri-state `credentialReady` (true / false / null),
`staleThresholdMinutes: 5`, and `isLive` false only for the backdated row —
whose `status` was still `active`, confirming the server-side derivation
rather than raw status. The zero-runtime agent returned
`{"runtimeInstances":[],"staleThresholdMinutes":5}`; an unknown agent id
returned 404. `GET /api/agents/{id}` showed `maxTasks: 4` from the policy
mirror.

## 2. Agent detail page

[01-agent-a-runtime-instances.png](screenshots/2026-08-19-agent-runtime-instances-ui/01-agent-a-runtime-instances.png)
— the Runtime instances card on the Profile tab: summary "3 live · 4 slots
reported" (stale runtime's slot excluded), logical task limit "4 concurrent
tasks across all runtimes", and one row per runtime with liveness dot,
LIVE/STALE badge, slot count, READY/WAITING/UNREPORTED credential badge, and
relative last-seen. The stale row shows STALE + "seen 13m ago" while the
sweep hasn't pruned it.

## 3. Logical task limit edit

[02-agent-a-edit-max-tasks.png](screenshots/2026-08-19-agent-runtime-instances-ui/02-agent-a-edit-max-tasks.png)
— pencil opens a bounded number input (1–100) with save/cancel.

[05-agent-a-max-tasks-saved.png](screenshots/2026-08-19-agent-runtime-instances-ui/05-agent-a-max-tasks-saved.png)
— saving 6 through the UI: success toast, limit and Quick Stats capacity
update to 6. Verified server-side that the write landed as the agent-scoped
`AGENT_MAX_TASKS` config row and mirrored into `agents.maxTasks = 6`.

## 4. Empty state

[03-agent-b-empty-state.png](screenshots/2026-08-19-agent-runtime-instances-ui/03-agent-b-empty-state.png)
— zero-runtime agent: the card explains that runtime instances appear when
workers register in multi-runtime mode; the task limit remains visible and
editable. No error styling.

## 5. Narrow viewport

[04-agent-a-narrow.png](screenshots/2026-08-19-agent-runtime-instances-ui/04-agent-a-narrow.png)
— 420px viewport: rows wrap without truncating badges; the card stays
legible.

## Not exercised

- The API error state (server unreachable) is covered by the component test
  (`runtime-instances-section.test.tsx`), not screenshotted.
- Tooltip content (full runtime id, liveness/credential help text) verified in
  component tests; hover states not screenshotted.
- Live 5s polling was implicitly exercised (the page kept refreshing between
  screenshots) but not asserted.

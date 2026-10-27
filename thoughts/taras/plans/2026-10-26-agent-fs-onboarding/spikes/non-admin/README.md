# Spike: non-admin (Requester / Viewer) live 403 matrix

Run on 2026-10-26 (BCN, CET). Checkout: `/Users/taras/worktrees/agent-swarm/2026-10-26-afo-run` at `860dd9cb9` (main, no .env, not edited).
API booted on a free port with a throwaway DB, `RBAC_ENABLED=true`, telemetry env test, all integrations disabled, random API key (never printed).

## What ran

1. `build-matrix.ts` boots the API, creates 4 users via `POST /api/users` (admin by DB trigger default, requester, viewer, plus `other` as foreign task owner), sets roles with `PUT /api/users/{id}/roles`, mints `aswt_` tokens (held in memory only), then calls 63 rows as operator key, admin user, requester, viewer. Fixtures: tasks are created by the operator with `requestedByUserId` so ownership is attributed to the caller (verified: `fixtureOwnerAttributed: true`). Loop order is viewer, requester, admin, operator so a destructive admin call cannot hide a 403.
2. Baseline result: `matrix.md` / `matrix.json` (re-run command below).
3. `apply-fix.py` applies the proposed edits to a scratch `git archive` copy (`/tmp/afo-spike-non-admin-fix`, deleted at the end). `check:rbac-coverage` passes on it. The same script then produced `matrix-after-fix.md` / `.json`. Patch: `route-edits.patch`.

Re-run (implementer, after the real fix): `bun build-matrix.ts <checkout> /tmp/m.md /tmp/m.json`. Diff `/tmp/m.json` against `matrix-after-fix.json`. Cell legend: `403 adm` = admission wall, `403 ses` = session-access wall, other 4xx/5xx = passed admission (handler or empty fixture answered).

## Baseline results (requester / viewer), numbers

63 rows. Requester gets `403 adm` on 39 rows (19 after the fix). Viewer gets `403 adm` on 43 rows (38 after the fix). Operator and admin user get 0 admission 403s.

Dead ends for a Requester (confirmed live): create task (3 variants), cancel, pause, resume, steer, title, session-triage, session-moves, session-moves/prefix, inbox-state upsert and bulk, UI telemetry relay, fs/members/invite, rooms/get, page feedback, create/patch/mint/identity/merge/roles on People, onboarding PUT and memory, config PUT/DELETE, db-query, telemetry enable, memory list/search, app detail (GET, `app.use`), ranking (GET, `config.write.any`).
Works for a Requester: all GETs sampled, promote-draft, attachment upload, share session (`PUT .../shares` 200), favorites, realtime ticket, comb review batch (passes admission, 404 because COMB is off here).
Viewer extra walls: promote-draft, upload, share, comb review batch. Viewer keeps favorites and realtime ticket.

## After the proposed edits

20 rows (25 cells) change, all Requester or Viewer and all `403 adm` to a pass or a session wall:
- Requester: create (plain, follow-up, draft, with `model` override) 201; cancel own 200; steer own 200; title own 200; pause/resume own reach the handler (400, task is pending); session-moves 200, prefix 400 (passed admission); triage 200; inbox-state 200.
- Viewer: triage, inbox-state upsert and bulk, UI telemetry now pass (they hold `favorite.write.own`). Viewer still cannot create, cancel, steer, title or move sessions. Good.
- Foreign tasks: Requester cancel/pause/resume/steer on another user's task moves from `403 adm` to `403 ses`. The session wall holds ownership. Safe.
- Operator and admin columns: zero changes.
- Tests that now fail and must be edited (7 of 38 in rbac-admission, rbac-roles, rbac-admission-e2e): `handleCore admission wiring > flag on requester ...`, `RBAC admission over real HTTP > flag-on admission narrows ...`, and 5 in rbac-roles (`REQUESTER_VERBS`, viewer subset, seed repair tests).

## Exact route-def edits (file:line on main 860dd9cb9)

| # | File:line | Edit | Verb |
|---|---|---|---|
| 1 | `src/http/tasks.ts:281` (createTask, after `session:`) | add `rbac` | `task.create.own` |
| 2 | `src/http/tasks.ts:414` (cancelTaskRoute) | add `rbac` | `task.cancel.own` |
| 3 | `src/http/tasks.ts:690` (pauseTaskRoute) | add `rbac` | `task.action.own` |
| 4 | `src/http/tasks.ts:706` (resumeTaskRoute) | add `rbac` | `task.action.own` |
| 5 | `src/http/tasks.ts:780-782` (updateTaskTitleRoute) | replace `ungated` | `task.action.own` |
| 6 | `scripts/check-rbac-coverage.ts:323,324,327,329` | delete 4 backlog lines | n/a |
| 7 | `src/be/rbac-roles.ts:40` (requester) | append `task.steer.own`, `comb.presence` | n/a |
| 8 | `src/be/rbac-roles.ts:49` (viewer) | append `comb.presence` | n/a |
| 9 | `src/http/sessions.ts:663` (session-triage) | replace `ungated` | `favorite.write.own` (see decision A) |
| 10 | `src/http/sessions.ts:674-678` (`sessionMoveRbac`, shared by moves and prefix) | replace `ungated` object | `task.fs.mutate` |
| 11 | `src/http/inbox-state.ts:~66` (upsertState, has no `rbac` today) | add `rbac` | `favorite.write.own` |
| 12 | `src/http/inbox-state.ts:85` (bulk) | replace `ungated` | `favorite.write.own` |
| 13 | `scripts/check-rbac-coverage.ts:267` | delete `PATCH /api/inbox-state` backlog line | n/a |
| 14 | `src/http/telemetry-ui.ts:35` | replace `ungated` | `favorite.write.own` (decision A) |

All verbs already exist and have live `can()` call sites, so `check:rbac-coverage` still passes (verified: "89 verbs live, 266 non-GET routes"). No new verb is needed. Edits 7 and 8 change the built-in roles on every existing install at next boot (additive only). Full diff: `route-edits.patch`.

## Corrections to the research doc

1. Admin user tokens are NOT unaffected by ownership. An `aswt_` user with the admin role gets `403 ses` on cancel, pause, resume and steer of a task owned by another user (`resolveSessionActor` returns a `user` actor for any `auth.kind==='user'`, `src/http/session-access.ts:35-39`). Only the operator key bypasses. Invited admins therefore cannot manage teammates' tasks. This is existing behavior, but the plan must not promise "admin can cancel anything" for invitees.
2. Research said the cross-user inbox-state risk "needs checking". Confirmed live: after edit 11/12, a requester and a viewer both get 200 on `PATCH /api/inbox-state` with `userId` of ANOTHER user. The handler never compares `body.userId` to the token. Do not ship edits 11 and 12 without a `userId === auth.userId` guard for `auth.kind==='user'` in `src/http/inbox-state.ts`.
3. Research said create-task body clamping is a policy call. Confirmed live: after edit 1 a requester gets 201 with `model: "opus"` plus `allowCustomModel`. No clamp exists.
4. `POST /api/fs/members/invite` returns 500 for operator and admin here (agent-fs not configured), 403 adm for non-admins. Unchanged by the fix.
5. whoami carries no `grants` for any identity (`hasGrants:false` for all four), as the research said.
6. Pause and resume never reached 200: no running task exists without a worker. The matrix proves admission and session pass (400 from the handler), not the transition itself.
7. `GET /api/inbox-state?userId=` was only called with the caller's own id. Whether a requester can read another user's inbox state was not tested.

## Decisions the plan must take

- A. Per-user UI-state verb. The matrix patch reuses `favorite.write.own` (both roles hold it, no new verb, no dead-verb risk). It is a naming smell. The clean alternative is a new verb `ui.state.own` (3 files plus a live `can()` call in the inbox-state handler). Pick one in the plan step.
- B. Add the `userId` guard (correction 2) in the same step as edits 11, 12.
- C. Clamp `agentId`, `model`, `profile`, `effort`, `dir`, `offeredTo` for user callers in the create handler, or accept them (correction 3).
- D. Still dead for Requesters after this fix, by design or follow-up: rooms/get, page feedback, fs/members/invite, memory list/search, app detail, ranking, all People writes, all Settings writes, /setup writes. The UI must hide these (`useCan`), not the server open them.

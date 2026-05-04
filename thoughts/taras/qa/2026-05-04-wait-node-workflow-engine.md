---
date: 2026-05-04
plan: thoughts/taras/plans/2026-05-04-wait-node-workflow-engine.md
qa_by: Claude
status: pass
---

# QA Report — Wait Node

## Environment
- DB: throwaway `/tmp/wait-qa-test.sqlite` (deleted after run)
- Server: `bun run start:http` on `:3419` (env had `PORT=3419` set; default would be `3013`)
- Branch: `workflows-wait-step`
- Commit: `d508797f4f044f2643affe8b5d40901b86ea9116`
- All 50 migrations applied including `049_wait_states` and `050_wait_states_scope`
- Slack/GitHub/Jira/Linear disabled for the run

## Scenarios

### A. Phase 2 — 10s time-wait walkthrough
Status: **PASS**

Workflow: single `wait` node (mode=time, durationMs=10000) → `notify`.

```
A:create  => 201 id=b7ed6d8f-6c5b-4752-b724-e7b9bf9c131b
A:trigger => 201 runId=21b364a0-3d6e-485e-96cb-673be6b60c81
A:t=0.0s   run=waiting   w1=waiting
A:t=2.0s   run=waiting   w1=waiting
A:t=8.0s   run=waiting   w1=waiting
A:t=12.5s  run=waiting   w1=waiting
A:t=14.0s  run=completed w1=completed (nextPort=default) done=completed
```

Final run: `startedAt=2026-05-04T21:40:51.258Z`, `finishedAt=2026-05-04T21:41:03.999Z` → 12.74s end-to-end (10s wait + ~2.7s for next 5s poller tick to pick it up). Step `w1.nextPort=default`, `done` notify ran, run `status=completed`. `context.w1.firedAt` populated.

### B. Phase 3 — event-mode happy path
Status: **PASS**

Workflow: `wait` (mode=event, eventName=`qa.demo.signal`, filter=`{ok:true}`, scope=run) → `notify` on `event` port.

```
B:trigger        => runId=8d2f5908-1afb-4c5c-b3f3-055890589740
B:t=0.0s          run=waiting w1=waiting
B:t=2.0s          run=waiting w1=waiting
B:signal POST /api/workflow-runs/<id>/events { name: 'qa.demo.signal', payload: { ok: true } } => 200 ok
B:t=2.5s (next poll) run=completed w1=completed (nextPort=event) done=completed
```

Resolved <500ms after signal. `context.w1.payload = {ok:true, _runId:"8d2f5908-..."}` (server injected `_runId` for run-scoped match).

### C. Phase 3 — event-mode timeout
Status: **PASS**

Workflow: `wait` (mode=event, eventName=`qa.never.fires`, `timeout: { seconds: 8 }`, scope=run), no signal sent.

```
C:trigger        => runId=e70cc061-d34e-4a97-a88e-466d3c528414
C:t=0..9.0s       run=waiting w1=waiting
C:t=10.0s         run=completed w1=completed (nextPort=timeout) tout=completed
```

Wait fired via the `timeout` port at t≈10s (8s expiry + ~2s poll-tick lag, within the 8–13s allowance). `tout` notify executed; `never` branch did not.

Note: the wait config schema uses `timeout: { seconds: N }`, NOT `timeoutMs: N` — my first attempt at this scenario silently never timed out because `timeoutMs` was an unknown field (not validated as required → no `expiresAt` set). Worth a glance: the run-scoped event signal endpoint and the executor both ignore unknown body fields. The test on the **second** attempt with the correct schema passed cleanly.

### D. Phase 4 — built-in `task.completed` (degraded — fired via `/api/workflow-events`)
Status: **PASS (degraded)**

Real `agent-task` spawn requires a worker container, so I simulated the bus event by POSTing the global event endpoint. Workflow: single `wait` (mode=event, eventName=`task.completed`, scope=`global`) → `notify` on `event` port. Used `scope: global` because the run-scoped path injects `_runId` server-side; built-in events from `src/be/db.ts` carry `workflowRunId` (the resume matcher in `workflows/resume.ts` accepts either).

```
D:trigger          => runId=2814459a-7984-4386-9cf0-f4203ddc4fb2
D:t=0..1.5s         run=waiting w1=waiting
D:signal POST /api/workflow-events { name:'task.completed', payload:{ workflowRunId:<runId>, taskId:'fake-task-id', status:'completed' } } => 200 ok
D:t=2.0s            run=completed w1=completed (nextPort=event) done=completed
```

`context.w1.payload` carries the full task-completed payload including `workflowRunId`.

Note: full fan-out flow (real `agent-task` finishing → built-in `task.completed` bus emit → wait resume) is already covered by `src/tests/workflow-wait-builtin-events.test.ts`. This walkthrough verified the HTTP signal-injection path and the `event`-port resolution against a live server, which the unit test does not exercise.

## Skipped
- **Phase 2 long-wait persistence (60s + pm2-restart)** — covered by `src/tests/workflow-wait-recovery.test.ts` (inserts a past-`wakeUpAt` row, calls `recoverIncompleteRuns`, asserts resume). Live walkthrough would require restarting the user's PM2 stack which is destructive (`cope-*` services running).

## Findings
- All four live walkthroughs passed against a real HTTP server with a clean DB. End-to-end timings match the documented 5s wait-poller granularity.
- Wait-poller resolution drift: time-mode and event-mode-timeout both add ~2–4s of poll-tick lag on top of the configured duration. Documented behavior; not a bug.
- Schema gotcha: event-mode timeout field is `timeout: { seconds: N }`, not the more obvious `timeoutMs: N`. Workflow-create accepted my malformed config without complaint — I'd expect the strict zod schema to reject unknown fields. Worth a follow-up to either rename for consistency with `durationMs` (time mode) or pass-through validate. Low priority; tests + docs use the correct shape.
- `/api/workflow-runs/{id}` returns `{ run, steps }` (top-level `status` is on `run.status`, not on the response root). Plan walkthrough text loosely says "step status = waiting" which is fine, but anyone scripting against this endpoint should remember the wrapper.
- Run-scoped signal endpoint (`POST /api/workflow-runs/{runId}/events`) injects `_runId` automatically — confirmed by `context.w1.payload._runId` in scenario B.
- Global signal endpoint (`POST /api/workflow-events`) emits the raw payload — confirmed working for built-in-style `task.completed` events with payload `workflowRunId`.

## Cleanup performed
- Bun server (PID 34673) killed via `pkill -f "DATABASE_PATH=/tmp/wait-qa-test"` — exit 144 is the expected SIGTERM result.
- `/tmp/wait-qa-test.sqlite{,-wal,-shm}` deleted.
- User's PM2 stack untouched.
- `/tmp/wait-qa-server.log` left in place as evidence (14KB, harmless).

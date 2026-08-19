# Multi-runtime QA — 2026-08-19

Branch: `feat/multi-runtime-capacity` (PR #1184)
Commit tested: `78c1a37c8` (merged with `upstream/main` @ `b673bdf14`)

Live run against an isolated server: scratch DB at `/tmp/mrqa/qa.sqlite`, port
13901, integrations and the background heartbeat disabled so sweeps are
triggered explicitly. `RUNTIME_STALE_THRESHOLD_MIN=1` for the multi-runtime
runs. Registration, ping, close, poll, task creation, session creation and
sweeps all went over real HTTP; SQLite queries are used only to observe state.

## Automated verification

| Check | Result |
|---|---|
| `bun run test:root` | 7631 pass, 7 skip, 2 fail |
| `src/tests/multi-runtime-registration.test.ts` | 68 pass |
| `bun run lint` | pass (1 pre-existing warning) |
| `bun run tsc:check` | pass |
| `bash scripts/check-db-boundary.sh` | pass |
| `bash scripts/check-api-key-boundary.sh` | pass |
| `bash scripts/check-audit-columns.sh` | pass (50 audited tables) |
| `bun run check:rbac-coverage` | pass (200 non-GET routes) |
| `bun run check:openapi-response-coverage` | pass (349 routes) |
| `bun run check:dep-graph` | pass (0 errors, 12 pre-existing warnings) |
| `bun run docs:openapi` | regenerated, committed |
| `apps/ui`: `lint`, `tsc -b`, `check:tokens` | pass |

The 2 failures are the `resource ulimits actually apply…` tests in
`script-workflows-runtime-e2e` and `workflow-executors`; they fail identically
on a pristine `upstream/main` checkout on macOS and touch nothing in this
branch.

Migration applied cleanly to a fresh database and to one built from current
pre-feature main carrying an existing lead and session row: the column is
added, `runtimeInstanceId` is NULL on the pre-existing session, `maxTasks`
survives, and `_migrations` holds a single row for version 132.

## 1. Default mode — `MULTI_RUNTIME_ENABLED=false`

One worker registered with `maxTasks: 3` while also sending a runtime id.

- Registration returned the agent `idle` with `maxTasks = 3` — legacy
  write-through intact.
- `runtime_instances` stayed empty: the id was ignored, as intended.
- `POST /ping` → 204; `POST /close` → 204 and the agent went `offline`.

## 2. Multi-runtime registration

One `AGENT_ID`, two runtimes (A reporting 1 slot, B reporting 2).

```
runtimes: [{id:8D89CAF1, status:active, slots:1},
           {id:DDF5B082, status:active, slots:2}]
agents.maxTasks:     1
AGENT_MAX_TASKS row: 1
```

Both are tracked as distinct live runtimes. B's higher reported capacity did
not overwrite the logical policy established at first registration.

## 3. Concurrent capacity

Two tasks offered to the agent, two `GET /api/poll` calls issued in parallel.

- At `AGENT_MAX_TASKS = 1`: exactly one poll received `task_offered`; the other
  received no trigger, and one task remained `offered`.
- Operator raised the policy to `2` via `PUT /api/config`; the mirrored
  `agents.maxTasks` followed to 2 in the same request, and the next poll
  admitted the second task (both then `reviewing`).

## 4. Follow-up / shared workspace

**Not exercised.** The harness ran the control plane only — no real harness
processes with working copies — so continuation across runtimes was not
observed end to end. The limitation is documented instead: runtimes sharing an
`AGENT_ID` need compatible workspace state, and deployments should mount the
same persistent workspace volume when continuation depends on local files.

## 5. Graceful lifecycle

| Step | Agent | Live runtimes |
|---|---|---|
| A and B registered | idle | 2 |
| anonymous `/close` | — | rejected with 400 |
| `/close` runtime A | idle | 1 |
| `/close` runtime B | offline | 0 |

A shutting down left the agent available; only the last close retired it.

## 6. Crash lifecycle

Runtime C owned an `in_progress` task and its session; runtime D was healthy
and kept pinging. C stopped reporting without `/close`, then aged past the
liveness window and a sweep ran.

Before: agent `idle`, 2 runtime rows, 2 sessions.

After the sweep:

```
agent:        busy         (D alive and running its task)
runtime rows: [44E4441D active]   ← C pruned
sessions:     [sibling-task → 44E4441D]  ← only C's session removed
crash task:   in_progress, no session
```

Nothing was assigned to the dead runtime, and D's session survived untouched.
A later sweep, once the freed task aged past the no-session threshold, put it
through the existing recovery path: the task became `superseded` with a
`pending` `resume` child. No separate recovery mechanism was introduced.

## 7. Repeated boots / retention

Five boot→close cycles for one agent, each aged past the window:

```
rows after 5 boots, before sweep: 5
rows after sweep:                 0
```

Retired runtimes are pruned rather than kept, so the table does not grow one
row per boot per agent.

## 8. Rollback to default

An agent with a live runtime row was left in place, the server restarted with
`MULTI_RUNTIME_ENABLED=false`, and the row aged 30 minutes past the window.

- Sweep with the flag off: agent stayed `idle`, runtime row untouched.
- `POST /ping` → 204.
- `POST /close` without a runtime id → **204**, the legacy path (a 400 would
  have meant the multi-runtime requirement leaked into legacy mode).

Old runtime state is inert after rollback and does not affect status,
capacity, or assignment.

## Issues found during QA

None during the live run itself. Review of the pushed branch afterwards
surfaced four more edge cases, all fixed and covered by tests: the
cleanup-only heartbeat tick skipped expiry entirely; the runtime-based
assignment filter needed the same flag guard as expiry; MCP `delete-config`
did not reset the capacity mirror; and enabling the flag while workers were
mid-task could delete a live session before its runtime re-registered.
Dispatch is now also gated on a live runtime identity, so a retired process
that reconnects is given no work.

## Known limitations

- Workspace state is not synchronized between runtimes; deployments must
  arrange compatible workspace access (see the configuration docs).
- Enabling the flag requires workers new enough to send a runtime id — older
  workers are rejected at registration and shutdown while it is on.
- A runtime that dies is noticed at the next sweep after
  `RUNTIME_STALE_THRESHOLD_MIN`, not instantly.

## Addendum — runtime-scoped readiness and liveness (same day)

Re-run against the later head with `RUNTIME_STALE_THRESHOLD_MIN=1`, covering
the state-isolation fixes. Same isolated setup, port 13902.

Credential readiness, one `AGENT_ID` with runtimes A and B:

| Step | Agent status | Live + ready runtimes |
|---|---|---|
| A reports ready, B reports waiting | idle | 1 |
| A polls and takes offered work | idle | 1 |
| B becomes ready while work is held | **busy** | 2 |
| B back to waiting, A closes | **waiting_for_credentials** | 0 |
| B closes | offline | 0 |

B's waiting report never disabled A, and B's ready report did not pull the
busy agent back to idle. Readiness fell back to B's state only once A was
gone, and the last close still produced offline.

Poll liveness: a runtime aged to 55s against the 60s cutoff was refreshed to
0s by a single authenticated poll and survived the following sweep — so a
worker inside the long-poll loop stays live without relying on ping timing.

## Addendum — reconciliation on runtime-set changes (same day)

Isolated server on port 13903, `RUNTIME_STALE_THRESHOLD_MIN=1`.

- **Expiry.** One `AGENT_ID` with a ready runtime and a waiting sibling read
  `idle`. Ageing the ready runtime past the window and running a sweep moved
  the agent to `waiting_for_credentials` — the surviving runtime cannot execute
  work, so it is no longer advertised as available.
- **Registration.** An agent whose only runtime reported waiting sat at
  `waiting_for_credentials`. A second runtime registering without ever
  reporting readiness (credential checks disabled) returned it to `idle`
  immediately, instead of waiting for an unrelated event to recompute it.

The MCP dispatch gate was **not** exercised live: driving `poll-task` needs a
real harness session with the swarm MCP server attached, which this harness
does not stage. It is covered by integration tests instead — expired, unknown,
foreign and missing runtime identities all receive no work, a replacement
runtime still does, and a concurrent HTTP + MCP poll under `AGENT_MAX_TASKS=1`
admits exactly one task.

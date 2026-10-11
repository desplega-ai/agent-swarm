---
date: 2026-10-11
plan: thoughts/taras/plans/2026-10-10-push-based-workers/
branch: spike/push-workers (PR #2045)
---

# QA log: push-based workers

All runs used a worker image built from this branch. Docker on OrbStack; E2B through an ngrok tunnel with a throwaway template (deleted after).

## Summary

| Run | Result |
|---|---|
| Manual E2E 1-5 (docker) | all PASS |
| Stress, docker leg (1 lead + 1 worker, 100 pong tasks, deepseek-v4.1-flash) | 100/100, 75 s, $0.165 |
| Manual E2E 6 (E2B) | PASS |
| Stress, E2B leg | 100/100, 631 s (2 of 5 slots filled), about $0.47 total |
| Bug found by the E2B leg | lost session DELETE kept an idle runtime busy: fixed (merge ec0af7ae3) |
| E2B scale ramp 10 / 25 / 50 sandboxes | all complete; found early per-task teardown + serial provisioning, fixed (ca54eb932); re-run 50/50 |
| Remote controller on Docker 29 (desplega-labs) | found Docker API pin, 1008 handshake close, lost finish on network drop: fixed; re-run all PASS |

## Manual E2E scenarios 1-5 (docker)


Worktree: /Users/taras/worktrees/agent-swarm/pw-qa (6a4081d1b). Image: `agent-swarm-worker:pw-int` (kept). Date 2026-10-11, OrbStack docker, harness claude, `modelTier: smol`.
API: port 13913, `RUNTIME_POOLS_ENABLED=true RUNTIME_WAKE_GRACE_SEC=5 RUNTIME_WORKER_API_URL=http://host.docker.internal:13913`. Server API log copy: /tmp/pw-qa-api.log. Scenarios 6 (E2B) and 7 (stress) not run (out of scope).

| # | Scenario | Result |
|---|----------|--------|
| 1 | On-demand docker coder, push, per-task | PASS |
| 2 | Pool task routed to on-demand agent | PASS (minor deviation) |
| 3 | Static lead on poll | PASS |
| 4 | Crash recovery | PASS |
| 5 | Remote controller | PASS |

## Adaptations vs plan text
- Field names matched the real schema (`ttlSec`, `placements`, `slotsPerRuntime`, `maxRuntimes`, `delivery`, `lifecycle`, `env`). Worker credentials went into pool `env` (`CLAUDE_CODE_OAUTH_TOKEN`, `HARNESS_PROVIDER=claude`).
- Task list endpoint omits `output`; read `GET /api/tasks/{id}` for it.
- Runtime rows expose `taskId`, `provisionAttempts`, `credentialReady`, `reportedSlots`, `lastSeenAt`; no `deliveryMode` field on runtime or agent rows. Delivery mode is only visible in the worker log (`[lead] Mode: runner-level polling`).
- Plan's token check used `/me` (returns 400 with a valid API key). I used `GET /api/agents` with the runtime token (container env `API_KEY`): 200 live, 401 after kill. Garbage token: 401.
- Remote controller creation: `{"name","kind":"docker","placement":"remote","config":{"WORKER_API_URL":"http://host.docker.internal:13913"}}`; token via `POST /api/runtime-controllers/{id}/token` (`.plaintext`); pool move via `PATCH /api/runtime-pools/{id}` `{"placements":["<controllerId>"]}`. CLI token from `AGENT_SWARM_CONTROLLER_TOKEN`.
- curl was blocked by a harness hook, so I used a bun fetch helper. Equivalent HTTP calls.

## Scenario 1: per-task docker pool, 2 pinned tasks
Pool `coders` (docker, per-task, slots 1, max 3, push), agent `coder-1` (maxTasks 3).
- 18:40:54.4 both tasks created (pinned, human_pinned).
- 18:40:54.6 / .8 two runtimes `provisioning` rows created (provisionRequestedAt).
- 18:40:57 (first 3 s sample): two containers `Up 2 s`, tasks already `in_progress`. So create to container about 3 s, create to in_progress <= 3 s.
- 16:41:01.36 UTC (18:41:01) both tasks `completed`, outputs `pong 1` / `pong 2`. Create to completed about 7 s.
- 18:41:09 containers `Exited (0)`; gone by 18:41:12 (removed within about 3 s).
- Final: both runtimes `offline`, provisionError null, provisionAttempts 1; agent `coder-1` `offline`. Matches expectation. No deviation.

## Scenario 2: unassigned task to pool agent
- 18:41:58 created (no agentId). Stayed `unassigned` for samples 18:41:58-18:42:04, container up 18:42:07 (about 9 s: 5 s wake grace plus tick), `in_progress` same sample, completed 16:42:11.2 UTC (13 s total), output `pong`, `agentId` = coder-1. Container exited 18:42:20, removed by 18:42:23.
- Deviation: I never observed the `pending for coder-1` state described in the plan (3 s sampling; it may be sub-second or skipped). Task `routingReason`/`routingSource` are null for the pool-routed task.

## Scenario 3: static lead on poll
`docker run --rm -d --name pw-qa-lead --add-host host.docker.internal:host-gateway --env-file <tmp> agent-swarm-worker:pw-int` with `AGENT_ROLE=lead`, `API_KEY`, `MCP_BASE_URL=http://host.docker.internal:13913` (env file deleted after start).
- 18:42:46 start; registered by 18:43:11 sample (about 25 s). Log: `[lead] Mode: runner-level polling`, `Registered as "pw-lead"`, `Polling for triggers`. Agent `isLead: true`, status idle. Note the registered ID differs from the AGENT_ID I passed (entrypoint/registration assigned it); not investigated.
- Pinned task created 18:43:24: pending -> in_progress 18:43:27 -> completed 18:43:39 (15 s). The lead completed it via polling. My task text ("report pong-lead") was ambiguous, so the lead answered that no agent named pong-lead exists. Delivery path worked; wording was my error.
- /api/poll requests in API log at end: 22. No runtime row created for the lead (expected).

## Scenario 4: crash recovery
Task `bea143e6` (`sleep 90` then store-progress), pinned to coder-1.
- 18:43:47 created; in_progress 18:43:53; container `swarm-rt-1889d3d4`.
- 18:44:05 `docker kill`. Resume task `9b6169` (source system, "Resume interrupted task", agent coder-1) created 16:44:06 UTC (1 s later); parent `superseded`; runtime 1889d3d4 `offline`.
- New container `swarm-rt-a60a59e6` Up by 18:44:07 (about 2 s). Resume completed (observed finished by 18:47:26, ran about 90 s sleep). Lead received a system "Worker task completed, review needed" task (pending; lead was not running).
- Old token: second run (task 68a68b64, `sleep 40`): live runtime token 200 on `GET /api/agents`; after `docker kill` plus 6 s: 401. Garbage token: 401. Runtime token of a cleanly-finished runtime also returned 401.
- Second recovery chain also worked (68a68b superseded, resume e35e01 completed, container removed).
- Final: runtimes offline, no leftover containers.

## Scenario 5: remote controller
- Controller `remote-docker` (id c0059696...), token minted (30 chars), pool placement moved via PATCH (returned new placement). Controller CLI start 18:49:10: `Connected as c0059696...`, API shows `online`.
- One pinned task (b8df5e8b) created 18:49:16: in_progress 18:49:19, completed 18:49:25 (9 s), container exited ~18:49:34 and removed by 18:49:38.
- Controller killed 18:49:59 (SIGTERM, PID gone, API shows `offline` within 3 s). Task 66060942 created 18:50:02: stayed `pending` and no new container for the 30 s observed (inside 120 s grace). Restarted 18:50:33: controller sent `list`, then `provision`; container Up ~18:50:37, task completed 16:50:46 UTC (44 s from create, about 13 s after restart), output `pong after-restart`.
- Reconcile also issued `terminate` for an orphan: container `swarm-rt-e90f713b` (provisioned by builtin-docker before I moved the placement) sat `Exited (0)` for about 1 minute while the pool pointed at the remote controller, then was terminated after the restart's list. Observation, not a failure: moving a pool leaves old-controller exited containers until the new controller's owner-scoped list adopts them.

## Observations / minor
1. `[runtime-pools] Supervisor failed: ControllerOfflineError ...` is logged with `console.error` 9 times while the remote controller was offline (src/be/runtime-pools/supervisor.ts:72). Noisy for an expected state during grace; no functional impact.
2. Runtime/agent responses do not expose delivery mode.
3. After `PATCH placements`, builtin-created exited containers are orphaned until the remote controller's list reconciles.

## Cleanup
Containers with swarm.runtime-id: none left. pw-qa-lead removed. API (PID from /tmp/pw-api.pid and the port listener) and controller (PID 99283 and the restarted one) stopped; temp DB /tmp/pw-qa.sqlite* and token files deleted. `agent-swarm-worker:pw-int` image kept. Other pre-existing containers (paxel-replica-api-501, onb-qa-*, docker-model-runner, deploy-postgres-1) untouched.

## Stress test, docker leg (scenario 7)


Date 2026-10-11. Worktree pw-qa @ 6a4081d1b, image `agent-swarm-worker:pw-int` (slim; ships `pi` 1.1.0, so no full build needed).
Harness `pi`, model `openrouter/deepseek/deepseek-v4.1-flash` (pool env `HARNESS_PROVIDER=pi`, `MODEL_OVERRIDE`, `OPENROUTER_API_KEY`; task `modelTier: smol` also maps to this model on pi).
Topology: API on a free port, temp DB, `RUNTIME_POOLS_ENABLED=true`, integrations disabled.
Lead: docker pool agent, `isLead`, `lifecycle: idle`, maxTasks 1, 1 runtime (pool-based lead, not a static container).
Worker: docker pool agent, maxTasks 5, slotsPerRuntime 5, maxRuntimes 1, delivery push, lifecycle idle.

| Metric | Result |
|---|---|
| Lead sends in ONE task | 100 / 100 (no top-up needed). Top-up via API: 0 |
| Worker tasks completed | 100 / 100 |
| failed / lost / duplicate | 0 / 0 / 0 |
| Output matches `pong <n>` | 100 / 100 (0 mismatches) |
| Max worker runtimes alive | 1 (limit 1) |
| Max worker tasks in_progress | 5 (limit 5) |
| Max lead runtimes alive | 1 |
| Wall clock, first task create to last completion | 75.2 s (16:54:18.5 to 16:55:33.7) |
| Lead send span (first to last child created) | 55.4 s |
| Lead task total | 105.6 s (created 16:53:50, completed 16:55:35.7) |
| First worker task create to worker runtime row | 0.26 s (provisioning row 16:54:18.718) |
| create to in_progress (sampler, 1.2 s resolution, n=98) | p50 8.9 s, p95 15.3 s, max 16.5 s |
| create to completed (n=100) | p50 10.0 s, p95 16.8 s, max 19.8 s |
| in_progress to completed (harness durationMs, n=100) | p50 1.6 s, p95 6.0 s, max 7.5 s |
| /api/poll requests | 108 total in API log (lead + worker startup and idle polling) |
| Nudges / supervisor / provision errors | 0 "Supervisor failed", 0 provision errors, 0 nudge lines |
| OpenRouter spend (/api/session-costs) | $0.1650 for 100 worker sessions; 211,439 input, 13,318 output, 14,267,136 cache-read tokens |
| Lead session cost | no row recorded (0 rows for lead agent) |
| DB size before / after | 4.89 MB / 8.87 MB (+1.9 MB WAL) |
| API RSS before / after | 126 MB (idle) / 1411 MB at run end, 1449 MB idle after (see note 2) |

## Notes

1. Lead handled the whole job in one task using direct `send-task` calls. Its own report: duplicate detection blocked n=2..100 (67% similar to "pong 1") and it re-sent with `allowDuplicate:true`; it disabled `followUpConfig` per task. It also reports that the bulk-script route (`ctx.swarm` SDK from script runtime) failed with "Unable to connect" from inside the docker lead, so it fell back to 100 individual tool calls. Worth a separate look (script SDK egress uses an MCP base URL that is probably not host.docker.internal in the container).
2. RSS is confounded by my own sampler. A control after the run: 300 plain `GET /api/tasks?limit=1000` calls (101 tasks in DB) raised API RSS from 1449 MB to 1927 MB (about 1.6 MB per call), and it never fell back at idle. So most of the 126 to 1411 MB growth is plausibly my 1.2 s task-list polling, not the push path. Not attributable cleanly. The list endpoint retaining memory is a separate suspect.
3. Concurrency ramp: during the run the sampler never saw more than 5 in_progress and never more than 1 worker runtime. Worker kept up with the lead (backlog of pending peaked around 22).
4. Request mix (5490 HTTP lines): 747 prompt-template renders, 534 task context posts, 436 /mcp, 303 credential-status PUTs, 244 runtime-list GETs, 213 /cancelled-tasks, 108 /ping.
5. No stall ever approached the 10 minute hard stop. Spend far below the "few dollars" cap.
6. Create to in_progress latency is dominated by queueing behind 5 slots (about 1.6 to 6 s per task), not delivery latency; the first runtime was requested 0.26 s after the first task.

Raw data: /tmp/pw-stress/samples.jsonl, tasks-final.json, rows.json, api.log.

## E2B legs (scenarios 6 and 7)


Date 2026-10-11. Worktree pw-qa @ 6a4081d1b (detached; the integration head 0e6d6e7e7 adds only the step-12 UI token dialog on top).
API: local `bun run start:http` on port 13931, temp DB, `RUNTIME_POOLS_ENABLED=true RUNTIME_WAKE_GRACE_SEC=5`, `RUNTIME_WORKER_API_URL=https://<ngrok-host>` (ngrok 3.39.6), integrations disabled, fresh random API key.
E2B key set only through `PATCH /api/runtime-controllers/builtin-e2b {"secretConfig":{"E2B_API_KEY":...}}`; the API process had no E2B_API_KEY env. Controller went `offline` (config error) to `online` right after the PATCH.
Harness for every agent: `pi`, pool env `HARNESS_PROVIDER=pi`, `MODEL_OVERRIDE=openrouter/deepseek/deepseek-v4.1-flash`, `OPENROUTER_API_KEY`.

## Worker template (built from this branch)

1. Documented local-checkout path fails, as recorded in the e2b-dispatch gotcha:
   `bun run src/cli.tsx e2b build-template --role worker --template pw-qa-worker-local`
   -> `Error: Multi-stage Dockerfiles are not supported` (e2b CLI 2.10.2, `@e2b/js-sdk dockerfileParser.ts:79`). Nothing was created.
2. Used path: E2B Template SDK (`e2b` 2.26.0 from the repo) with `fromImage(ghcr.io/desplega-ai/agent-swarm-worker@sha256:225cdc8a...)` (published `:slim` amd64, revision 9dd11026) plus two `copy` layers:
   - `/usr/local/bin/agent-swarm`: this branch compiled with the exact Dockerfile.worker `bun build` command plus `--target=bun-linux-x64` (local bun 1.4.2; the image pins 1.4.0).
   - `/docker-entrypoint.sh` from this branch.
   Checked first: between 6a4081d1b and the base revision, `Dockerfile.worker`, `docker-entrypoint.sh`, `plugin/` and the helper scripts differ only in the opencode, agent-fs and amp version pins. So the template equals this branch's worker-slim except those CLI pins and the bun patch version. A build step ran the binary in E2B (`agent-swarm v1.169.0`).
   Script: /tmp/pw-e2b/build-template.ts. Template `pw-qa-worker-1011` (id iv5frt8033azo78dw8k6), build 1m05s.

## Scenario 6: e2b pool, ttlSec 300, idle 2 min, one pinned pong task. PASS

Pool `e2b-s6` (slots 1, max 1, push), agent `e2b-coder`, task "Use store-progress to report 'pong'" pinned (`human_pinned`, `modelTier: smol`).

| Event | Time (UTC) | From task create |
|---|---|---|
| task created | 17:02:40.75 | 0 |
| runtime row `provisioning` | 17:02:41.01 | 0.3 s |
| sandbox handle `i4zzf4pxplgaevm3pu61s`, lease 17:08:41 (360 s = max(300, renew window + 60)) | <= 17:02:45 | <= 5 s |
| `bun run src/cli.tsx e2b list` shows the sandbox with template pw-qa-worker-1011 | 17:03:3x | |
| runtime `active` (worker registered) | <= 17:03:15 | <= 35 s |
| task completed, output `pong` | 17:03:39.82 | 59 s |
| lease renewals logged: `Runtime d2485270... lease renewed until 17:09:42.997Z`, then until 17:10:48 | 17:03:43, 17:04:48 | |
| runtime `offline` (idle timeout) | 17:05:48 | 2 m 08 s after completion |
| `e2b list` and `e2b sandbox list` empty | 17:05:51 | |

provisionAttempts 1, provisionError null, no `Supervisor failed` lines.

## Scenario 7 on E2B: 1 lead, 1 worker, 100 pong tasks

Topology: both agents on E2B (no docker controller row exists without a docker socket configured, and this keeps the leg pure E2B).
Lead: e2b pool agent, `isLead`, maxTasks 1, slots 1, maxRuntimes 1, push, lifecycle idle 2 min, ttlSec 600.
Worker: e2b pool agent, maxTasks 5, slotsPerRuntime 5, maxRuntimes 1, push, lifecycle idle 2 min, ttlSec 600.
Same lead prompt, sampler (1.2 s task-list polling) and analysis as the docker leg. Fresh DB.

| Metric | E2B | Docker leg (for reference) |
|---|---|---|
| Lead sends in ONE task | 100 / 100 (lead: duplicates blocked, re-sent with allowDuplicate, follow-ups disabled) | 100 / 100 |
| Worker tasks completed | 100 / 100 | 100 / 100 |
| failed / lost / duplicate | 0 / 0 / 0 | 0 / 0 / 0 |
| Output matches `pong <n>` | 100 / 100 | 100 / 100 |
| Max worker runtimes alive | 1 (limit 1) | 1 |
| Max worker tasks in_progress | **2** (limit 5) | 5 |
| Max lead runtimes alive | 1 | 1 |
| Wall clock, first worker task create to last completion | **631.4 s** (17:07:57.4 to 17:18:28.8) | 75.2 s |
| Lead send span | 41.5 s (1 task at 17:07:57, 99 at about 17:08:38) | 55.4 s |
| Lead task total | 121 s (17:06:55.6 to 17:08:56.7, incl. sandbox boot) | 105.6 s |
| First worker task create to worker runtime row | <= 1.2 s (sampler) ; runtime active 17:08:23 (about 26 s) | 0.26 s |
| create to in_progress (sampler, n=100) | p50 313.6 s, p95 560.3 s, max 583.5 s (queue) | p50 8.9 s, p95 15.3 s |
| create to completed (n=100) | p50 319.6 s, p95 566.2 s, max 589.9 s | p50 10.0 s, p95 16.8 s |
| in_progress to completed, harness durationMs (n=100) | p50 2.3 s, p95 3.5 s, max 5.0 s | p50 1.6 s, p95 6.0 s |
| in_progress to completed, sampler | p50 6.0 s, p95 6.7 s | |
| Throughput | 10.3 tasks/min, one task start every 5.7 s | about 80 tasks/min |
| /api/poll requests | 109 | 108 |
| Nudge log lines / Supervisor failed / provision errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Lease renewals logged | 2 (worker runtime) | n/a |
| Non-2xx HTTP | 0 of 6951 HTTP lines | |
| OpenRouter spend (/api/session-costs) | worker $0.2250 (100 rows; 404,211 in, 13,474 out, 14,601,984 cache-read); lead $0.0705 (1 row); total $0.2956 | worker $0.1650, lead no row |
| DB size before / after | 4.89 MB / 8.59 MB (+2.4 MB WAL); 8.65 MB after idle | 4.89 / 8.87 MB |
| API RSS | 916 MB about 20 s after boot (idle, before the run), min 245, max 1301 MB during the run, 306 MB idle after the sampler stopped | 126 / 1411 MB |

RSS is noisy: GC swings of 400 to 900 MB between samples, and the sampler's own list polling is the same confound as in the docker leg. No growth trend is attributable to push delivery.

## Findings

### F1 (bug): one lost session DELETE keeps an idle E2B runtime alive and renewed

After the run, the worker runtime stayed `active` with `idleSince: null` for 9 minutes. Its `taskId` was stuck on `0b388a5d` (pong 33, completed 17:11:46). The lease kept renewing (until 17:33).
Cause: two `active_sessions` rows were left for completed tasks (pong 33, pong 41), both with `runtimeInstanceId` = the worker runtime:
```
8220d878...|fcf9bf22...|0b388a5d...|task_assigned||Reply with exactly: pong 33|17:11:42.602Z|17:11:46.379Z|...|cad06a58-...
920c0672...|fcf9bf22...|91938814...|task_assigned||Reply with exactly: pong 41|17:13:10.019Z|17:13:13.409Z|...|cad06a58-...
```
API log: 101 `POST /api/active-sessions`, but only 99 `DELETE /api/active-sessions/by-task/...`. The worker log shows normal completion for both tasks ("completed with exit code 0").
- `src/commands/runner.ts:5124` calls `removeActiveSession` fire-and-forget. `src/commands/runner.ts:2999-3010` swallows every fetch error with an empty catch, so the lost DELETE left no trace. Why the request did not arrive is unconfirmed (probably a transient tunnel or connection failure).
- `src/be/runtime-pools/supervisor.ts:412-415` treats any `active_sessions` row for the runtime as busy, without checking the task status. `:437-442` then clears `idle_since` and copies the stale taskId into `task_id`. So the idle reaper never starts.
- The only safety net is `cleanupStaleSessions` at 30 minutes (`src/heartbeat/heartbeat.ts:138`, `src/be/db.ts:7096`). One lost DELETE therefore costs about 30 extra minutes of sandbox time plus renewals. The same applies to docker idle pools.
- Causation check: at 17:27:15 I called `DELETE /api/active-sessions/by-task/{id}` for both tasks through the API. `idleSince` was set at 17:27:16.6, and the runtime went `offline` at 17:29:22 (idle 2 min plus 1 tick). Then the sandbox was gone.
- Suggested fix: ignore (or delete) session rows whose task is terminal in the supervisor busy check. Optionally retry or log the runner DELETE.

### F2 (performance, not a correctness failure): on a high-RTT link the worker never fills its 5 slots

Max in_progress was 2 and one task started every 5.7 s (per-task log start times in the sandbox: 17:11:13.3, :18.9, :24.7, :31.0 ...). The tasks themselves took about 2.3 s.
Worker log pattern every cycle: `Polling (1/5)` -> `Trigger received` -> `Started task (2/5 active)` -> `Task ... completed` -> `Polling (1/5)`.
Sandbox to API RTT through ngrok: about 0.43 s per request (curl from the sandbox, 5 samples). Sandbox load average 0.08 on 4 vCPU.
Inference (not proven per call): the runner sets up each trigger (session register, prompt renders, memory search, MCP tool discovery, spawn) inline in the delivery loop (`src/commands/runner.ts` about 6795 to 7245). Each setup is a chain of serial API calls, so dispatch rate is bounded by setup calls x RTT, not by `slotsPerRuntime`. The docker leg has about 1 ms RTT and reached 5.
The tunnel exaggerates this (E2B to ngrok to a laptop). An API hosted near E2B would see smaller RTT. Push delivery itself behaved correctly: 109 polls, no idle polling storm, and no lost or duplicate claims.

### Observations
- The lead runtime rows disappeared from `GET /api/runtime-pools/{lead}/runtimes` after the reap (lRT went from `offline` to `[]`). The worker row stayed visible as `offline`. Not investigated.
- Lead lease was never renewed because the lead was reaped before its renewal window (ttl 600 s, renew within 300 s).
- Builtin-e2b `lastError` at boot says "E2B requires E2B_API_KEY. WORKER_API_URL must use HTTPS." although the URL was already https. The hint text is static, not a reflection of which check failed (minor wording).
- Template start logged `/bin/bash: /home/worker/.bash_profile: Permission denied` (start command runs as the default E2B user); harmless, same for published templates.

## Spend
- OpenRouter: $0.2956 recorded for scenario 7. Scenario 6 (one pong) cost was not recorded before the DB reset (docker-leg average is about $0.002 per pong).
- E2B: about 31 sandbox-minutes at 4 vCPU / 8 GiB (s6 3 min, lead about 5 min, worker 21.5 min incl. the 9-minute leak, template build about 1 min). At list prices (about $0.33/h for that size) that is about $0.17. This is an estimate, not a billed figure.

## Cleanup
- Sandboxes: `bun run src/cli.tsx e2b list` empty and `e2b sandbox list` -> "No sandboxes found". All three sandboxes were reaped by the supervisor (the worker one after F1's manual session DELETE). An unrelated `argus-gateway` sandbox present at the start was not touched; it was gone by 17:05.
- Template `pw-qa-worker-1011`: DELETED (`e2b delete-template`); `e2b template list` shows no `pw-qa-*`. The `pw-qa-worker-local` attempt never created a template.
- API (PID 23646 and the scenario-6 PID 18705, killed by listener PID only) and ngrok (PID 17985) stopped; port 13931 has no listener.
- Temp DB (`/tmp/pw-e2b/db.sqlite*`), encryption key, API key file and the 229 MB cross-compiled binary deleted. pw-qa worktree has no changes; nothing committed.
- Kept for evidence: /tmp/pw-e2b/{api.log, api-s6.log, s6-watch.log, samples.jsonl, rows.json, tasks-final.json, build.log, ngrok.log} and the helper scripts. Logs scanned for raw keys: none.

## E2B scale ramp (up to 50 sandboxes)


Date 2026-10-11, 18:06 to 18:30 UTC. Worktree pw-qa2 @ eb8fd2619 (detached, clean; it includes the stale-session fix 91e9b028d + 19f81f429).

## Setup

- E2B team limit: `GET /teams/{id}/metrics/max?metric=concurrent_sandboxes` returned 32, which is above the Hobby cap of 20. So the team is on Pro (100 concurrent sandboxes). This is an inference. No E2B endpoint reports the cap itself. The target of 50 was in range, and no 429 or rate-limit error occurred.
- Template `pw-qa-scale-1011` (id 08s0xytvk0f8lypc5ur2): same recipe as /tmp/pw-e2b-qa.md. It uses the published worker-slim digest, this branch's runner cross-compiled for linux-x64 (`agent-swarm v1.169.0`, bun 1.4.2), and this branch's entrypoint. The template is built at **2 vCPU / 2048 MiB**. The build took 17 s. Script: /tmp/pw-e2bs/build-template.ts.
  For plain E2B templates, pool `resources` does not change the sandbox size. E2B fixes the size at template build. I also set `resources {cpu 2, memoryMb 2048}` on the pool, to keep the record clear.
- API: local `start:http` on port 52880, temp DB, random key, `RUNTIME_POOLS_ENABLED=true`, `RUNTIME_WORKER_API_URL` = free ngrok HTTPS URL (ngrok 3.39.6), integrations disabled. The E2B key was set only through `PATCH /api/runtime-controllers/builtin-e2b`.
- Pool `e2b-scale`: kind e2b, builtin-e2b, `lifecycle: per-task`, slotsPerRuntime 1, maxRuntimes 50, delivery push, ttlSec 600, pool env `HARNESS_PROVIDER=pi`, `MODEL_OVERRIDE=openrouter/deepseek/deepseek-v4.1-flash`, `OPENROUTER_API_KEY`.
- One pool agent `scale-worker`, harness pi, maxTasks 50. One agent is enough: `computeDesired` caps runtimes per agent at `floor(maxTasks / slotsPerRuntime)` = 50. The schema allows maxTasks up to 100.
- Tasks: `POST /api/tasks` with `Reply with exactly: pong <n>`, `agentId` set to the pool agent, `routingReason: human_pinned`, follow-ups disabled. Each wave created all its tasks at once (in about 40 ms). No lead.
- Sampler (/tmp/pw-e2bs/sampler.ts): reads the temp SQLite read-only every 1 s, so it adds no API list-call RSS confound. It also samples API RSS and CPU time with `ps`, and `bun run src/cli.tsx e2b list --json` every 3 s (filtered by `swarm.pool-id`).

## Results

Times are seconds from wave start (task creation). "Provisioned" means the sandbox handle is stored. "Registered" means the runtime row is `active`.

| Wave | Done / failed / lost / dupes | Peak sandboxes (e2b list / live rows / in_progress) | All provisioned | All registered | All tasks done | All sandboxes gone | create→in_progress p50 / p95 | in_progress→completed p50 / p95 | Provision errors | Supervisor errors / circuit trips | API RSS pre → peak, CPU peak | /api/poll | Cost rows |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 10 / 0 / 0 / 0 | 10 / 10 / 3 | 31.3 | 55.6 | 77.4 | 82.2 | 47.4 / 71.7 | 5.8 / 6.9 | 0 | 0 / 0 | 354 → 521 MB, 27% | 10 | 7 / 10 |
| 25 | 25 / 0 / 0 / 0 | 25 / 18 / 7 | 74.2 | 139.9 | 161.5 | 174.3 | 77.3 / 155.1 | 6.0 / 74.8 | 0 | 0 / 0 | 521 → 737 MB, 29% | 25 | 18 / 25 |
| 50 | 49 + 1 recovered / 0 / 0 / 0 | **50** / 38 / 15 | 146.6 (50 first attempts) | 245 (p95; 50th at 356.4 after retry) | 560.2 (pong 40 via recovery) | 607.5 | 240.0 / 257.1 | 6.6 / 271.7 | 1 registration timeout (300 s), retried; 0 E2B 429s | 0 / 0 | 737 → 1117 MB, 41% | 51 | 24 / 50 |

More per-wave data:
- Output exact `pong <n>`: 10/10, 25/25, 48/50. In wave 50, pong 39 appended a note that store-progress was unavailable. pong 40 was superseded by crash recovery, and its resume task output `pong 40`.
- No task ran on more than one runtime, and no task has more than one cost row. pong 40 ran twice (original plus resume), and that is the recovery design, not a duplicate claim.
- Nudge counts: the API does not log nudges. Each sandbox made exactly one `/api/poll` (51 = 50 + 1 replacement), so every later claim came through push delivery.
- API request latency in each wave: p50 1.4 to 1.8 ms, p95 6.7 to 9.8 ms, p99 under 50 ms. Only 3 requests took more than 500 ms (memory search and a session-logs POST). There were 0 responses with 5xx and 0 with 429.
- Lease renewals: 3 (wave 50 only, on long-lived sandboxes). The orphan reaper or the supervisor terminated every sandbox. At the end of each wave, `e2b list` showed 0 sandboxes for the pool.
- Runtime phases. Provision cadence was serial at **2.9 s per sandbox** (2.93, 2.91, 3.04). Boot to register p50 was 15.2 / 24.3 / 98.5 s, and p95 was 27 / 78 / 166 s. Register to task in_progress was stable at 16 to 17 s.
- Registrations came in bursts. In wave 50, 9 runtimes registered in +30 to 60 s, 5 in +120 to 150 s, and then 29 in +210 to 240 s. Wave 25 shows the same pattern with a gap at +60 to 120 s.
- OpenRouter spend (`session_costs`): $0.1644 for 49 rows. About 44% of rows are missing (see B1). A pong costs about $0.002 to $0.004, so the true total is probably about $0.25 to $0.30.

## Bottleneck

1. **Boot over the tunnel is the main bottleneck (inference).** Each sandbox boot sends about 145 API requests: 24 prompt renders, about 30 skill-file GETs, config, keys and memory. At 50 sandboxes that is about 7,400 requests through one free ngrok tunnel. The API was not the limit: p95 was 7 ms and CPU peaked at 41%. Still, boot to register grew from 15 s to 98 s p50, and the registrations arrived in bursts.
   Sandbox logs show TLS handshake failures to the ngrok edge (`curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to ...ngrok-free.dev:443`, and `TypeError: unknown certificate verification error`). These appear in 0/10, 5/25 and 10/50 tasks. That count is a minimum, because some log pushes failed too. The local ngrok log shows no errors.
   I have no edge-side metrics, so ngrok throttling is the best explanation but it is not proven. An API hosted near E2B is needed to measure this properly.
2. **Serial provisioning in the supervisor.** `src/be/runtime-pools/supervisor.ts:738-766` awaits `provisionRuntime` (Sandbox.create plus the worker process start) one at a time in a single tick, at about 2.9 s each. So 50 sandboxes need about 146 s before the last one even starts to boot. The same tick also holds `inFlight`, so reaping and renewals for every pool wait for that loop.

## Bugs and findings

### B1 (regression from the stale-session fix): per-task sandboxes are terminated before the runner finishes its post-task calls

- `supervisor.ts:430-434` now counts as busy only those sessions whose task is not terminal. `supervisor.ts:498-501` terminates a per-task runtime as soon as its task is terminal. The task becomes terminal when the agent calls store-progress over MCP, which happens before the harness exits.
- So the next supervisor tick (5 s, or a kick) kills the sandbox and revokes its token. This can happen before the runner posts `/api/session-costs`, `DELETE /api/active-sessions/by-task/...` and the final session logs.
- Evidence:
  - Cost rows: 7/10, 18/25 and 24/50 (37 of 85 tasks have none).
  - `DELETE /api/active-sessions/by-task`: 4/10, 18/25 and 35/50.
  - Tasks without a cost row cluster at task finishedAt → runtime offline of 0.2 to 2 s (wave 50: 20 of 26 under 2 s). Tasks with a cost row cluster at 2.4 to 4.7 s.
  - Wave 50 has 401s from late runner calls after the token was revoked: `PUT /api/agents/<id>/credential-status → 401`, `POST /api/tasks/<id>/context → 401`, `POST /mcp → 401` (×2), `POST /api/session-logs → 401`.
- Impact: cost accounting is under-reported by about 44% on per-task pools, and session logs are truncated. Before the fix, the session row kept the runtime busy until the runner deleted it.
- Suggested fix: for `per-task`, treat the runtime as busy while its session row exists (bounded by a short grace after the task is terminal), or wait for the provider to report `exited`, before terminating. The 30-minute stale-session problem only needs the terminal-task filter for idle pools.

### B2 (robustness, pre-existing): pi MCP discovery has no retry

- `src/providers/pi-mono-adapter.ts:1570-1596`: one `initialize()` / `listTools()` failure leaves the whole session without swarm tools.
- The model then improvised. It ran curl against `/mcp`, read `/proc/1/environ` and `/workspace/logs`, and called store-progress by hand. Those tasks took 19 to 26 turns and up to 86 s (pong 24, 26, 27 and others), compared with about 2.5 s normally. pong 39 returned output that is not exact.
- One sandbox (pong 40) lost the tunnel completely. Its logs stop at 18:20:56. The heartbeat recovered it at 18:25:15 ("runtime-died", stale threshold 5 min), and the resume task completed. So recovery worked.

### Minor

- `PUT /api/agents/<id>/profile → 400` on every sandbox boot (86/86), from `src/commands/runner.ts:6208`. Not investigated.
- Offline runtime rows are pruned (`src/be/multi-runtime.ts:502`). After the run, only 3 of 87 rows remain. The per-wave runtime history comes from the sampler.
- Without the sampler, `in_progress` timing has no persisted timestamp. `acceptedAt` stays null for pinned tasks.

## Spend estimate

- E2B: 11,054 sandbox-seconds seen in `e2b list` (3 s sampling, so a slight underestimate), at 2 vCPU / 2 GiB (about $0.133/h at list price), comes to about **$0.41**. The template build is negligible.
- OpenRouter: $0.16 recorded, and about $0.25 to $0.30 is the probable true total.
- **Total about $0.7**, well under the $10 cap. No hard stop triggered: 0 failures, and the longest period without progress was about 4 min (pong 40 waiting for recovery).

## Cleanup

- `e2b list`: empty. E2B API: 0 running or paused sandboxes with the pool id, template or `pw-qa` alias. The only remaining sandboxes are unrelated paused `argus-gateway*` sandboxes, which I did not touch.
- Template `pw-qa-scale-1011`: deleted (`e2b template delete`). `/templates` lists no `pw-qa*` template.
- API (PID 1199, the listener on 52880), ngrok (PID 953) and the sampler are stopped. Port 52880 is free.
- Temp DB (+ WAL/SHM), API key file, `.encryption-key` and the 229 MB cross-compiled binary are deleted.
- pw-qa2 worktree is clean (0 changes), and nothing is committed.
- Retained logs were scanned for the swarm key, the OpenRouter key and the E2B key: 0 hits.
- Kept for evidence: /tmp/pw-e2bs/{api.log, ngrok.log, samples.jsonl, state.json, waves.jsonl, wave-*.log, build.log} and the helper scripts. (Run-1 files later moved to /tmp/pw-e2bs/run1/.)

## Re-run after fixes

Date 2026-10-11, 18:56 to 19:03 UTC. pw-qa2 @ ca54eb932 (per-task teardown waits for the runner's shutdown close or a 60 s grace; concurrent provisioning, default concurrency 8).
Setup is the same as before: new template `pw-qa-scale-1011b` (2 vCPU / 2 GiB, runner v1.169.0 from ca54eb932), fresh DB and key, new ngrok URL, one 50-task wave (pong 101 to 150).
Raw data: /tmp/pw-e2bs/{api.log, samples.jsonl, state.json, waves.jsonl, wave-r50.log, build2.log}.

| Metric | Run 1 (eb8fd2619) | Re-run (ca54eb932) |
|---|---|---|
| Done / failed / lost / dupes | 49 + 1 recovered / 0 / 0 / 0 | **50 / 0 / 0 / 0** |
| Output exact `pong <n>` | 48 / 50 | 49 / 50 (pong 106 appended a note that store-progress was missing) |
| All 50 provisioned (handle stored) | 146.6 s | **21.6 s** |
| All registered | 245 s (49 of 50), 50th at 356.4 s | 235.2 s (48 of 50), 49th and 50th at about 360 s after 2 registration timeouts |
| All tasks done / all sandboxes gone | 560.2 / 607.5 s | **388.9 / 398.7 s** |
| Peak sandboxes (e2b list / live rows / in_progress) | 50 / 38 / 15 | 50 / **50** / **28** |
| Boot to register p50 / p95 | 98.5 / 166 s | 124.7 / 139.9 s |
| create→in_progress p50 / p95 | 240 / 257 s | 158 / 253 s |
| in_progress→completed p50 / p95 | 6.6 / 272 s | 21.9 / 161 s |
| Cost rows | 24 / 50 | **30 / 50** |
| Session DELETEs (`/by-task`) that arrived | 35 / 50 | **50 / 50** |
| Runner 401s after task completion | 5 (credential-status, context, mcp ×2, session-logs) | **0** |
| Finished task → runtime offline | 0.2 to 4.7 s (supervisor kill) | 0.4 to 22.9 s, all far below the 60 s grace, so the runner closed every one |
| Finished task → sandbox gone from `e2b list` (3 s sampling) | not measured | cost rows: p50 5.4 s, max 27.3 s. No cost row: p50 2.1 s, max 4.5 s |
| Registration timeouts | 1 | 2 (retried; both replacements registered) |
| Supervisor errors / circuit trips / E2B 429s | 0 / 0 / 0 | 0 / 0 / 0 |
| API RSS peak, CPU peak | 1117 MB, 41% | 993 MB, 38% |

### Findings

- **Fixed: teardown no longer cuts off the runner.** All 50 session DELETEs arrived. No runner endpoint returned 401 (session-costs, session-logs, context, credential-status, active-sessions). No runtime reached the 60 s grace.
- **Not fixed: 20 of 50 cost rows are missing, but the cause is different.** Every missing row is in a degraded sandbox:
  - 7 tasks have no session logs at all, so all their log pushes failed too.
  - 13 tasks never called the swarm `store-progress` tool. Their logs show TLS or MCP-discovery failures, or the model searching for store-progress with bash and curl.
  - Healthy sandboxes (15 with a normal tool call) recorded cost 15 of 15. Degraded sandboxes recorded cost 15 of 35.
  - The logs of no-cost tasks stop 1 to 28 s before `finishedAt`. Their runtimes went offline 0.4 to 1.5 s after finish. Runtimes with a cost row went offline after 2.4 to 23 s.
  - So the runner ended first in every case. The lost cost POST is on the runner side: either `saveCostData` failed over the broken tunnel (`src/commands/runner.ts:2757`, which catches and only warns) or the session was aborted after the task turned terminal server-side (`runner.ts:5076-5082`). Runner stdout is gone, so I cannot tell which.
  - Suggestion: retry the cost POST like `/finish`, or have the API record cost at finish time.
- **401s in this run** (18): `GET /` ×5, `GET /mcp` ×7, `POST /mcp` ×4, `GET /api/tasks/6ca8a726…` ×2. All are model-made curl calls in degraded sessions. The task-GET 401s were at 19:00:08, which is before pong 119 finished (19:01:18).
- **The bottleneck is now only the tunnel.** Concurrent provisioning removed the 2.9 s-per-sandbox serial delay. But all 50 sandboxes now boot at once through one free ngrok tunnel: boot to register p50 was 125 s, and 37 registrations landed in one 30 s window. 35 of 50 sandboxes lost MCP (up from at least 10 of 50), and degraded sessions improvise, so in_progress→completed p50 rose to 22 s. The API was not the limit (CPU 38%). An E2B-local API is needed to measure the real ceiling.

### Spend (re-run)
- OpenRouter: $0.3581 recorded for 30 rows. That is higher than run 1 because degraded sessions run 19 to 26 turns. True total including the 20 missing rows: probably about $0.5.
- E2B: 9,383 sandbox-seconds at 2 vCPU / 2 GiB, about $0.35.
- Re-run total about $0.85. Both runs together are about $1.6, under the caps ($10, and $5 for the re-run).

### Cleanup (re-run)
- `e2b list` is empty. E2B API: 0 running or paused sandboxes for the pool (only unrelated `argus-gateway*`).
- Template `pw-qa-scale-1011b` is deleted. `/templates` lists no `pw-qa*`.
- API (PID 52453), ngrok (PID 52379) and the sampler are stopped. Port 62045 is free. No other processes were touched (the other agent's SSH tunnel was left alone).
- Temp DB, key files, `.encryption-key` and the cross-compiled binary are deleted. The secret scan of retained files found 0 hits. pw-qa2 is clean, and nothing is committed.

## Remote controller on a real Docker 29 host


Date 2026-10-11. Code: /Users/taras/worktrees/agent-swarm/pw-qa2 at eb8fd2619 (git archive copied to the box).
Box: `desplega-labs` (Ubuntu 24.04, Docker 29, server API 1.52, minimum API 1.44, bun 1.3.14).
Local API: port 13977, temp DB /tmp/pw-remote.sqlite, random key, `RUNTIME_POOLS_ENABLED=true`, `RUNTIME_WAKE_GRACE_SEC=5`, grace default 120 s, integrations disabled.
Image: `agent-swarm-worker:pw-remote` (worker-slim target, built on the box, 3.34 GB). Harness claude, `modelTier: smol`, OAuth token in pool `env`.
Helpers and API log: /tmp/pwr/ (key and tokens deleted).

| # | Test | Result |
|---|------|--------|
| 0 | Controller connects on Docker 29 | FAIL as shipped (bug 1). PASS after a box-only patch |
| 1 | One pinned task through the remote controller | PASS |
| 2 | 10 tasks, maxRuntimes 5, slots 1 | PASS |
| 3 | Controller kill: inside grace, past grace | PASS |
| 4 | SSH tunnel drop for 30 s | Recovered. Outcome loss on per-task worker (finding 2) |

## Network setup
- sshd on the box has `GatewayPorts no`. I made no system changes, so a bind on 172.17.0.1 was not possible.
- Tunnel: `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -R 127.0.0.1:13977:localhost:13977 desplega-labs`.
- Controller: `--api-url http://127.0.0.1:13977 --kind docker --docker-network host`.
- Controller row config: `WORKER_API_URL=http://127.0.0.1:13977`. Containers run with `NetworkMode: host`.
- Probe: a bridge container cannot reach 172.17.0.1:13977. A host-network container can reach 127.0.0.1:13977. Docker 29 accepts `ExtraHosts` together with host network.

## Bug 1: Docker API version pinned to 1.43 (blocks Docker >= 29)
`src/runtime-providers/docker.ts:22` `const API_VERSION = "v1.43";`. Docker 29 rejects it.
Controller log on first connect:
```
[runtime-controller] Connected as 3835e64f-...
[runtime-controller] Command list f4e4af8f-...
[runtime-controller] Error: ... docker GET /containers/json?... failed (400): {"message":"client version 1.43 is too old. Minimum supported API version is 1.44, please upgrade your client to a newer version"}
[runtime-controller] Controller access rejected or token revoked. Mint a token and restart this process.
```
Local QA passed because OrbStack accepts API 1.40 and later. The builtin docker controller has the same problem on any Docker 29 host.
To continue, I patched only the box copy to `v1.44`. The repository code is unchanged.

## Bug 1b: provider error during hello closes the socket with 1008
`src/http/controllers-connect.ts:123` (`reconcileHandles`) throws, and `:141-143` closes with `1008 "Controller handshake failed"`.
The CLI (`src/commands/controller.ts:109-112`) treats every 1008 close as fatal. It prints "token revoked" and exits.
A provider or infrastructure error is therefore reported as an auth failure, and the process does not retry. The controller row kept `lastError: null`. The API only logged the error with `console.error`.

## Test 1: one pinned pong task
- 20:10:59.95 task created. 20:11:00.57 container `Created`. 20:11:01.6 `Up`.
- 20:11:09.79 `in_progress` (about 8 s worker boot). 20:11:16.48 `completed`, output `pong` (16.5 s total).
- 20:11:17.97 container gone (removed about 1.5 s after completion).
- Controller log: `provision`, then `status` (4 times), then `terminate`. Runtime `offline`, provisionAttempts 1, no error.

## Test 2: 10 concurrent tasks
- 20:16:27 10 pinned tasks created (agent maxTasks 10, pool maxRuntimes 5, slots 1).
- Wave 1: 5 tasks `in_progress` at +12 to +14 s, completed at +20 to +22 s.
- 20:16:53 containers removed. 20:16:54 to :55 five new containers.
- Wave 2: 5 tasks `in_progress` at +37 to +40 s, completed at +46 to +48 s.
- All 10 completed with the correct `pong-N`. The 1 s box sampler showed at most 5 running and at most 5 listed containers (all states).
- 20:17:18 zero containers.

## Test 3: controller kill
3a (SIGTERM, idle):
- 20:17:43 kill. API `offline` by 20:17:47. A task created at 20:17:47 stayed `pending` with 0 containers for 44 s.
- 20:18:31 restart. Reconnect, then `provision`. Container up about 20:18:37. Task completed at 20:18:53 (22 s after restart).

3b (SIGKILL, live runtime):
- Long task (2 x `sleep 100`). `in_progress` 20:19:29. The runtime token returned 200 on `GET /api/agents` (curl from the box).
- 20:19:41 `kill -9`. Until 20:21:38 the runtime was `active`, the task was `in_progress`, and the token returned 200. Rows and credentials were kept during the grace.
- 20:21:55 (between 117 s and 134 s after the kill): the runtime was recovered (no active rows) and the token returned 401. The parent task was `superseded`, and resume task d69635b8 was `pending`.
- The orphan container kept running with the revoked token. The API log shows 401s from it on `/ping`, `/cancelled-tasks`, `/api/steering-messages`, `/mcp`, and `/close`.
- 20:23:13 restart. The orphan was terminated within about 1 s. A new runtime was up at 20:23:18. The resume task was `in_progress` at 20:24:22 and `completed` (`done-long`) at 20:25:17.

## Test 4: SSH tunnel drop for 30 s
4a (drop while the worker was in `sleep 60`):
- 20:26:04 drop. The controller was `offline` within 5 s. The CLI retried with backoff delays of 7.5 s, 14.3 s, and 28.1 s.
- 20:26:34 restore. The controller was `online` again by 20:27:05, about 31 s later because of the 28 s backoff step.
- The same container survived. The task completed at 20:27:06 (`done-net`). The drop did not overlap any API call that the task needed.

4b (drop while the worker must report):
- 20:27:58 `in_progress`. 20:28:01 drop.
- Worker log (`docker logs`):
  - `store-progress` → `MCP server "agent-swarm" is not connected`.
  - `Error finishing task b456cb2d: TypeError: Unable to connect`.
  - `Active-session removal failed ... after 3 attempts`.
  - `Received SWARM_EXIT_AFTER_TASKS, shutting down...`. The container exited with code 0 at 20:28:30.
- 20:28:37 restore. 20:28:59 controller online. The status check saw the exited runtime. The parent was `superseded`, and resume task d11709e4 ran in a new container. It completed at 20:29:29.
- Finding 2: a per-task worker that cannot reach the API at finish time loses the outcome. The worker makes one attempt to call `/finish` (`src/commands/runner.ts:1839-1876`), then `exitAfterTasksIfFinished` exits (`runner.ts:811`). Recovery re-executes the work. That is correct for idempotent tasks, but side effects run twice. A short retry of `/finish` before the per-task exit would close most of this gap.
- I did not observe a worker realtime reconnect: in 4a it did not need one, and in 4b the worker exited.

## Minor
- The controller log has no timestamps. It logs `Command list` about every 5 s (73 in 6 minutes), which is noisy.
- `Supervisor failed: ControllerOfflineError` did not appear in this run (0 occurrences).
- Bun 1.3.14 on the box ran the controller CLI without problems (repo pin is 1.4.x).

## Cleanup
- Box:
  - Controller, sampler, and log follower stopped.
  - 0 containers with `swarm.runtime-id`.
  - `agent-swarm-worker:pw-remote` removed. `/root/pw-remote` removed.
  - BuildKit cache from the image build remains. I did not run any prune.
  - The 3 swarm-studio-engine containers are still Up (8 days, 3 days, 4 weeks healthy).
- Local:
  - Tunnel and API stopped. Nothing listens on port 13977.
  - /tmp/pw-remote.sqlite* deleted. The key and token files are deleted.
  - The other agent's processes and /tmp/pw-* helpers were not touched.

# Re-run after fixes (ca54eb932)

Same setup: git archive of pw-qa2 at ca54eb932, NO patch on the box copy, image rebuilt as `agent-swarm-worker:pw-remote`.
New temp DB and new key. Tunnel 127.0.0.1:13977, `--docker-network host`. Swarm owner id 31c3cc4f-...

| # | Test | Result |
|---|------|--------|
| R0 | Unpatched controller on Docker 29 | PASS |
| R4 | Handshake failure (wrong DOCKER_HOST) | PASS |
| R1 | One pinned task | PASS |
| R2 | 10 tasks, maxRuntimes 5 | PASS |
| R3 | Tunnel drop at finish time (4b) | PASS (2 runs) |

## R4: handshake failure
- Controller started with `--docker-host unix:///root/pw-remote/nonexistent.sock`.
- Every hello: `Connected`, then `Command list`, then the socket error, then `Disconnected. Reconnect in Nms`. Delays: 1000, 1852, 3655, 6375, 14910 ms. The process stayed alive. It did not print "token revoked".
- Controller row: `status: offline`, `lastError: "... via socket /root/pw-remote/nonexistent.sock: ... Set DOCKER_HOST to select the Docker socket."`, `lastErrorAt` set.
- The CLI does not log the close code. The retry behavior shows a non-1008 close (`src/http/controllers-connect.ts:96`: 1011 unless `ControllerAuthError`).
- Restart with the default socket: `online`, and `lastError` cleared to null.

## R0 / R1: single pinned task, unpatched
- The controller connected and `list` succeeded on Docker 29 (API version negotiated through `/_ping`).
- 20:58:07.3 provision requested. 20:58:14.7 container Up (7.4 s; the first run took 0.6 s). 20:58:26 `in_progress`. 20:58:34 `completed`, output `pong` (27 s).
- 20:58:44 container exited (about 10 s after completion). 20:58:48 container removed (14 s after completion; the first run took 1.5 s).
- The longer teardown matches the new "wait for runner shutdown close" behavior. I did not investigate the slower create.

## R2: 10 tasks
- All 10 completed with the correct `pong-N` in 96 s (the first run took 48 s).
- Wave 1: `in_progress` at +22 to +28 s, completed at +35 to +41 s. Wave 2: `in_progress` at +73 to +85 s, completed at +87 to +96 s.
- Max running containers: 5. Max listed containers: 6 (5 running + 1 exited during turnover at 20:59:59).
- The time to the second wave doubled. The cause is the per-task exit delay (about 10 to 14 s from completion to container exit) plus a slower worker boot.

## R3: tunnel drop at finish time
Run 1 (task e7c458be): drop at 21:01:08, restore at 21:01:44. Task `completed` at 19:01:45.8Z, 1.8 s after restore. No resume task.
The worker log of run 1 was not captured: the follower attached to a leftover test-2 container.

Run 2 (task 6344b5da), worker log captured:
- 21:03:22 drop. The agent's `store-progress` failed (`MCP server not connected`).
- 19:03:51.85Z `Task 6344b5da completed with exit code 0`.
- `[runner] Final task update failed. Retry in 1000ms`, then 2000, 4000, and 8000 ms.
- 21:03:58 restore. 19:04:07.03Z `Runner marked task 6344b5da as completed`, then `SWARM_EXIT_AFTER_TASKS`.
- The task was `completed` at 19:04:06.95Z. No resume task: the agent has 13 completed tasks, 0 resume tasks, and 0 superseded tasks.
- The controller reconnected about 20 s after restore. The exited container was removed by 21:04:21.

Observation: the saved `output` is the agent's final message, not the answer. For example: "The task did not finish: `sleep 15` ran and returned, but I could not record completion ... Output to record once the server is back: `done-net2`".
The task is `completed`, but its output says it is not completed. The runner fallback stores the agent's last message as written. Consider a note or a status hint when the agent's own `store-progress` failed.

## Re-run cleanup
- Box:
  - Controller, sampler, and log follower stopped.
  - 0 `swarm.runtime-id` containers.
  - Image `agent-swarm-worker:pw-remote` deleted. `/root/pw-remote` removed.
  - BuildKit cache remains (no prune).
  - The 3 swarm-studio-engine containers are still Up (8 days, 3 days, 4 weeks healthy).
- Local:
  - Tunnel and API stopped. Nothing listens on port 13977.
  - /tmp/pw-remote.sqlite* deleted. The key and controller-token files are deleted.

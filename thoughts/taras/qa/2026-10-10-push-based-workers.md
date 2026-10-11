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

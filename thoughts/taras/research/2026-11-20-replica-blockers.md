---
date: 2026-11-21
researcher: Claude
repository: agent-swarm
topic: "Replica blockers for a second API process on Postgres"
tags: [research, postgres, replicas, ha, leader-election, realtime]
status: complete
---

# Replica blockers for a second API process on Postgres

## Summary

Today one API process owns each database. On Postgres a session advisory lock enforces it (`packages/storage-postgres/src/boot.ts:73`, `:100`), and the Helm chart refuses `api.replicas != 1` (`charts/agent-swarm/templates/api-statefulset.yaml:7-8`). Much of the API code relies on that rule, often in comments ("the API server is the single DB owner, so in-process is enough"). This inventory lists what a second replica breaks. Counts: realtime and event buses 11; locks and in-flight dedup 41 (4 of them the advisory locks and the chart guard); caches 15 (plus 1 closing line for 21 safe caches); timers and background loops 30 (plus 1 closing line for 11 per-replica loops); single-owner connections 8; local files and process-local resources 5; other 4. Total: 114 items.

One fact lowers the risk of many loops. The Postgres pool runs every transaction as SERIALIZABLE with retry (`packages/storage-postgres/src/client.ts:20`, `:400`). So a read-then-write claim inside one transaction (scheduler occurrence, retry claim, wait resume) is safe when two replicas run it. Two sites opt down to READ COMMITTED with explicit row locks (decision D7): the poll write pass (`src/http/poll.ts`) and task finish (`src/http/tasks.ts`); their locks hold across processes too. The dangerous code is the code that decides with process memory, not with a row: "is this run active in this process", "did this process already send this", "is this PID alive here", "was this claimed before my boot".

Replacement patterns used below:
- **NOTIFY**: Postgres LISTEN/NOTIFY fan-out. The payload cap is 8000 bytes, so notify an id or topic and re-read the row.
- **Leader**: one replica runs the loop. Use `pg_try_advisory_lock(key)` on a dedicated session connection, re-tried on a timer, so a dead leader frees the lock with its connection.
- **Lease**: an owner column (`owner_replica_id`, `lease_expires_at`) on the row, renewed by heartbeat, taken over only after expiry.
- **Xact lock**: `pg_advisory_xact_lock(hashtext(key))` inside the critical transaction.
- **Claim row**: insert a row with a unique key first, act only if the insert won.
- **Sticky**: route by a session key at the ingress (`mcp-session-id`, room, ticket).

## 1. Realtime and event buses

- `src/realtime/bus.ts:6`, `:31-33`: `InProcessBus` wraps one Node `EventEmitter`, stored on `globalThis.__realtimeBus`. A publish on replica B never reaches a subscriber on replica A (lost event). Replace with NOTIFY behind the same `publish`/`subscribe` interface, with a replica id to skip echo.
- `src/workflows/event-bus.ts:19-20`, `:71`: `workflowEventBus` sits on `realtimeBus` and keeps prefix handlers in a local `Map`. Each event fires only on the replica that committed it. Subscribers that only read the DB stay correct. The ones below do not. Replace as for the realtime bus, or keep local delivery and fix each subscriber.
- `src/workflows/resume.ts:1276-1277`, `:1340`: `waitsByEvent` and `listenersByEvent` hold event-mode workflow waits. A wait is registered only on the replica that created it (or that scanned it at boot, `:1288`). An event on the other replica does not resolve it, so it waits until its timeout (lost event). Replace with a fixed listener per event name that queries pending `wait_states` rows, as `src/scheduler/deferred-task-waits.ts` already does.
- `src/realtime/transport.ts:347`, `:365`: client channel `subscribe` and `publish` go through `realtimeBus`. A message a client publishes on B never reaches subscribers connected to A. Replace with NOTIFY fan-out.
- `src/be/worker-nudges.ts:11`, `src/be/worker-nudge-listener.ts:10`, `:26`, `src/realtime/channels.ts:8`: the nudge goes out on the replica that created the task, and the listener checks only local worker sockets. A worker connected to the other replica gets no nudge and waits for its next poll (lost event, latency). Replace with NOTIFY to the replica that holds the socket.
- `src/realtime/rooms.ts:66-75`, `:209`, `:235`: live Yjs room documents live in `globalThis.__swarmRoomsState`, and each room flushes to KV 1 s after a change. Two replicas hold two copies of one room. Clients on A and B diverge, and the last flush wins (lost edits). Replace with one owner per room (sticky by room key) or Yjs update relay over NOTIFY with a shared persisted state.
- `src/realtime/transport.ts:414`: presence is published per room on the local bus. Peers on the other replica do not see each other (stale presence). Same fix as rooms.
- `src/http/sessions.ts:1430`, `src/realtime/transport.ts:423`: a share change publishes `sessionAccessTopic` locally. A viewer on the other replica keeps receiving room updates until its ping check (`src/realtime/transport.ts:555`) re-validates (stale access window). Replace with NOTIFY.
- `src/be/db.ts:6803`, `src/http/index.ts:508`, `src/realtime/rooms.ts:76`: page deletion publishes `room:namespace-deleted` after commit, and only the local handler drops live rooms. The other replica keeps the room in memory, and its `namespaceEpoch` fence is process-local, so its next flush can write the deleted room back (resurrected state). Replace with NOTIFY plus a DB-side generation check on flush.
- `src/be/runtime-pools/recovery.ts:26`, `:196`, `:203`, `src/realtime/transport.ts:266`, `:354`: socket counts per runtime come from local `worker.socket.connected/disconnected` events. A worker that reconnects to the other replica looks disconnected here, and after `RUNTIME_SOCKET_GRACE_SEC` recovery can act on a live runtime. Replace with a socket presence table (runtime id, replica id, last seen).
- `src/oauth/ensure-token.ts:176`, `src/linear/app.ts:10`: `authorizationRefreshedListeners` is a local `Set`. Linear resets its client on refresh through it. A refresh on A leaves B's Linear client on the old token (stale credential). Replace with NOTIFY on token refresh, or build the client per call from the stored token.

## 2. Locks and in-flight dedup

### The advisory locks themselves

- `packages/storage-postgres/src/boot.ts:73`, `:100`, `src/be/storage-root.ts:245`, `:311`: `acquireProcessLock` holds session lock `PROCESS_LOCK_KEY` for the process life, and a second API waits 10 s then exits. This is the guard to remove. Replace with per-role locks (leader lock, per-loop locks) instead of one whole-process lock.
- `packages/storage-postgres/src/data-copy.ts:356`: the SQLite-to-Postgres data copy takes the same lock with `waitMs: 0` to prove no API runs on the target. Once APIs share the lock or drop it, the copy loses its guard. Keep an exclusive "maintenance" lock that every API takes in shared mode (`pg_advisory_lock_shared`) and the copy takes exclusively.
- `charts/agent-swarm/templates/api-statefulset.yaml:7-8`, `:21`: the chart fails on `api.replicas != 1` and hard-codes `replicas: 1`. Remove after the items below are fixed.
- `packages/storage-postgres/src/migrations.ts:25`, `:88`: the migration runner holds `MIGRATION_LOCK_KEY`. It already serializes several runners, so it needs no change.

### Locks and mutexes

- `src/oauth/ensure-mcp-token.ts:21`: `inflight` serializes MCP OAuth refreshes per server in one process only. Two replicas refresh one rotating refresh token at once. The provider rejects the second (`invalid_grant`) and the token row flips to `error` (split lock). Replace with the cross-process `oauth_refresh_locks` table that `src/oauth/ensure-token.ts:97-99` already uses, or a xact lock keyed by server and user.
- `src/http/mcp-oauth.ts:428`: `authorizeFlowLocks` serializes "find a reusable client, else register one". Two replicas both register a dynamic client and orphan one (duplicate provider registrations, wrong client pairing). Replace with a xact lock on `mcpServerId::userId` or a unique row claim.
- `src/apps/row-store.ts:63`, `:223`: `withMutationLock` chains app-row mutations per `appId:model` in a local `Map`. Two replicas interleave writes to one model (lost updates on read-modify-write). Replace with a session advisory lock taken before the transaction (the comment there forbids taking it inside one).
- `src/apps/row-store.ts:64`, `:272`: `lastCreatedAtMs` makes `createdAt` strictly increasing per process. Two replicas issue equal or out-of-order timestamps (cursor ties, unstable sort). Replace with a DB sequence or an `(createdAt, id)` tie-break.
- `src/apps/sync.ts:811`: `inFlight` single-flights a sync pass per `appId:model:source`. Two replicas run the same pass (duplicate pulls and row creates). Replace with a session advisory lock per pass key.
- `src/azure-devops/boards-sync.ts:263`: `withReceipt` shares one attempt per delivery key, then checks and writes a KV receipt in separate steps. Two replicas both pass the check (duplicate task). Replace with a claim row before the handler.
- `src/azure-devops/boards-sync.ts:295-297`: `workItemLocks` serializes per work item, and the comment says in-process is enough. Two replicas handle one work item at once (double run). Replace with a xact lock per work item.
- `src/azure-devops/outbound.ts:38`: `transitionChains` keeps state transitions per task in order. Events on two replicas can land "Doing" after "Done" (stale write). Replace with a per-task lock plus a monotonic transition check.
- `src/slack/render-v2.ts:120`, `:122`: `treeCreationPromises` dedups tree card creation per thread, and `treeUpdateTails` orders updates. Two replicas post two tree cards, or an older render overwrites a newer one. Replace with a claim row per thread card and a per-thread lock with a version check.
- `src/slack/session-status.ts:116-117`: `threads` and `keyTails` serialize Slack assistant status calls per thread. Two watchers set the status at once (flicker, wrong final status). Replace with a per-thread lock or one watcher leader.
- `src/workflows/engine.ts:413`, `:418`, `:457`, `:462`: `activeWalks` and `executingSteps` record which runs and steps this process is executing. Recovery (`src/workflows/recovery.ts:108`, `:139`, `:191`, `:198`) skips only local ones, so it re-walks runs and restarts steps the other replica is executing (double run). Replace with a lease on `workflow_runs` and step rows.
- `src/workflows/successor-routing.ts:14`: `owed` counts successors a walk still owes per run. A finalizer on the other replica sees no debt and closes the run early (premature completion). Replace with a persisted debt (column or table) checked inside the finalizer transaction.
- `src/workflows/foreach-driver.ts:61`: `ownedChildren` marks foreach children a drive is starting. A `running` child outside the local set counts as orphaned, so the other replica restarts a live child (double run). Replace with a lease on the child step row.
- `src/workflows/resume.ts:787`: `inFlightCancels` shares one cancel per run. Two replicas walk the same tree at once (duplicate work and serialization retries). Replace with a xact lock per root run.

### Inbound webhook and event dedup

- `src/github/handlers.ts:32`: `processedEvents` dedups GitHub events for 60 s. A redelivery that lands on the other replica creates a second task. Replace with a claim row per delivery, as `src/jira/webhook.ts:9` and `src/be/db-queries/tracker.ts:183` already do.
- `src/gitlab/handlers.ts:34`: same 60 s map for GitLab. Same failure and fix.
- `src/bitbucket/handlers.ts:40-41`: `processedEvents` and `processedDeliveries` for Bitbucket. Same failure and fix.
- `src/azure-devops/handlers.ts:42`: `processedEvents` for Azure DevOps service hooks. Same failure and fix.
- `src/agentmail/handlers.ts:134`: `processedEvents` for AgentMail. Same failure and fix.
- `src/linear/webhook.ts:10`: `recentDeliveries` dedups `Linear-Delivery` for 5 min. Same failure and fix.
- `src/slack/event-dedup.ts:23-24`, `:45`: the 25 h `event_id` cache. Its comment says "Single-pod-only". A Slack retry on the other replica passes the check (duplicate task). The socket path also has the durable `isSlackSocketEventStored`. Replace with a claim row on `event_id`.
- `src/slack/handlers.ts:371`: `processedMessages` dedups message keys for 60 s. Same failure. Same fix.
- `src/slack/watcher.ts:48`, `:51`, `:54`, `:57`: `notifiedCompletions`, `sentProgress`, `pendingSends` and `lastSendTime` dedup and throttle progress posts. Both watchers post the same progress update (duplicate Slack messages). Completions are already claimed in the DB (`:540`). Replace with a claimed `last_progress_hash` per task row, or one watcher leader.

### Rate limits and concurrency caps

- `src/slack/handlers.ts:386`: `rateLimitMap` caps Slack requests per user per minute. With N replicas the cap becomes N times larger. Replace with a counter row or KV `incr` with expiry.
- `src/be/mcp-events/protocol.ts:135-136`: `verificationLog` holds the per-user and global hourly verification budget. The comment says to upgrade for replicas. Budget becomes N times larger. Same fix.
- `src/http/db-query-bounded.ts:80`: `activeBoundedQueryCount` caps concurrent bounded `db-query` children per process. The cap becomes N times larger. Replace with a shared semaphore (advisory locks `0..cap-1` tried in turn).
- `src/be/savings/read.ts:165`: `scansInFlight` caps first-day scans at 2 per process. The DB sees 2N. Same fix, or accept.
- `src/tasks/follow-up-gate.ts:140-141`: `inFlight` and `pending` cap concurrent follow-up verifiers per process. The cap becomes N times larger. Same fix, or accept.
- `src/http/savings-calibration.ts:24`: `running` allows one calibration run at a time. Two replicas run two calibrations at once (double heavy scan, last write wins). Replace with a session advisory lock.

### Single-flight work guards

- `src/be/primitives/objects.ts:107-108`: `reindexing` guards one drive reindex. The comment already states two replicas duplicate the work. Replace with a session advisory lock per drive.
- `src/be/memory/embedding-space.ts:346-348`, `src/be/memory/embedding-recovery.ts:10-11`: re-embed and backfill run "one at a time" per process. Two replicas re-embed the same rows in parallel (double embedding cost, write conflicts). Replace with a session advisory lock around maintenance.
- `src/be/runtime-pools/e2b-images.ts:7`: `builds` tracks in-flight E2B image builds per pool. Two replicas build the same template. Replace with a claim row per build.
- `src/be/runtime-pools/recovery.ts:23`: `recovering` single-flights recovery per runtime. Two replicas recover one runtime at once (double restart). Replace with a lease on the runtime row.
- `src/http/savings.ts:559`, `:561`: `inFlight` and `scannedAt` limit today's savings refresh to one scan per minute per workflow. Each replica scans on its own (duplicate scans). Accept, or move `scannedAt` to a row.

### Ingress coalescing buffers

- `src/slack/thread-buffer.ts:176`, `src/tasks/additive-buffer.ts:24`: the Slack thread buffer debounces follow-ups per thread in memory. Its base says "single-process, no cross-instance locking". Messages of one thread that land on two replicas form two buffers and two tasks. Replace with a buffer table and a per-key lease, flushed by the lease holder.
- `src/integrations/chat-sdk/thread-buffer.ts:33`, `:43`: the Chat SDK buffer and `flushChains` keep per-thread order. Two replicas split one thread and lose the order (`dependsOn` breaks). Same fix.
- `src/agentmail/handlers.ts:34`: `agentmailBuffer` coalesces mail per context key in memory only. Same split, and a restart drops it. Same fix.

## 3. Caches

- `src/http/index.ts:705`, `src/http/core.ts:98`, `:317`: `swarm_config` values are copied into `process.env` at boot and on reload. A config write (`src/tools/swarm-config/set-config.ts:156`, `src/http/config.ts:236`, and five more callers) schedules `scheduleIntegrationsReload` only on the replica that served it. The other replica keeps the old env until restart (stale read). This is the root of most config staleness. Replace with a config version row plus NOTIFY (or a short poll), running the same reload on every replica.
- `src/github/app.ts:5-8`, `src/gitlab/auth.ts:11-14`, `src/bitbucket/auth.ts:13-15`, `src/azure-devops/auth.ts:13-16`, `src/agentmail/app.ts:5-6`, `src/linear/app.ts:9`, `src/jira/app.ts:11`: integration init captures webhook secrets and tokens. A rotation on A leaves B verifying with the old secret (rejected or wrongly accepted webhooks). Fixed by the reload fan-out above.
- `src/fs/registry.ts:5`: `memoizedProvider` picks local-fs or agent-fs once. Only the reloading replica resets it. Fixed by the reload fan-out.
- `src/be/memory/index.ts:3-4`: `embeddingProvider` and `memoryStore` are reset on reload only locally. A new embeddings key stays inert on B. Fixed by the reload fan-out.
- `src/integrations/chat-sdk/runtime.ts:49`, `:53`: Chat SDK adapter instances and `appliedFingerprint` change on reload only locally. B keeps the old adapter config. Fixed by the reload fan-out.
- `src/utils/secret-scrubber.ts:1108`, `:1112`, `:1686`: runtime-registered secret values and sensitive key names live in memory. The boot registry load (`src/be/secret-registry.ts:103`) covers stored secrets, but a secret saved on A after boot is unknown to B's scrubber, so B can log it unredacted (security). Replace with NOTIFY on secret write that re-registers on every replica.
- `src/be/model-catalog-store.ts:504-505`, `:520`, `src/be/models-catalog.ts:149-150`: the served model catalog and pricing live in memory and reload on refresh or overlay write. Only the writing replica reloads. B serves old pricing, so recomputed USD differs by replica. Replace with a catalog generation row checked on read or NOTIFY.
- `src/be/model-tier-resolution.ts:185`: `cachedCatalog` drops on a local generation bump. On the other replica it waits for its 30 s TTL (stale tier resolution). Fixed with the catalog generation row.
- `src/linear/client.ts:5`: `linearClient` keeps the access token it was built with. After a refresh on A, B calls Linear with an expired token until reset. Replace with a token-keyed client or the refresh NOTIFY.
- `src/linear/sync.ts:39`: `taskSessionMap` maps tasks to Linear agent sessions, filled by the webhook. Outbound sync on the other replica finds nothing and posts no activity (lost update). Replace with a column or table.
- `src/slack/watcher.ts:71`, `:74`, `:78`: `treeMessages`, `taskToTree` and `taskMessages` are hydrated only at watcher start. A tree started on A is unknown to B's watcher, which renders flat or skips it. Replace with reads from `slack_messages`, or one watcher leader.
- `src/slack/external-channel.ts:32`, `:35`: `externalityCache` and its generation are invalidated locally. B treats a newly shared external channel as internal until the TTL ends, so internal content can reach an external channel (security). Replace with NOTIFY on invalidation, or a much shorter TTL.
- `src/rbac/elevated-agents.ts:12`, `src/extensions/dispatcher.ts:40-42`: the loaded extension set and the lead-equivalent agent set are per process. They converge through the 30 s reload poll (`src/extensions/lifecycle.ts:37`, `:354`). After a disable, an extension keeps running and keeps lead privileges on B for up to 30 s. Replace with NOTIFY on extension change.
- `src/telemetry-identity.ts:28`, `src/telemetry.ts:95-109`, `src/be/telemetry-enable.ts:19`: user role cache, org identity and the telemetry on/off state are per process. B tags events with old roles or keeps sending after opt-out until its own reload. Fixed by the reload fan-out plus a role TTL.
- `src/http/usage-cache.ts:24`, `src/http/savings.ts:384`, `:576`, `src/be/savings/read.ts:156`, `:345`, `src/be/skill-usage.ts:21`, `src/http/fleet-benchmark.ts:94-95`: TTL caches over aggregate reads. `clearUsageCache` and `clearCalibrationCache` clear only the local copy. B serves stale reports for up to the TTL (30 s to 5 min). Accept, or invalidate through NOTIFY.

Safe across replicas (immutable after boot, keyed by immutable data, or caching external data equally stale everywhere): 21 caches. `src/http/openapi.ts:16`, `src/telemetry-trigger.ts:24`, `src/slack/handlers.ts:256`, `:261`, `:266`, `src/slack/assistant.ts:42`, `src/slack/thread-participants.ts:170`, `src/slack/enrich.ts:242`, `src/slack/channel-activity.ts:21`, `src/github/app.ts:11`, `:20`, `src/bitbucket/api.ts:21`, `src/azure-devops/api.ts:49`, `src/be/modelsdev-cache.ts:45`, `src/be/scripts/typecheck.ts:1406`, `src/workflows/predicate-sandbox.ts:19`, `src/be/runtime-pools/controllers.ts:24`, `src/runtime-providers/docker.ts:74`, `src/runtime-providers/boxd.ts:52`, `src/http/script-connections.ts:1012`, `src/http/tool-schema-estimate.ts:74`.

## 4. Timers and background loops

None of these loops has leader election. Each replica starts all of them from the listen callback in `src/http/index.ts:831-1058`.

### Double run with real damage

- `src/heartbeat/heartbeat.ts:938`, `:2063`: the reboot sweep runs 5 s after boot and auto-fails every `in_progress` task claimed before this boot whose session has not heartbeated since this boot. A second replica that boots fails the first replica's live tasks and spawns retries (double run, killed work). Replace with a leader, and base "orphaned" on a session lease, not on the local boot epoch.
- `src/heartbeat/heartbeat.ts:2051`, `:2074`, `:418`: the regular sweep remediates stalled tasks. `isSweeping` guards only the local process. Two sweeps remediate one task at once (duplicate retry tasks). Replace with a leader.
- `src/heartbeat/heartbeat.ts:2169`, `:2179`, `:2191`, `:1844-1849`, `:2112-2117`: the checklist loop and the boot triage task dedup with a read, then a long gate script, then an insert, outside one transaction. Two replicas create two lead checklist or boot triage tasks. Replace with a leader or a claim row.
- `src/workflows/index.ts:99`, `src/workflows/recovery.ts:51`, `:59`: `recoverIncompleteRuns` runs at every boot and during heartbeat sweeps. It treats runs the other replica is walking as interrupted (see `activeWalks`) and walks them again (double step execution). Replace with a lease per run, then recovery takes only expired leases.
- `src/script-workflows/supervisor.ts:137`, `:149`, `:162`, `:165`: every 15 s the supervisor restarts each running script run that has no local handle and whose PID is not running on this host. On B the PID from A is never running here, so B starts a second process for a live run (double run, and a recycled PID can look alive). Replace with an owner replica column plus the script-run heartbeat as a lease.
- `src/be/runtime-pools/supervisor.ts:63`, `:66`, `:870`, `:915`, `:926`, `:928`: the runtime supervisor reconciles pools every 5 s and on `task.created`. `inFlight` and `orphanFirstSeen` are local. Two reconcilers can spawn the same runtime twice or terminate one the other just started. Replace with a leader.
- `src/be/runtime-pools/routing.ts:300`, `:315`, `:319-321`: the pool router sweeps unassigned tasks on a timer and on task events, guarded by a local `isSweeping`. Two routers offer the same tasks at once (conflicts, possible double offer). Replace with a leader or `FOR UPDATE SKIP LOCKED` (the dialect already has `forUpdateSkipLocked`).
- `src/be/user-merge-jobs.ts:440`, `:491`: at boot `resumeUserMergeJobs` calls `resetInterruptedMergeJobs`, which re-queues every running job. A second replica's boot re-queues a job the first is running (double merge). Replace with a lease on the job row.
- `src/slack/watcher.ts:649`, `:884`: the Slack task watcher runs on each replica. With the in-memory send dedup above, both post progress (duplicate messages). Replace with a leader.
- `src/queue-stall-alarm.ts:22`, `:117`, `:127`: each replica checks the queue and keeps `alarmActive` locally. Both post the stall alarm and its recovery (duplicate alerts). Replace with a leader or a durable alarm state row.

### Double run, mostly safe but wasteful

- `src/scheduler/scheduler.ts:56`, `:603`, `:626`, `:421`: both replicas poll schedules and run boot recovery. `claimScheduleOccurrence` (`:352`, `:368`) compares `nextRunAt` inside a SERIALIZABLE transaction, so one occurrence fires once. Cost: double polling and serialization retries. Replace with a leader for efficiency.
- `src/workflows/retry-poller.ts:43`, `:65`, `:88`: both replicas poll retryable steps. `claimRetry` is atomic. Leader for efficiency.
- `src/workflows/wait-poller.ts:27`: both replicas poll due waits. `resumeWaitState` is an atomic update. Leader for efficiency.
- `src/integrations/chat-sdk/relay.ts:238`, `:308`, `:312`: both replicas relay pending chat replies. `markChatRelayAttempted` gates each attempt. A replica whose adapter is down skips rows the other can send, which is correct. Leader for efficiency.
- `src/be/db-retention.ts:214-218`, `:828`, `:835`: both replicas run batched retention deletes every hour and keep stats locally. Deletes conflict and metrics double. Replace with a leader.
- `src/be/savings/rollup.ts:488`, `:492`: both replicas roll up savings hourly and backfill 90 days at first start (double heavy work, write conflicts). Replace with a leader.
- `src/be/human-free-drain.ts:16`, `:53`, `src/be/db/tasks/human-free.ts:118`: both replicas drain the reclassify queue. A request wakes only the local drain. Batches conflict. Replace with a leader or `SKIP LOCKED` batches.
- `src/be/db/tasks/search-index.ts:119`, `:143`: each replica runs the task search backfill from the watermark (duplicate batches). Replace with a session advisory lock.
- `src/oauth/keepalive.ts:13`, `:106`, `:127`: both replicas refresh tracker tokens. The DB refresh lock in `ensure-token` keeps it correct. Cost: duplicate provider calls. Leader optional.
- `src/be/oauth-refresh-sweep.ts:111`, `:141`, `:158`: same as keepalive for all `oauth_apps`. Leader optional.
- `src/be/pricing-refresh.ts:208-209`, `:309`, `:314`: both replicas fetch models.dev and write the catalog. The forced-refresh rate limit is per process. Only the writer reloads its memory (see caches). Replace with a leader plus the catalog generation row.
- `src/telemetry-snapshot.ts:93`, `:140`, `:173`: both replicas emit the daily `org.snapshot` and recompute the org domain (duplicate telemetry events). Replace with a leader.
- `src/jira/webhook-lifecycle.ts:347`, `:366`: both replicas refresh Jira dynamic webhooks every 12 h and at boot (duplicate API calls, racing refreshes). Replace with a leader.
- `src/http/oauth-callback.ts:355`, `:357`: pending OAuth session GC on each replica. Idempotent deletes. Leader optional.
- `src/be/mcp-overflow-sweep.ts:27`, `:29`: overflow KV sweep on each replica. Idempotent. Leader optional.
- `src/http/memory.ts:1670`, `:1683`: expired memory GC on each replica. Idempotent. Leader optional.
- `src/be/rbac-audit.ts:250`, `:260`: audit retention GC on each replica. Idempotent. Leader optional.
- `src/be/scripts/retention.ts:142`, `:145`: scratch script GC on each replica. Idempotent. Leader optional.
- `src/http/index.ts:898-916`: at boot each replica sets the agent-fs org swarm URL and re-checks object webhooks for every drive (duplicate external calls). Leader optional.
- `src/http/index.ts:1020-1057`: at boot each replica runs embedding maintenance, the args-schema backfill, the scrub retro-sweep and the session-source backfill. They are idempotent and resumable, but run twice in parallel (double cost, conflicts). Replace with a session advisory lock per job.

Per-replica by design (keep one per replica, no change): 11 loops. `src/http/index.ts:251` (room sweep and idle MCP transport close), `src/http/index.ts:667` (event-loop lag probe), `src/extensions/lifecycle.ts:354` (extension reload poll), `src/be/rbac-audit.ts:214` (audit buffer flush), `src/slack/app.ts:275` (socket watchdog), `src/slack/event-dedup.ts:57` (cache cleanup), `src/realtime/transport.ts:555` and `src/http/controllers-connect.ts:157` (socket pings), `src/integrations/chat-sdk/typing.ts:48` (typing keepalive), `src/script-workflows/executor.ts:422` (script-run heartbeat), `src/http/webhooks.ts:181` (ignored-event log summary).

## 5. Single-owner connections

- `src/slack/app.ts:34`, `:385`, `:489`: in Socket Mode each replica opens its own socket. Slack spreads events across open connections, so dedup, thread buffers and watcher state split between replicas, and each runs its own watchdog. HTTP mode (`:36`) suits replicas better. Replace with a socket-owner leader (others serve HTTP only), or require `SLACK_MODE=http` for more than one replica.
- `src/slack/app.ts:454`, `src/slack/inbound-dispatch.ts:627-628`, `src/be/db-queries/slack-inbound.ts:349`: at Slack start each replica marks every `processing` inbound receipt `uncertain`, assuming its owner died. A second replica's start strands the first replica's live receipts (lost replies). Replace with an owner and lease on receipts.
- `src/integrations/chat-sdk/schema.ts:89`, `src/integrations/chat-sdk/adapters.ts:200`: the Chat SDK Slack adapter can run in socket mode too. Same split as Bolt Socket Mode. Same fix.
- `src/integrations/chat-sdk/discord-gateway.ts:67`, `:147`, `src/integrations/chat-sdk/runtime.ts:156-162`: each replica opens a Discord Gateway session for the bot. Without sharding, both sessions receive each message (duplicate tasks). Replace with a gateway-owner leader.
- `src/integrations/chat-sdk/schema.ts:81`: Telegram polling mode long-polls `getUpdates`. Telegram allows one poller per token, so two replicas fight with conflict errors and steal each other's updates. Replace with a poller leader, or require webhook mode.
- `src/http/index.ts:288-294`, `src/http/mcp.ts:157`, `:196`, `src/http/mcp-user.ts:47`, `:76`: MCP Streamable HTTP sessions live in a local `transports` record. A request with an `mcp-session-id` from the other replica finds no session (failed calls, forced re-init, lost in-flight streams). Replace with sticky routing on `mcp-session-id`, or a stateless MCP transport.
- `src/realtime/transport.ts:189`, `:221`, `src/realtime/tickets.ts:16`, `:28`, `:50`: realtime WebSocket tickets are issued over HTTP into a local `Map` and redeemed at upgrade. A ticket from A fails an upgrade that lands on B. Replace with signed (HMAC) tickets or a ticket table, plus the bus fixes in section 1.
- `src/http/controllers-connect.ts:56`, `src/be/runtime-pools/remote-controller.ts:22`: runtime controllers hold a WebSocket to one replica, kept in `sessions`. A runtime operation on the other replica finds no session (failed spawn or stop). Replace with a command queue table or NOTIFY to the replica that holds the socket.

## 6. Local files and process-local resources

- `src/be/crypto/key-bootstrap.ts:109`, `:129`, `src/be/db/runtime.ts:401`: without `SECRETS_ENCRYPTION_KEY`, the key lives in `<data dir>/.encryption-key` and is generated when no encrypted rows exist. The StatefulSet gives each replica its own volume (`charts/agent-swarm/templates/api-statefulset.yaml:136`, `:162`). Two fresh replicas generate two keys, and each later fails to decrypt the other's secrets. Replace with a required shared key (env or Kubernetes Secret) for more than one replica.
- `src/utils/page-session.ts:41`, `:113`: the page-session signing secret is generated into the data dir. A cookie signed on A fails on B (forced re-login, broken public pages). Same fix: a shared secret.
- `src/fs/local-fs-provider.ts:17`, `:28`: without agent-fs, files go to `./data/fs` (or `AGENT_FS_LOCAL_DIR`) on the local volume. A file uploaded through A is missing on B. Replace with a required shared provider (agent-fs or object storage) for replicas.
- `src/script-workflows/supervisor.ts:23`, `src/script-workflows/executor.ts:185-186`: a durable script run is a child process with a temp dir and a capability socket on one host, tracked in `managed`. Stop, pause and abort requests served by the other replica cannot reach it. Replace with an owner replica column and NOTIFY-forwarded commands.
- `src/script-workflows/supervisor.ts` tracks launches in `starting`. This prevents duplicate local launches. Other API replicas need the durable ownership lease.
- `src/be/scripts/legacy-journal-credential.ts` keeps historical replay grants in API memory. Route their journal requests to the issuing API for the lifetime of the replay.
- `src/utils/process-group.ts:10-11`: `liveProcessGroups` and `terminations` track sandboxed child groups locally. Cleanup and kill run only on the owning replica. Fixed with the owner routing above.

## 7. Other

- `src/be/api-drain.ts:11`, `:33`: drain state is per process, and a draining API marks responses `X-Swarm-Draining: 1`. When one replica drains on a rolling deploy, its workers supersede their in-flight tasks although the other replica keeps serving. Replace with a drain that applies only when the last replica stops, or drop the worker reaction when other replicas are live.
- `src/http/index.ts:662-663`: the boot id `run_<ms>` feeds the heartbeat boot epoch and the business-use `api` flow run id. With replicas, "the API boot" is no longer one moment (see the reboot sweep). Replace with a per-replica id plus a replica registry table (id, started at, last seen).
- `src/http/poll.ts:221`: `lastChannelActivityCheckAt` throttles the channel activity check to once per 60 s per process. N replicas check N times as often. Accept, or move to a row.
- `src/azure-devops/boards-sync.ts:297`, `src/workflows/resume.ts:785`, `src/slack/event-dedup.ts:23-24`: these comments justify process-local state with "the API is the single DB owner". A later goal should grep for that idea again after its changes, because new code keeps adding it.

## Hardest blockers

1. Workflow execution ownership (`activeWalks`, `executingSteps`, `owed`, `ownedChildren`, boot and heartbeat recovery). Correctness depends on process memory at many points in the engine. It needs a run and step lease model, not a lock.
2. Realtime rooms (in-memory Yjs documents with delayed flush). They need one owner per room or a real CRDT relay.
3. The heartbeat reboot sweep and the other boot-time "everything running is orphaned" resets (script-run supervisor PID check, user-merge reset, Slack receipt reset). They need a replica registry and leases before any replica can safely boot next to another.
4. Config reload into `process.env`. Many integrations read env at call time or capture it at init, so a config write must re-run the full reload on every replica.

## Script-runner link

- `src/be/script-runners/sessions.ts`: `scriptRunnerSessions` and each runner's pending map belong to one API process. Jobs and their waiters cannot move between replicas.
- `src/http/script-runners-connect.ts`: handshake and ping timers, sockets and credential callbacks belong to the API process that accepted the connection.
- `src/script-runner/client.ts`: active jobs and reconnect timers belong to one runner process. A disconnect aborts inline jobs before reconnect.
- `src/scripts-runtime/dispatch/dispatcher.ts`: the remote picker resolves sessions from this API process only. This registry does not enable multiple API replicas.

## Sync script capacity

The FIFO sync queue, slot counters and waiters live in API process memory.
An API restart loses queued callers. Multiple API replicas do not share placement or queue metrics.

### Durable execution tier state

`src/be/script-runners/durable-dispatch.ts` retains capability sessions and held jobs in this API process.
`src/script-workflows/capability-session.ts` retains broker calls and responses for reconnect.
`src/script-workflows/supervisor.ts` owns the lease sweep timer and the `embedded:<bootId>` identity.
`src/scripts-runtime/dispatch/held-reservations.ts` retains shared slot reservations.
These files still require one API process per database.

## Execution bus additions

- `packages/storage-postgres/src/bus/table-backend.ts`: subscriptions and the delivery timer belong to one process. Wake-up subscriptions only reach that process.
- Delivery claims use SERIALIZABLE transactions and `FOR UPDATE SKIP LOCKED`. A unique token fences each acknowledgement across processes.
- `src/be/script-runners/durable-dispatch.ts`: the API subscribes to `script.job.requested`. The supervisor recovery scan remains necessary after lost wakes.
- Existing realtime and workflow bus subscribers retain their current behavior.

# Execution tier verification

This branch adds a PostgreSQL execution tier for one API owner. SQLite keeps embedded execution. Opus 5.5 reviewed all eleven implementation phases. The tests used disposable credentials, databases, runners and a local Kubernetes cluster.

## Observed behavior

| Area | Check | Result |
|---|---|---|
| Embedded execution | Two baseline scenarios on both engines before and after the dispatcher split | All four pairs passed. The eleven existing unit files passed 258 tests. |
| Upgrade and identity | Boot a database written by the reference API and resume a durable run | The stored agent credential retained its identity. The durable run produced 42. Older ambiguous manual records require a known principal before replay. |
| Revocation | Exercise operator run credentials and revoke an active runner credential | HTTP rejected the expired run authority. Revocation closed its registered connection. The API stored only the runner token hash. |
| Placement | Run native and QuickJS scripts on two registered Kubernetes runners | The native process reported UID 65534. QuickJS returned 42. The session counters recorded each remote execution. |
| Admission | Run six requests against bounded capacity and inspect queue depth | Depth reached four, then returned to zero. A durable object committed after 42.414 seconds in the queue. |
| Durable execution | Interrupt a runner with SIGTERM, SIGKILL and SIGSTOP in separate PostgreSQL runs | The original focused run passed all three transfers. Each journal contained three completed steps. The two long slots admitted two runs while a sync job completed within two seconds. |
| Durable delivery | Commit, roll back, restart after commit and claim concurrently on PostgreSQL | The crash test recovered the committed event. Twenty public launches produced 20 events, 20 deliveries and 20 successful acknowledgements. |
| Workflow fanout | Park eight one-second bodies on four available slots, then run forty bodies on one slot | Eight bodies completed in 2.735 seconds with four running together. All forty completed on one slot. The dashboard showed the parent and eight bodies waiting. |
| Database copy | Copy, reject a populated target, upgrade a copied target and compare PostgreSQL layouts | All four public scenarios passed. Existing pending bus work survived a refused copy. |
| Credential issuer | Delete or reassign the creator, check operator credentials, and check old writers | Migration 384 preserves the original issuer separately from audit attribution. Tests confirmed refusal after reassignment. Both storage suites passed, with 415 SQLite and 516 PostgreSQL tests. |
| Shell workflow nodes | Compare embedded and remote Bash, TypeScript and Python on PostgreSQL | The focused scenario passed with 72 API calls. It checked output, nonzero exits, timeout, runtime selection, working directories, redaction and descendant cleanup. |

## Combined API restart

The workflow step, durable guest and synchronous child occupied three remote slots at once. The first integration attempts lost the workflow child during the API shutdown.

A real WebSocket control on `86412c6570` received HTTP 401 during drain. Commit `82e0ef397f` kept the upgrade handler installed until the HTTP server closed. The same control received HTTP 503.

The repaired PostgreSQL scenario passed on its first attempt, in 47.8 seconds. The API was unavailable for 10.905 seconds. The runner reauthenticated 431 ms after health returned. The guest SDK observed eleven refused connections.

The original workflow process completed under the same claim. The sync caller failed and its child exited. The durable guest exited, and a replacement replayed its journal. Each of the two independently counted effects occurred once. This test covers the initial 30-second reconnect window. Longer outages use the documented backoff.

The ten-step manual walkthrough also passed on `5352fdd087`. Eight one-second bodies finished in 2.660 seconds across four slots. A separate restart preserved all four running workflow children and completed all eight items. Both runners reconnected within 236 ms of API health. [Manual commands and receipts](2026-11-25-execution-tier-manual-e2e-e77d1a34.md)

## Kubernetes pod deletion

The first local cluster test used Linux binaries from `39e5a796e0` in the earlier runner image. Recovery took 27.53 seconds.

A second test built the complete Dockerfile from `061bd3870a` and imported the image into a fresh cluster. The API and both runners reported image ID `sha256:e9eee21537148fec584a8ae736ccefd1bb831c1b486fab3b72fd2bcc3f0f1f94`. Native execution reported UID 65534. QuickJS returned 42.

The test deleted the Kubernetes pod that owned a running durable guest. The surviving runner completed the run in 26.602 seconds. Two guests executed the source, the first journal entry stayed identical, and the counted effect occurred once. The three journal results were 41, 1 and 0. KEDA configuration received template validation.

The final image test built `73aaec431e` and ran it in a fresh cluster. The API and both runner pods reported image ID `sha256:3570b95f7ba08514e5f4bed9dca76e45470b9c2b5bcb9b2d2dcfcf6b3b222d7c`. The imported manifest digest was `sha256:c7ddbbcf70ddb6a18e145780bbfd4ab5bc1ef794ea136e315d9e13c3ac423c83`.

Deleting the owning pod triggered recovery in 28.167 seconds. Both native guests ran under UID 65534. QuickJS returned 42. The replacement guest preserved the first journal entry and completed all three steps. Two guests executed, and the journaled effect occurred once.

## Performance

Three paired rounds of 300 HTTP requests gave median p50 changes of +0.144 ms for native and +0.028 ms for QuickJS after the dispatcher split. Individual rounds exceeded the 0.5 ms target.

The Phase 1 five-round scenario comparison had 27 consistently passing pairs. Sixteen had a median slowdown above 5% on this shared host. The machine's load average exceeded 40 during these measurements. These runs leave the 5% criterion open.

On `5352fdd087`, all 46 shared script and workflow scenarios passed twice without a runner. The comparison used three main passes. Sixteen scenarios exceeded 5% by median. The sum of medians was 3.1% lower on the branch. Four scenarios had disjoint timing ranges. Their slowdowns did not recur in four isolated runs per revision. The full-batch limit remains open.

The durable benchmark made 200 calls per operation. Remote p50 was 40.03 ms for a new step, 3.00 ms for replay and 5.67 ms for a swarm call. The embedded measurements ran under heavier load and cannot establish transport overhead.

The workflow benchmark used forty 500 ms bodies and two slots per runner. Elapsed times were 23.56 seconds sequentially and 15.33, 20.90 and 11.55 seconds with one, two and four runners. Machine load and transaction retries varied.

## Integration review

The final Opus 5.5 review approved the integration. Three details received further checks.

- Durable launch accepts an authenticated agent or operator. The public API description now documents its 403 response. The reference API already refused a user token naming an agent on this route.
- Deleted agents and inactive users receive a structured executor error. Direct credential acquisition still refuses an unknown principal. All sixteen credential tests passed.
- The dispatch failure handler calls the owner-checked release function. It deletes the active entry, aborts execution, releases the credential and returns capacity.

The integrated affected unit suite passed 9,674 tests, with 31 skips. Both TypeScript 5 projects passed. The storage SQL portability, RBAC coverage and async checks passed. Three additional failures from the full root suite reproduced in isolation on main at `361eb90ca4`. They cover a Pi model presence check and two macOS shell path expectations.

On `73aaec431e`, all eight PostgreSQL execution scenarios passed on their first attempts. Eight one-second workflow bodies completed in 3.533 seconds with four running together. The combined restart took 3.293 seconds. The runner reconnected 27 ms after API health returned. The same workflow child survived, two durable guests executed, and each journaled effect occurred once.

The full root suite on that revision recorded 23,318 passes, 43 skips and the three failures reproduced on main. The SQLite strict suite on the preceding integration revision passed all coverage checks. It recorded 290 first-attempt passes and two passes on retry.

The database-copy check upgraded a disposable SQLite database from migration 383 to 384, then copied it to PostgreSQL. Each legacy credential kept its revocation date. The new operator credential stayed active. The old writer's empty issuer stayed distinct from the operator's null issuer.

The full dashboard run had 295 passes, 79 skips and one failed Slack sidebar assertion. That case passed on an isolated rerun. Live KEDA scaling and the 5% performance criterion remain unverified.

## Reproduction

Use the repository's Bun version and a disposable PostgreSQL 16 database with pgvector. The API needs its normal storage owner lock. Set `DESPLEGA_TELEMETRY_ENV=test` for local verification.

```sh
bun run e2e --only workflow-script-sync-baseline,script-schedule-fire
bun run e2e --engine postgres --only script-runner-credentials,script-runner-remote-sync,script-runner-capacity
bun run e2e --engine postgres --only script-runner-durable,stress-bus-claim,bus-launch-recovery
bun run e2e --engine postgres --only workflow-script-fanout,workflow-script-park-restart
bun run e2e --engine postgres --only workflow-script-node-remote,script-runner-api-restart
```

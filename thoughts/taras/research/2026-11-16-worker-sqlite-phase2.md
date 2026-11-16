# Worker SQLite Phase 2 evidence

Taras, Phase 2 is completed. The parent accepted the gate after independent Standards and Spec reviews.
QA Doc: n/a. The plan defines no manual Phase 2 verification or QA document.
Phase 1's manual protocol review remains unconfirmed under autopilot.

Workspace: `/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc`.
Branch: `t3/research-async-database-options`.
HEAD: `556461bfc0e2249991eab35df5c606ed5813ad1f`.
Runtime: Bun 1.4.4 (`38afee6c8`).
No subagents, Git publication, deployment, Docker build, or Phase 3/4 implementation occurred.
The plan and prior research remain unchanged by this phase.

The patch contains 56 implementation and verification paths: 54 existing paths and two new files.
Each existing file had a task-owned baseline copy before its first edit.
The patch compares those copies with the final files, rather than comparing against Git HEAD.
The working tree contained approximately 680 preserved paths at the start.
The patch excludes changes that preceded this phase, including prior changes within paths touched again.
It also excludes this report and the patch artifact itself.
Reverse-apply validation passed against the final workspace.
Current patch SHA-256: `921589703d1a65af41b41145fe25f24430356770c7df713b86da38cba1182577`.
Patch size: 155100 bytes. Patch summary: 56 files, 938 insertions, 482 deletions.
The current patch includes the parent correction described below.

## Independent reviews and parent closure

Both reviews used the original patch SHA-256 `41cdf582477f62159d4c8f70077d180d43d822ebe93866146987e4a2051c59b1`.

### Standards

Verdict: pass with one Minor finding. No Critical or Important findings.
The ownership probe checked aggregate completion. One loader could finish early while another kept the aggregate pending.
The reviewer reproduced that gap but found no production violation.
The parent changed the probe to track each operation's fulfillment or rejection separately.
It now reports the name of any operation that settles before the owner releases its lock.

### Spec

Verdict: pass with no findings.
The reviewer checked the Phase 2 requirements and applicable Swarm Apps invariants.
Fresh checks passed the 54-check repository probe and 56 independent assertions across both drivers.
Caller inspection and static checks confirmed asynchronous routing and preserved generated declarations.

### Parent verification

The corrected probe passed all 54 checks, with 140 observed runtime statements per driver.
Temporary copies replaced the queued listing with a direct SQLite read that completed before transaction release.
Both driver variants failed at the intended ownership check and named `listing`.
Biome, direct probe typechecking, whitespace validation, and incremental patch reverse-apply validation passed.
Production source remained unchanged after the independent reviews. The parent did not repeat the broad suites for this probe-only correction.
This correction is a parent resolution, not a claim of another independent review.
The parent accepted Phase 2 and authorized Phase 3 under the existing autopilot instruction.

Correction commands used synthetic credentials, `NODE_ENV=test`, and loopback telemetry:

```sh
bun --no-env-file scripts/probe-db-runtime-loaders.ts
bunx --no-install biome check scripts/probe-db-runtime-loaders.ts
bun x --no-install tsc --noEmit -p <owned-temporary-directory>/tsconfig.json
git diff --check
git apply --reverse --check thoughts/taras/research/2026-11-16-worker-sqlite-phase2.patch
```

The temporary mutation scripts, typecheck configuration, and metadata fixture were removed.
Available space increased from 16,846,672 KiB to 16,846,688 KiB during that cleanup, an observed increase of 16 KiB.
OrbStack remained stopped. No shared cache was removed.

## Behavior and source routing

- Runtime prompt listing and resolution use `getDbClient()` in `src/be/db.ts`.
- The shared prompt query builder and mapper live in `src/be/db/prompt-templates.ts`.
- `src/be/db/prompt-templates-boot.ts` provides synchronous listing for startup seeding.
- The seeder imports that loader and the existing synchronous mutation helpers.
- Phase 1's asynchronous upsert/reset bodies remain unchanged. Their history writes retain the transaction executor.
- `DbResolverFn`, DB resolution, and reference expansion are asynchronous in `src/prompts/resolver.ts`.
- Each expansion owns its `matchAll` iterator and cursor. Existing cycle and depth guards remain.
- `resolveTemplate` returns synchronous code defaults. Runtime overrides use `resolveTemplateAsync`.
- The baseline caller audit counted 54 runtime calls across 22 files, rather than the plan's older count.
- The required resolver audit returns zero matches. No old synchronous connection-loader identifiers remain in source.
- Script type and descriptor loaders await `listScriptConnectionsAsync`. Their pure generation logic remains unchanged.
- Optional typecheck inputs load within async function bodies. Tools, routes, apps, saved scripts, schedules, and workflows await loaders.
- `scripts/bundle-script-types.ts:45` already awaited its type helper, so it required no edit.
- Asset loaders share SQL constants and pure validation. Every runtime read uses the supplied executor, including user lookup.
- `src/http/assets.ts:247` and session movement already used transaction-bound audits from Phase 1.
- The asset HTTP seam exemption was already absent. This phase removes the script-connections exemption.
- The new prompt boot loader has a narrowly documented boot exemption.
- An AST audit finds raw `getDb()` calls in `db.ts` only inside `upsertPromptTemplateForBoot` and `resetPromptTemplateToDefaultForBoot`.
- The new boot list loader and synchronous asset startup audit retain raw reads. Runtime connection loaders contain no raw DB access.
- DB_DRIVER defaults, Worker transport, transaction error handling, and memory initialization remain unchanged.

The standalone probe runs both drivers against fresh file databases and deletes its fixtures.
It passed 54 checks: 27 per driver, with 140 captured runtime statements per driver.
Worker instrumentation captures protocol SQL and rejects affected reads through the main boot handle.
SQLite instrumentation captures the same runtime tables through the native driver's query path.
Checks cover loader parity, concurrent references, uncommitted prompt/history/connection/user/key visibility, lock ownership, reset, and rollback atomicity.
The audit fixture includes a known personal user and a deleted personal user without disabling triggers.
A separate local HTTP 503 fixture verifies the code-default fallback.
The black-box prompt scenario verifies the effective driver through authenticated `GET /api/stats`.
It also verifies 12 concurrent nested reference renders and segment totals.
`core-sessions` exercises `/api/session-moves` and `/api/session-moves/prefix` on both drivers.

Existing tests now await runtime resolution and connection loaders. Their expected output assertions remain unchanged.
The Managed Agent stream fixture yields one I/O boundary between events for asynchronous rendering.
Its delayed-render and ownership assertions remain unchanged. Production stream handling remains unchanged.
No new unit test files or `test()` calls were added.

## Verification

Environment: coreutils gnubin first on PATH, TMPDIR=/private/tmp, BUSINESS_USE_API_KEY empty.
Root and affected suites unset DESPLEGA_TELEMETRY_ENV. Explicit test boots use the test tag.
The outer process uses the closed loopback telemetry endpoint requested by Taras.
Black-box SUTs use the harness's own loopback telemetry sink.
No real provider, production database, external telemetry, or Docker target was used.
Heavy test suites ran sequentially.

| Gate | Final result | Duration, seconds |
|---|---|---:|
| `bun run check:local` | PASS | 197.99 |
| `bun run test:root -- --parallel=4` | PASS | 301.45 |
| `bun run e2e --only knowledge-prompt-templates,script-connections,core-sessions --sut-env DB_DRIVER=sqlite --sut-env BUN_OPTIONS=--preload=/tmp/worker-sqlite-phase2/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /tmp/worker-sqlite-phase2/target-sqlite-final.json` | PASS | 7.33 |
| `bun run e2e --only knowledge-prompt-templates,script-connections,core-sessions --sut-env DB_DRIVER=worker --sut-env BUN_OPTIONS=--preload=/tmp/worker-sqlite-phase2/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /tmp/worker-sqlite-phase2/target-worker-final.json` | PASS | 8.81 |
| `bun run e2e --sut-env DB_DRIVER=sqlite --sut-env BUN_OPTIONS=--preload=/tmp/worker-sqlite-phase2/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /tmp/worker-sqlite-phase2/e2e-sqlite-final.json` | PASS | 402.5 |
| `bun run e2e --sut-env DB_DRIVER=worker --sut-env BUN_OPTIONS=--preload=/tmp/worker-sqlite-phase2/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /tmp/worker-sqlite-phase2/e2e-worker-final.json` | PASS | 413.12 |
| `bun --no-env-file scripts/probe-db-runtime-loaders.ts` | PASS | 1.23 |
| `bun tsc --noEmit -p /tmp/worker-sqlite-phase2/tsconfig.json` | PASS | 7.95 |
| `bun run tsc:check:tsc` | PASS | 23.13 |
| `bun run lint` | PASS | 6.18 |
| `bun run lint:slop` | PASS | 1.96 |
| `bun scripts/check-floating-promises.ts` | PASS | 18.34 |
| `bun scripts/check-promise-sinks.ts` | PASS | 16.72 |
| `bash scripts/check-async-db-seam.sh` | PASS | 0.84 |
| `bun run check:unit-test-allowlist` | PASS | 5.69 |
| `bash scripts/check-db-boundary.sh` | PASS | 0.14 |
| `bun run check:dep-graph` | PASS | 3.03 |
| `bun run e2e:tsc` | PASS | 2.12 |
| `bun run build:script-types` | PASS | 1.37 |

- Focused integration: 440 passed, 8 skipped, zero failed, 2,673 assertions across 14 files.
- Affected suite: 14,869 passed, 29 skipped, zero failed, 80,410 assertions across 835 files.
- Full root suite: 22,277 passed, 43 skipped, zero failed, 116,596 assertions across 1,468 files.
- Targeted black-box QA: three scenarios passed per driver, zero failures, skips, or flaky results.
- Full sqlite black-box suite: 155 passed, zero failed, skipped, or flaky, 401.63 seconds.
- Full worker black-box suite: 155 passed, zero failed, skipped, or flaky, 412.14 seconds.
- Full black-box coverage: 505/505 routes, 192/192 MCP tools, and 15/15 workflow node types.
- Floating-promise findings: zero. Promise-sink findings: zero.
- Lint passes with five warnings and four informational findings in files outside this phase.
- `git diff --check` and incremental patch reverse-apply checks passed.

Generated declarations match the pre-Phase-2 baseline byte-for-byte:

| Path | Bytes | SHA-256 |
|---|---:|---|
| `src/scripts-runtime/types/swarm-sdk.d.ts` | 45493 | `56bb8f2b511fc8e513af075ccb29e305615d124cc184d4de27bb6d13fcc37d3a` |
| `src/scripts-runtime/types/swarm-extension.d.ts` | 27281 | `8bf6056421cd764cf9b5eb245bebc5c6946e1713a396c7fd74756e761ce9b94c` |
| `src/scripts-runtime/types/stdlib.d.ts` | 46996 | `99cc479a3d788ce7c08d7d4f396a14d291140427e86344cb6fde6cf1ac56f621` |

Required resolver audit:

```sh
grep -rn 'resolveTemplate(' src --include='*.ts' | grep -v tests | grep -v 'resolveTemplateAsync\|function resolveTemplate\|//'
```

It produced no matches. Additional literal searches found no removed synchronous script-loader names.

The standalone probe typecheck used a temporary configuration extending the repository configuration.
It included the probe, `src/templates.d.ts`, and `src/scripts-runtime/types/swarm-sdk.d.ts`.

Final commands used a task-owned Bun preload to intercept the existing models.dev refresh with a local 503 response.
The preload affected only that host. It did not change scenario assertions or retries.
The recorded temporary paths are removed during cleanup. To recreate the preload:

```ts
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "models.dev") return Promise.resolve(new Response("Phase 2 catalog fixture", { status: 503 }));
  return originalFetch(input, init);
}, originalFetch);
```

## Failures resolved and limits

Early checks found remaining synchronous resolver tests and new helper bodies in the frozen DB facade.
The final implementation migrates those test callers and locates the new helper bodies in domain modules.
The probe fixture initially attempted an invalid personal mapping. It now creates the user before insertion and deletes it afterward.
The probe's Worker hook needed Bun's overload types. Its direct typecheck now passes.

The first full SQLite run passed 154 scenarios and failed telemetry twice, including the harness's automatic fresh-SUT retry.
My explicit SUT endpoint override displaced the harness's telemetry sink. I removed that override.
The isolated telemetry scenario then passed on both drivers before the final full runs.

A preliminary type build lacked the models.dev guard. Its logs cannot prove whether it contacted that public metadata host.
Final generation and black-box verification intercepted that host locally.
The generator also emitted an existing background-refresh warning after DB cleanup during preliminary generation.
The final generator completed successfully and preserved all generated bytes.

The root suite's 43 skips remain skipped. No assertion, retry policy, timeout, or ownership check was weakened.
Compiled packaging was not repeated because these edits create no Worker entrypoint or binary packaging change.
The independent reviews and parent closure appear above. The broad results below the original implementation remain unchanged.

## Exact incremental paths

Paths are relative to the workspace above. Two evidence artifacts follow this list separately.

```text
scripts/check-async-db-seam.sh
scripts/e2e/scenarios/knowledge-prompt-templates.ts
scripts/probe-db-runtime-loaders.ts
src/agentmail/handlers.ts
src/apps/action-runner.ts
src/apps/definition.ts
src/apps/sync.ts
src/azure-devops/boards-sync.ts
src/azure-devops/handlers.ts
src/be/asset-key-audit.ts
src/be/budget-refusal-notify.ts
src/be/db.ts
src/be/db/prompt-templates-boot.ts
src/be/db/prompt-templates.ts
src/be/script-connections.ts
src/be/scripts/run-saved.ts
src/be/scripts/type-contributors.ts
src/be/scripts/typecheck.ts
src/be/seed-prompt-templates.ts
src/bitbucket/handlers.ts
src/comb/review-batch.ts
src/github/handlers.ts
src/gitlab/handlers.ts
src/heartbeat/heartbeat.ts
src/http/pages.ts
src/http/prompt-templates.ts
src/http/script-connections.ts
src/http/scripts.ts
src/http/x.ts
src/integrations/chat-sdk/inbound.ts
src/integrations/kapso/inbound.ts
src/jira/sync.ts
src/linear/sync.ts
src/prompts/resolver.ts
src/scheduler/scheduler.ts
src/server.ts
src/slack/assistant.ts
src/slack/inbound-files.ts
src/slack/thread-participants.ts
src/tasks/worker-follow-up.ts
src/tests/base-prompt.test.ts
src/tests/claude-managed-adapter.test.ts
src/tests/connection-embedded-auth.test.ts
src/tests/cursor-adapter.test.ts
src/tests/prompt-template-github.test.ts
src/tests/prompt-template-remaining.test.ts
src/tests/prompt-template-resolver.test.ts
src/tests/prompt-template-session.test.ts
src/tests/script-connections-mcp.test.ts
src/tests/script-connections-sql.test.ts
src/tests/script-connections.test.ts
src/tests/steering-delivery.test.ts
src/tools/prompt-templates/list.ts
src/tools/script-connections/tool.ts
src/workflows/approval-notifications.ts
src/workflows/executors/swarm-script.ts
```

Evidence artifacts:

- `thoughts/taras/research/2026-11-16-worker-sqlite-phase2.md`
- `thoughts/taras/research/2026-11-16-worker-sqlite-phase2.patch`

## Cleanup

Initial available space was 18 GiB. The task-owned files occupied 20,472 KiB before deletion.
Cleanup removed the task directory, baseline copies, temporary inventories, command logs, and JSON reports after preserving evidence.
The harness removed all recorded SUT databases, logs, temporary credential homes, and secrets directories.
The standalone probe removed its databases and fixtures. No task-owned process remains.
No project clean command exists at the repository root. No shared cache or node_modules directory was deleted.
OrbStack remained stopped. No container or builder was created.

Available space from `df -k /`: 17,247,344 KiB before cleanup and 17,267,684 KiB after cleanup.
The measured available-space increase was 20,340 KiB (19.86 MiB).

Before cleanup:

```text
Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   482797652  12469668  17247344    42%  458788 172473440    0%   /
```

After cleanup:

```text
Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   482797652  12469668  17267684    42%  458788 172676840    0%   /
```

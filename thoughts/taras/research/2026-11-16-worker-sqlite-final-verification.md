# Worker SQLite final verification

Date: 2026-11-16 BCN. Executor: Codex. Status: corrected local acceptance passes. PR checks remain pending.
The final parent decision appears below. Earlier failures remain as historical evidence.
QA Doc: n/a. The Worker SQLite plan has no separate QA specification.

## Source and scope

Workspace: `/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc`.
Branch: `t3/research-async-database-options`.
Pinned HEAD: `e8c136b53dca3bf2c0486ccf9a9665f1ab265f23`.
Parents: `86c40b81a04cce6346fd318d71b05fe8e05d0def` and `974d8c0cca3ba571f8adb7ef7633a9738c32dda3`.
The initial HEAD, branch, parents, and all seven integration hashes matched.
The task preserves the five existing untracked files and the parent's publication directory.
The parent owns source changes, plan changes, commits, pushes, and PR publication.
This task performs no publication, merge, deployment, production application access, or default change.
One supplemental public-documentation check exceeded the requested local-only network scope, as recorded below.
Earlier phase results remain historical evidence.

Read sources: AGENTS.md and identical CLAUDE.md, the complete Worker SQLite plan, integration report, and Phase 4 report.
Testing references: runbooks/testing.md, runbooks/ci.md, LOCAL_TESTING.md, runbooks/e2e-blackbox.md, and scripts/e2e/README.md.
The task also reads relevant merge-gate commands and the Phase 1 production benchmark and compiled smoke recipes.
The current integration's focused memory and lifecycle probes are not repeated separately.

## Environment and isolation

Owned temporary directory: `/private/tmp/worker-sqlite-final.V1ynwI`.
Bun: 1.4.4. Node: v26.0.0. Host architecture: arm64.
OrbStack initially reports `Stopped`.
Initial `df -h /` availability: 11 GiB.

Each command receives a minimal environment containing PATH, HOME, CODEX_HOME, USER, SHELL, LANG, TERM, and SSH_AUTH_SOCK when present.
HOME and CODEX_HOME retain their existing values.
Provider credentials, remote test targets, and deployment configuration do not enter that environment.

```bash
export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
export TMPDIR=/private/tmp
export BUSINESS_USE_API_KEY=
export DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events
export BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-final.V1ynwI/network-guard.ts
export DB_DRIVER=sqlite
unset DESPLEGA_TELEMETRY_ENV
```

Direct benchmark and generation boots additionally use these synthetic settings:

```bash
export DESPLEGA_TELEMETRY_ENV=test
export NODE_ENV=test
export SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111
```

The preload intercepts only models.dev and returns a synthetic HTTP 503 response.

```typescript
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "models.dev") {
    return Promise.resolve(new Response("Worker SQLite final catalog fixture", { status: 503 }));
  }
  return originalFetch(input, init);
}, originalFetch);

```
Other fetch calls retain their existing implementation.
Black-box SUTs receive explicit DB_DRIVER and BUN_OPTIONS overrides through --sut-env.
They retain the runner's loopback telemetry endpoint.
All performance workloads run sequentially.

## Final results

The pinned source does not pass final acceptance. The failures below require parent corrections.
No publication verification against GitHub occurred.

Full commands, exit codes, BCN start times, durations, scenario timings, retry attempts, and API call counts appear in [the timing evidence](./2026-11-16-worker-sqlite-final-timings.json).
That file retains compact evidence before temporary results are deleted.

### CI and source checks

The 52 initial and supplemental check commands report 50 passes and two failures.
These totals include the scoped local check, static checks, evals checks, and workflow validation.
They exclude root suites, black-box suites, UI acceptance, production benchmarks, generation, and packaging.

- `bun run check:local --skip-e2e` passed frozen installation, affected lint, Bun typechecking, generated drift checks, and affected tests.
- Its affected tests reported 14,969 passes, 29 skips, no failures, and 80,800 assertions across 846 files.
- The inner local E2E stage was explicitly skipped. Four sequential strict suites supplied guarded black-box coverage instead.
- Independent lint, slop, TypeScript 5, both promise checks, architecture boundaries, allowlist, dependency graph, and registration checks passed.
- Bun version, spawn sync, audit columns, RBAC, OpenAPI coverage, extension schemas, skills, docs, telemetry contracts, and migration checks passed.
- Dependency analysis reported 2,799 existing warnings and no errors. Biome reported five warnings. Structural lint reported three warnings.
- Evals typechecking, its UI build, and 1,193 tests passed. One evals test skipped.
- Gitleaks scanned the integrated feature range and found no leaks. Its self-test passed.

The full root command reported 22,604 passes, 43 skips, one failure, and 117,568 assertions across 1,491 files.
Its test duration was 312.43 seconds. The isolated failing file reproduced the failure.

### Strict black-box suites

Each command used `bun run e2e --strict --sut-env DB_DRIVER=<driver> --sut-env BUN_OPTIONS=--preload=<owned-dir>/network-guard.ts --json <unique-result>`.
The first pair ran SQLite then Worker. The second pair ran Worker then SQLite.
Each pair used `bun run e2e:bench <sqlite-result> <worker-result>`. Both comparison commands exited zero.
The comparison command enforces no ratio threshold.

| Result | Duration seconds | First-attempt passes | Successful retries | API calls | API p50 ms | API p95 ms | Strict exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| round1-sqlite | 433.911 | 168 | 1 | 5244 | 0.62 | 10.38 | 1 |
| round1-worker | 444.637 | 168 | 1 | 5248 | 0.73 | 12 | 1 |
| round2-worker | 435.937 | 168 | 1 | 5247 | 0.7 | 11.41 | 1 |
| round2-sqlite | 433.217 | 168 | 1 | 5245 | 0.65 | 11.64 | 1 |

These suites completed 676 scenario executions. They recorded 672 first-attempt passes and four successful retries.
No scenario had a remaining runtime failure or skip. All four strict coverage gates failed.
All registered operations reached full coverage: 509 routes, 192 tools, 15 workflow node types, and 16 CLI commands.
Four CLI commands had reasoned exclusions. State and engine coverage reached 100 percent.

### Bounded latency investigation

A single additional pair selected every scenario above 1.5x in either full pair.
Both drivers passed all 22 selected scenarios without retries.
Each bounded suite starts a fresh SUT, so its state differs from the full suites.
Commands used `bun run e2e --only <comma-separated-selection> --sut-env DB_DRIVER=<driver> --sut-env BUN_OPTIONS=--preload=<guard> --json <unique-result>`.
The exact selection and commands appear in the timing evidence. Its comparison command also exited zero.

Each cell gives SQLite milliseconds, Worker milliseconds, and the Worker delta.

| Scenario | First full pair | Reverse full pair | Bounded pair |
| --- | ---: | ---: | ---: |
| poll-concurrent-claim | 23 / 36 / +13 | 19 / 36 / +17 | 62 / 238 / +176 |
| slack-mention | 1073 / 2047 / +974 | 1073 / 2064 / +991 | 1075 / 1880 / +805 |
| runtime-pools | 49 / 82 / +33 | 52 / 54 / +2 | 93 / 54 / -39 |
| workflow-wait-event-loop | 23 / 371 / +348 | 28 / 369 / +341 | 82 / 422 / +340 |
| script-inline-run | 460 / 743 / +283 | 486 / 761 / +275 | 473 / 341 / -132 |
| audit-attribution-scripts | 229 / 1434 / +1205 | 244 / 239 / -5 | 438 / 350 / -88 |
| knowledge-memory | 561 / 1719 / +1158 | 594 / 860 / +266 | 856 / 859 / +3 |
| knowledge-skills | 305 / 487 / +182 | 284 / 290 / +6 | 241 / 266 / +25 |
| knowledge-prompt-templates | 46 / 122 / +76 | 45 / 60 / +15 | 83 / 59 / -24 |
| knowledge-pages | 415 / 662 / +247 | 423 / 409 / -14 | 423 / 443 / +20 |
| knowledge-apps-primitives | 10 / 18 / +8 | 11 / 10 / -1 | 16 / 13 / -3 |
| knowledge-objects-reindex-scope | 60 / 109 / +49 | 76 / 69 / -7 | 175 / 176 / +1 |
| platform-oauth-locks | 9 / 61 / +52 | 59 / 8 / -51 | 59 / 5 / -54 |
| defer-wake-pr-merged | 6751 / 13291 / +6540 | 7298 / 5782 / -1516 | 15177 / 14784 / -393 |
| platformb-model-groups | 15 / 27 / +12 | 47 / 21 / -26 | 41 / 55 / +14 |
| platformb-slack-tools | 154 / 665 / +511 | 171 / 650 / +479 | 152 / 688 / +536 |
| platformb-fs-keys | 29 / 44 / +15 | 37 / 30 / -7 | 23 / 23 / +0 |
| health | 2 / 2 / +0 | 3 / 10 / +7 | 7 / 2 / -5 |
| slack-http-restart-redelivery | 3254 / 3553 / +299 | 2998 / 5312 / +2314 | 3548 / 3682 / +134 |
| workflow-engine-cancel | 80 / 74 / -6 | 65 / 366 / +301 | 182 / 427 / +245 |
| platform-config | 63 / 78 / +15 | 52 / 81 / +29 | 47 / 54 / +7 |
| platformb-repo-merge-policy | 45 / 48 / +3 | 34 / 57 / +23 | 59 / 31 / -28 |

Full-suite Worker elapsed time increased 2.47 percent in the first pair and 0.63 percent in the reverse pair.
API p95 changed by +1.62 ms and -0.23 ms, respectively.
The bounded pair increased 1.553 seconds across 22 scenarios.

Slack mention and Slack tools retained repeatable increases of roughly 0.5 to 1 second.
The event-loop workflow retained roughly 340 ms. Concurrent claims retained smaller full-suite increases and a 176 ms bounded increase.
Workflow cancellation added 245 ms in the bounded pair and 301 ms in the reverse full pair.

Source inspection found 500 ms Slack polls, 100 ms event-wait polls, and 250 ms workflow completion polls.
Extra asynchronous turns can move observations into another polling interval. This explains a plausible contribution, not a proven complete cause.
The bounded workflow-run request count increased from 31 to 34. Its API p95 decreased from 7.02 ms to 3.17 ms.
The concurrent-claim case performs six simultaneous polls over three tasks, with at most five rounds.
Its assertions remained intact.

Several first-pair increases disappeared during the reverse pair or bounded pair, including memory, pages, skills, and PR-merge wake.
The evidence does not establish a universal performance pass or a production latency guarantee.
Repeatable scenario increases remain visible for the parent's acceptance decision.

### UI and generated artifacts

`bun run e2e:ui` passed 284 tests, skipped 74, and recorded no failure or retry.
The suite used three local browser workers and explicitly selected DB_DRIVER=worker for each SUT.
An owned PATH wrapper appended the driver and preload through the boot command's supported `--sut-env` arguments.
No repository configuration changed. The suite measured 178 dashboard files for coverage.
No feature diff exists under apps/ui or apps/templates-ui, so review screenshots are not required.

`bun run docs:openapi` and `bun run check:script-types` passed.
OpenAPI, API reference, script declarations, and extension declarations match the committed tree.
Generation produced no tracked content diff. No generated file was hand-edited.
The extension generator uses lib.esnext.d.ts. The earlier DOM Worker error did not recur.

### Production-client assertions

Both commands used the Phase 1 synthetic environment:

`bun scripts/bench-db-worker.ts --driver sqlite --assert`

`bun scripts/bench-db-worker.ts --driver worker --assert`

Calibration targeted 1,000 ms, accepted 850 to 1,300 ms, and allowed at most eight calibration attempts.
The lag probe interval remained 5 ms. Both drivers calibrated in two attempts.

| Driver | Execution ms | Round trip ms | Transport and scheduling ms | Main-thread lag ms | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| sqlite | 986.356 | 986.699 | 0.343 | 984.840 | PASS |
| worker | 999.490 | 999.719 | 0.229 | 1.958 | PASS |

Both assertions verified production-client write/read and active vector support.
Worker lag stayed below 50 ms. SQLite blocking lag exceeded the 500 ms baseline requirement.
Worker attribution reported db_ms=0 and worker_execution_ms=126 in its separate calibration sample.
SQLite attribution reported db_ms=986 for the blocking statement.

### Packaging

Only the local orbstack context and the owned worker-sqlite-final-v1ynwi builder were used.
No configured remote builder was listed or queried. Builds ran sequentially.
Each completed stage removed its owned image and pruned only its dedicated builder cache.
The API Dockerfile embeds db/db-worker.ts and memory/search-read-worker.ts.

| Image | Platform | Image digest | Bytes | Build | Smoke |
| --- | --- | --- | ---: | --- | --- |
| api-arm64 | linux/arm64, native | sha256:59c51bf69e10f18ee36ee3407b691a69bc552a77f295976807c761f110731020 | 460073898 | PASS | PASS |
| api-amd64 | linux/amd64, emulated | sha256:657d1831af2d6a9d4c0fd50acebaeea3dff1935c1bcd8bf945e5ce4897de8a5f | 435336170 | PASS | PASS |
| worker-slim-initial | linux/amd64, emulated | unavailable | n/a | FAIL | not required |
| worker-slim-retry | linux/amd64, emulated | sha256:2ae81b9bac420c1519e04616cac810169bbeb8bcec4e73fad5bfb141e5050712 | 3401121518 | PASS | not required |
| evals-image | linux/amd64, emulated | sha256:ae5f45f864891fbfbcad056890fa9e96a670180d2b90e81293c794f9b5eda4bc | 3150749034 | PASS | not required |
| ui-image | linux/amd64, emulated | sha256:2ae3e0323d40265c78a21c3c1a32be7b2d47fd34476c08f985886f21cd28d490 | 107044255 | PASS | PASS |

Native Linux arm64 ran in OrbStack on the arm64 host. Linux x64 used emulation.
No native x64 hardware was available. These checks establish local packaging behavior only.
The API smokes used container network isolation, free ports, UUID identities, a fresh file database, and deterministic 512-dimensional embeddings.
Telemetry stayed on container loopback. Both smokes verified the models.dev HTTP 503 guard.
They verified authenticated driver stats, public health redaction, task write/read, vector retrieval, both memory reader Workers, and shutdown exit zero.

arm64: startup 4307.22 ms, shutdown 12.48 ms, 44 synthetic embedding requests, and 5 local telemetry requests.

amd64: startup 34277.76 ms, shutdown 289.36 ms, 44 synthetic embedding requests, and 5 local telemetry requests.

The worker-slim and evals images mirror the triggered CI build legs. No full-only worker stage changed.
The UI image passes all 34 checks in the canonical `bash scripts/smoke-ui-image.sh <owned-tag>` smoke.
The UI frontend build uses the native build platform. Its nginx runtime smoke uses x64 emulation.
Image metadata, largest layers, and exact Docker commands remain in the timing evidence.
The worker-slim retry and evals build export gzip archives, prune only the owned cache, then load those archives.
No successful image build was repeated. No Dockerfile, dependency, or build assertion changed.

### Compiled smoke reproduction

Create the preload from this report's isolation section. Save the following harness as compiled-smoke.ts.
Mount both files read-only under /qa. The exact Docker invocation appears in the timing evidence.

```typescript
import { Database } from "bun:sqlite";
const platform = process.env.FINAL_PLATFORM!;
const agentId = crypto.randomUUID();
const key = "worker-sqlite-final-synthetic";
let embeddingRequests = 0;
let telemetryRequests = 0;
const mock = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
 const path = new URL(request.url).pathname;
 if(path === "/v1/embeddings") {
  embeddingRequests++;
  const body = await request.json() as {input:string|string[],model:string};
  const inputs = Array.isArray(body.input)?body.input:[body.input];
  return Response.json({object:"list",model:body.model,data:inputs.map((_,index)=>({object:"embedding",index,embedding:[1,...Array(511).fill(0)]})),usage:{prompt_tokens:1,total_tokens:1}});
 }
 if(path === "/telemetry") {telemetryRequests++;return Response.json({ok:true});}
 return Response.json({error:"Synthetic unsupported inference request"},{status:503});
}});
const portProbe=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("probe")});
const port=portProbe.port;
portProbe.stop(true);
const base=`http://127.0.0.1:${port}`;
const dbPath="/tmp/worker-sqlite-final.sqlite";
const env={...process.env,PORT:String(port),MCP_BASE_URL:base,DATABASE_PATH:dbPath,
 DB_DRIVER:"worker",NODE_ENV:"test",DESPLEGA_TELEMETRY_ENV:"test",BUSINESS_USE_API_KEY:"",
 DESPLEGA_TELEMETRY_ENDPOINT:`http://127.0.0.1:${mock.port}/telemetry`,
 AGENT_SWARM_API_KEY:key,SECRETS_ENCRYPTION_KEY:"1".repeat(64),
 SLACK_DISABLE:"true",GITHUB_DISABLE:"true",GITLAB_DISABLE:"true",JIRA_DISABLE:"true",LINEAR_DISABLE:"true",AGENTMAIL_DISABLE:"true",HEARTBEAT_DISABLE:"true",MULTI_RUNTIME_ENABLED:"false",API_DRAIN_MAX_MS:"0",
 EMBEDDING_API_KEY:"synthetic-embedding",EMBEDDING_API_BASE_URL:`http://127.0.0.1:${mock.port}/v1`,
 BUN_OPTIONS:"--preload=/qa/network-guard.ts"};
const started=performance.now();
const child=Bun.spawn(["/api-entrypoint.sh"],{env,stdout:"pipe",stderr:"pipe",stdin:"ignore"});
let logs="";
const collect=async(stream:ReadableStream<Uint8Array>)=>{for await(const part of stream){logs+=new TextDecoder().decode(part);}};
const drains=Promise.all([collect(child.stdout),collect(child.stderr)]);
function assert(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function api(path:string,body?:unknown,auth=true):Promise<any>{
 const res=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{...(auth?{Authorization:`Bearer ${key}`,"X-Agent-ID":agentId}:{}),"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const json=await res.json();assert(res.ok,`${path}: ${res.status} ${JSON.stringify(json)}`);return json;
}
let success=false;
try {
 const budget=platform==="linux/amd64"?600000:120000;
 let health:any;
 while(performance.now()-started<budget){
  if(child.exitCode!==null)throw new Error(`API exited at startup: ${child.exitCode}`);
  try{health=await api("/health",undefined,false);break;}catch{await Bun.sleep(250);}
 }
 assert(health,"API readiness deadline expired");
 const startupMs=performance.now()-started;
 assert(!("dbDriver" in health),"Public health exposed driver selection");
 const stats=await api("/api/stats");assert(stats.dbDriver==="worker","Wrong effective driver");
 await api("/api/agents",{name:`final-${platform.split("/")[1]}`,isLead:true});
 const task=await api("/api/tasks",{task:"Compiled Worker acceptance persistence"});
 const read=await api(`/api/tasks/${task.id}`);assert(read.id===task.id&&read.task===task.task,"Task persistence mismatch");
 const indexed=await api("/api/memory/index",{agentId,name:"Compiled Worker vector smoke",content:"Compiled Worker vector acceptance document with isolated deterministic embeddings.",scope:"agent",source:"manual"});
 let memoryHealth:any;
 const vectorStart=performance.now();
 while(performance.now()-vectorStart<60000){memoryHealth=await api("/api/memory/health");if(memoryHealth.counts?.memoryVec>=1)break;await Bun.sleep(250);}
 assert(memoryHealth.retrievalMode==="vec"&&memoryHealth.counts?.memoryVec>=1,"Vector population failed");
 const search=await api("/api/memory/search",{query:"Compiled Worker vector acceptance document",scope:"agent",limit:5});
 const found=search.results?.find((row:any)=>indexed.memoryIds.includes(row.id));
 assert(found&&["vec","hybrid"].includes(found.retrievalSource),"Indexed memory retrieval failed");
 assert(logs.includes("[memory-search] read workers started workers=2"),"Compiled memory readers did not start");
 assert(!logs.includes("read workers failed to start")&&!logs.includes("read workers stopped"),"Memory readers used a fallback");
 const db=new Database(dbPath,{readonly:true});
 const persisted=db.query("SELECT id FROM agent_tasks WHERE id=?").get(task.id);db.close();assert(persisted,"Task absent from file database");
 child.kill("SIGTERM");
 const shutdownStart=performance.now();
 const shutdown=await Promise.race([child.exited,Bun.sleep(30000).then(()=>{throw new Error("Clean shutdown exceeded 30 seconds");})]);
 await drains;assert(shutdown===0,`Shutdown exit ${shutdown}`);
 assert(!logs.includes("shutdown failed"),"Shutdown reported a failure");
 success=true;
 console.log(JSON.stringify({platform,dbDriver:stats.dbDriver,startupMs,taskWriteRead:true,vector:memoryHealth,retrievalSource:found.retrievalSource,memoryReadWorkers:2,embeddingRequests,telemetryRequests,shutdownExit:shutdown,shutdownMs:performance.now()-shutdownStart,modelsGuard503:logs.includes("models.dev returned HTTP 503"),network:"none"},null,2));
} catch(error){console.error(String(error));console.error(logs.slice(-14000));process.exitCode=1;}
finally {if(!success&&child.exitCode===null){child.kill("SIGKILL");await child.exited;}mock.stop(true);await drains;}

```


## Failures and limitations

The following failures and deviations occurred during verification. No implementation or assertion changed.

1. `bash scripts/check-node-env-access.sh` exits 1.
   It reports `src/be/db/runtime.ts:472`, which directly reads `process.env.NODE_ENV`.
   The checker requires `getNodeEnv()` because compilation can replace direct reads with a build-time constant.
   The direct read appears in the feature diff against integrated main.
2. `bun run e2e:tsc` exits 2 with TS2554 at `scripts/e2e/scenarios/knowledge-memory.ts:1107` and `:1225`.
   Both added `dbCount` calls omit the required parameter array.
   `dbCount` requires three arguments at `knowledge-helpers.ts:144`.
   The downstream read-only helper defaults missing arrays.
   Both drivers pass the memory scenario during full suites and bounded repetitions. The TypeScript gate still fails.

3. `bun run test:root -- --parallel=4` reports 22,604 passes, 43 skips, and one failure across 1,491 files.
   The failing test selects a known Codex model in `apps/ui/src/components/shared/agent-runtime-settings.test.tsx:891`.
   Its picker cannot find the `GPT-5.6 Luna` option at line 521. The error is `nothing to click`.
   One isolated retry reproduces the failure: `bun run test:root -- apps/ui/src/components/shared/agent-runtime-settings.test.tsx`.
   That retry reports 37 passes and one failure.
   This test file has no feature diff against integrated main.
4. The first strict SQLite suite completes all 169 scenarios with no remaining runtime failure.
   Strict coverage rejects `db-driver-startup` because the manifest assigns it to no flow.
   Route, tool, workflow-node, CLI, state, and engine coverage otherwise reach 100 percent.
   `script-inline-run` initially fails its empty-stderr assertion, then passes the runner's single retry.
   The result preserves the original failure and the final flaky status.
   The available assertion message does not identify the stderr content.
   All four full suites reproduce that initial stderr failure, then pass their runner retry.
   Both bounded timing suites pass this scenario without a retry.
   Fresh diagnostic requests return empty stderr under both drivers.
   The exact cause remains unproven.
   Every full suite rejects the missing flow assignment.
   The first Worker suite also rejects two stale exclusions for workflow run and step `running` states.
   The other three full suites do not observe those transient states.
   Their manifest explanations assume these states disappear before coverage reads the tables.
5. The first worker-slim image load fails with `no space left on device`.
   Docker completes its build steps, then fails during image import at `usr/lib/python3.12/test/typinganndata`.
   The retry separates compressed Docker archive export, task-owned cache cleanup, and image load.
   The original failure remains distinct from the successful archive export and image load.
6. `bun run check:operator-skill` passes but issues HEAD requests to 25 public URLs on docs.agent-swarm.dev.
   Those requests exceed the requested local-only testing scope.
   The request code supplies no authentication headers, and the command receives the task's minimal environment.
   No production application data enters this check. Local source inspection confirms its network behavior.
   The timing evidence preserves the URL list. Diagnosis sends no additional requests.

The parent owns corrections. Static failures received no retry.

PR checks remain the parent's responsibility after publication. This task does not mark them passed.
Staging acceptance, sustained production RSS, Taras's protocol review, and default rollout remain unconfirmed.
Native x64 hardware is unavailable. Linux x64 results must identify emulation.

## Cleanup and final integrity

Completed at 2026-11-16 05:22:50 BCN.

HEAD remains e8c136b53dca3bf2c0486ccf9a9665f1ab265f23 on t3/research-async-database-options.
All seven integration hashes match before and after verification.
All eight preserved file hashes match, including the five existing untracked files, the plan, and both current phase reports.
The tracked diff remains empty. Generated artifacts match HEAD, and no generated patch was necessary.
No implementation, test, assertion, dependency manifest, runtime configuration, plan, or prior phase report changed.
Nothing was staged, committed, pushed, published, merged, deployed, or enabled by default.

The six black-box ports are available again. Their databases, logs, homes, secrets directories, and filesystem fixtures are absent.
Both production-benchmark directories are absent. Diagnostic and UI fixtures completed their runner-owned teardown.
Owned API containers used automatic removal. The canonical UI smoke completed its cleanup trap.
Every owned image removal and the dedicated builder removal exited zero.
The worker and evals export archives were deleted after loading and inspection.
The builder's local metadata is absent. OrbStack reports Stopped, matching its initial state.
The OrbStack status command returns one for Stopped. That result confirms restoration rather than an acceptance failure.

The task removed apps/ui/dist, apps/evals/ui/dist, and the UI test output, report, and coverage directories.
The root package has no clean command. Shared node_modules and shared caches remain intact.
No global Docker prune occurred.
The parent-owned publication directory remains present and untouched.
Temporary cleanup removed 122 logs before deleting the owned helper directory.
Only the requested final report and compact timing artifact remain as new task files.

| Disk observation | Available KiB | Approximate GiB |
| --- | ---: | ---: |
| Initial task | 11337824 | 10.813 |
| Before first artifact cleanup | 10684640 | 10.190 |
| Before final temporary cleanup | 12114708 | 11.553 |
| After final cleanup | 12126916 | 11.565 |

Observed availability increased 1.375 GiB from the first artifact cleanup measurement.
The final temporary cleanup changed availability by 12208 KiB.
Initial-to-final availability changed by 789092 KiB.
These are filesystem observations. Host activity and deferred APFS or Docker reclamation can affect attribution.
The lowest sampled availability during the failed worker image load was about 1.2 GiB.

QA Doc status: n/a. The requested verification evidence is complete, and final acceptance remains blocked by the recorded failures.
PR checks, staging acceptance, sustained production RSS, Taras's protocol review, and default rollout remain unconfirmed.


## Correction pass, 2026-11-16 BCN

Status: partial corrections are ready for independent review.
The earlier failures and timing records above remain unchanged.
The new `corrections` object in the timing file preserves this pass, including failed diagnosis attempts.
HEAD remains `e8c136b53dca3bf2c0486ccf9a9665f1ab265f23`.
The parent retains Git, plan closure, and publication ownership.

### Model picker correction

The bundled catalog contains GPT-5.6 Luna, and the Codex harness accepts its identifier.
A fixed catalog alone still fails the interaction test.
The model picker contains no options because the popup closes after it opens.
Radix Select schedules focus restoration with `setTimeout(0)` when the previous select closes.
The test opens the model popup before that timer finishes, so focus restoration dismisses the popup.
The helper now waits for that lifecycle timer inside React `act()`.
The target test also supplies a fixed Sol and Luna catalog.
All existing selection, save, profile-clear, and rehydration assertions remain.
Separate focused runs pass with the fixed catalog and the bundled catalog.
No main checkout reproduction was attempted or claimed.

### Inline stderr correction

A focused Worker run captures the first attempt's scrubbed stderr:

```text
/Users/taras/.bashrc: line 6: /.turso/env: No such file or directory
```

The existing retry passes on its fresh stack. Its first failure remains in the appended scenario evidence.
The inline sandbox starts Bash before its `env -i` prelude installs the clean child environment.
Bash can read the user's startup file while stdin remains open.
The native warm harness keeps stdin open while it waits for a configuration payload.
A promptly closed stdin probe produces empty stderr and does not reproduce the issue.
An open stdin probe reproduces the same startup error without running a script.
The same probe produces empty stderr with `--noprofile --norc -p`.
Inline mode now uses those flags, matching the existing spawn mode.
The existing startup-file test now checks both modes and requires empty stderr.
The E2E assertion remains strict and includes the scrubbed stderr in its failure message.
No retry was added.

### Workflow coverage diagnosis and limitation

The parent's database-driver-startup flow assignment fixes the deterministic missing-flow failure.
One full Worker suite records a diagnostic query after every scenario.
All 169 boundaries contain no running workflow run or step.
Its final live fixture is only `cancel-park-cfda4a193c34`, with a waiting run and waiting step.
A focused workflow suite and a suite containing the final import restarts also pass.
Temporary runner diagnostics were removed before the final SQLite suite.
An external read-only monitor samples the SQLite fixture every 50 ms through completion.
It captures normal execution in the chain, async, control, approval, input-reference, and edge-webhook scenarios.
Those transitions settle before their scenarios finish. No activity survives the final scenarios in this run.
The monitor source and row changes remain in the appended timing evidence.
Neither full suite reproduces the historical stale-exclusion failure.
The specific historical racing or leaked scenario remains unidentified.
No deterministic cleanup or live-state coverage guarantee was added without that evidence.
The existing exclusions, coverage SQL, and stale-exclusion checker remain unchanged.
This issue remains unresolved despite the fresh strict passes.

### Verification

Commands use the minimal environment described above, with unchanged HOME and CODEX_HOME.
PATH includes `/opt/homebrew/opt/coreutils/libexec/gnubin`, and TMPDIR is `/private/tmp`.
BUSINESS_USE_API_KEY is empty. Root and harness commands do not inherit DESPLEGA_TELEMETRY_ENV.
The models.dev guard is the parent's `/private/tmp/worker-sqlite-publication.fmFGyW/network-guard.ts`.
Black-box boots retain the harness's loopback telemetry and disabled integrations.

| Strict full suite | Duration seconds | First-attempt passes | Successful retries | Strict gate |
| --- | ---: | ---: | ---: | --- |
| full-worker-diagnostic | 439.582 | 169 | 0 | PASS |
| full-sqlite | 428.314 | 169 | 0 | PASS |

Both suites pass all route, tool, workflow-node, CLI, state, and engine coverage gates.
Both suites pass script-inline-run on its first attempt.
Both suites pass db-driver-startup and knowledge-memory, exercising the parent's related corrections.

Successful commands:

- `bun run test:root -- apps/ui/src/components/shared/agent-runtime-settings.test.tsx src/tests/sandboxed-process.test.ts`: 56 passes, 158 assertions.
- `bun run check:local --skip-e2e`: passes installation, lint, type checks, generated drift checks, and affected tests.
- Its affected tests report 15,271 passes, 31 skips, zero failures, and 857 files.
- `bun run e2e:tsc`, `bash scripts/check-node-env-access.sh`, and `bash scripts/check-e2e-boundary.sh` pass.
- `bun run check:unit-test-allowlist` passes.
- Biome checks all eight changed source and manifest paths without changes.
- `git diff --check` passes.

The strict commands use `bun run e2e --strict --sut-env DB_DRIVER=<driver> --sut-env BUN_OPTIONS=--preload=<parent-guard> --json <owned-result>`.
The timing evidence records exact argument arrays and BCN start times for every wrapped command.
The initial Biome attempt failed on formatting in script-inline-run. Formatting was corrected before the final successful check.

The default SQLite root command, `bun run test:root -- --parallel=4`, still exits one.
It reports 22,604 passes, 43 skips, one failure, and 117,583 assertions across 1,491 files.
The model picker test passes in that full run.
The remaining failure is `reconnect adopts a lost provision result and only reaps owner-filtered orphans`.
It times out in `connect()` at runtime-remote-controller.test.ts:210, called from line 561.
An isolated run of that file passes all 25 tests and 136 assertions.
That file remains unchanged. The full-run timeout's cause remains unproven.
The failed full run remains distinct from the successful isolated run.

An additional root attempt with DB_DRIVER=worker was stopped after 184.595 seconds, with exit 137.
Several fixtures deliberately combine NODE_ENV=production and an in-memory database.
Those fixtures hit the required Worker file-database guard. Other tests also time out in this mode.
This interrupted attempt is preserved as a failed, incomplete run. It is not a completed Worker root result.
Only its owned test process tree was terminated.
No guard was weakened, and sqlite remains the default.

### Exact paths and remaining work

This executor changes:

- `apps/ui/src/components/shared/agent-runtime-settings.test.tsx`
- `scripts/e2e/scenarios/script-inline-run.ts`
- `src/utils/sandboxed-process.ts`
- `src/tests/sandboxed-process.test.ts`
- `thoughts/taras/research/2026-11-16-worker-sqlite-final-verification.md`
- `thoughts/taras/research/2026-11-16-worker-sqlite-final-timings.json`

The parent's existing edits remain in runtime.ts, knowledge-memory.ts, coverage-manifest.json, and db-driver-startup.ts.
The five protected plan, research, and patch files retain their original SHA-256 hashes.
The parent publication directory remains intact.
No plan, commit, push, PR, deployment, Docker operation, external provider, or public-documentation HEAD check occurs in this correction pass.
Earlier Docker builds, UI suites, benchmarks, and compiled smokes were not repeated.

Remaining work: identify and correct the historical workflow coverage race, and explain the controller timeout in the full root suite.
The corrections are reviewable, but this pass does not claim that all requested verification failures are resolved.

### Cleanup

Owned diagnostic API processes and mocks have stopped.
The final SQLite stack performs its normal automatic cleanup.
Explicit cleanup removes 160 kept diagnostic fixture paths, totaling 447,496 KiB by `du -sk`.
During that cleanup, available disk space rises from 11,276,252 KiB to 11,729,916 KiB by `df -k /`.
The owned correction directory is removed after evidence extraction.
The timing file records the final disk measurement and cleanup verification.

Final temporary cleanup removes 22136 KiB and deletes 24 logs first.

```text
Before final temporary cleanup:
Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   482797652  12469668  11947360    52%  458788 119473600    0%   /
After final temporary cleanup:
Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   482797652  12469668  11969408    52%  458788 119694080    0%   /
```

Protected file hashes and the original 115 commands and six suites remain intact.

## Parent acceptance and final repetition

The final root repetition started at 05:53:36 BCN on 2026-11-16 and completed in 304.878 seconds.
`bun run test:root -- --parallel=4` passed 22,605 tests, with 43 skips, zero failures, and 117,561 assertions across 1,491 files.
The reconnect test passed in this complete run. No test, timeout, or retry setting changed for the repetition.
The earlier reconnect timeout remains an unexplained intermittent result. This does not establish a clean-main baseline.

The independent correction review found no Standards or Spec findings across the eight changed source paths.
It independently passed 56 focused tests and 158 assertions. It checked the preserved sandbox limits, environment filtering, and privilege drop.
The parent accepts these corrections and the local Phase 4 gate.
Both final strict suites passed all 169 scenarios without retries. The earlier transient-state coverage race remains unexplained.
No coverage query, exclusion, or stale-exclusion check was weakened.

The complete evidence retains the initial failures, failed diagnosis attempts, and interrupted Worker root experiment.
The first parent repetition wrapper failed before spawning tests because Bun rejected its stderr option.
The corrected wrapper used separate stdout and stderr files and the same minimal environment as the earlier verification.
The timing JSON records the successful final command, counts, review, and source hashes.

The PR body passes its template checker. A direct stdin secret scan covered 1,087,008 bytes of final evidence and found no leaks.
An earlier directory scan covered zero bytes because the repository configuration excludes `thoughts/`. It provided no evidence.

PR checks, Taras's manual protocol review, staging, sustained production RSS, and rollout remain pending.
The implementation keeps `DB_DRIVER=sqlite` as the default. No default change or deployment is included.
The remote release commit `fbc96bd0fc` followed the integrated base. It changes release metadata and agent-fs versions.
Local acceptance uses the reviewed integrated source at `e8c136b53d` plus these corrections.

Parent cleanup removed 5,136 KiB of owned repetition logs and wrapper files.
Available disk space changed from 11,949,616 KiB to 11,954,732 KiB during cleanup.
The PR draft and network guard remain until publication finishes. No shared cache was removed.

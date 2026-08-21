---
date: 2026-08-20
topic: Bun 1.4 adoption audit for agent-swarm
source: https://bun.com/blog/bun-v1.4 (released 2026-08-20T14:07Z)
status: research, no code changes yet
---

# Bun 1.4: what we can change or adapt

## TL;DR

1. **CI already runs Bun 1.4.0.** Every `setup-bun` step uses `bun-version: latest`. The 15:24Z Merge Gate run today downloaded `bun-v1.4.0` and passed (lint, tsc, all 4 test shards, Docker builds). Docker builder images and `packageManager` still pin `1.3.11`, local is `1.3.14`. We ship binaries built by a runtime two minors behind the one CI validates. Close that gap first.
2. **`bun test --isolate` removes our worst test-suite failure class.** Fresh `globalThis` + fresh module registry per file kills the `mock.module()` leak, the `@hono/node-server` `Response` swap, and the macOS-vs-Linux file-order dependence (gotchas 1, 2, 8, 10 in the bun-test memory). Measured below.
3. **`bun test --parallel` runs the whole root suite in 87 s on this laptop** (496 files, 7,844 tests). Today: ~80-108 s per CI shard, 4 shards. Failures under `--parallel` are load-related (full `src/http.ts` subprocess servers that miss a 15 s startup deadline), not correctness.
4. **`bun test --changed=origin/main` fixes the pre-push hook problem** (17-minute full run, SSH idle timeout, gotcha 5b). Only the files reachable from the diff run.
5. Native API swaps are mostly low value for us: we do not serve static dirs, do not render markdown server-side, do not need a PTY, and the scheduler already owns cron semantics. A few are worth a small PR (listed in "Worth a small PR").

## Where we stand

| Thing | Value |
|---|---|
| `package.json` `packageManager` | `bun@1.3.11` |
| `Dockerfile` / `Dockerfile.worker` builder | `oven/bun:1.3.11` |
| `apps/evals/Dockerfile` | `oven/bun:latest` (already 1.4.0) |
| All GitHub workflows (`setup-bun`) | `bun-version: latest` (1.4.0 since today) |
| Local | 1.3.14 |
| `bun.lock` | `lockfileVersion: 1`, `configVersion: 1` |
| `bunfig.toml` | `linker = "hoisted"`, `[test] maxConcurrency = 1`, `retry = 3`, `preload`, `pathIgnorePatterns` |

Verified on 1.4.0 in this worktree: `bun install --frozen-lockfile` succeeds against the v1 lockfile and does not rewrite it (6.6 s, 1,285 packages). Bun only writes `lockfileVersion: 2` when a non-frozen install runs.

## Test runner: the part that matters

Decision (review 2026-08-20): go with `--parallel`, fix the load failures, and combine it with the sharding we already do. `--isolate` comes for free (`--parallel` implies it). Measurements for both, plus `--changed`, follow.

### Experiment 1: whole suite, three ways (Bun 1.4.0, macOS, this worktree)

Script: `bun test` three ways, same tree, stray `./test-*.sqlite` files removed between runs.

| Run | Wall clock | pass | fail | errors | Notes |
|---|---|---|---|---|---|
| plain (baseline) | 257 s | 7,854 | 5 | 3 | 7,861 tests / 496 files |
| `--isolate` | 412 s | 7,854 | 5 | 3 | **identical failure set to baseline** |
| `--parallel --timings --update-timings` | **87 s** | 7,827 | 10 | 3 | 5 extra failures, all load-related |

The 5 baseline failures are the known macOS-only ones (`ulimit -v` reports `unlimited` on macOS: 3 × `workflow-executors`, 1 × `script-workflows-runtime-e2e`, plus the `workflow-engine-v2` step-watchdog timing test). The 3 "errors" are the late rejection of the same `workflow-executors` truncation test after its timeout. They are not Bun 1.4 regressions; CI on Linux is green on 1.4.0.

**`--isolate` result:** zero new failures, zero order-dependent surprises. Cost is +60 % wall clock, and the cause is visible in the log: `preload.ts` runs `initDb(":memory:")` + all migrations to build the SQLite template, and under `--isolate` that runs once per file (514 migration runs vs 19 in the baseline, ~0.3 s each). Cache the serialized template on disk keyed by a hash of `src/be/migrations/` and the cost goes away.

**`--parallel` failures, by cause:**

- 4 × `Server did not start within 15000ms` (`memory-rate-endpoint`, `memory-rater-llm`, `page-proxy-authed`, `memory-rater-e2e`). Each spawns a full `src/http.ts` child on its own unique port (19111, 19119, 19881, 19131). Ports do not collide. The child did not finish booting in 15 s while ~10 workers shared the CPU. Fix: raise the boot deadline in the shared helper, or cap `--parallel=4`, or feed `--timings` so these files start first on idle workers.
- `seed-scripts` 5 s per-test timeout and `http-api-integration` hook-piggyback: timing-sensitive under load; both pass in the other two runs.
- The remaining 5 are the macOS-only set above.

Per-file timings from `--update-timings` (sum 13.3 min under contention). The slowest files:

```
50.7 s  workflow-executors.test.ts
36.1 s  seed-scripts.test.ts
35.2 s  pi-mono-adapter.test.ts
32.4 s  rbac-mcp-admission-e2e.test.ts
29.1 s  http-api-integration.test.ts
28.4 s  opencode-adapter.test.ts
16.8 s  rbac-wire-e2e.test.ts
16.3 s  page-proxy-authed.test.ts
16.3 s  memory-rater-e2e.test.ts
16.1 s  memory-rater-llm.test.ts
15.8 s  memory-rate-endpoint.test.ts
```

24 files take more than 5 s. 455 files take less than 2 s. Round-robin `--shard` by file count is fine today (CI shards are 80 / 80 / 94 / 108 s) because the heavy files spread out by luck. `--timings` makes that deterministic.

### Experiment 2: shards × `--parallel=4` (what a CI runner would do)

`--shard` and `--parallel` compose: `--shard=i/N` picks this runner's slice of files (by time when `--timings` is given), `--parallel=4` spreads that slice over 4 workers. `ubuntu-latest` has 4 vCPU, so each shard below was run with `--parallel=4 --timings=<file from experiment 1>`, one after another on this machine.

| Layout | Per-shard wall clock | Files per shard | Failures beyond the macOS-only 5 |
|---|---|---|---|
| 4 shards × `--parallel=4` | **29 / 29 / 29 / 55 s** | 162 / 85 / 90 / 159 | 1 (`slack-render-v2` watermark test, timing) |
| 2 shards × `--parallel=4` | **51 / 53 s** | 247 / 249 | 1 (`kv-page-proxy`: `401 Unauthorized`, a port collision, see below) |
| today: 4 shards, sequential (CI, Linux) | 80 / 80 / 94 / 108 s | ~124 each | 0 |

Notes:

- The 4 × "`Server did not start within 15000ms`" failures from experiment 1 disappear at `--parallel=4`. They were an artefact of ~10 workers on one laptop.
- `--timings` balances by time, not count: shard 2 got 85 files and shard 1 got 162, both finished in 29 s.
- Shard 4 at 55 s is a floor, not an imbalance: `workflow-executors.test.ts` alone is 50 s here (four attempts of a 5 s-timeout test on macOS). A single file cannot be split across workers. On Linux that file passes first time and is much shorter.
- 2 shards cost 2 runner setups (~40 s checkout + install each) instead of 4, for ~25 s more wall clock. That is the cheaper layout and Taras's preference ("if 2 is enough, ok, less gh bill"). Go with **2 shards × `--parallel=4`**.

**The one real bug `--parallel` exposed: duplicate fixed ports.** `kv-page-proxy` uses `19877 + 4` = 19881, which is `page-proxy-authed`'s port; under parallel it registered its agent against the wrong server and got `401`. Scanning `const TEST_PORT = <n>` literals finds six more duplicate groups (13016, 13020, 13031, 13041, 13050, 13051; ~14 files), plus the 6 files on 3013. Sequential runs never notice. `src/tests/rbac-e2e-helpers.ts:26` already has `getFreePort()`; the fix is to use it (or `port: 0` + `server.port` for in-process servers) in every fixed-port file. Mechanical, one PR.

### Experiment 3: `--changed`

`--changed[=ref]` resolves every test file's import graph once, asks git which files changed (unstaged + staged + untracked, or the diff against `ref`), and runs only the test files that reach a changed file.

| Diff | Files selected | Time |
|---|---|---|
| docs only (this research note) vs merge-base | 0 | 0.2 s |
| + `// tmp` appended to `src/slack/blocks.ts` (mid-size hub) | 116 | 77 s sequential |
| + `// tmp` appended to `src/tools/schedules/create-schedule.ts` (leaf), with `--parallel=4` | 22 | 6 s |
| docs only vs `origin/main` after main moved ahead | 318 | 136 s |

The last row is the gotcha: `--changed=origin/main` diffs against the ref itself, so every upstream commit since the branch point counts as "changed". For the hook use `--changed=$(git merge-base origin/main HEAD)`.

Limits worth knowing: the walk is import-graph only. A change to `src/be/migrations/*.sql`, `templates/skills/**`, `bunfig.toml`, or `package.json` selects nothing, so the hook needs a small path filter that falls back to the full run for those (prek already has per-hook `files` regexes; add a second hook with the inverse pattern). CI stays the full run.

### What each flag gives us

**`--isolate`** (new `globalThis` + module registry per file, same process, shared transpile cache)

- Solves: `mock.module()` poisoning later files (28 files use it, 6 with no `afterAll` restore), `@hono/node-server` replacing `globalThis.Response` (the `preload.ts` `afterEach` guard becomes unnecessary), `process.chdir()` leaks, leaked servers / sockets / timers pinning the next file.
- Cost: every file re-runs `--preload`. Our `preload.ts` builds the migrated SQLite template in memory once per process. Under `--isolate` it runs per file: measured +155 s over 496 files. Fix in the same PR: serialize the template to `$TMPDIR/agent-swarm-test-template-<migrations-hash>.sqlite` on first build and `readFileSync` it afterwards.
- Cost: module top-level code re-executes per file. Transpile + parse is cached, so this is cheap.
- Risk checked: `Database.setCustomSQLite()` in `preload.ts` "must run exactly once, before any connection". It re-ran per file under `--isolate` and the memory-hybrid tests still passed (no `fts`-instead-of-`hybrid` failures), so the second call is a harmless no-op.

**`--parallel[=N]`** (N worker processes, implies `--isolate`, `JEST_WORKER_ID` / `BUN_TEST_WORKER_ID` exposed)

- Our suite is mostly shaped for it: 282 distinct `./test-<name>.sqlite` paths, zero duplicates; 25 servers on `port: 0`. Ports are the gap: 6 files bind 3013 (`pi-mono-adapter`, `codex-oauth-refresh-lock`, `scripts-runtime`, `connection-embedded-auth`, `script-connections`, `codex-adapter-pool-auth-revalidate`) and experiment 2 found six more duplicate `TEST_PORT` groups. All of them move to `getFreePort()` / `port: 0` before `--parallel` is safe.
- Coverage and JUnit are merged across workers. `--bail` stops every worker.
- CI `ubuntu-latest` has 4 vCPU. Realistic: `--parallel=4` inside each shard, shards from 4 down to 2, or keep 4 shards and cut each to ~30 s.

**`--shard=M/N --timings=<file>`**: already on `--shard`. Add a committed `test-timings.json`, refreshed by a scheduled job or on release, and shards balance by time. `--parallel --timings` also starts each worker on its slowest file first.

**`--changed[=ref]`**: walks the import graph back from `git diff` (measured in experiment 3). For the prek pre-push hook: `bun test --parallel=4 --changed=$(git merge-base origin/main HEAD)` instead of four sequential shards that end in `; true` (today the hook never fails and takes ~17 min). Also useful for local loops: `bun test --changed --watch`.

**`--retry <N>` and `test(..., { retry })`**: today `bunfig.toml` has a global `retry = 3`, which turns every non-idempotent failure into four attempts of constraint-error noise (gotcha 9). Move to per-test `{ retry: n }` on the known-flaky ones and drop the global retry. JUnit now emits one `<testcase>` per test with the final outcome after retries.

**Behaviour changes that touch tests (all verified as non-issues here)**

- `jest.resetAllMocks()` now drops implementations (matches Jest). We do not call it.
- `toContain()` uses `===` instead of `Object.is`. No `toContain(NaN)` / `toContain(-0)` in `src/tests`.
- `toEqual()` compares `Temporal` objects by value. `Temporal` is now defined globally. We do not use it.
- `jest.useFakeTimers()` + `setSystemTime()` now work together. Zero usages today. Only 2 test files sleep ≥ 1 s, so the win is small.
- `using spy = spyOn(...)` auto-restores. `onTestFinished()` exists. Niceties, no action.
- `bun test --only-failures` trims CI logs. `run-bun-tests.sh` already scrapes the summary lines; it keeps working.

### The plan: one PR (test runner)

Review decision: a single PR, not four. Everything below is test-infra only, no product code.

1. **Version alignment (prereq, same PR):** `packageManager` → `bun@1.4.0`; `setup-bun` steps → `bun-version-file: package.json` (reads `packageManager`, single source of truth); `Dockerfile`, `Dockerfile.worker`, `apps/evals/Dockerfile` → `oven/bun:1.4.0`; add a one-line CI check that the three `FROM oven/bun:` tags equal `packageManager`. Run a non-frozen `bun install` once and commit the `lockfileVersion: 2` rewrite.
2. **Ports:** replace every `const TEST_PORT = <literal>` and the 6 hard-coded `3013` binds with `getFreePort()` from `src/tests/rbac-e2e-helpers.ts` (spawned `http.ts` children) or `port: 0` + `server.port` (in-process servers). This is the only correctness fix `--parallel` needs.
3. **Preload template cache:** `preload.ts` serializes the migrated template to `$TMPDIR/agent-swarm-test-template-<sha of src/be/migrations>.sqlite` on first build and reads it back afterwards, so per-file preload under isolate is a file read, not 130+ migrations.
4. **Boot deadline:** the shared "`Server did not start within`" helper goes from 15 s to 60 s (it is a ceiling; healthy boots still take ~1 s).
5. **CI:** matrix `shard: [1, 2]`; `bun run test:root -- --parallel=4 --shard=${{ matrix.shard }}/2 --timings=test-timings.json`. Commit `test-timings.json` (generated with `--update-timings` on Linux, since the macOS numbers above include the retry floor) and refresh it from a weekly scheduled job or at release time. Update the ci-timings reporting step's `total: 4` → `2`.
6. **Pre-push hook:** `bun test --parallel=4 --changed=$(git merge-base origin/main HEAD)` gated on the existing `files` regex, plus a second hook matching `src/be/migrations/|templates/|bunfig.toml|package.json|bun.lock` that runs the full `--parallel=4` suite. Drop the `; true`.
7. **Retry:** remove global `retry = 3` from `bunfig.toml`; add `{ retry: 2 }` to the handful of tests that are timing-sensitive by design (the `slack-render-v2` watermark test and `workflow-engine-v2` watchdog test showed up once each under load).
8. **Docs:** `runbooks/testing.md`, `runbooks/ci.md`, `LOCAL_TESTING.md`: new commands, gotchas 1, 2, 8, 10 retired, "unique test ports per file" rule replaced by "always `getFreePort()` / `port: 0`". Keep the `preload.ts` `Response`/`Request` guard (see decisions below).

Verification for the PR: `bun run test:root -- --parallel=4 --shard=1/2 --timings=test-timings.json` and `--shard=2/2` both green on Linux CI twice in a row; `bun test --parallel=4` green locally on macOS except the known ulimit set; `bun test --changed=$(git merge-base origin/main HEAD)` selects 0 files on a docs-only branch.

## Runtime and packaging

### Do first: pin and align the Bun version (agreed in review)

- `Dockerfile` + `Dockerfile.worker`: `oven/bun:1.3.11` → `oven/bun:1.4.0`. Both compile the binaries we ship (`agent-swarm-api`, `agent-swarm`). The Dockerfile runtime stage also copies `/usr/local/bin/bun` from the builder, so the scripts-runtime sandbox children run the builder's Bun. Today prod runs user scripts on 1.3.11 while CI tests them on 1.4.0.
- `packageManager`: `bun@1.4.0`. `engines.bun`: bump from `>=1.0.26` to something honest (`>=1.3.12`, gotcha 11 already requires it for text imports).
- CI: pin to the repo's version, not `latest` (Taras's call). `setup-bun` v2 reads `packageManager` from `package.json` when `bun-version` is omitted, and `bun-version-file: package.json` makes that explicit. So: delete the 15 `bun-version: latest` lines (or replace them with `bun-version-file: package.json`) and `packageManager` becomes the single source of truth. Dockerfiles cannot read it, so add a tiny check script (same shape as `scripts/sync-chart-version.ts --check`) that asserts the three `FROM oven/bun:<tag>` lines match. Absorb new Bun releases through a bump PR. `apps/evals/Dockerfile` uses `oven/bun:latest`; pin it too.
- Lockfile: run a non-frozen `bun install` once on 1.4.0 and commit the `lockfileVersion: 2` rewrite so local, CI, and Docker agree. Note from the release notes: lockfiles that use nested or version-scoped overrides become version 3, which older Bun cannot read. Our `overrides` are flat (`react`, `react-dom`), so we land on v2.

Expected free wins from the bump (release notes, not measured here): the API is a `node:http` server, and that row in the blog's table goes from 135 MB to 81 MB peak RSS (−40 %) with `node:http` rewritten and passing 403/415 Node tests; 2× lower idle CPU on long-running processes (the blog's example is Claude Code, the same shape as our worker runner); 2× faster Linux startup; native Web Streams; `fetch()` body buffering at ~1× payload; `Response.clone()` chains flat in memory; `node:zlib` on zlib-ng; `child_process` piped stdio now applies kernel backpressure instead of buffering unbounded (relevant to the runner's harness stdout readers).

### Breaking changes checked against our code

| Change | Our exposure | Action |
|---|---|---|
| `Bun.$` globs only literal template patterns; interpolated `*` is literal | 49 files use `Bun.$`; the only literal glob-ish template is `pm2 jlist 2>/dev/null \|\| echo "[]"` (no glob). Interpolations are paths. | None. Safer than before. |
| `server.stop()` waits for in-flight requests and closes idle keep-alives | The API server is `node:http` (`createServer` in `src/http/index.ts`), so this does not apply there. The artifact server (`src/commands/artifact.ts:128`, `src/artifact-sdk/server.ts:173`) is `Bun.serve` and does `await server.stop()` on SIGINT/SIGTERM; a hung client now delays exit until it closes. | Use `stop(true)` in the artifact signal handlers, or race `stop()` against a short deadline. |
| Node 26: `res.writeHeader()` removed, paused `read()` returns one chunk | No `writeHeader(` and no paused-mode `.read()` in `src/`. | None. |
| `fetch()` network errors are `TypeError` (`.code` kept) | No `instanceof TypeError` or `name === "Error"` branching in `src/`. | None. |
| `Request#clone()` / `Response#clone()` throw after body read | `src/scripts-runtime/api-client.ts:213` clones the response in the error path. The only caller (`:296`) checks `response.ok` and has not read the body. | None. |
| Duplicate headers join with `, ` | `X-Agent-ID` / bearer readers take `headers.get()`. A client sending two `X-Agent-ID` values now yields `"a, b"` instead of the last one. Auth fails closed. | None. |
| `dns.lookup()` uses `getaddrinfo` on Linux | Docker split-DNS / systemd-resolved names now resolve. | None; positive. |
| Bun-as-`node` no longer loads `.env` | `ecosystem.config.cjs` and `docker-entrypoint.sh` invoke `bun`, not `node`. | None. |
| `Bun.TOML` strict (unquoted strings fail) | `bunfig.toml` values are quoted. | None. |
| `Bun.password.hash` argon2 `memoryCost ≥ 8` | We hash pages passwords with `"bcrypt"`. | None. |
| `trustedDependencies` exact-name match | `esbuild`, `unrs-resolver` are exact names. | None. |
| `AbortSignal.timeout()` fires even when unobserved | 9 fetch call sites; each signal is single-use. | None. |
| `bun build --compile` no longer auto-loads `tsconfig.json` / `package.json` at runtime (1.3.4) | Already past this on 1.3.11. `src/http/core.ts:349` reads `package.json` via `Bun.file()` from cwd; the Dockerfile copies it. | None. |
| Node 26 ABI (`NODE_MODULE_VERSION` 147) | `sqlite-vec` is a plain `.so` loaded by `bun:sqlite`, not a N-API addon. `@aws-sdk` etc. are pure JS. | None. |
| `bun install` isolated-linker default for new monorepos | `bunfig.toml` pins `hoisted`; `configVersion: 1` already recorded. | None. |

### Worth a small PR

- **`--no-orphans` on the scripts-runtime harness child** (agreed in review). `src/utils/sandboxed-process.ts` wraps user code in `ulimit ... ; exec env -i ... bun <harness>`. Adding `--no-orphans` to that inner `bun` invocation makes Bun SIGKILL every descendant when the harness exits and exit when the API dies. Today the test log prints `killed N dangling processes` after the executor tests; this closes the gap at the runtime level, not only in tests. Also applies to the worker runner spawning `claude` / `codex` if we want parent-death propagation. Needs the Bun 1.4 pin first (the flag is 1.4-only), so it rides after the alignment PR.
- **`bun build --compile --bytecode --format=esm`** for `agent-swarm-api` and the worker `agent-swarm` binary. 1.4 lifts the CJS-only restriction, so top-level await and dynamic `import()` keep working. Measured here on Bun 1.4.0 (macOS arm64, same source):

  | Binary | Size plain | Size bytecode | Startup plain | Startup bytecode |
  |---|---|---|---|---|
  | `agent-swarm` (worker CLI), `help` | 103 MB | 235 MB | 388 ms | **81 ms** |
  | `agent-swarm-api`, time to first log line | 83 MB | 158 MB | ~500-550 ms | **~195-250 ms** |

  Build time rises from 0.3 s to 0.7 s (CLI) and from 0.2 s to 0.5 s (API). The worker binary boots on every container start and every hook invocation (`src/hooks/hook.ts` runs through the same binary), so 300 ms × hooks-per-session adds up. The cost is +130 MB on a 1.96 GB slim / 4.22 GB full worker image (3-7 %) and +75 MB on the 381 MB API image (~20 %). Recommendation: adopt for the worker binary, decide per image-size budget for the API.
- **`bun build --compile --asset ./templates --asset ./src/be/migrations`.** Today the API image copies `migrations/*.sql`, `modelsdev-cache.json`, `vendored-openapi/`, `script-types/` beside the binary, and `src/be/seed-skills/index.ts` + `seed-scripts/index.ts` hold 49 static `with { type: "text" }` imports because "templates/ only exists in the builder stage". `--asset` embeds a directory and `node:fs` reads it under `/$bunfs/`, so the seeders could `readdir` the skill directory at runtime and the "static imports because compiled binary" rule in CLAUDE.md goes away. Medium-size refactor; worth it only if the next seeded-skill change is painful.
- **`Bun.markdown.render()` for `markdownToSlack`.** `src/slack/blocks.ts:46` converts GFM to mrkdwn with a chain of regexes and private-use placeholders. `Bun.markdown.render(src, { strong, em, heading, link, codespan, ... })` is a real parser with GFM tables / strikethrough / task lists and linear-time guarantees on adversarial input. Replaces the regex chain with per-node callbacks. The output is ours to escape, so the "HTML output is not sanitized" caveat does not apply.
- **`bun dedupe --check` in the lint job** and **`bun pm licenses --prod --json`** as a release artifact. Cheap, no risk.
- **`bun audit fix`** is now a thing; note it in `runbooks/ci.md` next to the lockfile rules.

### Looked at, not worth it

- **`Bun.cron()`**: the OS-level overload registers crontab / launchd jobs; we have a DB-backed scheduler with per-schedule timezones, `nextRunAt`, and a heartbeat reaper. `Bun.cron.parse(expr, { tz })` returns only the next UTC `Date` and handles 5-field syntax. `cron-parser` gives us `currentDate`, an iterator, and a richer grammar (`src/scheduler/scheduler.ts:257`). Swapping saves one dependency and risks semantic drift in schedules users already created. `cronstrue` in the UI stays either way.
- **`Bun.serve({ routes: { "/x/*": { dir } } })`, Range / conditional requests, `Bun.serve` backpressure, HTTP/3**: the API is a `node:http` server (`createServer` in `src/http/index.ts`), not `Bun.serve`, and it does not serve a static directory (the UI is a separate container; pages and artifacts are DB- or agent-fs-backed). No `new Response(Bun.file(...))` in `src/http`. Moving the API to `Bun.serve` is a separate decision with its own tradeoffs (MCP SDK transports, hono adapter) and is not a 1.4 item.
- **`Bun.Terminal`**: no PTY usage anywhere (no `node-pty`, no `script -q`). Harnesses run headless.
- **`Bun.Image`, `Bun.WebView`, HTTP/3 in `Bun.serve`**: no use case.
- **HTTP/2 `fetch()`**: experimental flag; our provider SDKs manage their own clients. Revisit when stable.
- **`fetch({ compress })`**: worker → API uploads (session logs, progress) are small; the API would also need decompression on the receiving route. Skip.
- **Global virtual store (isolated linker, 7× faster warm installs)**: only applies to `linker = "isolated"`, which we pinned away from because of phantom deps (`typebox`, `@slack/web-api`, `@types/node`). Docker builds install from a cold cache anyway. Revisit when the "declare the phantom deps" follow-up lands.
- **`bun run --parallel`** vs turbo: `mono:*` scripts use turbo for its cache. `bun run --parallel --filter '*' lint` would drop caching for no speed gain.
- **`bun prune --production`**: the API image ships a compiled binary plus a curated copy list; there is no `node_modules` to prune.
- **Built-in React Compiler, barrel-import optimization, `bun:bundle` feature flags**: `apps/ui` builds with Vite; `src/` bundles are small.
- **OpenTelemetry `instrumentation-http` / `-fs` now work**: they patch `node:http`, which is what the API uses, so `@opentelemetry/instrumentation-http` would now produce a server span per request automatically. We already emit request spans by hand in `src/otel-impl.ts`, so adopting it means duplicate spans unless the manual ones go. Not a 1.4 action; a candidate for the next OTel pass.
- **`--cpu-prof-md` / `--heap-prof-md`**: nice for the next perf investigation (Markdown profile you can paste into a task). Worth remembering, nothing to change.

## Decisions (review, 2026-08-20)

1. **CI Bun version: pin to the repo's version.** `packageManager` is the source of truth; `setup-bun` follows it once `bun-version: latest` is removed; a check script keeps the Dockerfile tags in sync.
2. **CI layout: 2 shards × `--parallel=4`.** Measured 51 / 53 s per shard against 29 / 29 / 29 / 55 s for 4 shards; two runner setups instead of four is the cheaper bill for ~25 s of wall clock.
3. **Keep the `preload.ts` `Response`/`Request` guard.** Taras asked whether removing it is worth it. It is not: the guard is six lines, costs nothing per test, and still protects anyone running `bun test <one file>` or `bun test --watch` locally without the CI flags (the `@hono/node-server` swap happens inside a single file as soon as an MCP HTTP transport is constructed, so it can bite within a file, not only across files). Leave it.
4. **All of it lands as one PR** (section "The plan: one PR"), version alignment included as its first step. The runtime items under "Worth a small PR" (`--no-orphans`, bytecode, `--asset`, `Bun.markdown`) stay separate.

## Outcome (implementation PR, 2026-08-21)

Taras widened decision 4 to "one PR with all the proposals". What actually landed, and where reality differed from the plan above:

- **Version pin**: `packageManager` `bun@1.4.0`, `engines.bun >=1.3.12`, three `FROM oven/bun:1.4.0`, plus the worker-base runtime `bun.sh/install` pin (it was unpinned `latest`). `scripts/check-bun-version.ts` runs in the merge gate. All 15 `setup-bun` steps use `bun-version-file: package.json`.
- **Lockfile stays `lockfileVersion: 1`.** Bun 1.4.0 only writes v2 for new lockfiles; `bun add` + `bun remove` on an existing v1 file rewrites it as v1. Deleting the lockfile to force v2 would re-resolve versions, so it was left alone (and Bun < 1.4 can still read it).
- **Ports**: 52 test files converted (50 by Sonnet sub-agents in four batches, Codex auth was broken; two by hand). The "6 hard-coded 3013 binds" in the plan did not exist: every spawned `src/http.ts` already set `PORT`, and 3013 only appears inside URL strings. Two files used `30000 + Math.random() * 20000`; those moved to `getFreePort()` too.
- **Preload cache** key is wider than "hash of migrations": it also hashes `db.ts`, `seed-prompt-templates.ts`, `preload.ts`, the prompt-template registry JSON, and `Bun.version`, because `initDb` bakes the prompt registry into the template. Cold 300 ms, warm 60 ms per file.
- **Retry**: global `retry = 3` removed and NO per-test retries added. The two candidates from the plan do not benefit: the `workflow-engine-v2` watchdog test fails deterministically on macOS (sandboxed bash hangs; it is one of the known local-only failures, passes on Linux), and the `slack-render-v2` watermark test had a real millisecond race (the stale-tree query compares `task.lastUpdatedAt > tree.updated_at`; failing the task in the same ms the tree rendered left nothing to render; ~1 in 3 local runs, and its retries fail in a chain because the first attempt consumes `updateFailuresRemaining`). Fixed with a 2 ms sleep before `failTask`, 6/6 green after. A retry there would only have hidden it. The `seed-scripts` catalog test got a 30 s timeout (it typechecks every seed script; slow under load, not flaky).
- **`bun dedupe --check` is NOT in the gate.** It fails today with 31 removable duplicates, and `bun dedupe` would move `@biomejs/biome` 2.3.10 -> 2.4.5, `zod`, `openai`, and others. That is a dependency PR, not a lint step. Documented in `runbooks/ci.md`.
- **`Bun.markdown.render()` for `markdownToSlack`: skipped.** The current function is a line-preserving regex pass whose tests assert exact output (blank lines, bullets, placeholders). A real Markdown renderer normalizes structure and cannot pass those tests unchanged, so it would be a behavior change for no measured gain.
- **Bytecode**: worker binary only (`Dockerfile.worker` + `build:binary*`), API binary unchanged.
- **`--no-orphans`**: added centrally in `buildSandboxedCommand` whenever the inner command is `bun`, so all three callers (scripts-runtime native executor, script-workflow executor, workflow script executor) get it.
- **Artifact servers**: `await server.stop(true)` in the SDK `stop()`.
- **Release**: `create-release` attaches `third-party-licenses.json` from `bun pm licenses --prod --json`.

### Review round (two-axis code review, 2026-08-21)

Changes after the Standards + Spec review:

- **Shared helpers** in `src/tests/test-net.ts`: `getFreePort`, `listenOnFreePort(server)`, `waitForServer`, `SERVER_BOOT_HOOK_TIMEOUT_MS`. The 40 pasted `server.address()` blocks and the 9 `waitForServer` copies are gone; `rbac-e2e-helpers` re-exports `getFreePort`. The 25 pre-existing local `listen()` helpers in files this PR did not otherwise touch stay (diff test).
- **Boot deadline was inert**: every spawn hook still had a 20 s hook timeout, so the 60 s `waitForServer` ceiling never applied. Hooks now use `SERVER_BOOT_HOOK_TIMEOUT_MS` (90 s).
- **Preload cache-hit parity**: a cache hit now opens the template once through `initDb`'s fast path (then closes it) so the encryption-key cache, prompt-resolver DI, and sqlite-vec load happen exactly as on a cold build. Cache entries are pruned by age (24 h, including orphaned `.tmp`) instead of "everything but my key", so two worktrees can share the dir.
- **Pre-push**: one hook, `scripts/pre-push-tests.sh`, picks `--changed=<merge-base>` or the full suite (migrations / templates / bunfig / package.json / bun.lock / no origin/main). A `bun-version` hook runs `check:bun-version` on Dockerfile or package.json pushes.
- **Merge gate** runs `--timeout 10000` like `ci.yml` already did (4 workers saturate a runner and the global retry is gone). `check:bun-version` also runs in `ci.yml`; `test-timings.json` is in the TEST change filter.
- **Release**: the license-inventory steps are `continue-on-error` and the asset is attached only when the file exists.
- **Env-hygiene test** excludes exactly `BUN_FEATURE_FLAG_NO_ORPHANS` instead of the whole `BUN_FEATURE_FLAG_*` prefix.
- `check-bun-version.ts`: line-anchored install regex, no `required` knob, missing-file report.
- Docs: size table 2.1 / 4.3 GB, "four pins", `runbooks/testing.md` hard rule 4, dangling `runbooks/testing.md` pointers now target `LOCAL_TESTING.md`.

Observed once in three full local `--parallel=4` runs: `scripts-runtime-identity` "ctx.swarm.task_poll() presents X-Runtime-Instance-ID" returned `eval_error` (spawn failure under load; passes alone and in the other runs). Same macOS `ulimit -u` class as the known set; watch it on Linux CI.

### CI round (Linux, 4-vCPU runners, 2026-08-21)

The first two Merge Gate runs each failed shard 1/2 on tests my macOS runs never tripped; shard 2/2 was green both times and the known macOS-only set passes on Linux as expected.

- Run 1: `apps-spike5` bulk migration scan (200k kv rows) took 10.2 s and hit the new `--timeout 10000`. Explicit 60 s budget. Two `seed-scripts` typecheck tests were at 9.7 s / 10.1 s and got the same.
- Run 2: `additive-buffer` debounce tests (20 ms / 30 ms windows with 5 ms / 20 ms sleeps) flushed early under load; windows widened 10x. `claude-managed-adapter` tool-loop test: the adapter fires `checkToolLoop` without awaiting it and each call is a read-modify-write of a `/tmp` history file behind a `mkdir -p` subprocess, so 25 ms event gaps overlap under load and lose updates. Event gap 100 ms, poll window 10 s, `{ timeout: 30_000, retry: 2 }`. The lost-update race itself is a product follow-up (serialize the checks per session); not touched here.

These are the flakes the global `retry = 3` used to hide. `--parallel=4` on a 4-vCPU runner is the honest load test for them; if a third class shows up, dropping to `--parallel=3` is the cheap lever.


### PR review round (CodeQL + Codex, 2026-08-21)

- **CodeQL `missing-workflow-permissions`** on the jobs this PR touched. No job in `ci.yml` or `merge-gate.yml` declared `permissions:` before. Scoped the four touched jobs (`test`: `contents: read`; `save-timings`: `{}`). The sweep over the other 13 jobs is #1224.
- **Codex P1, real**: both shards restored the timings cache independently through the `bun-test-timings-` prefix fallback (the `run_id` primary key never exists at restore time). A save landing between the two restores gives the shards different snapshots, and `--shard` assigns files from the durations it is given, so the two shards would split two different lists while the run stays green. The workflow comment that claimed "the shared restore key guarantees" the same files was wrong. Fix: a `restore-timings` job resolves the snapshot once and uploads it as the `timings-snapshot` artifact (with a `snapshot-key.txt` marker so the artifact exists on a miss and the run logs which snapshot it used); both shards download that. Listed in the merge gate's `needs` so a failed restore cannot skip the matrix silently.
- **Codex P2, declined**: move `withBunNoOrphans` above the win32 early return in `buildSandboxedCommand`. Bun's `ParentDeathWatchdog.rs` is `#[cfg(unix)]` throughout (Linux `PR_SET_PDEATHSIG`, macOS kqueue `NOTE_EXIT`); every non-unix branch returns `None` / `false`, so the flag is inert on Windows. The win32 path is already the explicitly unsandboxed fallback and the API that spawns the runtime ships as a Linux image.

Follow-up issues from the handoff: #1220 (tool-loop lost-update race), #1221 (fold the 25 local `listen()` helpers), #1222 (`bun dedupe`), #1223 (API binary `--asset` / `--bytecode`), #1224 (workflow permissions sweep).

Gate run 5 (bb46a66a) surfaced one more load flake: `memory-edges` "Q2 free-form" failed with `SQLiteError: database is locked` inside `applyRating`. The transaction is a deferred `BEGIN` that reads (`checkExists`) before it writes; the test shares the DB file with a spawned `src/http.ts`, and when that process commits between the read and the first write, SQLite returns `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` never retries. Fix: `applyTx.immediate()` (write lock up front, waits on the 5 s busy_timeout). 5/5 green alone, 9 memory files green under `--parallel=4`. The same shape exists in other deferred write transactions (55 `db.transaction(` call sites); only reachable from tests that spawn a second process on the same file, so the sweep is a follow-up, not this PR.

Gate run 6 (1faa3ea9): `memory-edges` green; a new one appeared. `entrypoint-codex-oauth-seed` runs `jq` five times through `Bun.spawnSync` with a stdin Buffer; the first three took 6-30 ms, then the two standalone-path calls each sat for the full 10 s budget with the child alive and were reaped as "dangling". The file normally takes 180 ms (per the timings snapshot). jq blocks only on stdin EOF, so the sync spawn loop either never closed the pipe or lost the exit. Not reproducible here (400 consecutive calls in 1.5 s on macOS); Bun has an open issue on the same `SpawnSyncEventLoop` losing child events (oven-sh/bun#34069, macOS kqueue flavour). Mitigation, not a proven fix: the helper is now async `Bun.spawn` with explicit stdin write + close and a 5 s `timeout` + `SIGKILL`, so the regular event loop does the I/O and a hang fails fast with stderr and the signal in the message. Watch item: if another `spawnSync` + piped-stdin hang shows up on Linux, open a Bun issue with the log.

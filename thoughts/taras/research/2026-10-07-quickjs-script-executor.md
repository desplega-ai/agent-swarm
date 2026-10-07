---
date: 2026-10-07T15:30:00+02:00
researcher: Claude
git_commit: 67bf06f4c
branch: worktree-quickjs-script-executor
repository: agent-swarm
topic: "QuickJS as a second script executor: feasibility, benches, and what we learned building it"
tags: [research, scripts-runtime, quickjs, wasm, executor, bench, script-apis]
status: complete
last_updated: 2026-10-07
last_updated_by: Claude
---

# Research: QuickJS as a second script executor

**Question (Taras):** Can we run scripts in QuickJS, in the style of
[supermemoryai/company-brain `quickjs-executor.ts`](https://github.com/supermemoryai/company-brain/blob/main/src/brain/codemode/quickjs-executor.ts),
as a second backend next to the Bun subprocess executor? What do we gain,
especially for scripts exposed as APIs (`POST /api/x/script/<id>`)?

**Answer:** Yes. It now exists behind `SCRIPT_EXECUTOR=quickjs`. It removes
the process spawn from every run: a short script costs ~1 ms instead of
~10 ms (Linux) or ~35 ms (macOS). It loses on CPU-heavy scripts and on scripts
that import `zod`. Keep `native` as the default.

## Summary

| | native (default) | quickjs (opt-in) |
|---|---|---|
| Isolation | `bun` subprocess, `ulimit`, `env -i` | WASM heap, interrupt deadline, no globals except host calls |
| Per-run floor (Linux) | ~10 ms | ~1 ms |
| Per-run floor (macOS) | ~35 ms | ~1 ms |
| CPU-heavy work | JIT (fast) | interpreter, 3-11x slower |
| `zod` import | parsed by JSC, cheap | ~10-25 ms per run to evaluate the tree-shaken zod |
| API surface | full Bun + Node compat | `ctx.*`, text-only `fetch`, `setTimeout`, `console` |
| Spawn failure modes | `capacity_exceeded` (RLIMIT_NPROC), spawn under load | none |

## Design (as built)

```
API process
 └─ QuickJSScriptExecutor (executors/quickjs.ts)
     └─ pool of 4 Bun Workers (executors/quickjs-worker.ts), one job each at a time,
        recycled after an abort, a hang, or WASM memory above 64 MB
         ├─ QuickJS WASM module loaded once per worker (~25 ms, singlefile variant)
         ├─ per job: restore pristine fetch, apply egress patch, build host ctx
         └─ runQuickJSJob (executors/quickjs-runner.ts)
             ├─ bundleForQuickJS (executors/quickjs-bundle.ts): Bun.build in memory,
             │   IIFE, zod from ESM sources (tree-shaken), stdlib/swarm-sdk virtual,
             │   external source map, LRU cache of 128 bundles per worker
             ├─ fresh QuickJS runtime: heap = memoryMb, interrupt at wallClockMs
             ├─ prelude (executors/quickjs-prelude.ts) rebuilds ctx on host calls
             └─ epilogue runs argsSchema + default(args, ctx), reports via __host_done
```

Host boundary (every value crosses as JSON):

- `__host_call(path, argsJson)` (async): `swarm.<tool>`, `swarm.room.<m>`,
  `api.<slug>.<op>`, `mcp.<slug>.<tool>`, `fetch`, `stdlib.fetch`,
  `stdlib.fetchJson`. The host side reuses the real `buildCtx`, so the SDK
  allowlist, scrubbing, and the 64 MiB response guard all apply unchanged.
- `__host_sync(op, json)`: `redacted.value`, `redacted.meta`, `config.has`, `table`.
- `__host_log`, `__host_sleep`, `__host_done`.

Why a worker pool and not the API thread: a synchronous loop in QuickJS blocks
its thread until the interrupt deadline fires. In the worker, the API event
loop stays free (bench: <2.5 ms stall during a 400 ms CPU script). The worker
also gives each job its own `globalThis.fetch`, so the egress credential patch
never leaks into the API process. Terminating the worker is the hard kill for
an abort.

Why a pool and not a worker per run: a fresh worker plus the singlefile WASM
load costs ~19-35 ms, which is the whole native floor again.

## Benches

Bench source: `experiments/quickjs-executor/bench.ts` (real executor classes,
native with prebuilt bundles as in the Docker image).

### Linux (oven/bun:1.4.0 container, arm64, OrbStack on an M-series Mac)

| latency p50, ms | native | quickjs | change |
|---|---|---|---|
| trivial | 9.6 | 1.2 | 8.3x faster |
| 3 HTTP calls | 11 | 1.5 | 7.1x faster |
| zod `argsSchema` | 20 | 25 | 0.8x (slower) |
| CPU loop, 5M iterations | 39 | 428 | 11x slower |
| JSON, 50k rows | 26 | 82 | 3.2x slower |

Throughput, 16 concurrent: trivial 319 vs 876 runs/s, 3 HTTP calls 404 vs
974, zod 247 vs 107. The quickjs numbers are bounded by the pool of 4.

### macOS (Bun 1.4.2, arm64)

| latency p50, ms | native | quickjs | change |
|---|---|---|---|
| trivial | 35 | 1.1 | 32x faster |
| 3 HTTP calls | 34 | 1.5 | 23x faster |
| zod `argsSchema` | 44 | 13 | 3.3x faster |
| CPU loop, 5M iterations | 68 | 401 | 6x slower |
| JSON, 50k rows | 45 | 80 | 1.8x slower |

### End to end: `POST /api/x/script/<id>` (p50 over 20 calls, includes HTTP + DB)

| script | native (Docker) | quickjs (Docker) | native (macOS binary) | quickjs (macOS binary) |
|---|---|---|---|---|
| trivial | 13.5 | 3.5 | 36.1 | 2.3 |
| `ctx.swarm` kv set + get | 16.6 | 3.6 | 39.7 | 2.8 |
| throws | 13.3 | 2.4 | 34.9 | 1.9 |
| zod `argsSchema` | 22.7 | 29.6 | 45.3 | 16.4 |

Docker = the API image built from this branch's Dockerfile, run under OrbStack.

## Learnings

1. **The native floor is much lower on Linux than on macOS.** ~10 ms against
   ~35 ms. The first in-session bench ran on macOS only and overstated the gain
   by ~4x. Always bench on Linux before quoting a number for prod.
2. **The native floor is mostly our own overhead, not Bun.** On macOS a bare
   `bun -e 0` costs ~6 ms. The bash `ulimit` prelude adds ~9 ms, and loading
   the 177 KB harness bundle adds ~7 ms. Trimming these is a cheaper latency
   win for `native` than a new executor.
3. **zod is the QuickJS trap.** QuickJS re-evaluates the zod code on every
   fresh runtime. Measured eval + parse per run (fresh runtime):
   whole zod namespace 22.6 ms, zod/mini namespace 19.2 ms, tree-shaken full
   zod 7.3 ms, tree-shaken zod/mini 1.6 ms. Tree-shaking only works against
   zod's ESM sources: the prebuilt `zod.bundle.js` stays ~340 KB. So the
   Dockerfile now stages `scripts-runtime/zod-esm/` (~1 MB). Minifying
   whitespace + syntax saved ~7% (9.9 to 9.2 ms); mangling identifiers saved
   another ~7% but ruins stack-frame names, so we do not mangle.
4. **For native, bundling barely helps.** Pre-bundled tree-shaken zod saves
   3-6 ms of ~43 ms on macOS. Not worth it for `native` alone.
5. **No QuickJS runs TypeScript.** quickjs-ng also does not. Every TS-on-QuickJS
   project strips types first. `Bun.build` does it in 0.5-4 ms in memory with
   the `files` option (Bun >= 1.3; the pinned bun-types lack the option, so the
   call site casts).
6. **Compiled binary + Worker path.** In `bun build --compile`, every module's
   `import.meta.url` is the binary itself (`/$bunfs/root/<binary>`). An extra
   entrypoint lives at its path relative to the entrypoints' common root, so
   the worker is `./scripts-runtime/executors/quickjs-worker.ts`, not a URL
   relative to the importing module. `new URL("./quickjs-worker.ts", import.meta.url)`
   fails with `ModuleNotFound` in the binary.
7. **Use the singlefile QuickJS variant.** It embeds the WASM as base64, so it
   works in the compiled binary with no asset path. It loads in ~25 ms (the
   wasmfile variant loads in ~6 ms), which the pool pays once per worker.
8. **QuickJS stack frames carry columns** (`at foo (user-script.js:3:18)`), so
   an external source map from `Bun.build` maps errors back to the user's TS
   line. Evaluate the prelude, the bundle, and the epilogue as separate
   `evalCode` calls so bundle lines match the source map 1:1.
9. **OOM can be slow.** Many small strings make QuickJS's GC thrash near the
   heap limit (~4.7 s before `out of memory`). One growing array fails in
   ~80 ms.
10. **Bun quirk:** a `data:` URL response returns `null` headers if its body is
    streamed before the headers are first read. The runner reads headers first.
11. **`Bun.build` constant-folds `typeof require` to `"function"`**, so probe
    sandbox globals through `globalThis.<name>`.
12. **WASM memory never shrinks.** A worker's linear memory went from 16 MB
    to ~298 MB after one job that built 3M objects, and stayed there after the
    QuickJS runtime was disposed. With 4 workers and `memoryMb: 512`, the API
    process could hold ~2 GB of idle WASM memory. The worker now reports its
    heap size after each job, and the pool recycles any worker above 64 MB.
13. **Script APIs already validate args on the host.** `src/http/x.ts` checks
    `argsJsonSchema` before it runs the script, so the in-sandbox zod parse is
    a second check. Skipping zod inside QuickJS for script APIs is a safe
    follow-up that removes the zod cost.

## Parity check

The existing runtime suites pass under `SCRIPT_EXECUTOR=quickjs`
(`scripts-runtime`, `scripts-runtime-secret-egress`, `scripts-runtime-fetch`,
`scripts-runtime-identity`, `script-connections*`, `scripts-http`,
`script-runs-http`, `workflow-swarm-script`, `scripts-external-api`,
`script-apis-mcp`, `scripts-mcp-e2e`): 226 of 227. The one failure is
expected: "subprocess env is stripped to the explicit allowlist" reads
`process.env`, and QuickJS has no `process` at all.

## Not done (follow-ups)

- `zod/mini` on the import allowlist (needs typecheck `.d.ts` and prompt changes).
- Skip in-sandbox `argsSchema` for script APIs that already validated on the host.
- `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`, `setInterval`,
  `crypto.randomUUID` shims. The typecheck accepts them today, so a script can
  pass `script-upsert` and fail at run time under `quickjs`.
- Per-script executor choice (today `SCRIPT_EXECUTOR` is server-wide).
- `SCRIPT_EXECUTOR` in the dashboard configuration catalog.
- Configurable pool size (fixed at 4).
- Native floor trimming (learning 2).

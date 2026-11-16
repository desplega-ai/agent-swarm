# Phase 1 transaction error contract

**Decision note, 2026-11-15:** Taras approved option 1: preserve caught errors and require stricter static checks.
The historical counterexample and results below remain unchanged.
The former universal rollback requirement for abandoned failures no longer applies to runtime acceptance.
Current implementation evidence appears in `2026-11-15-worker-sqlite-phase1.md`.

Verdict: **contract-blocked**.

The current Promise API cannot enforce all five requirements through local instrumentation on pinned Bun without additional runtime observation or caller cooperation.
This conclusion concerns the permitted API and runtime facilities. It does not claim that an engine modification could never provide the missing information.

The escalation changed only this report. Production code, tests, the semantic probe, the plan, and the routing savepoint workaround remain unchanged.
No later phase, subagent, production access, Docker operation, commit, push, or PR occurred.

**Fresh evidence**

The runtime is Bun 1.4.4, revision `38afee6c84fcf48c0edb2466aa4b27d287a59c30`.
`package.json:57` pins this version.
The unmodified semantic probe ran with this command:

```bash
NODE_ENV=test \
SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events \
DESPLEGA_TELEMETRY_ENV=test \
bun scripts/probe-db-transaction-errors.ts
```

The probe validates the HTTP loopback endpoint before database initialization.
It created isolated databases with synthetic data and UUID identities, then closed both clients and removed its directory.
It exited 1: **16 failed checks, 10 passed checks, six captured native unhandled rejections**.
The existing diagnostic listener remained confined to that probe and was removed by its cleanup.

Both drivers produced the same results:

- Six caught-error cases failed: native await, async wrapper, ambient client wrapper, catch, finally followed by catch, and caught rethrow.
- Both best-effort cases failed: optional workflow snapshot and memory embedding update.
- Four floating-error cases passed: direct statement, async wrapper, then chain, and finally chain.
- The successful chained-statement drain passed.

The snapshot case reported `synthetic snapshot failure`.
The embedding case reported `Internal sqlite-vec error: Could not insert a new vector chunk`.
The six caught-error cases reported `no such table: absent_probe`.
These are expected reproductions of the blocker, not acceptance results.

**Why the seam lacks the required information**

Consider these callbacks, using the same helper:

```ts
async function callback(tx: DbExecutor, recover: boolean) {
  await tx.run("INSERT INTO probe VALUES (1)");
  const completed = Promise.withResolvers<void>();
  async function helper() {
    try {
      await tx.run("INSERT INTO absent_probe VALUES (1)");
    } finally {
      completed.resolve();
    }
  }
  const wrapped = helper();
  if (recover) {
    try { await wrapped; } catch {}
  } else {
    await completed.promise;
  }
}
```

With `recover=true`, requirement 1 demands a commit.
With `recover=false`, requirement 2 demands a rollback.
Both callbacks fulfill after the failing statement settles.
The completion signal establishes this condition without timers, sleeps, or a guessed number of microtasks.

In both cases, the seam receives the same SQL calls and returns the same statement rejection to the same helper.
The difference exists only at `wrapped`, a native promise created by the async function.
The caller never gives `wrapped` to the seam.
Neither the statement promise nor its rejection callback exposes that wrapper's downstream consumer.
Error identity also remains identical.

Consequently, marking the statement handled when the helper awaits it loses the floating-wrapper failure.
Keeping that statement fatal rejects the caught-wrapper case.
Waiting for a stable statement queue cannot reveal a private consumer of an already-settled wrapper.
The same counterexample applies to ambient client calls and within a savepoint.
One indistinguishable pair suffices to defeat a contract that must support every listed Promise form.

Native await and thenable assimilation use internal promise reactions and resolving functions.
Those functions do not return the downstream rejection result to the thenable.
The language provides rejection tracking to the host, not as a local Promise observer.
See [Await](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#await), [thenable assimilation](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-newpromiseresolvethenablejob), and [host rejection tracking](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-host-promise-rejection-tracker).

**Pinned-runtime checks**

Six isolated subprocesses exercised the pair above with a synthetic failing statement.
Each pair used one local representation: a native Promise, a Promise subclass, or a thenable.
The parent asserted identical local traces, successful caught-process exit, and unhandled floating-process failure.
All three comparisons passed:

```text
native:   statement admitted -> transaction callback fulfilled
subclass: statement admitted -> local then called -> transaction callback fulfilled
thenable: statement admitted -> local then called
          -> reject callback returned undefined -> transaction callback fulfilled

For every representation:
  caught process:   exit 0, no native unhandled error
  floating process: exit 1, native db-error-contract-synthetic error
```

The native Promise experiment overrode only its own `then` method. Native await bypassed that method.
The subclass and thenable experiments observed the local call, but neither revealed the wrapper's consumer.
These diagnostics installed no rejection listener and changed no global Promise behavior.
They did not inspect callback source text or use timing heuristics.

Separate runtime checks confirmed:

- `node:async_hooks.createHook` recorded no events across fulfilled and caught-rejected async work.
- `node:v8.promiseHooks.createHook` threw `NotImplementedError: node:v8 createHook is not yet implemented in Bun.`
- `Bun.peek.status` returned `rejected` before and after a catch. Settlement state does not expose rejection consumption.

Current [Bun compatibility documentation](https://github.com/oven-sh/bun/blob/main/docs/runtime/nodejs-compat.mdx) also describes the lifecycle-hook limitations.
The direct checks above establish the pinned runtime's behavior independently of those moving documents.
AsyncLocalStorage associates operations with a transaction. It does not expose the hidden promise dependency graph.
A global rejection listener would change process behavior and still need ownership, propagation, and a defined pre-commit observation boundary.
A Promise prototype patch alone would also miss native await paths.
Neither approach was installed or approved.

**Relevant source and test constraints**

[enqueue](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/be/db-client.ts:792) records every rejection.
[runTransactionAttempt](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/be/db-client.ts:652) then rejects any recorded failure before COMMIT.
Internal handlers in `admit`, `execute`, and the drain cannot count as evidence of caller recovery.

[runSavepoint](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/be/db-client.ts:751) removes failures by scope identity.
Any approved revision must retain that isolation. A caught nested failure must never clear an outer failure.
The [existing ownership regression](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/tests/db-client.test.ts:113) specifically exercises an outer executor inside a nested callback.

The [stable-drain regression](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/tests/db-client.test.ts:763) attaches `pending.catch(() => {})` while expecting rollback.
That catch prevents a native unhandled rejection. It is not evidence for distinguishing caught errors from unhandled errors.
Its expectation needs explicit reconciliation after a contract decision. It must not silently redefine the requested semantics.
The [Worker floating-statement regression](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/tests/db-worker-driver.test.ts:216) uses actual unawaited statement calls.

The [routing savepoint workaround](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/be/db.ts:3097) remains necessary and unchanged.
The [workflow snapshot caller](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/workflows/version.ts:86) and [embedding caller](/Users/taras/.t3/worktrees/agent-swarm/t3-6b7c0548-f85e774a66b750fc/src/be/memory/providers/sqlite-store.ts:1572) deliberately catch statement failures.
The current failure ledger breaks their documented best-effort behavior.

**Minimum decision required from Taras and the parent**

Choose which requirement may change. Neither option below implements the original contract unchanged.

1. **Preserve native caught-error semantics and require structured Promise consumption statically. Recommended.**
   Roll back when the transaction callback rejects. Preserve serialization, stable draining of admitted operations, scope ownership, and transport safeguards.
   Require every DB operation and DB-bearing helper to be awaited, returned, or joined before its transaction scope ends.
   Replace requirement 2's universal runtime detection with rejection of unsupported floating code during static checks and review.
   The supported coding subset must reject `void`, ignored chain results, abandoned stored promises, and detached async callbacks that can access transactions.
   It must also cover helpers and nested transaction calls, not only direct executor methods.
   Arbitrary JavaScript cannot receive a complete static proof. Reject unsupported dynamic escapes conservatively and document the limit.
   Existing checks are insufficient: `check-floating-promises.ts` explicitly permits `void` and then/catch/finally chains.
   `check-promise-sinks.ts` checks unsafe sinks, not complete promise lifetimes.

2. **Keep conservative runtime rollback and require explicit error tolerance.**
   Change requirement 1: a native catch alone no longer authorizes commit after a failed statement.
   Provide a scope or operation API that explicitly authorizes tolerance, or explicitly acknowledges a particular failure record.
   Keep every other statement failure fatal, regardless of Promise observation.
   Existing nested savepoints provide SQL isolation, but merely catching their returned native promise recreates the same observation problem.
   A complete design needs explicit recovery authorization, or a static rule requiring every nested scope to be joined.
   Update all tolerated-error callers through that general contract, rather than exempting only the two known callers.

The explicit-scope option also needs a memory-specific semantic check.
Wrapping both vector deletion and insertion in one savepoint can restore an obsolete vector when insertion fails.
The current fallback expects the failed replacement to leave that vector absent while preserving the updated memory row.
Savepoint placement must preserve that behavior, not merely make the metadata assertion pass.

If neither change is acceptable, retain the blocker until an approved runtime facility can expose owned promise descendants and their rejection handling before COMMIT.
Do not treat authorization for a global listener or patch as proof that it would solve those requirements.

**Validation boundary and cleanup**

The semantic probe remains red, so focused seam, BUSY retry, transport, snapshot, memory regression suites, and typechecking were not run.
No broad suite or compiled build ran. No production implementation or new acceptance test is claimed.
The additional checks were standalone Promise diagnostics, not a weakened replacement for the semantic probe.
The probe closed its clients and removed its databases. Task-prefixed diagnostic files were removed after preserving their evidence here.
The five remaining files occupied 72 KiB according to `du -k` before cleanup.
The exact reproducer below also passed in two subprocesses. Its temporary source was removed immediately after verification.
The filesystem reported approximately 16 GiB available before and after the task. No shared cache or existing build output was removed.

**Reproduce the minimal diagnostic**

Save this block as `/tmp/db-error-contract-counterexample.ts`.
Run `bun /tmp/db-error-contract-counterexample.ts caught`, then `bun /tmp/db-error-contract-counterexample.ts floating`.
The first command must exit 0. The second must report the synthetic native unhandled error and exit 1.
Both commands must print the same local trace. Remove the temporary file afterward.
This thenable variant isolates the missing information without a database or external endpoint.

```ts
const mode = process.argv[2];
if (mode !== "caught" && mode !== "floating") throw new Error("Invalid mode");
const trace: unknown[] = [];
const error = new Error("db-error-contract-synthetic");
function statement() {
  trace.push("statement admitted");
  return {
    then(_resolve: unknown, reject: (error: Error) => unknown) {
      trace.push("local then called");
      const result = reject(error);
      trace.push(["reject callback returned", typeof result]);
    },
  };
}
async function callback() {
  const completed = Promise.withResolvers<void>();
  async function helper() {
    try { await statement(); }
    finally { completed.resolve(); }
  }
  const wrapped = helper();
  if (mode === "caught") {
    try { await wrapped; } catch {}
  } else {
    await completed.promise;
  }
}
await callback();
trace.push("transaction callback fulfilled");
console.log(JSON.stringify(trace));
```

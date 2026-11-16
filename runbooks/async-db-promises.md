# Transaction promise ownership

A rejected transaction callback causes rollback. A caught statement error alone permits commit.
The client drains admitted statements before completion. This drain does not detect abandoned native promise descendants.
Worker transport loss and failed savepoint recovery remain fatal, even when the callback catches their errors.
A lost COMMIT reply leaves the outcome uncertain. Neither hook group runs for that outcome.

Every DB operation and DB-bearing helper must finish through an await, return, or join before its transaction scope ends.
Use native `try`/`catch`, returned chains, and awaited chains for recovery.
Do not use a savepoint merely to tolerate a statement error.
A savepoint provides SQL isolation when rollback of its statements is required.

## Supported source forms

`scripts/check-floating-promises.ts` applies transaction ownership checks through `scripts/db-promise-analysis.ts`.
The existing general check still permits intentional background work outside transaction scopes.
The stricter check starts at source-resolved `DbClient.transaction` callbacks.
It follows source-resolved helpers, ambient client calls, nested transactions, and callback parameters.
It also follows helpers that capture bound executors without calling a DB method.
It checks helpers reached through these calls, including helpers in other source files.
Contextually typed callback properties connect configured dependencies to their source implementations.
Property assignments and shorthand properties receive this analysis, including implementations that use the ambient client.

Supported consumption forms include:

- Direct `await` and `return`, including expression bodies and returned conditional branches.
- Native `then`, `catch`, and `finally` chains with an awaited, returned, or joined final result.
- `Promise.all` and `Promise.allSettled`, including array literals and joined `map` callbacks.
- Local `const` promises or arrays with an unconditional join in the same block.
- Lazy callable factories with source-resolved returned functions. Their bodies and callback dependencies receive the same checks.
- Returned memoization through `return (pending ??= operation())`. Each invocation returns its pending promise.

For stored promises, place the join before branches, loops, or other control transfers.
Only straight-line declarations and expressions may precede that join.
This restriction deliberately rejects some safe programs to avoid an incomplete control-flow proof.
The join must follow a known unconditional expression path.
Short-circuit branches, ternary branches, optional calls, and destructuring defaults cannot prove consumption of previously created work.

Unsupported forms include:

- Discarded `void` calls and discarded chain results.
- Stored promises without a proven join, including conditional joins.
- Detached timers, `forEach` callbacks, and constructor callbacks that access transactions.
- `Promise.race` and `Promise.any` as ownership joins.
- Awaited or returned arrays of promises without `Promise.all` or `Promise.allSettled`.
- Transaction executors passed to unresolved functions or stored in objects.
- DB type erasure, executor destructuring, and extracted DB methods.
- DB callbacks assigned dynamically or stored in object properties.
- DB helpers or executor closures returned from a transaction callback.

Awaiting a returned closure does not make it safe. The closure still captures its expired executor.

Use `afterCommit` for work that must start after the transaction.
Its callback must use the client, rather than an expired bound executor.
The checker rejects direct captures and source-resolved helper captures of bound executors.
The checker treats commit and rollback hooks as separate lifecycle boundaries.
Commit hooks clear both ambient transaction and savepoint contexts before executing.

## Analysis boundary

This check enforces a supported TypeScript subset. It does not prove promise lifetimes for arbitrary JavaScript.
It uses TypeScript signatures, source declarations, callback bindings, and a conservative call graph.
It excludes tests, declaration files, and external packages from implementation analysis.
The seam tests deliberately exercise unsupported source forms to verify admitted-operation draining and executor expiry.
Their runtime behavior does not authorize those forms in application code.

The configured `auditAssetKeys` dependency in `src/be/db/session-moves.ts` has one explicit analysis exemption.
Boot wiring supplies `auditAssetKeysAsync`. That implementation receives its own transaction-root analysis.
The call must still return its promise through the transaction callback.
This exemption preserves the existing module boundary without claiming general support for dynamic dependency injection.

Reflection, runtime-generated code, arbitrary mutation of function bindings, and external callback implementations require review.
Do not hide DB operations behind these forms to bypass the checker.
Source changes that introduce new dynamic boundaries require a narrower implementation or an explicit, reasoned analysis exemption.

## Verification

```bash
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bun run test:root -- src/tests/db-promise-analysis.test.ts
NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events DESPLEGA_TELEMETRY_ENV=test bun scripts/probe-db-transaction-errors.ts
```

The corpus replaces the former runtime requirement for universal rollback after abandoned failures.
The semantic probe retains caught-error and best-effort reproductions.
It also verifies callback rejection, nested rollback isolation, and successful admitted-work draining on both drivers.

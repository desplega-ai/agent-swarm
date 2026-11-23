/**
 * Bounded db-query execution — Fix 1 for the API event-loop freeze.
 *
 * `bun:sqlite` is synchronous and exposes no interrupt, progress handler, or
 * statement timeout (verified two ways — see the design doc referenced from
 * the PR). A single expensive query therefore blocks the whole API process
 * until SQLite finishes. Running the query in a short-lived child process
 * lets the parent SIGKILL it on a wall-clock budget: the child dies and its
 * CPU is reclaimed immediately, unlike a worker thread's `terminate()`,
 * which detaches the main thread's view of the worker but leaves the native
 * SQLite call running to completion.
 *
 * SQL and params travel over the child's stdin (not argv), so query text
 * never appears in `ps` output. The child opens its own read-only
 * connection to the same on-disk WAL database file and loads the
 * sqlite-vec extension itself, from the same path the parent process uses
 * (env var first, npm resolver fallback in dev) — the child cannot see the
 * parent's already-loaded extension across the process boundary.
 *
 * `maxRows` travels in the same payload and is applied in the child, before
 * `rowArrays` is built and written to stdout — a query against a huge table
 * with a small `maxRows` transfers and parses a payload bounded by
 * `maxRows`, not by the full match count. `total` still reports every row
 * SQLite matched, so truncation is still detectable by comparing the two.
 *
 * If no `bun` executable can be spawned at all (no separate Bun CLI on
 * $PATH), the query falls back to the synchronous in-process path instead
 * of failing outright — see runBoundedQueryChild's catch around Bun.spawn.
 *
 * The child's own connection sets `PRAGMA busy_timeout` to the same
 * `budgetMs` the parent uses for its SIGKILL timer, not a fixed value — a
 * lock wait that would out-wait the overall budget anyway should surface as
 * SQLite's own busy error (or the parent's timeout) rather than waiting
 * longer than the query could ever be allowed to run.
 */

import { QueryReaderTimeoutError } from "@desplega/storage";
import { SqliteQuerySpawnUnavailableError, sqliteDbQuery } from "../be/storage-root";
import type { DbQueryResult } from "./db-query-shared";
import {
  assertNoDeniedTables,
  assertSingleStatement,
  DbQueryConcurrencyCapError,
  DbQueryTimeoutError,
  executeReadOnlyQuery,
  getDbQueryConcurrencyCap,
  isDbQueryWorkerPoolEnabled,
  warnDbQuerySpawnUnavailableOnce,
} from "./db-query-shared";

// The child and worker scripts, the worker pool and the kill-on-budget timer
// live with the SQLite engine (packages/storage-sqlite/src/db-query.ts),
// reached through the composition root.
export {
  getDbQueryWorkerPidsForTests,
  isReportableTimeout,
  resetDbQueryWorkerPoolForTests,
} from "../be/storage-root";

/**
 * Concurrency cap for in-flight bounded child-process queries.
 *
 * Before this cap, N concurrent callers spawned N children in parallel, each
 * materializing its own full result set — peak memory went from roughly 1x
 * (the old synchronous path serialized callers on one thread) to roughly
 * 3x-per-query and unbounded in N (the child's own rows array, the parent's
 * raw stdout buffer, and the parent's parsed JS object all live at once per
 * in-flight query).
 *
 * The default is `DB_QUERY_CONCURRENCY_CAP_DEFAULT` (see db-query-shared.ts
 * for the sizing math against the API pod's real 1 GiB memory limit);
 * overridable per deployment via `DB_QUERY_CONCURRENCY_CAP`, read dynamically
 * on every call (never captured in a module-level const) so a `swarm_config`
 * edit takes effect on the next request with no restart — mirrors
 * `isDbQueryBoundedEnabled`. Rejects immediately when full rather than
 * queueing — an unbounded queue would just move the memory growth from "many
 * children" to "many pending callers," and a caller that's told to retry can
 * back off, whereas a caller stuck in an in-process queue can't.
 */
let activeBoundedQueryCount = 0;

export function acquireBoundedQuerySlot(): void {
  const cap = getDbQueryConcurrencyCap();
  if (activeBoundedQueryCount >= cap) {
    throw new DbQueryConcurrencyCapError(
      `Too many concurrent db-query executions in flight (cap ${cap}). Retry shortly.`,
    );
  }
  activeBoundedQueryCount++;
}

export function releaseBoundedQuerySlot(): void {
  activeBoundedQueryCount--;
}

/**
 * Run one read-only query in a bounded `bun -e` child process, SIGKILLing it
 * if it runs past `budgetMs`. `total` semantics match executeReadOnlyQuery
 * exactly: the child visits every matching row to count `total`, but only
 * converts and serializes the first `maxRows` of them (in the child, see
 * CHILD_SCRIPT), so `total` still means "rows SQLite returned," not "rows
 * delivered" (callers such as src/tools/db-query.ts:41 and
 * src/http/metrics.ts:168 compare the two to decide whether a result was
 * truncated).
 */
export async function executeReadOnlyQueryBounded(
  sql: string,
  params: unknown[] = [],
  budgetMs: number,
  maxRows?: number,
): Promise<DbQueryResult> {
  assertSingleStatement(sql);
  // The child opens its own connection, so the parent checks the program first.
  assertNoDeniedTables(sql);
  acquireBoundedQuerySlot();

  try {
    return await sqliteDbQuery.runBounded(sql, params, budgetMs, maxRows, {
      pooled: isDbQueryWorkerPoolEnabled(),
    });
  } catch (err) {
    if (err instanceof QueryReaderTimeoutError) throw timeoutError(budgetMs);
    // No `bun` executable to spawn (e.g. the standalone `dist/agent-swarm`
    // binary): run in-process rather than failing every db-query outright.
    if (err instanceof SqliteQuerySpawnUnavailableError) {
      warnDbQuerySpawnUnavailableOnce();
      return executeReadOnlyQuery(sql, params, maxRows);
    }
    throw err;
  } finally {
    releaseBoundedQuerySlot();
  }
}

export function timeoutError(budgetMs: number): DbQueryTimeoutError {
  return new DbQueryTimeoutError(
    `Query exceeded the ${budgetMs}ms budget and was terminated. Filter on an indexed column and add a LIMIT. Aggregates such as COUNT(*), SUM(...) or typeof() over session_logs, agent_log, events or task_context_snapshots read every row in range and cannot be made cheap by chunking on rowid.`,
  );
}

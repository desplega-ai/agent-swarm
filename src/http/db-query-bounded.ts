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

import { getDb, resolveSqliteVecExtensionPath } from "../be/db";
import type { DbQueryResult } from "./db-query-shared";
import {
  assertSingleStatement,
  DbQueryConcurrencyCapError,
  DbQueryTimeoutError,
  executeReadOnlyQuery,
  getDbQueryConcurrencyCap,
  warnDbQuerySpawnUnavailableOnce,
} from "./db-query-shared";

interface ChildPayload {
  file: string;
  sql: string;
  params: unknown[];
  vecExtensionPath?: string;
  maxRows?: number;
  busyTimeoutMs: number;
}

interface ChildSuccess {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

/** Exit code the child uses when the query is a write statement. */
const WRITE_REJECTED_EXIT_CODE = 2;

// Plain JS (no TypeScript syntax) — this string is executed directly by
// `bun -e`, not compiled first. Mirrors executeReadOnlyQuery's read-only
// guard exactly, so `total` keeps meaning "rows SQLite actually returned"
// regardless of which path ran the query.
//
// Iterates the statement rather than calling `stmt.all()` — Codex review,
// PR #1192 thread 3815922598: `stmt.all()` still materializes every matching
// row as a JS object before anything gets to look at `maxRows`, even though
// the earlier fix already bounded what crosses the child/parent boundary.
// Iterating keeps that same boundary bound, but only ever holds one row
// object at a time plus the (at most `maxRows`) retained arrays — a query
// against a huge table with a small `maxRows` no longer allocates one JS
// object per matched row just to discard almost all of them. `total` is
// still incremented for every row visited, so truncation stays detectable
// by comparing it against `rows.length`.
//
// BLOB columns (e.g. memories.embedding, script_embeddings.embedding) come
// back from bun:sqlite as a Uint8Array — Codex review, PR #1192 thread
// 3816302384. JSON.stringify on a Uint8Array serializes it as an indexed
// object ({"0":1,"1":2,...}), not an array, because TypedArrays have no
// toJSON and JSON.stringify only special-cases real Arrays. The parent's
// JSON.parse then hands the MCP table renderer that indexed object, and its
// `String(v)` prints "[object Object]" instead of the byte list "1,2,3" the
// pre-child-process path produced. Converting to a plain Array here keeps
// `String()` on the round-tripped value identical to `String()` on the
// original Uint8Array (both join with commas) — the fix belongs in the
// child, once, rather than every consumer of DbQueryResult guessing which
// columns might be BLOBs.
const CHILD_SCRIPT = `
const { Database } = require("bun:sqlite");

(async () => {
  let payload = "";
  for await (const chunk of Bun.stdin.stream()) {
    payload += Buffer.from(chunk).toString("utf8");
  }

  const { file, sql, params, vecExtensionPath, maxRows, busyTimeoutMs } = JSON.parse(payload);

  try {
    const db = new Database(file, { readonly: true });
    // Bound by the same wall-clock budget the parent uses for its SIGKILL
    // timer, not a fixed value — a lock wait that would out-wait the overall
    // budget anyway should surface as SQLite's own busy error (or the
    // parent's timeout) rather than waiting longer than the query could ever
    // be allowed to run.
    db.exec("PRAGMA busy_timeout = " + Math.trunc(busyTimeoutMs) + ";");
    if (vecExtensionPath) {
      try {
        db.loadExtension(vecExtensionPath);
      } catch {
        // Non-fatal: only queries that reference vec0 tables/functions need it.
      }
    }

    const stmt = db.prepare(sql);
    if (stmt.columnNames.length === 0) {
      process.stderr.write("Only read-only queries are allowed");
      process.exit(${WRITE_REJECTED_EXIT_CODE});
    }

    const columns = stmt.columnNames;
    const start = performance.now();
    const rowArrays = [];
    let total = 0;
    for (const row of stmt.iterate(...(params || []))) {
      total++;
      if (!maxRows || rowArrays.length < maxRows) {
        rowArrays.push(
          columns.map((col) => {
            const value = row[col];
            return value instanceof Uint8Array ? Array.from(value) : value;
          }),
        );
      }
    }
    const elapsed = Math.round(performance.now() - start);

    process.stdout.write(JSON.stringify({ columns, rows: rowArrays, elapsed, total }));
  } catch (err) {
    process.stderr.write(err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
`;

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

function acquireBoundedQuerySlot(): void {
  const cap = getDbQueryConcurrencyCap();
  if (activeBoundedQueryCount >= cap) {
    throw new DbQueryConcurrencyCapError(
      `Too many concurrent db-query executions in flight (cap ${cap}). Retry shortly.`,
    );
  }
  activeBoundedQueryCount++;
}

function releaseBoundedQuerySlot(): void {
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
  acquireBoundedQuerySlot();

  try {
    return await runBoundedQueryChild(sql, params, budgetMs, maxRows);
  } finally {
    releaseBoundedQuerySlot();
  }
}

/**
 * Whether a fired timer should be reported to the caller as a timeout.
 *
 * A complete, correct result can land in the same tick the budget timer
 * fires — the SIGKILL is a no-op on an already-exited child, and its stdout
 * is still the real answer. Only report a timeout when the kill genuinely
 * prevented a clean result (no successful, non-empty stdout); pulled out as
 * its own function so both halves of the condition can be pinned directly in
 * tests instead of only through process-timing races.
 */
export function isReportableTimeout(timedOut: boolean, exitCode: number, stdout: string): boolean {
  return timedOut && !(exitCode === 0 && stdout.length > 0);
}

async function runBoundedQueryChild(
  sql: string,
  params: unknown[],
  budgetMs: number,
  maxRows?: number,
): Promise<DbQueryResult> {
  const payload: ChildPayload = {
    file: getDb().filename,
    sql,
    params,
    vecExtensionPath: resolveSqliteVecExtensionPath(),
    maxRows,
    busyTimeoutMs: budgetMs,
  };

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bun", "-e", CHILD_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // No `bun` executable resolvable on $PATH to spawn as a child — e.g. the
    // standalone `dist/agent-swarm` binary, which embeds the Bun runtime for
    // its own execution but does not bundle a separate spawnable `bun`
    // binary. Every other documented deployment surface (Docker, npm/bunx,
    // the systemd installer) ships or requires `bun` on $PATH, so this is
    // expected to be rare; fall back to the in-process path rather than
    // failing every db-query outright.
    const message = err instanceof Error ? err.message : String(err);
    if (!/executable not found/i.test(message) && !/enoent/i.test(message)) {
      throw err;
    }
    warnDbQuerySpawnUnavailableOnce();
    return executeReadOnlyQuery(sql, params, maxRows);
  }

  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, budgetMs);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (isReportableTimeout(timedOut, exitCode, stdout)) {
    throw new DbQueryTimeoutError(
      `Query exceeded the ${budgetMs}ms budget and was terminated. Filter on an indexed column and add a LIMIT. Aggregates such as COUNT(*), SUM(...) or typeof() over session_logs, agent_log, events or task_context_snapshots read every row in range and cannot be made cheap by chunking on rowid.`,
    );
  }

  if (exitCode === WRITE_REJECTED_EXIT_CODE) {
    throw new Error(stderr.trim() || "Only read-only queries are allowed");
  }

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Query failed with exit code ${exitCode}`);
  }

  // The child already applies maxRows before serializing (see CHILD_SCRIPT) —
  // parsed.rows is already capped, so no second slice is needed here.
  const parsed = JSON.parse(stdout) as ChildSuccess;

  return {
    columns: parsed.columns,
    rows: parsed.rows,
    elapsed: parsed.elapsed,
    total: parsed.total,
  };
}

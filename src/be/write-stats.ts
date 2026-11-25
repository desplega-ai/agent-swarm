/**
 * Postgres write statistics for the e2e commit budget (`bun run e2e:bench --check`).
 * Test only: on when `STORAGE_WRITE_STATS_DIR` is set (`bun run e2e --write-stats`),
 * never in production. Like `STORAGE_TX_STATS_FILE`, a bench diagnostic.
 *
 * Each API process keeps one file, `<dir>/<pid>-<uuid>.json`, and rewrites it after each
 * transaction. It holds the totals of the process and, per e2e scenario, the most commits
 * and write statements that one HTTP request made. The e2e runner writes the name of the
 * running scenario to `<dir>/window`. A request belongs to the scenario that ran when the
 * request started. Totals depend on time (pollers, timers, background loops). The count of
 * one request does not, so the budget gates on it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type WindowStats = {
  /** HTTP requests that started while the scenario ran. */
  requests: number;
  maxRequestCommits: number;
  maxRequestCommitsPath: string;
  maxRequestWriteStatements: number;
  maxRequestWriteStatementsPath: string;
};

type FileStats = {
  /** Read-write transactions that committed. Each autocommit write is one (the write fence). */
  commits: number;
  /** Read-only transactions that committed: no WAL flush, for information. */
  readOnlyCommits: number;
  /** Transactions that ended without a commit (error or exhausted retries). */
  rollbacks: number;
  /** INSERT, UPDATE, DELETE and MERGE statements, also inside a WITH, also failed ones. */
  writeStatements: number;
  windows: Record<string, WindowStats>;
};

type RequestScope = {
  window: string;
  path: string;
  commits: number;
  writeStatements: number;
  /** Write statements since the last transaction of this request ended. */
  pendingWriteStatements: number;
  /** False once the handler returned: work it left running does not count. */
  open: boolean;
};

type Sink = { file: string; windowFile: string; stats: FileStats };

const scopes = new AsyncLocalStorage<RequestScope>();
let sink: Sink | undefined | null = null;

function currentSink(): Sink | undefined {
  if (sink !== null) return sink;
  const dir = process.env.STORAGE_WRITE_STATS_DIR;
  if (!dir) {
    sink = undefined;
    return sink;
  }
  mkdirSync(dir, { recursive: true });
  sink = {
    file: join(dir, `${process.pid}-${randomUUID()}.json`),
    windowFile: join(dir, "window"),
    stats: { commits: 0, readOnlyCommits: 0, rollbacks: 0, writeStatements: 0, windows: {} },
  };
  flush(sink);
  const opened = sink;
  process.on("exit", () => flush(opened));
  console.log(`[db] write statistics go to ${sink.file} (bench)`);
  return sink;
}

/** Write a temporary file and rename it: a reader never sees a half-written file. */
function flush(target: Sink): void {
  writeFileSync(`${target.file}.tmp`, JSON.stringify(target.stats));
  renameSync(`${target.file}.tmp`, target.file);
}

function currentWindow(target: Sink): string {
  try {
    return readFileSync(target.windowFile, "utf8").trim();
  } catch {
    return "";
  }
}

function windowStats(target: Sink, window: string): WindowStats {
  target.stats.windows[window] ??= {
    requests: 0,
    maxRequestCommits: 0,
    maxRequestCommitsPath: "",
    maxRequestWriteStatements: 0,
    maxRequestWriteStatementsPath: "",
  };
  return target.stats.windows[window];
}

/** A statement that changes rows. Savepoints, locks and SELECTs do not count. */
export function isWriteStatement(sql: string): boolean {
  if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) return true;
  return /^\s*WITH\b/i.test(sql) && /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql);
}

/** Run one HTTP request handler. Without `STORAGE_WRITE_STATS_DIR` this only calls `fn`. */
export async function withRequestWriteScope<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const target = currentSink();
  if (!target) return fn();
  const scope: RequestScope = {
    window: currentWindow(target),
    path,
    commits: 0,
    writeStatements: 0,
    pendingWriteStatements: 0,
    open: true,
  };
  if (scope.window) windowStats(target, scope.window).requests += 1;
  try {
    return await scopes.run(scope, fn);
  } finally {
    scope.open = false;
  }
}

function openScope(): RequestScope | undefined {
  const scope = scopes.getStore();
  return scope?.open && scope.window ? scope : undefined;
}

/** Called by the Postgres statement observer with each statement. */
export function recordStatementForWriteStats(sql: string): void {
  const target = currentSink();
  if (!target || !isWriteStatement(sql)) return;
  target.stats.writeStatements += 1;
  // Every write runs in a transaction (the write fence wraps an autocommit write), so the
  // request counts it when that transaction ends.
  const scope = openScope();
  if (scope) scope.pendingWriteStatements += 1;
}

/**
 * Called once per outermost Postgres transaction when it ends. A retry (40001, 40P01) runs
 * the callback again, and how often depends on contention. So a request counts the write
 * statements of one attempt: the pending ones divided by the attempts, none on a rollback.
 */
export function recordTransactionForWriteStats(info: {
  outcome: "commit" | "error" | "exhausted";
  readOnly: boolean;
  attempts: number;
}): void {
  const target = currentSink();
  if (!target) return;
  const scope = openScope();
  const pending = scope?.pendingWriteStatements ?? 0;
  if (scope) scope.pendingWriteStatements = 0;
  if (info.outcome !== "commit") target.stats.rollbacks += 1;
  else if (info.readOnly) target.stats.readOnlyCommits += 1;
  else target.stats.commits += 1;
  if (scope && info.outcome === "commit") {
    const window = windowStats(target, scope.window);
    if (!info.readOnly) scope.commits += 1;
    scope.writeStatements += Math.round(pending / Math.max(info.attempts, 1));
    if (scope.commits > window.maxRequestCommits) {
      window.maxRequestCommits = scope.commits;
      window.maxRequestCommitsPath = scope.path;
    }
    if (scope.writeStatements > window.maxRequestWriteStatements) {
      window.maxRequestWriteStatements = scope.writeStatements;
      window.maxRequestWriteStatementsPath = scope.path;
    }
  }
  flush(target);
}

/** On when the process was started with `STORAGE_WRITE_STATS_DIR`. */
export function writeStatsEnabled(): boolean {
  return currentSink() !== undefined;
}

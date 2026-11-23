/**
 * The SQLite `db-query` reader (moved from src/http/db-query-shared.ts and
 * src/http/db-query-bounded.ts, Postgres brief M4 step 5). User SQL never runs
 * on the application connection: it runs on a read-only handle, in-process
 * or in a bounded `bun` child process the caller can SIGKILL on a budget.
 * The denied tables are refused from the compiled program (bytecode), not
 * from the SQL text. The HTTP/MCP surface, the `DB_QUERY_*` knobs, the
 * concurrency cap and the error classes stay in src/http.
 */

import { Database } from "bun:sqlite";
import {
  DB_QUERY_DENIED_TABLES,
  QueryReaderDeniedError,
  type QueryReaderResult,
  QueryReaderTimeoutError,
} from "@desplega/storage";

/**
 * No `bun` executable can be spawned for the bounded path (no Bun CLI on
 * $PATH). The caller decides what to do; src/http runs the query in-process
 * and logs it once.
 */
export class SqliteQuerySpawnUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SqliteQuerySpawnUnavailableError";
  }
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

/** Bytecode opcodes whose p2 is the root page of the b-tree they open. */
const CURSOR_OPEN_OPCODES = new Set(["OpenRead", "ReopenIdx", "OpenWrite"]);

/**
 * Open a read-only connection to the swarm database. User SQL is never
 * prepared on the writable application connection. In-memory databases have
 * no file to reopen, so they get a read-only snapshot instead.
 */
export function openSqliteQueryReader(
  database: Database,
  vecExtensionPath: string | undefined,
): Database {
  const reader =
    !database.filename || database.filename === ":memory:"
      ? Database.deserialize(database.serialize(), { readonly: true })
      : new Database(database.filename, { readonly: true });
  if (vecExtensionPath) {
    try {
      reader.loadExtension(vecExtensionPath);
    } catch {
      // Match the bounded path: only vec queries require the extension.
    }
  }
  return reader;
}

/**
 * Reject `sql` if it reads a denied table. Works on the compiled program, not
 * the SQL text: `EXPLAIN` lists every b-tree the statement opens by root page,
 * and `sqlite_master` maps root pages (tables and their indexes) back to a
 * table name. Views, CTEs and subqueries are already expanded in the program,
 * so no SQL parsing is needed. A user `EXPLAIN ...` returns bytecode, never
 * row data, so it is allowed as is.
 */
export function assertNoDeniedTablesSqlite(sql: string, db: Database): void {
  const statement = stripTrailingSemicolon(sql);
  if (/^explain\b/i.test(stripLeadingComments(statement))) return;

  const rootPages = new Map<number, string>();
  for (const row of db
    .query("SELECT rootpage, tbl_name FROM main.sqlite_master WHERE rootpage > 0")
    .all() as Array<{ rootpage: number; tbl_name: string }>) {
    rootPages.set(row.rootpage, row.tbl_name.toLowerCase());
  }

  using program = db.prepare(`EXPLAIN ${statement}`);
  const denied = new Set<string>();
  for (const op of program.all() as Array<{ opcode: string; p2: number; p3: number }>) {
    // p3 is the schema index: 0 = main. Credential tables only live there.
    if (!CURSOR_OPEN_OPCODES.has(op.opcode) || op.p3 !== 0) continue;
    const table = rootPages.get(op.p2);
    if (table && DB_QUERY_DENIED_TABLES.has(table)) denied.add(table);
  }
  if (denied.size > 0) throw new QueryReaderDeniedError([...denied].sort());
}

function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      rest = end === -1 ? "" : rest.slice(end + 1).trimStart();
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end === -1 ? "" : rest.slice(end + 2).trimStart();
    } else {
      return rest;
    }
  }
}

/**
 * Execute a read-only SQL query on `reader` (see openSqliteQueryReader),
 * synchronously, on the caller's own thread. Two callers in src/http rely on
 * this in-process path: the `DB_QUERY_BOUNDED_ENABLED=false` kill switch, and
 * the bounded path when no `bun` executable can be spawned.
 */
export function executeSqliteReadOnlyQuery(
  reader: Database,
  sql: string,
  params: unknown[] = [],
  maxRows?: number,
): QueryReaderResult {
  assertNoDeniedTablesSqlite(sql, reader);
  using stmt = reader.prepare(sql);

  // Require a result set; SQLite readonly mode is the write barrier.
  // RETURNING statements have columns too, so columnNames alone is not a guard.
  if (stmt.columnNames.length === 0) {
    throw new Error("Only read-only queries are allowed");
  }

  const columns = stmt.columnNames as string[];
  const start = performance.now();
  // Iterate rather than `stmt.all()` + slice: a query against a huge table
  // with a small maxRows would otherwise hold every matched row's object in
  // memory at once just to throw most of them away. Iterating still visits
  // every row (so `total` keeps meaning "rows SQLite matched"), but only the
  // first `maxRows` are converted and retained.
  const rowArrays: unknown[][] = [];
  let total = 0;
  for (const row of stmt.iterate(...(params as [string]))) {
    total++;
    if (maxRows === undefined || rowArrays.length < maxRows) {
      rowArrays.push(columns.map((col) => (row as Record<string, unknown>)[col]));
    }
  }
  const elapsed = Math.round(performance.now() - start);

  return { columns, rows: rowArrays, elapsed, total };
}

interface ChildPayload {
  file: string;
  sql: string;
  params: unknown[];
  vecExtensionPath?: string;
  maxRows?: number;
  busyTimeoutMs: number;
  /** Parent-side only: the SIGKILL budget (the child ignores it). */
  budgetMs: number;
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

/** One bounded query: the database file, the statement and its limits. */
export type SqliteBoundedQuery = {
  file: string;
  sql: string;
  params: unknown[];
  vecExtensionPath?: string;
  maxRows?: number;
  /** The wall-clock budget; the child's busy_timeout is bound to it too. */
  budgetMs: number;
};

/**
 * Run one read-only query in a `bun` child process, SIGKILLed past its budget
 * (throws QueryReaderTimeoutError). `pooled`: a long-lived worker child, else
 * one `bun -e` spawn per query. Throws SqliteQuerySpawnUnavailableError when
 * no `bun` executable can be spawned.
 */
export function runSqliteBoundedQuery(
  query: SqliteBoundedQuery,
  options: { pooled: boolean },
): Promise<QueryReaderResult> {
  const payload: ChildPayload = {
    file: query.file,
    sql: query.sql,
    params: query.params,
    vecExtensionPath: query.vecExtensionPath,
    maxRows: query.maxRows,
    busyTimeoutMs: query.budgetMs,
    budgetMs: query.budgetMs,
  };
  return options.pooled ? runPooledQuery(payload) : runBoundedQueryChild(payload);
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

/** No `bun` to spawn (see the catch in runBoundedQueryChild): run in-process, loudly, once. */
function isMissingExecutable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /executable not found/i.test(message) || /enoent/i.test(message);
}

async function runBoundedQueryChild(payload: ChildPayload): Promise<QueryReaderResult> {
  const { budgetMs } = payload;

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
    if (!isMissingExecutable(err)) throw err;
    throw new SqliteQuerySpawnUnavailableError(err);
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
    throw new QueryReaderTimeoutError(budgetMs);
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

// ---------------------------------------------------------------------------
// Worker pool. The per-request `bun -e` spawn costs ~65 ms of runtime start,
// module load and sqlite-vec load per call, which dominated POST /api/db-query
// latency (~70k calls/day). Long-lived children keep one read-only connection
// and take newline-delimited JSON requests on stdin. The kill-on-budget
// guarantee is unchanged: the parent SIGKILLs the worker, drops it from the
// pool, and the next request spawns a fresh one. `acquireBoundedQuerySlot`
// already caps in-flight queries, so live workers never exceed the cap.
// ---------------------------------------------------------------------------

/** Recycle a worker after this many queries to bound its RSS growth. */
const POOL_MAX_QUERIES_PER_WORKER = 500;
const POOL_IDLE_REAP_MS = 60_000;
/** A reply this large left the worker holding a big heap; recycle it instead of parking it. */
const POOL_MAX_PARKED_REPLY_CHARS = 8 * 1024 * 1024;

// Plain JS like CHILD_SCRIPT. Same read-only guard, iteration and BLOB handling;
// JSON.stringify output has no raw newline, so "\n" delimits messages.
const WORKER_SCRIPT = `
const { Database } = require("bun:sqlite");

let db = null;
let dbFile = null;

function run(req) {
  const { file, sql, params, vecExtensionPath, maxRows, busyTimeoutMs } = req;
  if (!db || dbFile !== file) {
    if (db) db.close();
    db = null;
    const opened = new Database(file, { readonly: true });
    if (vecExtensionPath) {
      try {
        opened.loadExtension(vecExtensionPath);
      } catch {
        // Non-fatal: only queries that reference vec0 tables/functions need it.
      }
    }
    db = opened;
    dbFile = file;
  }
  db.exec("PRAGMA busy_timeout = " + Math.trunc(busyTimeoutMs) + ";");
  const stmt = db.prepare(sql);
  try {
    if (stmt.columnNames.length === 0) throw new Error("Only read-only queries are allowed");
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
    return { columns, rows: rowArrays, elapsed: Math.round(performance.now() - start), total };
  } finally {
    // Finalize so no read transaction stays open and blocks WAL checkpoints.
    stmt.finalize();
  }
}

function handle(line) {
  let out;
  try {
    out = JSON.stringify(run(JSON.parse(line)));
  } catch (err) {
    out = JSON.stringify({ error: err && err.message ? err.message : String(err) });
  }
  process.stdout.write(out + "\\n");
}

(async () => {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  }
})();
`;

interface PoolWorker {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  queries: number;
  stderr: Promise<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Set only while a query is in flight on this worker. */
  onLine?: (line: string) => void;
  onExit?: (reason: string) => void;
}

const idleWorkers: PoolWorker[] = [];

/** Kill a worker and forget it. Idempotent. */
function retireWorker(w: PoolWorker): void {
  clearTimeout(w.idleTimer);
  const i = idleWorkers.indexOf(w);
  if (i >= 0) idleWorkers.splice(i, 1);
  w.proc.kill("SIGKILL");
}

async function pumpWorker(w: PoolWorker): Promise<void> {
  const decoder = new TextDecoder();
  let partial = "";
  try {
    for await (const chunk of w.proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      // Only scan the new chunk: a reply can be tens of MB and arrive in many chunks.
      let from = 0;
      let nl = text.indexOf("\n", from);
      while (nl >= 0) {
        const line = partial + text.slice(from, nl);
        partial = "";
        from = nl + 1;
        w.onLine?.(line);
        nl = text.indexOf("\n", from);
      }
      partial += text.slice(from);
    }
  } catch {
    // A broken stdout pipe means the worker is gone; handled below like a clean EOF.
  }
  const code = await w.proc.exited;
  const stderr = (await w.stderr).trim();
  retireWorker(w);
  w.onExit?.(stderr || `db-query worker exited with code ${code}`);
}

function spawnWorker(): PoolWorker {
  const proc = Bun.spawn(["bun", "-e", WORKER_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Idle workers must not keep the API (or a test run) alive; they exit on stdin EOF anyway.
  proc.unref();
  const w: PoolWorker = { proc, queries: 0, stderr: new Response(proc.stderr).text() };
  void pumpWorker(w);
  return w;
}

async function runPooledQuery(payload: ChildPayload): Promise<QueryReaderResult> {
  const { budgetMs } = payload;
  let worker = idleWorkers.pop();
  if (worker) {
    clearTimeout(worker.idleTimer);
  } else {
    try {
      worker = spawnWorker();
    } catch (err) {
      // Same fallback as runBoundedQueryChild: no spawnable `bun` means in-process.
      if (!isMissingExecutable(err)) throw err;
      throw new SqliteQuerySpawnUnavailableError(err);
    }
  }
  const w = worker;
  const request = `${JSON.stringify(payload)}\n`;

  let reply: string;
  try {
    reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        retireWorker(w);
        reject(new QueryReaderTimeoutError(budgetMs));
      }, budgetMs);
      w.onLine = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      w.onExit = (reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
      };
      w.proc.stdin.write(request);
      w.proc.stdin.flush();
    });
  } catch (err) {
    retireWorker(w);
    throw err;
  } finally {
    w.onLine = undefined;
    w.onExit = undefined;
  }

  w.queries++;
  if (w.queries >= POOL_MAX_QUERIES_PER_WORKER || reply.length > POOL_MAX_PARKED_REPLY_CHARS) {
    retireWorker(w);
  } else {
    w.idleTimer = setTimeout(() => retireWorker(w), POOL_IDLE_REAP_MS);
    idleWorkers.push(w);
  }

  const parsed = JSON.parse(reply) as ChildSuccess & { error?: string };
  if (parsed.error !== undefined) throw new Error(parsed.error);
  return {
    columns: parsed.columns,
    rows: parsed.rows,
    elapsed: parsed.elapsed,
    total: parsed.total,
  };
}

/** Exposed for tests only — pids of the parked workers. */
export function getDbQueryWorkerPidsForTests(): number[] {
  return idleWorkers.map((w) => w.proc.pid);
}

/** Exposed for tests only — kills every parked worker. */
export function resetDbQueryWorkerPoolForTests(): void {
  for (const w of [...idleWorkers]) retireWorker(w);
}

/**
 * The memory search read pool of the SQLite engine (moved from
 * src/be/memory/search-reader.ts and search-read-worker.ts, Postgres brief
 * M4 step 5). The server builds one through the composition root and hands
 * it to the storage as `memoryIndexes.searchReader`.
 */

import type { Database } from "bun:sqlite";
import type { DbClient, DbParam, MemoryReadExecutor } from "@desplega/storage";

type SearchReadInit = { type: "init"; file: string; vecExtensionPath?: string };
type SearchReadRequest = {
  type: "read";
  id: number;
  mode: "all" | "get";
  sql: string;
  params: DbParam[];
};
type SearchReadMessage =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "result"; id: number; rows: unknown }
  | { type: "error"; id: number; message: string };

/** Workers in the pool. Reads beyond this wait in a FIFO queue, so a burst never piles onto SQLite. */
export const SEARCH_READ_WORKERS = 2;
const START_TIMEOUT_MS = 10_000;

type Mode = SearchReadRequest["mode"];
type Job = {
  id: number;
  mode: Mode;
  sql: string;
  params: DbParam[];
  resolve: (rows: unknown) => void;
  reject: (err: Error) => void;
};
/** Bun's Worker has ref/unref; the DOM lib the extension type bundle compiles against does not. */
type RefWorker = Worker & { ref?: () => void; unref?: () => void };
type Slot = { worker: RefWorker; job: Job | null };

/** A worker died or was stopped with this read in flight; the read is safe to rerun in-process. */
class WorkerGoneError extends Error {}

/**
 * The worker's code, as a script: a Blob URL needs no separate entrypoint in
 * the compiled API binary (one `bun build --compile` root for every worker).
 * It holds its own read-only connection to the API's WAL database file (with
 * sqlite-vec when the host has it), so the vec KNN and bm25 statements block
 * this thread, not the API event loop. Plain JS: it runs as written.
 */
const WORKER_SCRIPT = `
const { Database } = require("bun:sqlite");

let db = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      db = new Database(message.file, { readonly: true });
      // Same lock wait as the main connection; WAL readers rarely wait at all.
      db.run("PRAGMA busy_timeout = 5000;");
      db.run("PRAGMA mmap_size = 268435456;");
      if (message.vecExtensionPath) db.loadExtension(message.vecExtensionPath);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "fatal", message: err.message });
    }
    return;
  }
  const { id, mode, sql, params } = message;
  try {
    // db.query caches the statement, as the main connection's client does.
    const statement = db.query(sql);
    const rows = mode === "all" ? statement.all(...params) : statement.get(...params);
    self.postMessage({ type: "result", id, rows });
  } catch (err) {
    self.postMessage({ type: "error", id, message: err.message });
  }
};
`;

let workerUrl: string | null = null;

function workerSpecifier(): string {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_SCRIPT], { type: "application/javascript" }));
  return workerUrl;
}

function spawnWorker(file: string, vecExtensionPath: string | undefined): Promise<Worker> {
  return new Promise<Worker>((resolve, reject) => {
    // Inside the executor, so a constructor that throws rejects like a failed boot.
    const worker: RefWorker = new Worker(workerSpecifier());
    // An idle pool must not keep the API process (or a test run) alive.
    worker.unref?.();
    const fail = (message: string) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("timed out starting"), START_TIMEOUT_MS);
    worker.addEventListener("message", function onReady(event: MessageEvent<SearchReadMessage>) {
      worker.removeEventListener("message", onReady);
      if (event.data.type === "ready") {
        clearTimeout(timer);
        resolve(worker);
      } else fail(event.data.type === "fatal" ? event.data.message : "unexpected first message");
    });
    worker.addEventListener("error", (event) => fail(event.message), { once: true });
    worker.postMessage({ type: "init", file, vecExtensionPath } satisfies SearchReadInit);
  });
}

class SearchReadPool {
  private readonly idle: Slot[];
  private readonly queue: Job[] = [];
  private readonly slots: Slot[];
  private nextId = 1;
  broken = false;

  constructor(workers: Worker[]) {
    this.slots = workers.map((worker) => ({ worker, job: null }));
    this.idle = [...this.slots];
    for (const slot of this.slots) {
      slot.worker.addEventListener("message", (event: MessageEvent<SearchReadMessage>) =>
        this.settle(slot, event.data),
      );
      slot.worker.addEventListener("error", (event) => this.stop(`worker error: ${event.message}`));
      slot.worker.addEventListener("close", () => this.stop("worker exited"));
    }
  }

  get stats() {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((slot) => slot.job).length,
      queued: this.queue.length,
    };
  }

  read(mode: Mode, sql: string, params: DbParam[]): Promise<unknown> {
    if (this.broken) return Promise.reject(new WorkerGoneError("pool stopped"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, mode, sql, params, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const slot = this.idle.pop()!;
      const job = this.queue.shift()!;
      slot.job = job;
      // Busy workers hold the process open, so an awaited read always settles.
      slot.worker.ref?.();
      const request: SearchReadRequest = {
        type: "read",
        id: job.id,
        mode: job.mode,
        sql: job.sql,
        params: job.params,
      };
      slot.worker.postMessage(request);
    }
  }

  private settle(slot: Slot, message: SearchReadMessage): void {
    const job = slot.job;
    if (!job || (message.type !== "result" && message.type !== "error") || message.id !== job.id) {
      return;
    }
    slot.job = null;
    slot.worker.unref?.();
    this.idle.push(slot);
    if (message.type === "result") job.resolve(message.rows);
    else job.reject(new Error(message.message));
    this.pump();
  }

  /** Fail every pending read over to the in-process path and stop the workers. */
  stop(reason: string, log = true): void {
    if (this.broken) return;
    this.broken = true;
    if (log) console.warn(`[memory-search] read workers stopped (${reason}); reads run in-process`);
    const pending = [...this.slots.flatMap((slot) => (slot.job ? [slot.job] : [])), ...this.queue];
    this.queue.length = 0;
    for (const slot of this.slots) {
      slot.job = null;
      slot.worker.terminate();
    }
    for (const job of pending) job.reject(new WorkerGoneError(reason));
  }
}

async function startPool(
  file: string,
  vecExtensionPath: string | undefined,
): Promise<SearchReadPool | null> {
  const started = await Promise.allSettled(
    Array.from({ length: SEARCH_READ_WORKERS }, () => spawnWorker(file, vecExtensionPath)),
  );
  const failed = started.find((result) => result.status === "rejected");
  if (failed) {
    for (const result of started) if (result.status === "fulfilled") result.value.terminate();
    console.warn(
      `[memory-search] read workers failed to start (${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}); reads run in-process`,
    );
    return null;
  }
  console.log(`[memory-search] read workers started workers=${SEARCH_READ_WORKERS}`);
  return new SearchReadPool(
    started.map((result) => (result as PromiseFulfilledResult<Worker>).value),
  );
}

/** What the reader needs from the server: the handle, the extension and the in-process path. */
export type SqliteMemorySearchReaderDeps = {
  /** The application's bun:sqlite handle (its file is what the workers open). */
  database: () => Database;
  /** sqlite-vec's loadable path when the main connection loaded it, else undefined. */
  vecExtensionPath: () => string | undefined;
  /** The main connection's async client: reads that must run in-process. */
  inProcess: () => Pick<DbClient, "query" | "get">;
  /** A transaction is open on the main connection (its reads must see its writes). */
  inTransaction: () => boolean;
};

export type SqliteMemorySearchReader = {
  /** Read-only executor for memory search statements; same contract as the client's query/get. */
  reader: MemoryReadExecutor;
  /** Pool state for tests and diagnostics; null while no pool is running. */
  stats(): Promise<SearchReadPool["stats"] | null>;
  /** Test-only: stop the pool; `inProcess` forces every read onto the main connection. */
  reset(options?: { inProcess?: boolean }): Promise<void>;
};

/**
 * Memory search reads off the API event loop.
 *
 * bun:sqlite is synchronous: at ~56k memories one search's vec KNN and bm25
 * statements held the loop ~1.3 s, and every other request waited. These
 * reads run in a small pool of Bun workers, each with its own read-only
 * connection to the same WAL file, so the loop only awaits a message. The
 * SQL and params are the ones the in-process path runs, so results match.
 *
 * The in-process path (the main client) still serves a read when:
 * - it runs inside a transaction (it must see that transaction's writes),
 * - the database is not a file (tests restore an in-memory template),
 * - the workers failed to start or one died (logged once).
 */
export function createSqliteMemorySearchReader(
  deps: SqliteMemorySearchReaderDeps,
): SqliteMemorySearchReader {
  // One pool per database handle: a closed and reopened DB (tests) gets fresh workers.
  let current: { db: unknown; pool: Promise<SearchReadPool | null> } | null = null;
  let inProcessOnly = false;

  function poolForCurrentDb(): Promise<SearchReadPool | null> {
    const db = deps.database();
    if (current?.db === db) return current.pool;
    void current?.pool.then((pool) => pool?.stop("database handle changed", false));
    const file = db.filename;
    const pool =
      !file || file === ":memory:"
        ? Promise.resolve(null)
        : startPool(file, deps.vecExtensionPath());
    current = { db, pool };
    return pool;
  }

  function readInProcess(mode: Mode, sql: string, params: DbParam[]): Promise<unknown> {
    return mode === "all" ? deps.inProcess().query(sql, params) : deps.inProcess().get(sql, params);
  }

  async function read(mode: Mode, sql: string, params: DbParam[]): Promise<unknown> {
    if (inProcessOnly || deps.inTransaction()) return readInProcess(mode, sql, params);
    const pool = await poolForCurrentDb();
    if (!pool || pool.broken) return readInProcess(mode, sql, params);
    try {
      return await pool.read(mode, sql, params);
    } catch (err) {
      // shortcut: a dead worker stops the pool for this DB handle, no respawn; add one if crashes show up.
      if (err instanceof WorkerGoneError) return readInProcess(mode, sql, params);
      throw err;
    }
  }

  return {
    reader: {
      query: <T>(sql: string, params: DbParam[] = []) => read("all", sql, params) as Promise<T[]>,
      get: <T>(sql: string, params: DbParam[] = []) =>
        read("get", sql, params) as Promise<T | null>,
    },
    async stats() {
      const pool = await current?.pool;
      return pool && !pool.broken ? pool.stats : null;
    },
    async reset(options: { inProcess?: boolean } = {}) {
      (await current?.pool)?.stop("reset", false);
      current = null;
      inProcessOnly = options.inProcess ?? false;
    },
  };
}

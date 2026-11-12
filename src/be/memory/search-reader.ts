/**
 * Memory search reads off the API event loop.
 *
 * bun:sqlite is synchronous: at ~56k memories one search's vec KNN and bm25
 * statements held the loop ~1.3 s, and every other request waited. These
 * reads run in a small pool of Bun workers, each with its own read-only
 * connection to the same WAL file, so the loop only awaits a message. The
 * SQL and params are the ones the in-process path runs, so results match.
 *
 * The in-process path (getDbClient()) still serves a read when:
 * - it runs inside a transaction (it must see that transaction's writes),
 * - the database is not a file (tests restore an in-memory template),
 * - the workers failed to start or one died (logged once).
 */

import { getDb, getDbClient, isSqliteVecAvailable, resolveSqliteVecExtensionPath } from "@/be/db";
import { type DbParam, isInTransaction } from "../db-client";
import type { SearchReadMessage, SearchReadRequest } from "./search-read-worker";

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
type Slot = { worker: Worker; job: Job | null };

/** A worker died or was stopped with this read in flight; the read is safe to rerun in-process. */
class WorkerGoneError extends Error {}

/** In the compiled API binary every `import.meta.url` is the binary; see the Dockerfile compile step. */
function workerSpecifier(): string {
  if (import.meta.url.includes("/$bunfs/")) return "./be/memory/search-read-worker.ts";
  return new URL("./search-read-worker.ts", import.meta.url).href;
}

function spawnWorker(file: string, vecExtensionPath: string | undefined): Promise<Worker> {
  return new Promise<Worker>((resolve, reject) => {
    // Inside the executor, so a constructor that throws rejects like a failed boot.
    const worker = new Worker(workerSpecifier());
    // An idle pool must not keep the API process (or a test run) alive.
    worker.unref();
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
    worker.postMessage({ type: "init", file, vecExtensionPath });
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
      slot.worker.ref();
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
    slot.worker.unref();
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

// One pool per database handle: a closed and reopened DB (tests) gets fresh workers.
let current: { db: unknown; pool: Promise<SearchReadPool | null> } | null = null;
let inProcessOnly = false;

function poolForCurrentDb(): Promise<SearchReadPool | null> {
  const db = getDb();
  if (current?.db === db) return current.pool;
  void current?.pool.then((pool) => pool?.stop("database handle changed", false));
  const file = db.filename;
  const pool =
    !file || file === ":memory:"
      ? Promise.resolve(null)
      : startPool(file, isSqliteVecAvailable() ? resolveSqliteVecExtensionPath() : undefined);
  current = { db, pool };
  return pool;
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
      `[memory-search] read workers failed to start (${(failed.reason as Error).message}); reads run in-process`,
    );
    return null;
  }
  console.log(`[memory-search] read workers started workers=${SEARCH_READ_WORKERS}`);
  return new SearchReadPool(
    started.map((result) => (result as PromiseFulfilledResult<Worker>).value),
  );
}

function readInProcess(mode: Mode, sql: string, params: DbParam[]): Promise<unknown> {
  return mode === "all" ? getDbClient().query(sql, params) : getDbClient().get(sql, params);
}

async function read(mode: Mode, sql: string, params: DbParam[]): Promise<unknown> {
  if (inProcessOnly || isInTransaction()) return readInProcess(mode, sql, params);
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

/** Read-only executor for memory search statements; same contract as getDbClient().query/get. */
export const memorySearchReader = {
  query: <T>(sql: string, params: DbParam[] = []) => read("all", sql, params) as Promise<T[]>,
  get: <T>(sql: string, params: DbParam[] = []) => read("get", sql, params) as Promise<T | null>,
};

/** Pool state for tests and diagnostics; null while no pool is running. */
export async function memorySearchReaderStats(): Promise<SearchReadPool["stats"] | null> {
  const pool = await current?.pool;
  return pool && !pool.broken ? pool.stats : null;
}

/** Test-only: stop the pool; `inProcess` forces every read onto the main connection. */
export async function __resetMemorySearchReaderForTests(options: { inProcess?: boolean } = {}) {
  (await current?.pool)?.stop("reset", false);
  current = null;
  inProcessOnly = options.inProcess ?? false;
}

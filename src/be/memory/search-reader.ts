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

import { getDbClient } from "@/be/db";
import { getDbConnectionIdentity, getMemoryReadConnection, isCurrentDbClient } from "../db/runtime";
import { type DbClient, type DbParam, isInTransaction } from "../db-client";
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
/** Bun's Worker has ref/unref; the DOM lib the extension type bundle compiles against does not. */
type RefWorker = Worker & { ref?: () => void; unref?: () => void };
type Slot = { worker: RefWorker; job: Job | null };

/** A worker died or was stopped with this read in flight; the read is safe to rerun in-process. */
class WorkerGoneError extends Error {}

/** In the compiled API binary every `import.meta.url` is the binary; see the Dockerfile compile step. */
function workerSpecifier(): string {
  if (import.meta.url.includes("/$bunfs/")) return "./be/memory/search-read-worker.ts";
  return new URL("./search-read-worker.ts", import.meta.url).href;
}

type PoolEntry = {
  client: DbClient;
  identity: object;
  controller: AbortController;
  pool: Promise<SearchReadPool | null>;
  exits: Promise<void>[];
  workers: RefWorker[];
  closedWorkers: Set<RefWorker>;
};

function closeWorker(worker: RefWorker): void {
  try {
    worker.ref?.();
    worker.postMessage({ type: "close" });
  } catch {
    worker.terminate();
  }
}

function spawnWorker(
  connection: Awaited<ReturnType<typeof getMemoryReadConnection>>,
  entry: PoolEntry,
): Promise<Worker> {
  const signal = entry.controller.signal;
  return new Promise<Worker>((resolve, reject) => {
    // Inside the executor, so a constructor that throws rejects like a failed boot.
    const worker: RefWorker = new Worker(workerSpecifier());
    let ready = false;
    entry.workers.push(worker);
    entry.exits.push(
      new Promise<void>((exited) =>
        worker.addEventListener(
          "close",
          () => {
            entry.closedWorkers.add(worker);
            exited();
            if (!ready) fail("worker exited during startup");
          },
          { once: true },
        ),
      ),
    );
    // An idle pool must not keep the API process (or a test run) alive.
    worker.unref?.();
    const fail = (message: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      closeWorker(worker);
      reject(new Error(message));
    };
    const abort = () => fail("database connection closed");
    const timer = setTimeout(() => fail("timed out starting"), START_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    worker.addEventListener("message", function onReady(event: MessageEvent<SearchReadMessage>) {
      worker.removeEventListener("message", onReady);
      if (event.data.type === "ready") {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (event.data.sqliteVec !== connection.sqliteVec) {
          fail("vector capability differs from the database client");
          return;
        }
        if (signal.aborted) return abort();
        ready = true;
        resolve(worker);
      } else fail(event.data.type === "fatal" ? event.data.message : "unexpected first message");
    });
    worker.addEventListener("error", (event) => fail(event.message), { once: true });
    worker.postMessage({
      type: "init",
      file: connection.file,
      customSQLite: connection.customSQLite,
      vecExtensionPath: connection.vecExtensionPath,
    });
    if (signal.aborted) abort();
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
      try {
        slot.worker.postMessage(request);
      } catch {
        this.stop("request submission failed");
      }
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
    else
      job.reject(
        Object.assign(new Error(message.message), { name: message.name, code: message.code }),
      );
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
      closeWorker(slot.worker);
    }
    for (const job of pending) job.reject(new WorkerGoneError(reason));
  }
}

// One pool per database handle: a closed and reopened DB (tests) gets fresh workers.
let current: PoolEntry | null = null;
let inProcessOnly = false;

function poolForCurrentDb(client: DbClient): Promise<SearchReadPool | null> {
  const identity = getDbConnectionIdentity();
  if (!identity || !isCurrentDbClient(client))
    return Promise.reject(new Error("Memory store connection closed."));
  if (current?.client === client && current.identity === identity) return current.pool;
  if (current) stopEntry(current);
  const entry: PoolEntry = {
    client,
    identity,
    controller: new AbortController(),
    pool: Promise.resolve(null),
    exits: [],
    workers: [],
    closedWorkers: new Set(),
  };
  // Await the effective driver's capability before opening additional connections.
  entry.pool = (async () => {
    const config = await getMemoryReadConnection(client);
    if (entry.controller.signal.aborted) return null;
    return !config.file || config.file === ":memory:" ? null : startPool(config, entry);
  })();
  current = entry;
  return entry.pool;
}

async function startPool(
  connection: Awaited<ReturnType<typeof getMemoryReadConnection>>,
  entry: PoolEntry,
): Promise<SearchReadPool | null> {
  const signal = entry.controller.signal;
  const started = await Promise.allSettled(
    Array.from({ length: SEARCH_READ_WORKERS }, () => spawnWorker(connection, entry)),
  );
  const failed = started.find((result) => result.status === "rejected");
  if (
    failed ||
    started.some((result) => result.status === "fulfilled" && entry.closedWorkers.has(result.value))
  ) {
    for (const result of started) if (result.status === "fulfilled") closeWorker(result.value);
    if (!signal.aborted)
      console.warn(
        `[memory-search] read workers failed to start (${failed ? (failed.reason as Error).message : "worker exited during startup"}); reads run in-process`,
      );
    return null;
  }
  if (signal.aborted) {
    for (const result of started) if (result.status === "fulfilled") closeWorker(result.value);
    return null;
  }
  console.log(`[memory-search] read workers started workers=${SEARCH_READ_WORKERS}`);
  return new SearchReadPool(
    started.map((result) => (result as PromiseFulfilledResult<Worker>).value),
  );
}

function readInProcess(
  client: DbClient,
  mode: Mode,
  sql: string,
  params: DbParam[],
): Promise<unknown> {
  if (!isCurrentDbClient(client))
    return Promise.reject(new Error("Memory store connection closed."));
  return mode === "all" ? client.query(sql, params) : client.get(sql, params);
}

async function read(
  client: DbClient,
  mode: Mode,
  sql: string,
  params: DbParam[],
): Promise<unknown> {
  if (inProcessOnly || isInTransaction()) return readInProcess(client, mode, sql, params);
  const pool = await poolForCurrentDb(client);
  if (!isCurrentDbClient(client)) throw new Error("Memory store connection closed.");
  if (!pool || pool.broken) return readInProcess(client, mode, sql, params);
  try {
    const result = await pool.read(mode, sql, params);
    if (!isCurrentDbClient(client)) throw new Error("Memory store connection closed.");
    return result;
  } catch (err) {
    // shortcut: a dead worker stops the pool for this DB handle, no respawn; add one if crashes show up.
    if (err instanceof WorkerGoneError) return readInProcess(client, mode, sql, params);
    throw err;
  }
}

/** Read-only executor for memory search statements; same contract as getDbClient().query/get. */
export const memorySearchReader = {
  query: <T>(sql: string, params: DbParam[] = [], client = getDbClient()) =>
    read(client, "all", sql, params) as Promise<T[]>,
  get: <T>(sql: string, params: DbParam[] = [], client = getDbClient()) =>
    read(client, "get", sql, params) as Promise<T | null>,
};

function stopEntry(entry: PoolEntry): void {
  entry.controller.abort();
  void entry.pool.then(
    (pool) => pool?.stop("database connection closed", false),
    () => {},
  );
}

/** Cancel startup and active reads before the database lifecycle closes admission. */
export async function stopMemorySearchReader(client: DbClient): Promise<void> {
  const entry = current;
  if (!entry || entry.client !== client) return;
  current = null;
  stopEntry(entry);
  await entry.pool.then(
    (pool) => pool?.stop("database connection closed", false),
    () => {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(entry.exits),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          for (const worker of entry.workers) worker.terminate();
          reject(new Error("Memory read worker shutdown timed out."));
        }, START_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Pool state for tests and diagnostics; null while no pool is running. */
export async function memorySearchReaderStats(): Promise<SearchReadPool["stats"] | null> {
  const pool = await current?.pool;
  return pool && !pool.broken ? pool.stats : null;
}

/** Test-only: stop the pool; `inProcess` forces every read onto the main connection. */
export async function __resetMemorySearchReaderForTests(options: { inProcess?: boolean } = {}) {
  if (current) await stopMemorySearchReader(current.client);
  inProcessOnly = options.inProcess ?? false;
}

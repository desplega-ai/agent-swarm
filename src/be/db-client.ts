import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Async database seam.
 *
 * This interface is the ONLY contract a future non-SQLite backend has to
 * reimplement. It is deliberately minimal and portable:
 * - no prepared-statement objects cross the boundary (SQL text + positional
 *   params only),
 * - no `lastInsertRowid` (use `RETURNING` and read the row back),
 * - every method is async even though the bun:sqlite implementation resolves
 *   synchronously under the hood.
 */
export type DbParam = string | number | bigint | boolean | null | Uint8Array;

export interface DbExecutor {
  /** SELECT returning all rows. */
  query<T>(sql: string, params?: DbParam[]): Promise<T[]>;
  /** SELECT (or DML with RETURNING) returning the first row or null. */
  get<T>(sql: string, params?: DbParam[]): Promise<T | null>;
  /** DML/DDL without a result set. */
  run(sql: string, params?: DbParam[]): Promise<{ changes: number }>;
}

export type TransactionOptions = {
  /**
   * Declare the callback SELECT-only. The transaction then opens with a
   * deferred BEGIN and never contends for the cross-process write lock, so
   * it reads the WAL snapshot at full speed even while an external process
   * (litestream checkpoint, CLI) holds the file's write lock. Measured cost
   * of NOT setting this on a read-only transaction under an external locker:
   * 2x read throughput at a mild 250ms hold, 14x at a 6s hold.
   *
   * A callback that writes despite `readOnly: true` still works (SQLite
   * upgrades the deferred transaction), but it loses BUSY retry and can fail
   * mid-callback under cross-process contention. Only set it on genuinely
   * SELECT-only callbacks.
   */
  readOnly?: boolean;
};

export interface DbClient extends DbExecutor {
  /**
   * Run `fn` atomically. The callback receives an executor bound to the
   * transaction; awaiting it is safe. Client-level calls made (directly or
   * through helpers) while the callback runs are routed into the same
   * transaction via AsyncLocalStorage, mirroring how synchronous helpers
   * sharing one connection behaved before this seam existed. Nested
   * `transaction` calls become SAVEPOINTs (opts are ignored for them).
   */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /**
   * `run`, plus the wall time the driver actually spent executing the
   * statement.
   *
   * Timing a `run` from the caller measures something else: the returned
   * promise also covers waiting for the FIFO lock behind unrelated operations
   * and the async SQLITE_BUSY backoff sleeps, which happen with the lock
   * released and nothing executing. A caller that reads that wall time as
   * statement cost — a stall monitor, an adaptive batch sizer — reports a
   * responsive process as stalled and reacts to queueing instead of to work.
   *
   * `executionMs` sums only the driver attempts, measured with
   * `performance.now()` (so it is fractional, and sub-millisecond statements
   * do not floor to 0). A retried statement counts every attempt: each one
   * really did occupy the driver and block the event loop, up to
   * `attemptSpinMs` per BUSY attempt. It excludes all lock waiting and all
   * backoff sleeping.
   */
  runTimed(sql: string, params?: DbParam[]): Promise<{ changes: number; executionMs: number }>;
  /**
   * Schedule `fn` to run strictly after the currently-open transaction
   * COMMITs; if that transaction rolls back the hook is DROPPED (the write it
   * reacts to never happened). With no transaction open it runs on the next
   * microtask-ish turn. This is the post-commit hook point: under synchronous
   * bun:sqlite transactions a queueMicrotask always observed settled state,
   * but an async transaction callback drains microtasks before COMMIT —
   * hooks that must see committed state go through here.
   *
   * Nested-savepoint caveat: hooks queue on the outermost transaction, so a
   * hook registered inside a savepoint that rolls back still fires when the
   * outer transaction commits (matches the pre-seam microtask behaviour).
   *
   * An async hook is fire-and-forget: its completion is not awaited, but a
   * rejection is contained and logged, never an unhandled rejection.
   */
  afterCommit(fn: () => void | Promise<void>): void;
}

const LOCK_WATCHDOG_MS = 30_000;

/**
 * FIFO promise-chain lock. All top-level operations are serialized through it
 * so a transaction's BEGIN..COMMIT window can never be interleaved by an
 * unrelated write on the shared connection. Acquisition is effectively free
 * when uncontended because the underlying driver calls are synchronous.
 */
class FifoLock {
  private tail: Promise<void> = Promise.resolve();
  /** Callers holding or queued on the lock. Watchdog diagnostics only. */
  private depth = 0;

  acquire(): Promise<() => void> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.depth += 1;
    // Structured stack is captured here cheaply; the string only materializes
    // if the watchdog fires.
    const holder = new Error("db-client: FIFO lock acquired here");
    return prev.then(() => {
      // Watchdog: a holder that never releases wedges every DB operation in
      // the process with no error and no log. One line beats a silent hang.
      const watchdog = setTimeout(() => {
        console.error(
          `[db-client] FIFO lock held for ${LOCK_WATCHDOG_MS}ms (queue depth ${this.depth}). Holder:\n${holder.stack}`,
        );
      }, LOCK_WATCHDOG_MS);
      if (typeof watchdog.unref === "function") watchdog.unref();
      return () => {
        clearTimeout(watchdog);
        this.depth -= 1;
        release();
      };
    });
  }
}

type TxContext = {
  /** Set once the outermost transaction commits or rolls back. */
  closed: boolean;
  /** Hooks to run after COMMIT; dropped on ROLLBACK. */
  afterCommit: (() => void | Promise<void>)[];
};

const txContext = new AsyncLocalStorage<TxContext>();

/**
 * Cross-process SQLITE_BUSY retry posture (litestream checkpoints, CLI access
 * on the same file). Retries happen only where a repeat is exact: top-level
 * single statements, BEGIN IMMEDIATE (nothing ran yet), and COMMIT (the
 * transaction stays intact on a BUSY commit). Statements inside an open
 * transaction are never retried, and `readOnly` transactions opt out
 * entirely (deferred BEGIN never contends for the write lock).
 *
 * Two properties keep a retrying operation from starving the rest of the
 * process, both measured (see PR #1229's read-heavy probe):
 * - each retryable driver attempt runs under a SHORT `busy_timeout`
 *   (`attemptSpinMs`), so the driver's synchronous busy wait blocks the
 *   event loop for at most that long per attempt; the real waiting happens
 *   in the async backoff sleeps,
 * - the FIFO lock is RELEASED during those sleeps (except after COMMIT
 *   failures, where the open transaction pins the connection), so queued
 *   reads flow while a writer waits out an external lock holder.
 */
export type BusyRetryOptions = {
  /** Ceiling on the summed async backoff across attempts. */
  maxWaitMs: number;
  /** Per-retry sleep; the attempt count is bounded by this array's length + 1. */
  backoffMs: number[];
  /** `busy_timeout` applied for the duration of each retryable driver attempt. */
  attemptSpinMs: number;
};

// The backoff sum (~6.9s) plus per-attempt spins must outlast a realistic
// external hold (litestream checkpoint stalls measured in seconds) so writes
// land in the holder's release gaps instead of failing at the driver cliff.
const DEFAULT_BUSY_RETRY: BusyRetryOptions = {
  maxWaitMs: 10_000,
  backoffMs: [25, 50, 100, 250, 500, 1000, 1000, 1000, 1000, 1000, 1000],
  attemptSpinMs: 100,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 0.5x-1.5x jitter so concurrent retriers cannot phase-lock with a periodic holder. */
function jittered(ms: number): number {
  return Math.max(1, Math.round(ms * (0.5 + Math.random())));
}

function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

class BunSqliteClient implements DbClient {
  private readonly lock = new FifoLock();
  private savepointSeq = 0;
  /** Lazily captured ambient busy_timeout, restored after each short-spin attempt. */
  private restoreBusyTimeoutMs: number | null = null;

  constructor(
    private readonly getDatabase: () => Database,
    private readonly busyRetry: BusyRetryOptions = DEFAULT_BUSY_RETRY,
  ) {}

  query<T>(sql: string, params: DbParam[] = []): Promise<T[]> {
    return this.execute((db) => db.query<T, DbParam[]>(sql).all(...params));
  }

  get<T>(sql: string, params: DbParam[] = []): Promise<T | null> {
    return this.execute((db) => db.query<T, DbParam[]>(sql).get(...params));
  }

  run(sql: string, params: DbParam[] = []): Promise<{ changes: number }> {
    return this.execute((db) => {
      const result = db.query(sql).run(...params);
      return { changes: result.changes };
    });
  }

  async runTimed(
    sql: string,
    params: DbParam[] = [],
  ): Promise<{ changes: number; executionMs: number }> {
    let executionMs = 0;
    const result = await this.execute(
      (db) => {
        const run = db.query(sql).run(...params);
        return { changes: run.changes };
      },
      (ms) => {
        executionMs += ms;
      },
    );
    return { ...result, executionMs };
  }

  async transaction<T>(fn: (tx: DbExecutor) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    const existing = txContext.getStore();
    if (existing && !existing.closed) {
      return this.savepoint(existing, fn);
    }

    const readOnly = opts?.readOnly === true;
    let sleptMs = 0;
    for (let attemptIndex = 0; ; attemptIndex++) {
      const backoff = this.busyRetry.backoffMs[attemptIndex];
      const canRetryAfter = backoff !== undefined && sleptMs + backoff <= this.busyRetry.maxWaitMs;
      // The FINAL attempt camps on the ambient busy_timeout instead of the
      // short spin: a lone writer sampling 100ms windows can stay phase-locked
      // with a periodic external holder and miss every release gap (measured:
      // 3 of 6 writes lost at 1 writer under a 6s/500ms locker). One long
      // synchronous spin per request, only after every polite attempt failed,
      // acquires the lock the instant the holder releases.
      const attempt = await this.runTransactionAttempt(fn, readOnly, !canRetryAfter);
      if (attempt.ok) return attempt.value;
      if (!canRetryAfter || backoff === undefined) throw attempt.busyBegin;
      sleptMs += backoff;
      // The FIFO lock is NOT held here: nothing began, so other DB work
      // (reads especially) proceeds while this writer waits out the external
      // lock holder. Jitter desynchronizes concurrent retriers from each
      // other and from periodic holders.
      await sleep(jittered(backoff));
    }
  }

  /**
   * One BEGIN..COMMIT attempt under the FIFO lock. Returns `busyBegin`
   * instead of throwing when BEGIN IMMEDIATE hits a cross-process BUSY, so
   * the caller can back off with the lock released.
   */
  private async runTransactionAttempt<T>(
    fn: (tx: DbExecutor) => Promise<T>,
    readOnly: boolean,
    campOnAmbientTimeout = false,
  ): Promise<{ ok: true; value: T } | { ok: false; busyBegin: unknown }> {
    const release = await this.lock.acquire();
    const ctx: TxContext = { closed: false, afterCommit: [] };
    let began = false;
    try {
      const db = this.getDatabase();
      const tx = this.boundExecutor(ctx);
      if (readOnly) {
        // Deferred BEGIN executes no locking work, cannot BUSY, and keeps the
        // whole transaction off the cross-process write lock.
        db.run("BEGIN");
      } else {
        try {
          // IMMEDIATE takes the write lock at BEGIN: a cross-process BUSY
          // then surfaces here, where a retry is exact (nothing ran yet),
          // instead of on an arbitrary statement mid-callback where it is
          // not. The short spin keeps the driver's synchronous busy wait off
          // the event loop; the real waiting is the caller's async backoff.
          // The final attempt camps on the ambient busy_timeout instead (see
          // transaction()).
          if (campOnAmbientTimeout) {
            db.run("BEGIN IMMEDIATE");
          } else {
            this.shortSpin(db, () => db.run("BEGIN IMMEDIATE"));
          }
        } catch (err) {
          if (isSqliteBusy(err)) return { ok: false, busyBegin: err };
          throw err;
        }
      }
      began = true;
      const result = await txContext.run(ctx, () => fn(tx));
      if (readOnly) {
        db.run("COMMIT");
      } else {
        // A BUSY COMMIT leaves the transaction open and intact, so a repeat
        // is exact. The open transaction pins the connection, so these
        // retries hold the FIFO lock and their sleeps block queued work;
        // WAL-mode COMMIT BUSY is rare enough for that to be acceptable.
        await this.retryHoldingLock(() => this.shortSpin(db, () => db.run("COMMIT")));
      }
      for (const hook of ctx.afterCommit) this.scheduleHook(hook);
      return { ok: true, value: result };
    } catch (err) {
      if (began) {
        try {
          this.getDatabase().run("ROLLBACK");
        } catch {
          // Connection-level failure while rolling back; surface the original error.
        }
      }
      throw err;
    } finally {
      ctx.closed = true;
      release();
    }
  }

  afterCommit(fn: () => void | Promise<void>): void {
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) {
      // Inside a transaction: run only if it commits; dropped on rollback.
      ctx.afterCommit.push(fn);
      return;
    }
    this.scheduleHook(fn);
  }

  private scheduleHook(fn: () => void | Promise<void>): void {
    // Queueing behind the FIFO lock keeps hooks ordered after already-queued
    // operations. The hook runs outside the lock so its own client calls
    // re-acquire normally. A hook that throws synchronously or rejects
    // asynchronously must not become an unhandled rejection (which would
    // crash the process) and must not look like a lock failure.
    void this.lock.acquire().then((release) => {
      release();
      try {
        const result = fn();
        if (result && typeof result.then === "function") {
          result.then(undefined, (err) => {
            console.error("[db-client] afterCommit hook rejected:", err);
          });
        }
      } catch (err) {
        console.error("[db-client] afterCommit hook threw:", err);
      }
    });
  }

  private async savepoint<T>(ctx: TxContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const db = this.getDatabase();
    // Monotonic per-client counter, NOT nesting depth: two nested transactions
    // running concurrently under one outer transaction would otherwise reuse a
    // name, and the first RELEASE would silently swallow the sibling's writes.
    // SQLite savepoints are still a stack, so out-of-LIFO release remains
    // wrong — unique names turn that into a loud "no such savepoint" error
    // instead of silent data loss.
    this.savepointSeq += 1;
    const name = `db_client_sp_${this.savepointSeq}`;
    const tx = this.boundExecutor(ctx);
    db.run(`SAVEPOINT ${name}`);
    try {
      const result = await fn(tx);
      db.run(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      db.run(`ROLLBACK TO SAVEPOINT ${name}`);
      db.run(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  }

  /**
   * Runs `op` inside the ambient transaction when one is open on this async
   * context, otherwise serialized through the lock. A context that leaked into
   * a post-commit continuation (e.g. queueMicrotask) is treated as absent.
   */
  private async execute<T>(
    op: (db: Database) => T,
    recordExecutionMs?: (ms: number) => void,
  ): Promise<T> {
    // Wraps ONLY the synchronous driver call, so lock acquisition above and
    // backoff sleeps below are never charged to the statement. Called once per
    // attempt; a retrying statement reports the sum. See DbClient.runTimed.
    const timed = (attempt: () => T): T => {
      if (!recordExecutionMs) return attempt();
      const startedAt = performance.now();
      try {
        return attempt();
      } finally {
        recordExecutionMs(performance.now() - startedAt);
      }
    };
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) {
      return timed(() => op(this.getDatabase()));
    }
    let sleptMs = 0;
    for (let attemptIndex = 0; ; attemptIndex++) {
      const next = this.busyRetry.backoffMs[attemptIndex];
      const canRetryAfter = next !== undefined && sleptMs + next <= this.busyRetry.maxWaitMs;
      const release = await this.lock.acquire();
      let backoff = 0;
      try {
        // A top-level single statement is atomic, so a repeat on BUSY is
        // exact. The final attempt camps on the ambient busy_timeout so a
        // lone writer cannot stay phase-locked with a periodic holder (see
        // transaction()).
        return timed(() =>
          canRetryAfter
            ? this.shortSpin(this.getDatabase(), () => op(this.getDatabase()))
            : op(this.getDatabase()),
        );
      } catch (err) {
        if (!isSqliteBusy(err) || !canRetryAfter || next === undefined) throw err;
        backoff = next;
        sleptMs += next;
      } finally {
        release();
      }
      // Lock released: queued reads flow while this statement waits out the
      // external lock holder. Jitter desynchronizes concurrent retriers.
      await sleep(jittered(backoff));
    }
  }

  /**
   * Run a retryable driver attempt under a short `busy_timeout` so the
   * synchronous in-driver busy wait blocks the event loop for at most
   * `attemptSpinMs`. Only called while the FIFO lock is held, so the
   * set/attempt/restore sequence cannot interleave with other client work.
   */
  private shortSpin<T>(db: Database, attempt: () => T): T {
    if (this.restoreBusyTimeoutMs === null) {
      const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
      this.restoreBusyTimeoutMs = row?.timeout ?? 5000;
    }
    db.exec(`PRAGMA busy_timeout = ${this.busyRetry.attemptSpinMs}`);
    try {
      return attempt();
    } finally {
      db.exec(`PRAGMA busy_timeout = ${this.restoreBusyTimeoutMs}`);
    }
  }

  /**
   * COMMIT-only retry: the open transaction pins the shared connection, so
   * the FIFO lock stays held and these sleeps block queued in-process work.
   */
  private async retryHoldingLock<T>(attempt: () => T): Promise<T> {
    let sleptMs = 0;
    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return attempt();
      } catch (err) {
        if (!isSqliteBusy(err)) throw err;
        const backoff = this.busyRetry.backoffMs[attemptIndex];
        if (backoff === undefined || sleptMs + backoff > this.busyRetry.maxWaitMs) throw err;
        sleptMs += backoff;
        await sleep(backoff);
      }
    }
  }

  private boundExecutor(ctx: TxContext): DbExecutor {
    const guard = (): Database => {
      if (ctx.closed) {
        throw new Error("db-client: transaction executor used after the transaction closed");
      }
      return this.getDatabase();
    };
    return {
      query: async <T>(sql: string, params: DbParam[] = []): Promise<T[]> =>
        guard()
          .query<T, DbParam[]>(sql)
          .all(...params),
      get: async <T>(sql: string, params: DbParam[] = []): Promise<T | null> =>
        guard()
          .query<T, DbParam[]>(sql)
          .get(...params),
      run: async (sql: string, params: DbParam[] = []): Promise<{ changes: number }> => {
        const result = guard()
          .query(sql)
          .run(...params);
        return { changes: result.changes };
      },
    };
  }
}

/**
 * Wrap a lazily-resolved bun:sqlite handle in the async DbClient seam.
 * `getDatabase` is invoked per operation so close/reopen cycles (tests) are
 * transparent to holders of the client. `busyRetry` overrides the
 * cross-process SQLITE_BUSY retry posture (tests use tiny values).
 */
export function createBunSqliteClient(
  getDatabase: () => Database,
  busyRetry?: BusyRetryOptions,
): DbClient {
  return new BunSqliteClient(getDatabase, busyRetry);
}

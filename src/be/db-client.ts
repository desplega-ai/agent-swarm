import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { scrubSecrets } from "../utils/secret-scrubber";
import { currentLoopPath, recordStatement } from "./event-loop-lag";

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
  /**
   * Wall-clock deadline (epoch ms) for the whole transaction, BEGIN retries and
   * COMMIT retries included. Past it the transaction is rolled back and the call
   * throws `DbTransactionDeadlineError`: BEGIN stops retrying, and COMMIT is never
   * issued (or retried) once the deadline has passed, so a caller that already
   * answered 504 cannot be followed by a late write. A COMMIT that starts before
   * the deadline can still finish up to one `attemptSpinMs` after it. Ignored for
   * a nested call (a SAVEPOINT): the outermost transaction owns the deadline.
   */
  deadlineAt?: number;
};

/** The transaction's `deadlineAt` passed before it could commit; nothing was written. */
export class DbTransactionDeadlineError extends Error {
  constructor() {
    super("db-client: transaction passed its deadline and was rolled back");
    this.name = "DbTransactionDeadlineError";
  }
}

function assertBeforeDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new DbTransactionDeadlineError();
}

/** A backoff sleep never runs past the deadline: the next loop turn then fails on time. */
function sleepMs(ms: number, deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? ms : Math.max(0, Math.min(ms, deadlineAt - Date.now()));
}

export interface DbClient extends DbExecutor {
  /**
   * Run `fn` atomically. The callback receives an executor bound to the
   * transaction; awaiting it is safe. Client-level calls made (directly or
   * through helpers) while the callback runs are routed into the same
   * transaction via AsyncLocalStorage, mirroring how synchronous helpers
   * sharing one connection behaved before this seam existed. Nested
   * `transaction` calls become SAVEPOINTs (opts are ignored for them).
   * Callback rejection rolls back. Caught statement errors retain native Promise semantics.
   * Await, return, or join all DB work. See runbooks/async-db-promises.md.
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
   * occupies the driver, up to `attemptSpinMs` per BUSY attempt. Only the
   * synchronous driver blocks the main event loop during execution.
   * The timer excludes FIFO lock waits, retry backoff, and Worker message transfer.
   *
   * `changes` counts only the rows the statement itself changed. Unlike
   * `run`, it excludes rows touched by foreign-key actions.
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
  /**
   * Run `fn` synchronously if the currently-open outermost transaction rolls
   * back, including a COMMIT that fails; dropped on commit. With no
   * transaction open it does nothing. For undoing process-local state taken
   * inside the transaction. A hook registered inside a savepoint that rolls
   * back runs only if the outer transaction rolls back too.
   */
  afterRollback(fn: () => void): void;
  close(): Promise<void>;
}

export type DriverResult<T> = { value: T; executionMs: number };
export type DriverOptions = { spinMs?: number; deadlineAt?: number };
export interface SqliteDriver {
  readonly blocksEventLoop: boolean;
  all<T>(
    sql: string,
    params: DbParam[],
    options?: DriverOptions,
  ): DriverResult<T[]> | Promise<DriverResult<T[]>>;
  get<T>(
    sql: string,
    params: DbParam[],
    options?: DriverOptions,
  ): DriverResult<T | null> | Promise<DriverResult<T | null>>;
  run(
    sql: string,
    params: DbParam[],
    options?: DriverOptions,
  ): DriverResult<{ changes: number }> | Promise<DriverResult<{ changes: number }>>;
  runTimed(
    sql: string,
    params: DbParam[],
    options?: DriverOptions,
  ): DriverResult<{ changes: number }> | Promise<DriverResult<{ changes: number }>>;
  exec(sql: string, options?: DriverOptions): DriverResult<void> | Promise<DriverResult<void>>;
  close(): Promise<void>;
}

/** Execute on the current handle. The caller owns this handle's lifecycle. */
export function createSyncSqliteDriver(getDatabase: () => Database): SqliteDriver {
  let closed = false;
  const execute = <T>(run: (db: Database) => T, options?: DriverOptions): DriverResult<T> => {
    if (closed) throw new Error("db-client: driver is closed");
    const db = getDatabase();
    const restore =
      options?.spinMs === undefined
        ? undefined
        : (db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? 5000);
    if (options?.spinMs !== undefined) db.exec(`PRAGMA busy_timeout = ${options.spinMs}`);
    const start = performance.now();
    try {
      assertBeforeDeadline(options?.deadlineAt);
      return { value: run(db), executionMs: performance.now() - start };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { executionMs: performance.now() - start });
      throw error;
    } finally {
      if (restore !== undefined) db.exec(`PRAGMA busy_timeout = ${restore}`);
    }
  };
  return {
    blocksEventLoop: true,
    all: <T>(sql: string, params: DbParam[], options?: DriverOptions) =>
      execute((db) => db.query<T, DbParam[]>(sql).all(...params), options),
    get: <T>(sql: string, params: DbParam[], options?: DriverOptions) =>
      execute((db) => db.query<T, DbParam[]>(sql).get(...params), options),
    run: (sql, params, options) =>
      execute((db) => ({ changes: db.query(sql).run(...params).changes }), options),
    runTimed: (sql, params, options) =>
      execute((db) => {
        db.query(sql).run(...params);
        return { changes: (db.query("SELECT changes() AS n").get() as { n: number }).n };
      }, options),
    exec: (sql, options) =>
      execute((db) => {
        db.run(sql);
      }, options),
    close: async () => {
      closed = true;
    },
  };
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

type TransactionScope = { closed: boolean };
type TxContext = {
  /** Set once the outermost transaction commits or rolls back. */
  closed: boolean;
  client: BunSqliteClient;
  tail: Promise<void>;
  fatal?: { error: unknown };
  /** Hooks to run after COMMIT; dropped on ROLLBACK. */
  afterCommit: (() => void | Promise<void>)[];
  /** Hooks to run after ROLLBACK; dropped on COMMIT. */
  afterRollback: (() => void)[];
};

const txContext = new AsyncLocalStorage<TxContext>();
const transactionScope = new AsyncLocalStorage<TransactionScope>();
const hookContext = new AsyncLocalStorage<{ client: BunSqliteClient; active: boolean }>();

export function isInTransaction(): boolean {
  const store = txContext.getStore();
  return store !== undefined && !store.closed;
}

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
 * - every driver attempt runs under a SHORT `busy_timeout`
 *   (`attemptSpinMs`, or `finalAttemptSpinMs` for the last one), so the
 *   driver's synchronous busy wait blocks the event loop for at most that
 *   long per attempt; the real waiting happens in the async backoff sleeps,
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
  /**
   * `busy_timeout` for the final attempt, after the backoff budget is spent.
   * Defaults to `DEFAULT_FINAL_ATTEMPT_SPIN_MS`.
   */
  finalAttemptSpinMs?: number;
  /**
   * Longest gap between spinning probes while an external holder is
   * detected (see `BusyGate`). Defaults to `DEFAULT_MAX_GATE_MS`.
   */
  maxGateMs?: number;
};

/**
 * The final attempt used to camp on the connection's ambient busy_timeout
 * (5000ms), which froze every in-flight request for up to 5s whenever an
 * external holder outlived the backoff budget. A slightly longer spin than
 * `attemptSpinMs` still widens the last window without that freeze.
 */
const DEFAULT_FINAL_ATTEMPT_SPIN_MS = 250;

// The backoff sum (~10.9s) plus per-attempt spins must outlast a realistic
// external hold (litestream checkpoint stalls measured in seconds) so writes
// land in the holder's release gaps instead of failing at the driver cliff.
// It covers the patience the old 5s synchronous final camp provided, spent
// in async sleeps instead. The 500ms tail keeps attempts at most one spin
// apart from any 500ms release gap, so a lone writer cannot phase-lock with a
// periodic holder (measured: 6 of 6 writes under a 6s-hold/500ms-gap locker;
// 1s spacing lost 3 of 6).
const DEFAULT_BUSY_RETRY: BusyRetryOptions = {
  maxWaitMs: 11_000,
  backoffMs: [25, 50, 100, 250, ...Array<number>(21).fill(500)],
  attemptSpinMs: 100,
  finalAttemptSpinMs: DEFAULT_FINAL_ATTEMPT_SPIN_MS,
};

/**
 * A single synchronous driver call longer than this froze the whole event
 * loop (every route, not only its own request) and is logged.
 */
const SLOW_STATEMENT_WARN_MS = 100;
const SLOW_STATEMENT_SQL_MAX_CHARS = 200;

/** Params are never logged: they can carry secrets and user content. */
function warnIfSlowStatement(
  sql: string,
  durationMs: number,
  driver: "sqlite" | "worker" = "sqlite",
): void {
  recordStatement(sql, durationMs, driver);
  if (durationMs < SLOW_STATEMENT_WARN_MS) return;
  // Scrub the complete SQL before truncation, so a secret that straddles the
  // cut cannot leave a partial token, then scrub the complete line at egress.
  const flat = scrubSecrets(sql.replace(/\s+/g, " ").trim());
  const shown =
    flat.length > SLOW_STATEMENT_SQL_MAX_CHARS
      ? `${flat.slice(0, SLOW_STATEMENT_SQL_MAX_CHARS)}…`
      : flat;
  console.warn(
    scrubSecrets(
      `[db-client] ${driver === "sqlite" ? "slow sync statement blocked the event loop for" : "slow worker statement executed for"} ${Math.round(durationMs)}ms path=${currentLoopPath()}: ${shown}`,
    ),
  );
}

/**
 * Longest stretch of DB work (driver calls plus the JS between them) that may
 * run without handing the event loop back. The FIFO lock hands over through
 * microtasks, so a burst of queued statements (a dozen memory searches, one
 * store-progress with 20 deletes) otherwise runs as ONE macrotask: measured
 * 4-30 s in which /health, scripts and MCP calls get no turn.
 */
const SLICE_MS = 25;
let sliceStartedAt = 0;

function markSlice(): void {
  if (sliceStartedAt !== 0) return;
  sliceStartedAt = performance.now();
  // Fires at the next macrotask boundary, whoever caused it: the slice is over.
  // A timer, not setImmediate: the yield below owns setImmediate.
  setTimeout(() => {
    sliceStartedAt = 0;
  }, 0);
}

/** Starts the slice if none is open; yields to timers and sockets once it is spent. */
async function yieldIfSliceSpent(): Promise<void> {
  markSlice();
  if (performance.now() - sliceStartedAt < SLICE_MS) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  sliceStartedAt = 0;
}

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

/** Ceiling on the gap between spinning probes while a holder is detected. */
const DEFAULT_MAX_GATE_MS = 1_000;
/** A quiet stretch this long ends a BUSY episode even without a proven write. */
const GATE_DECAY_MS = 5_000;

/**
 * Process-wide memory of a cross-process write-lock holder.
 *
 * Every retrying writer used to spin `attemptSpinMs` (100ms, or 250ms for the
 * last attempt) SYNCHRONOUSLY inside the FIFO lock on every attempt. With N
 * writers queued behind a holder that lasts minutes, one round of attempts
 * costs N x 100ms of blocked event loop, and each attempt waits for that
 * whole round before its own turn. A 5-minute Litestream snapshot turned
 * the nominal 11s retry budget into 90-105s request hangs, 3s /health and
 * 3s page loads, although only writes were contending.
 *
 * The gate records a BUSY seen by a spinning probe. For the next interval
 * (doubling from `attemptSpinMs` up to `maxGateMs`) every attempt runs with
 * a ZERO busy_timeout: it still tries, so recovery is immediate, but it
 * fails in microseconds instead of blocking the loop, and the async backoff
 * sleeps do the waiting. Once the interval lapses, the next attempt is the
 * lone spinning probe again.
 */
class BusyGate {
  private openUntil = 0;
  private streak = 0;
  private lastBusyAt = 0;
  private episodeStartedAt = 0;
  private episodeProbes = 0;

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
  ) {}

  /** True while attempts must not spin. */
  isOpen(now = performance.now()): boolean {
    return now < this.openUntil;
  }

  /** A spinning probe hit BUSY: a holder exists. Open the gate and widen it. */
  recordBusy(now = performance.now()): void {
    if (this.streak > 0 && now - this.lastBusyAt > GATE_DECAY_MS) this.endEpisode(now, "decayed");
    if (this.streak === 0) {
      this.episodeStartedAt = now;
      this.episodeProbes = 0;
      console.warn(
        "[db-client] SQLITE_BUSY: another process holds the write lock; spinning at most one probe per gate interval until it releases",
      );
    }
    this.streak += 1;
    this.episodeProbes += 1;
    this.lastBusyAt = now;
    const interval = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.streak - 1, 20));
    this.openUntil = now + interval;
  }

  /** A write got through after BUSY: the holder is gone. */
  recordRecovered(now = performance.now()): void {
    if (this.streak === 0) return;
    this.endEpisode(now, "released");
  }

  private endEpisode(now: number, how: "released" | "decayed"): void {
    console.warn(
      `[db-client] write lock ${how} after ${Math.round(now - this.episodeStartedAt)}ms (${this.episodeProbes} spinning probes)`,
    );
    this.streak = 0;
    this.openUntil = 0;
  }
}

class BunSqliteClient implements DbClient {
  private readonly lock = new FifoLock();
  private readonly gate: BusyGate;
  private savepointSeq = 0;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly admitted = new Set<Promise<unknown>>();
  private readonly hooks = new Set<Promise<void>>();

  constructor(
    private readonly driver: SqliteDriver,
    private readonly busyRetry: BusyRetryOptions = DEFAULT_BUSY_RETRY,
  ) {
    this.gate = new BusyGate(
      busyRetry.attemptSpinMs,
      Math.max(busyRetry.attemptSpinMs, busyRetry.maxGateMs ?? DEFAULT_MAX_GATE_MS),
    );
  }

  query<T>(sql: string, params: DbParam[] = []): Promise<T[]> {
    return this.admit(() =>
      this.execute(sql, (options) => this.driver.all<T>(sql, params, options)),
    );
  }

  get<T>(sql: string, params: DbParam[] = []): Promise<T | null> {
    return this.admit(() =>
      this.execute(sql, (options) => this.driver.get<T>(sql, params, options)),
    );
  }

  run(sql: string, params: DbParam[] = []): Promise<{ changes: number }> {
    return this.admit(() => this.execute(sql, (options) => this.driver.run(sql, params, options)));
  }

  runTimed(sql: string, params: DbParam[] = []): Promise<{ changes: number; executionMs: number }> {
    return this.admit(async () => {
      let executionMs = 0;
      const result = await this.execute(
        sql,
        (options) => this.driver.runTimed(sql, params, options),
        (ms) => {
          executionMs += ms;
        },
      );
      return { ...result, executionMs };
    });
  }

  private admit<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = txContext.getStore();
    if (this.closing && !(ctx?.client === this && !ctx.closed) && !this.inActiveHook())
      return Promise.reject(new Error("db-client: client is closed"));
    const promise = fn();
    this.admitted.add(promise);
    void promise.then(
      () => this.admitted.delete(promise),
      () => this.admitted.delete(promise),
    );
    return promise;
  }

  close(): Promise<void> {
    if (txContext.getStore()?.client === this && !txContext.getStore()?.closed) {
      return Promise.reject(new Error("db-client: cannot close inside a transaction"));
    }
    this.closing = true;
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      const drain = async () => {
        while (this.admitted.size || this.hooks.size) {
          await Promise.allSettled([...this.admitted, ...this.hooks]);
        }
      };
      const timeout = new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          // The driver bounds its own close wait and terminates a stuck Worker.
          void this.driver
            .close()
            .then(() => reject(new Error("db-client: shutdown drain timed out")), reject);
        }, 10_000);
      });
      try {
        await Promise.race([drain(), timeout]);
        await this.driver.close();
        if (timedOut) throw new Error("db-client: shutdown drain timed out");
      } finally {
        clearTimeout(timer!);
      }
    })();
    return this.closePromise;
  }

  transaction<T>(fn: (tx: DbExecutor) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.admit(() => this.transact(fn, opts));
  }

  private async transact<T>(
    fn: (tx: DbExecutor) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    const existing = txContext.getStore();
    if (existing?.client === this && !existing.closed) {
      return this.savepoint(existing, fn);
    }

    const readOnly = opts?.readOnly === true;
    const deadlineAt = opts?.deadlineAt;
    let sleptMs = 0;
    for (let attemptIndex = 0; ; attemptIndex++) {
      assertBeforeDeadline(deadlineAt);
      const backoff = this.busyRetry.backoffMs[attemptIndex];
      const canRetryAfter = backoff !== undefined && sleptMs + backoff <= this.busyRetry.maxWaitMs;
      // The FINAL attempt spins `finalAttemptSpinMs`, never the ambient
      // busy_timeout: a 5s synchronous camp froze every in-flight request.
      // The dense 500ms backoff tail catches a periodic holder's release gap
      // instead (see DEFAULT_BUSY_RETRY).
      const attempt = await this.runTransactionAttempt(fn, readOnly, !canRetryAfter, deadlineAt);
      if (attempt.ok) return attempt.value;
      if (!canRetryAfter || backoff === undefined) throw attempt.busyBegin;
      sleptMs += backoff;
      // The FIFO lock is NOT held here: nothing began, so other DB work
      // (reads especially) proceeds while this writer waits out the external
      // lock holder. Jitter desynchronizes concurrent retriers from each
      // other and from periodic holders.
      await sleep(sleepMs(jittered(backoff), deadlineAt));
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
    finalAttempt = false,
    deadlineAt?: number,
  ): Promise<{ ok: true; value: T } | { ok: false; busyBegin: unknown }> {
    const release = await this.lock.acquire();
    const ctx: TxContext = {
      closed: false,
      client: this,
      tail: Promise.resolve(),
      afterCommit: [],
      afterRollback: [],
    };
    let began = false;
    let committing = false;
    try {
      const tx = this.boundExecutor(ctx);
      if (readOnly) {
        // Deferred BEGIN executes no locking work, cannot BUSY, and keeps the
        // whole transaction off the cross-process write lock.
        await this.driver.exec("BEGIN");
      } else {
        try {
          // IMMEDIATE takes the write lock at BEGIN: a cross-process BUSY
          // then surfaces here, where a retry is exact (nothing ran yet),
          // instead of on an arbitrary statement mid-callback where it is
          // not. The short spin keeps the driver's synchronous busy wait off
          // the event loop; the real waiting is the caller's async backoff.
          await this.shortSpin(
            (options) => this.driver.exec("BEGIN IMMEDIATE", options),
            finalAttempt,
          );
          this.gate.recordRecovered();
        } catch (err) {
          if (isSqliteBusy(err)) return { ok: false, busyBegin: err };
          throw err;
        }
      }
      began = true;
      const result = await txContext.run(ctx, () => fn(tx));
      await this.drain(ctx);
      if (ctx.fatal) throw ctx.fatal.error;
      ctx.closed = true;
      // Last point a deadline can stop the write: the throw rolls back in the catch below.
      assertBeforeDeadline(deadlineAt);
      committing = true;
      if (readOnly) {
        await this.driver.exec("COMMIT", { deadlineAt });
      } else {
        // A BUSY COMMIT leaves the transaction open and intact, so a repeat
        // is exact. The open transaction pins the connection, so these
        // retries hold the FIFO lock and their sleeps block queued work;
        // WAL-mode COMMIT BUSY is rare enough for that to be acceptable.
        await this.retryHoldingLock(
          () =>
            this.shortSpin(
              (options) => this.driver.exec("COMMIT", { ...options, deadlineAt }),
              false,
              false,
            ),
          deadlineAt,
        );
      }
      for (const hook of ctx.afterCommit) this.scheduleHook(hook);
      return { ok: true, value: result };
    } catch (err) {
      if (
        began &&
        !(committing && (err as Error | null | undefined)?.name === "DbWorkerTransportError")
      ) {
        try {
          ctx.closed = true;
          await this.drain(ctx);
          await this.driver.exec("ROLLBACK");
        } catch {
          // Connection-level failure while rolling back; surface the original error.
        }
        for (const hook of ctx.afterRollback) {
          try {
            hook();
          } catch (hookErr) {
            console.error("[db-client] afterRollback hook threw:", scrubSecrets(String(hookErr)));
          }
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
    if (this.closing && !(ctx?.client === this && !ctx.closed) && !this.inActiveHook())
      throw new Error("db-client: client is closed");
    if (ctx?.client === this && !ctx.closed) {
      // Inside a transaction: run only if it commits; dropped on rollback.
      ctx.afterCommit.push(fn);
      return;
    }
    this.scheduleHook(fn);
  }

  afterRollback(fn: () => void): void {
    const ctx = txContext.getStore();
    if (ctx?.client === this && !ctx.closed) ctx.afterRollback.push(fn);
  }

  private scheduleHook(fn: () => void | Promise<void>): void {
    // Queueing behind the FIFO lock keeps hooks ordered after already-queued
    // operations. The hook runs outside the lock so its own client calls
    // re-acquire normally. A hook that throws synchronously or rejects
    // asynchronously must not become an unhandled rejection (which would
    // crash the process) and must not look like a lock failure.
    const hook = this.lock.acquire().then(async (release) => {
      release();
      const context = { client: this, active: true };
      try {
        await txContext.exit(() => transactionScope.exit(() => hookContext.run(context, fn)));
      } catch (err) {
        console.error("[db-client] afterCommit hook failed:", scrubSecrets(String(err)));
      } finally {
        context.active = false;
      }
    });
    this.hooks.add(hook);
    void hook.then(() => this.hooks.delete(hook));
  }

  private inActiveHook(): boolean {
    const context = hookContext.getStore();
    return context?.client === this && context.active;
  }

  private async savepoint<T>(ctx: TxContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const scope: TransactionScope = { closed: false };
    return transactionScope.run(scope, () => this.runSavepoint(ctx, scope, fn));
  }

  private async runSavepoint<T>(
    ctx: TxContext,
    scope: TransactionScope,
    fn: (tx: DbExecutor) => Promise<T>,
  ): Promise<T> {
    this.savepointSeq += 1;
    const name = `db_client_sp_${this.savepointSeq}`;
    const tx = this.boundExecutor(ctx, scope);
    await this.enqueue(ctx, () => this.driver.exec(`SAVEPOINT ${name}`));
    try {
      const result = await fn(tx);
      await this.drain(ctx);
      if (ctx.fatal) throw ctx.fatal.error;
      await this.enqueue(ctx, () => this.driver.exec(`RELEASE SAVEPOINT ${name}`));
      return result;
    } catch (err) {
      await this.drain(ctx);
      try {
        await this.enqueue(ctx, () => this.driver.exec(`ROLLBACK TO SAVEPOINT ${name}`));
        await this.enqueue(ctx, () => this.driver.exec(`RELEASE SAVEPOINT ${name}`));
      } catch (rollbackError) {
        // A caught savepoint error cannot authorize commit after failed recovery.
        ctx.fatal ??= { error: rollbackError };
        throw rollbackError;
      }
      throw err;
    } finally {
      scope.closed = true;
    }
  }

  private async drain(ctx: TxContext): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = ctx.tail;
      await tail;
      // Statement continuations can admit more work while the captured tail drains.
    } while (tail !== ctx.tail);
  }

  /** Reserve order before readiness or transport can yield. Drain every admitted operation. */
  private enqueue<T>(
    ctx: TxContext,
    op: () => T | Promise<T>,
    scope = transactionScope.getStore(),
  ): Promise<T> {
    if (ctx.closed || scope?.closed)
      return Promise.reject(
        new Error("db-client: transaction executor used after the transaction closed"),
      );
    const result = ctx.tail.then(op);
    ctx.tail = result.then(
      () => {},
      (error) => {
        // Ordinary statement errors retain native catch semantics. Transport loss is fatal.
        if ((error as Error | null | undefined)?.name === "DbWorkerTransportError")
          ctx.fatal ??= { error };
      },
    );
    return result;
  }

  /**
   * Runs `op` inside the ambient transaction when one is open on this async
   * context, otherwise serialized through the lock. A context that leaked into
   * a post-commit continuation (e.g. queueMicrotask) is treated as absent.
   */
  private async execute<T>(
    sql: string,
    op: (options?: DriverOptions) => DriverResult<T> | Promise<DriverResult<T>>,
    recordExecutionMs?: (ms: number) => void,
  ): Promise<T> {
    const timed = (attempt: () => DriverResult<T> | Promise<DriverResult<T>>, retryable = false) =>
      this.timed(sql, attempt, recordExecutionMs, retryable);
    const ctx = txContext.getStore();
    if (ctx?.client === this && !ctx.closed) {
      return this.enqueue(ctx, async () => {
        const value = await timed(() => op());
        if (this.driver.blocksEventLoop) await yieldIfSliceSpent();
        return value;
      });
    }
    let sleptMs = 0;
    let sawBusy = false;
    for (let attemptIndex = 0; ; attemptIndex++) {
      const next = this.busyRetry.backoffMs[attemptIndex];
      const canRetryAfter = next !== undefined && sleptMs + next <= this.busyRetry.maxWaitMs;
      const release = await this.lock.acquire();
      let backoff = 0;
      try {
        // Checked while holding the lock: waiters queued behind it passed any
        // earlier check long ago. Other callers just wait, as behind a slow statement.
        if (this.driver.blocksEventLoop) await yieldIfSliceSpent();
        // A top-level single statement is atomic, so a repeat on BUSY is
        // exact. The final attempt spins `finalAttemptSpinMs` (see
        // transaction()).
        const result = await timed(() => this.shortSpin(op, !canRetryAfter), canRetryAfter);
        // A statement that was BUSY earlier in this call and now landed is a
        // write that got through: the external holder is gone.
        if (sawBusy) this.gate.recordRecovered();
        return result;
      } catch (err) {
        if (!isSqliteBusy(err) || !canRetryAfter || next === undefined) throw err;
        sawBusy = true;
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

  private async timed<T>(
    sql: string,
    attempt: () => DriverResult<T> | Promise<DriverResult<T>>,
    recordExecutionMs?: (ms: number) => void,
    retryable = false,
  ): Promise<T> {
    try {
      const result = await attempt();
      recordExecutionMs?.(result.executionMs);
      this.observe(sql, result.executionMs);
      return result.value;
    } catch (err) {
      const ms = (err as { executionMs?: number } | null | undefined)?.executionMs ?? 0;
      recordExecutionMs?.(ms);
      if (!(retryable && isSqliteBusy(err))) this.observe(sql, ms);
      throw err;
    }
  }

  private observe(sql: string, ms: number): void {
    warnIfSlowStatement(sql, ms, this.driver.blocksEventLoop ? "sqlite" : "worker");
  }

  /**
   * Run a driver attempt under a short `busy_timeout` so the synchronous
   * in-driver busy wait blocks the event loop for at most `attemptSpinMs`
   * (`finalAttemptSpinMs` for the final attempt). Only called while the FIFO
   * lock is held, so the set/attempt/restore sequence cannot interleave with
   * other client work.
   */
  private async shortSpin<T>(
    attempt: (options: DriverOptions) => T | Promise<T>,
    finalAttempt = false,
    gateable = true,
  ): Promise<T> {
    const gated = gateable && this.gate.isOpen();
    const spinMs = gated
      ? 0
      : finalAttempt
        ? (this.busyRetry.finalAttemptSpinMs ?? DEFAULT_FINAL_ATTEMPT_SPIN_MS)
        : this.busyRetry.attemptSpinMs;
    try {
      return await attempt({ spinMs });
    } catch (err) {
      if (gateable && !gated && isSqliteBusy(err)) this.gate.recordBusy();
      throw err;
    }
  }

  /**
   * COMMIT-only retry: the open transaction pins the shared connection, so
   * the FIFO lock stays held and these sleeps block queued in-process work.
   */
  private async retryHoldingLock<T>(attempt: () => Promise<T>, deadlineAt?: number): Promise<T> {
    let sleptMs = 0;
    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return await attempt();
      } catch (err) {
        if (!isSqliteBusy(err)) throw err;
        // The transaction is still open and intact after a BUSY COMMIT: the caller rolls it back.
        assertBeforeDeadline(deadlineAt);
        const backoff = this.busyRetry.backoffMs[attemptIndex];
        if (backoff === undefined || sleptMs + backoff > this.busyRetry.maxWaitMs) throw err;
        sleptMs += backoff;
        await sleep(sleepMs(backoff, deadlineAt));
        assertBeforeDeadline(deadlineAt);
      }
    }
  }

  private boundExecutor(
    ctx: TxContext,
    scope = transactionScope.getStore() ?? { closed: false },
  ): DbExecutor {
    const execute = <T>(sql: string, op: () => DriverResult<T> | Promise<DriverResult<T>>) =>
      this.enqueue(
        ctx,
        async () => {
          const value = await this.timed(sql, op);
          if (this.driver.blocksEventLoop) await yieldIfSliceSpent();
          return value;
        },
        scope,
      );
    return {
      query: <T>(sql: string, params: DbParam[] = []) =>
        execute(sql, () => this.driver.all<T>(sql, params)),
      get: <T>(sql: string, params: DbParam[] = []) =>
        execute(sql, () => this.driver.get<T>(sql, params)),
      run: (sql: string, params: DbParam[] = []) =>
        execute(sql, () => this.driver.run(sql, params)),
    };
  }
}

/**
 * Wrap a lazily-resolved bun:sqlite handle in the async DbClient seam.
 * `getDatabase` is invoked per operation. Closed clients reject stale calls. `busyRetry` overrides the
 * cross-process SQLITE_BUSY retry posture (tests use tiny values).
 */
export function createBunSqliteClient(
  getDatabase: () => Database,
  busyRetry?: BusyRetryOptions,
): DbClient {
  return createDbClient(createSyncSqliteDriver(getDatabase), busyRetry);
}

export function createDbClient(driver: SqliteDriver, busyRetry?: BusyRetryOptions): DbClient {
  return new BunSqliteClient(driver, busyRetry);
}

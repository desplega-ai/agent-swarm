import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { scrubSecrets } from "../utils/secret-scrubber";

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
function warnIfSlowStatement(sql: string, durationMs: number): void {
  if (durationMs < SLOW_STATEMENT_WARN_MS) return;
  const flat = sql.replace(/\s+/g, " ").trim();
  const shown =
    flat.length > SLOW_STATEMENT_SQL_MAX_CHARS
      ? `${flat.slice(0, SLOW_STATEMENT_SQL_MAX_CHARS)}…`
      : flat;
  console.warn(
    `[db-client] slow sync statement blocked the event loop for ${Math.round(durationMs)}ms: ${scrubSecrets(shown)}`,
  );
}

/** Run one synchronous driver call and log it when it blocked the loop too long. */
function timedStatement<T>(sql: string, run: () => T): T {
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    warnIfSlowStatement(sql, performance.now() - startedAt);
  }
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
  /** Lazily captured ambient busy_timeout, restored after each short-spin attempt. */
  private restoreBusyTimeoutMs: number | null = null;

  constructor(
    private readonly getDatabase: () => Database,
    private readonly busyRetry: BusyRetryOptions = DEFAULT_BUSY_RETRY,
  ) {
    this.gate = new BusyGate(
      busyRetry.attemptSpinMs,
      Math.max(busyRetry.attemptSpinMs, busyRetry.maxGateMs ?? DEFAULT_MAX_GATE_MS),
    );
  }

  query<T>(sql: string, params: DbParam[] = []): Promise<T[]> {
    return this.execute(sql, (db) => db.query<T, DbParam[]>(sql).all(...params));
  }

  get<T>(sql: string, params: DbParam[] = []): Promise<T | null> {
    return this.execute(sql, (db) => db.query<T, DbParam[]>(sql).get(...params));
  }

  run(sql: string, params: DbParam[] = []): Promise<{ changes: number }> {
    return this.execute(sql, (db) => {
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
      sql,
      (db) => {
        db.query(sql).run(...params);
        // bun:sqlite's `run().changes` also counts rows touched by foreign-key
        // actions (an ON DELETE SET NULL child update counts as a change), so
        // a DELETE on a self-referencing table reports up to twice the rows it
        // removed. SQLite's changes() counts only the statement's own rows.
        // Same connection, still inside the lock: nothing can run in between.
        const own = db.query("SELECT changes() AS n").get() as { n: number } | null;
        return { changes: own?.n ?? 0 };
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
      // The FINAL attempt spins `finalAttemptSpinMs`, never the ambient
      // busy_timeout: a 5s synchronous camp froze every in-flight request.
      // The dense 500ms backoff tail catches a periodic holder's release gap
      // instead (see DEFAULT_BUSY_RETRY).
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
    finalAttempt = false,
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
          this.shortSpin(db, () => db.run("BEGIN IMMEDIATE"), finalAttempt);
          this.gate.recordRecovered();
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
        await this.retryHoldingLock(() => this.shortSpin(db, () => db.run("COMMIT"), false, false));
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
    sql: string,
    op: (db: Database) => T,
    recordExecutionMs?: (ms: number) => void,
  ): Promise<T> {
    // Wraps ONLY the synchronous driver call, so lock acquisition above and
    // backoff sleeps below are never charged to the statement. Called once per
    // attempt; a retrying statement reports the sum. See DbClient.runTimed.
    // A BUSY attempt that will be retried is not logged as slow: its block is
    // capped at `attemptSpinMs` by construction.
    const timed = (attempt: () => T, retryable = false): T => {
      const startedAt = performance.now();
      let willRetry = false;
      try {
        return attempt();
      } catch (err) {
        willRetry = retryable && isSqliteBusy(err);
        throw err;
      } finally {
        const ms = performance.now() - startedAt;
        recordExecutionMs?.(ms);
        if (!willRetry) warnIfSlowStatement(sql, ms);
      }
    };
    // The first call opens the database and applies migrations; resolve it
    // before the timer, so boot work is not logged as this statement's cost.
    // Outside a transaction it resolves inside the retry loop, so a boot that
    // hits SQLITE_BUSY boots again.
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) {
      const db = this.getDatabase();
      return timed(() => op(db));
    }
    let sleptMs = 0;
    let sawBusy = false;
    for (let attemptIndex = 0; ; attemptIndex++) {
      const next = this.busyRetry.backoffMs[attemptIndex];
      const canRetryAfter = next !== undefined && sleptMs + next <= this.busyRetry.maxWaitMs;
      const release = await this.lock.acquire();
      let backoff = 0;
      try {
        // A top-level single statement is atomic, so a repeat on BUSY is
        // exact. The final attempt spins `finalAttemptSpinMs` (see
        // transaction()).
        const db = this.getDatabase();
        const result = timed(() => this.shortSpin(db, () => op(db), !canRetryAfter), canRetryAfter);
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

  /**
   * Run a driver attempt under a short `busy_timeout` so the synchronous
   * in-driver busy wait blocks the event loop for at most `attemptSpinMs`
   * (`finalAttemptSpinMs` for the final attempt). Only called while the FIFO
   * lock is held, so the set/attempt/restore sequence cannot interleave with
   * other client work.
   */
  private shortSpin<T>(db: Database, attempt: () => T, finalAttempt = false, gateable = true): T {
    if (this.restoreBusyTimeoutMs === null) {
      const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
      this.restoreBusyTimeoutMs = row?.timeout ?? 5000;
    }
    // While a holder is known (BusyGate) the attempt runs without a spin: it
    // still tries, so a released lock is taken at once, but a held one costs
    // microseconds of event loop instead of a full spin per queued writer.
    // Only the spinning probe that follows a lapsed gate reports BUSY back.
    const gated = gateable && this.gate.isOpen();
    const spinMs = gated
      ? 0
      : finalAttempt
        ? (this.busyRetry.finalAttemptSpinMs ?? DEFAULT_FINAL_ATTEMPT_SPIN_MS)
        : this.busyRetry.attemptSpinMs;
    db.exec(`PRAGMA busy_timeout = ${spinMs}`);
    try {
      return attempt();
    } catch (err) {
      if (gateable && !gated && isSqliteBusy(err)) this.gate.recordBusy();
      throw err;
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
        timedStatement(sql, () =>
          guard()
            .query<T, DbParam[]>(sql)
            .all(...params),
        ),
      get: async <T>(sql: string, params: DbParam[] = []): Promise<T | null> =>
        timedStatement(sql, () =>
          guard()
            .query<T, DbParam[]>(sql)
            .get(...params),
        ),
      run: async (sql: string, params: DbParam[] = []): Promise<{ changes: number }> => {
        const result = timedStatement(sql, () =>
          guard()
            .query(sql)
            .run(...params),
        );
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

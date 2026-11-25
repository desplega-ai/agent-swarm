/**
 * The driver seam. Each engine package implements `DbClient` over its own
 * driver; nothing outside the storage packages sees it (check:storage-boundary).
 *
 * The interface is deliberately minimal and portable:
 * - no prepared-statement objects cross the boundary (SQL text + positional
 *   params only),
 * - no `lastInsertRowid` (use `RETURNING` and read the row back),
 * - every method is async even where the driver resolves synchronously.
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
   * Declare the callback SELECT-only. On SQLite the transaction then opens
   * with a deferred BEGIN and never contends for the cross-process write
   * lock. Only set it on genuinely SELECT-only callbacks.
   */
  readOnly?: boolean;
  /**
   * Wall-clock deadline (epoch ms) for the whole transaction, BEGIN retries
   * included. Past it the transaction rolls back with
   * `DbTransactionDeadlineError`.
   */
  deadlineAt?: number;
  /**
   * Decision D7 opt-down: run this transaction at READ COMMITTED instead of
   * SERIALIZABLE (Postgres). Allowed only for a site whose stress scenario
   * measured a retry rate above 5%; the call site must take explicit row
   * locks for every read-then-write invariant and state the reason in a
   * comment. SQLite ignores it: its write transactions are serial.
   */
  isolation?: "read committed";
};

export class DbTransactionDeadlineError extends Error {
  constructor() {
    super("db-client: transaction passed its deadline and was rolled back");
    this.name = "DbTransactionDeadlineError";
  }
}

export interface DbClient extends DbExecutor {
  /**
   * Run `fn` atomically. Client-level calls made while the callback runs are
   * routed into the same transaction (AsyncLocalStorage). Nested calls become
   * SAVEPOINTs (opts are ignored for them).
   *
   * The callback may run more than once (decision D6: Postgres retries on a
   * serialization failure, `--tx-replay` replays every first attempt). It must
   * therefore have no side effect outside the database: put those in
   * `afterCommit`.
   */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /**
   * `run`, plus the wall time the driver spent executing the statement
   * (lock waits and retry sleeps excluded). `changes` counts only the rows the
   * statement itself changed, never rows touched by foreign-key actions.
   */
  runTimed(sql: string, params?: DbParam[]): Promise<{ changes: number; executionMs: number }>;
  /**
   * Run `fn` after the open outermost transaction COMMITs. Hooks of an attempt
   * that rolls back are discarded. With no transaction open it runs on the
   * next turn. An async hook is fire-and-forget; a rejection is logged.
   */
  afterCommit(fn: () => void | Promise<void>): void;
  /**
   * Run `fn` synchronously right after the open outermost transaction COMMITs,
   * before `transaction()` resolves. Savepoints and failed attempts drop it as
   * they drop `afterCommit`. Only for in-process state that must not lag the
   * commit (a cache epoch), never for I/O: put side effects in `afterCommit`.
   * With no transaction open it runs now.
   */
  onCommit(fn: () => void): void;
  /**
   * Run `fn` synchronously when the open outermost transaction rolls back for
   * good (the last attempt). Dropped on commit. With no transaction open it
   * does nothing.
   */
  afterRollback(fn: () => void): void;
  /**
   * Run `fn` synchronously when the current attempt of the open outermost
   * transaction rolls back, also when the client then runs the callback
   * again (decision D6: a Postgres retry, a `--tx-replay` first attempt).
   * Dropped on commit. Only for undoing in-process state that the attempt
   * set up (a hold, a claim mark), never for a side effect: those go in
   * `afterCommit` or `afterRollback`. With no transaction open it does nothing.
   */
  onAttemptRollback(fn: () => void): void;
  /** True while the current async context is inside an open transaction. */
  inTransaction(): boolean;
}

/**
 * Process hooks an engine client reports to. The API server injects them so
 * the storage packages never import from `src/` (logging, secret scrubbing,
 * event-loop accounting stay owned by the server).
 */
export type StatementObserver = {
  /** Called after each driver call with its SQL text and duration. */
  onStatement?: (sql: string, durationMs: number) => void;
  /** Called with a ready log line for a statement that blocked too long. */
  onSlowStatement?: (sql: string, durationMs: number) => void;
  /** Called once per outermost transaction when it ends (Postgres). */
  onTransaction?: (info: TransactionObservation) => void;
};

export type TransactionObservation = {
  /** Attempts the callback ran, counting the last one (a `--tx-replay` replay does not count). */
  attempts: number;
  /** SQLSTATE of each retried attempt (40001, 40P01). */
  retries: readonly string[];
  /** `exhausted`: the last attempt failed retryably and no attempt was left. */
  outcome: "commit" | "rollback" | "exhausted";
};

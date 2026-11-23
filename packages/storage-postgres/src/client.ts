import { AsyncLocalStorage } from "node:async_hooks";
import {
  type DbClient,
  type DbExecutor,
  type DbParam,
  DbTransactionDeadlineError,
  type StatementObserver,
  type TransactionOptions,
} from "@desplega/storage";
import { decodeRows, type ResultColumn, type TimestampFormats } from "./codec";
import { type CheckMessages, mapPostgresError, SQLSTATE } from "./errors";
import { checkOwnerFence, mayWrite, type OwnerFence } from "./owner-fence";

/**
 * The Postgres engine client over `Bun.SQL` (decision D14).
 *
 * - One pool. Statements outside a transaction run on any pooled connection.
 * - A transaction pins one connection (`sql.begin`). Client calls made inside
 *   the callback join it through AsyncLocalStorage; a nested `transaction`
 *   becomes a SAVEPOINT on the same connection.
 * - Every connection defaults to SERIALIZABLE (decision D6). A transaction that
 *   fails with SQLSTATE 40001 or 40P01 runs again, whole, with a bounded
 *   jittered backoff. The hooks of a failed attempt are discarded:
 *   `onAttemptRollback` hooks run at once, `afterRollback` hooks run only when
 *   the last attempt fails, `afterCommit` hooks run only after COMMIT. A
 *   statement outside a transaction that fails with 40001 or 40P01 changed
 *   nothing and runs again, with the same backoff.
 * - `txReplay` (the `--tx-replay` e2e mode) rolls back the first attempt of
 *   every outermost transaction and runs the callback again.
 */

/** The parts of a `Bun.SQL` handle this client uses (pool, transaction or savepoint). */
type SqlHandle = {
  unsafe(text: string, params?: unknown[]): Promise<PgResult>;
};
type TxHandle = SqlHandle & {
  savepoint<T>(fn: (sp: TxHandle) => Promise<T>): Promise<T>;
};
type PoolHandle = SqlHandle & {
  begin<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  begin<T>(options: string, fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  reserve(): Promise<SqlHandle & { release(): void }>;
  close(opts?: { timeout?: number }): Promise<void>;
};
type PgResult = Record<string, unknown>[] & {
  count?: number | null;
  statement?: { columns?: ResultColumn[] };
};

export type PostgresRetryOptions = {
  /** Attempts in total, the first one included. */
  maxAttempts: number;
  /** Base backoff before attempt 2; doubles per attempt, with full jitter. */
  baseBackoffMs: number;
  /** Upper bound of one backoff. */
  maxBackoffMs: number;
};

export const DEFAULT_POSTGRES_RETRY: PostgresRetryOptions = {
  maxAttempts: 16,
  baseBackoffMs: 5,
  maxBackoffMs: 1000,
};

export type PostgresClientOptions = {
  /** Pool size. */
  max?: number;
  retry?: PostgresRetryOptions;
  /** Roll back the first attempt of each outermost transaction (decision D6 proof). */
  txReplay?: boolean;
  observer?: StatementObserver;
  /**
   * Text formats of timestamptz columns for the read codec (decision D8).
   * Without it every timestamp reads as ISO text with milliseconds and `Z`.
   */
  timestampFormats?: TimestampFormats;
  /**
   * Return rows as the driver gives them, with no read codec. Only for tools
   * that inspect the Postgres catalog itself (check:schema-parity).
   */
  rawValues?: boolean;
  /** SQLite's CHECK failure texts by constraint name, for error messages equal to SQLite's. */
  checkMessages?: CheckMessages;
  /** Called once per retried attempt, with the SQLSTATE that caused it (bench, diagnostics). */
  onRetry?: (sqlstate: string, attempt: number) => void;
  /**
   * Called once per outermost transaction when it ends (bench only: the caller
   * stack is captured only when this is set). `retries` holds the SQLSTATE of
   * each retried attempt; `exhausted` means the last attempt failed retryably.
   */
  onTransactionEnd?: (info: TransactionEndInfo) => void;
  /**
   * The write fence of the one-process lock (owner-fence.ts). Set by the API:
   * each read-write transaction, and each statement outside a transaction that
   * may write, first checks that this process still owns the database.
   */
  fence?: OwnerFence;
};

export type TransactionEndInfo = {
  /** `new Error().stack` at the transaction call. */
  stack: string;
  attempts: number;
  retries: string[];
  outcome: "commit" | "error" | "exhausted";
};

type TxContext = {
  closed: boolean;
  handle: TxHandle;
  /**
   * Shared by the outermost transaction and its savepoints: the SQLSTATE of a
   * retryable failure (40001, 40P01) that a statement hit, even when the
   * callback caught it. Postgres aborts the transaction either way, so the
   * client retries the whole callback (D6) instead of failing at COMMIT.
   */
  failure: { retryable: string | null };
  afterCommit: (() => void | Promise<void>)[];
  afterRollback: (() => void)[];
  attemptRollback: (() => void)[];
};

const txContext = new AsyncLocalStorage<TxContext>();

/** Thrown inside `sql.begin` to roll back a replayed first attempt. */
/**
 * A retryable failure (40001, 40P01) that a statement hit and the callback
 * caught, for example around a savepoint. The callback returned, but the
 * transaction must not commit: it rolls back and the whole callback runs again.
 */
class SwallowedRetryableFailure extends Error {
  constructor(readonly errno: string) {
    super(
      `[pg-client] the transaction caught a retryable failure (SQLSTATE ${errno}) and cannot commit`,
    );
  }
}

class ReplayRollback extends Error {
  constructor(readonly value: unknown) {
    super("tx-replay: first attempt rolled back");
  }
}

function runHooks(hooks: (() => void)[], label: string): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch (err) {
      console.error(`[pg-client] ${label} hook threw:`, err);
    }
  }
}

function sqlstateOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as { errno?: unknown; cause?: unknown };
  if (typeof record.errno === "string") return record.errno;
  return sqlstateOf(record.cause);
}

function isRetryable(err: unknown): boolean {
  const state = sqlstateOf(err);
  return state === SQLSTATE.serializationFailure || state === SQLSTATE.deadlockDetected;
}

function bindParams(params: DbParam[] | undefined): unknown[] {
  if (!params) return [];
  // Bun.SQL binds a JS boolean as boolean and a Uint8Array as bytea. A bigint
  // stays a bigint (int8).
  return params;
}

export class PostgresClient implements DbClient {
  /** Transactions retried after 40001/40P01 (diagnostics). */
  retriedAttempts = 0;
  /** Outermost transactions replayed under `txReplay` (diagnostics). */
  replayedTransactions = 0;
  private savepointCounter = 0;
  private readonly retry: PostgresRetryOptions;

  constructor(
    readonly pool: PoolHandle,
    private readonly options: PostgresClientOptions = {},
  ) {
    this.retry = options.retry ?? DEFAULT_POSTGRES_RETRY;
  }

  private handle(): SqlHandle {
    const ctx = txContext.getStore();
    return ctx && !ctx.closed ? ctx.handle : this.pool;
  }

  private async execute(text: string, params: DbParam[] | undefined): Promise<PgResult> {
    const ctx = txContext.getStore();
    const inTransaction = ctx !== undefined && !ctx.closed;
    if (!inTransaction && this.options.fence && mayWrite(text)) {
      return this.transaction(() => this.execute(text, params));
    }
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      try {
        return await this.handle().unsafe(text, bindParams(params));
      } catch (err) {
        // A statement outside a transaction is its own transaction (D6): one
        // that loses a serialization race changed nothing, so it runs again,
        // with the same bounded backoff. Inside a transaction the whole
        // callback retries instead, even when the callback catches the error.
        if (!inTransaction && isRetryable(err) && attempt < this.retry.maxAttempts) {
          this.retriedAttempts += 1;
          this.options.onRetry?.(sqlstateOf(err) ?? "", attempt);
          await Bun.sleep(this.backoffMs(attempt));
          continue;
        }
        if (inTransaction && isRetryable(err)) ctx.failure.retryable ??= sqlstateOf(err) ?? "";
        throw mapPostgresError(err, this.options.checkMessages);
      } finally {
        this.options.observer?.onStatement?.(text, performance.now() - started);
      }
    }
  }

  async query<T>(text: string, params?: DbParam[]): Promise<T[]> {
    const rows = await this.execute(text, params);
    return this.decode(rows) as T[];
  }

  async get<T>(text: string, params?: DbParam[]): Promise<T | null> {
    const rows = await this.execute(text, params);
    if (rows.length === 0) return null;
    return (this.decode(rows.slice(0, 1) as PgResult, rows.statement?.columns)[0] ??
      null) as T | null;
  }

  private decode(rows: PgResult, columns = rows.statement?.columns): Record<string, unknown>[] {
    if (this.options.rawValues === true) return [...rows] as Record<string, unknown>[];
    return decodeRows(rows, columns, this.options.timestampFormats ?? null);
  }

  async run(text: string, params?: DbParam[]): Promise<{ changes: number }> {
    const rows = await this.execute(text, params);
    return { changes: Number(rows.count ?? 0) };
  }

  async runTimed(
    text: string,
    params?: DbParam[],
  ): Promise<{ changes: number; executionMs: number }> {
    const started = performance.now();
    const { changes } = await this.run(text, params);
    return { changes, executionMs: performance.now() - started };
  }

  async transaction<T>(
    fn: (tx: DbExecutor) => Promise<T>,
    opts: TransactionOptions = {},
  ): Promise<T> {
    const outer = txContext.getStore();
    if (outer && !outer.closed) return this.savepoint(outer, fn);

    let replayPending = this.options.txReplay === true;
    // The caller stack is captured only for the bench sink: it is not free.
    const stack = this.options.onTransactionEnd ? (new Error().stack ?? "") : "";
    const retries: string[] = [];
    const end = (attempts: number, outcome: TransactionEndInfo["outcome"]) => {
      this.options.onTransactionEnd?.({ stack, retries, attempts, outcome });
      this.options.observer?.onTransaction?.({
        attempts,
        retries,
        outcome: outcome === "error" ? "rollback" : outcome,
      });
    };
    for (let attempt = 1; ; attempt++) {
      if (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt) {
        throw new DbTransactionDeadlineError();
      }
      const replaying = replayPending;
      replayPending = false;
      let ctx: TxContext | undefined;
      try {
        const value = await this.pool.begin(
          (opts.isolation === "read committed" ? "isolation level read committed " : "") +
            (opts.readOnly ? "read only" : "read write"),
          async (handle) => {
            ctx = {
              closed: false,
              handle,
              failure: { retryable: null },
              afterCommit: [],
              afterRollback: [],
              attemptRollback: [],
            };
            const active = ctx;
            if (this.options.fence && !opts.readOnly) {
              await checkOwnerFence(handle, this.options.fence);
            }
            const result = await txContext.run(active, () => fn(this.boundExecutor(active)));
            // A serialization failure inside a savepoint that the callback caught
            // leaves the outer transaction usable, but its reads are no longer
            // serializable: roll back and run the whole callback again.
            if (active.failure.retryable !== null) {
              throw new SwallowedRetryableFailure(active.failure.retryable);
            }
            if (replaying) throw new ReplayRollback(result);
            if (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt) {
              throw new DbTransactionDeadlineError();
            }
            active.closed = true;
            return result;
          },
        );
        // Committed.
        const committed = ctx as TxContext | undefined;
        if (committed) {
          committed.closed = true;
          for (const hook of committed.afterCommit) this.scheduleHook(hook);
        }
        end(attempt, "commit");
        return value;
      } catch (rawErr) {
        const failed = ctx as TxContext | undefined;
        if (failed) failed.closed = true;
        if (rawErr instanceof ReplayRollback) {
          this.replayedTransactions += 1;
          if (failed) runHooks(failed.attemptRollback, "onAttemptRollback");
          attempt -= 1; // the replayed attempt does not count against retries
          continue;
        }
        const err = mapPostgresError(rawErr, this.options.checkMessages);
        if (failed) runHooks(failed.attemptRollback, "onAttemptRollback");
        // A retryable failure the callback swallowed still aborted the transaction.
        const retryState = isRetryable(rawErr)
          ? (sqlstateOf(rawErr) ?? "")
          : (failed?.failure.retryable ?? null);
        if (retryState !== null && attempt < this.retry.maxAttempts) {
          this.retriedAttempts += 1;
          this.options.onRetry?.(retryState, attempt);
          retries.push(retryState);
          await Bun.sleep(this.backoffMs(attempt));
          continue;
        }
        if (failed) runHooks(failed.afterRollback, "afterRollback");
        end(attempt, retryState !== null ? "exhausted" : "error");
        throw err;
      }
    }
  }

  private backoffMs(attempt: number): number {
    const cap = Math.min(this.retry.maxBackoffMs, this.retry.baseBackoffMs * 2 ** (attempt - 1));
    return Math.random() * cap;
  }

  private async savepoint<T>(outer: TxContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    this.savepointCounter += 1;
    // afterCommit hooks wait in their own list until the savepoint is
    // released: a savepoint that rolls back drops its writes, so it drops
    // their hooks too. The other hook lists are the outermost transaction's.
    const savepointHooks: (() => void | Promise<void>)[] = [];
    let result: T;
    try {
      result = await outer.handle.savepoint(async (sp) => {
        const inner: TxContext = {
          closed: false,
          handle: sp,
          failure: outer.failure,
          afterCommit: savepointHooks,
          afterRollback: outer.afterRollback,
          attemptRollback: outer.attemptRollback,
        };
        try {
          return await txContext.run(inner, () => fn(this.boundExecutor(inner)));
        } finally {
          inner.closed = true;
        }
      });
    } catch (err) {
      if (isRetryable(err)) outer.failure.retryable ??= sqlstateOf(err) ?? "";
      throw mapPostgresError(err, this.options.checkMessages);
    }
    outer.afterCommit.push(...savepointHooks);
    return result;
  }

  /**
   * The executor a transaction callback receives: bound to that attempt (or
   * savepoint), it runs on the attempt's connection even outside its async
   * context, and it throws once the attempt ends. A retained handle can then
   * never write through the pool after a rollback.
   */
  private boundExecutor(ctx: TxContext): DbExecutor {
    const guard = <R>(call: () => Promise<R>): Promise<R> => {
      if (ctx.closed) {
        return Promise.reject(
          new Error("[pg-client] transaction handle used after its transaction ended"),
        );
      }
      return txContext.run(ctx, call);
    };
    return {
      query: <T>(text: string, params?: DbParam[]) => guard(() => this.query<T>(text, params)),
      get: <T>(text: string, params?: DbParam[]) => guard(() => this.get<T>(text, params)),
      run: (text: string, params?: DbParam[]) => guard(() => this.run(text, params)),
    };
  }

  afterCommit(fn: () => void | Promise<void>): void {
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) {
      ctx.afterCommit.push(fn);
      return;
    }
    this.scheduleHook(fn);
  }

  afterRollback(fn: () => void): void {
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) ctx.afterRollback.push(fn);
  }

  onAttemptRollback(fn: () => void): void {
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) ctx.attemptRollback.push(fn);
  }

  inTransaction(): boolean {
    const ctx = txContext.getStore();
    return ctx !== undefined && !ctx.closed;
  }

  private scheduleHook(fn: () => void | Promise<void>): void {
    // Next turn, outside any transaction context, so the hook's own client
    // calls run on the pool.
    setTimeout(() => {
      txContext.exit(() => {
        try {
          const result = fn();
          if (result && typeof result.then === "function") {
            result.then(undefined, (err) =>
              console.error("[pg-client] afterCommit hook rejected:", err),
            );
          }
        } catch (err) {
          console.error("[pg-client] afterCommit hook threw:", err);
        }
      });
    }, 0);
  }

  async close(): Promise<void> {
    await this.pool.close({ timeout: 5 });
  }
}

export type PostgresConnectionOptions = {
  url: string;
  max?: number;
};

/** Open the pool with the session defaults of decision D6 (SERIALIZABLE, UTC). */
export function openPostgresPool(options: PostgresConnectionOptions): PoolHandle {
  return new Bun.SQL({
    url: options.url,
    max: options.max ?? 10,
    connection: { default_transaction_isolation: "serializable", TimeZone: "UTC" },
  }) as unknown as PoolHandle;
}

export function createPostgresClient(
  url: string,
  options: PostgresClientOptions = {},
): PostgresClient {
  return new PostgresClient(openPostgresPool({ url, max: options.max }), options);
}

export function isInPostgresTransaction(): boolean {
  const ctx = txContext.getStore();
  return ctx !== undefined && !ctx.closed;
}

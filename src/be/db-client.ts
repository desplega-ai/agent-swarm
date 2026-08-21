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

export interface DbClient extends DbExecutor {
  /**
   * Run `fn` atomically. The callback receives an executor bound to the
   * transaction; awaiting it is safe. Client-level calls made (directly or
   * through helpers) while the callback runs are routed into the same
   * transaction via AsyncLocalStorage, mirroring how synchronous helpers
   * sharing one connection behaved before this seam existed. Nested
   * `transaction` calls become SAVEPOINTs.
   */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
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

class BunSqliteClient implements DbClient {
  private readonly lock = new FifoLock();
  private savepointSeq = 0;

  constructor(private readonly getDatabase: () => Database) {}

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

  async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const existing = txContext.getStore();
    if (existing && !existing.closed) {
      return this.savepoint(existing, fn);
    }

    const release = await this.lock.acquire();
    const ctx: TxContext = { closed: false, afterCommit: [] };
    let began = false;
    try {
      const db = this.getDatabase();
      const tx = this.boundExecutor(ctx);
      db.run("BEGIN");
      began = true;
      const result = await txContext.run(ctx, () => fn(tx));
      db.run("COMMIT");
      for (const hook of ctx.afterCommit) this.scheduleHook(hook);
      return result;
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
  private async execute<T>(op: (db: Database) => T): Promise<T> {
    const ctx = txContext.getStore();
    if (ctx && !ctx.closed) {
      return op(this.getDatabase());
    }
    const release = await this.lock.acquire();
    try {
      return op(this.getDatabase());
    } finally {
      release();
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
 * transparent to holders of the client.
 */
export function createBunSqliteClient(getDatabase: () => Database): DbClient {
  return new BunSqliteClient(getDatabase);
}

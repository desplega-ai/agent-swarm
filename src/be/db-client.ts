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
}

/**
 * FIFO promise-chain lock. All top-level operations are serialized through it
 * so a transaction's BEGIN..COMMIT window can never be interleaved by an
 * unrelated write on the shared connection. Acquisition is effectively free
 * when uncontended because the underlying driver calls are synchronous.
 */
class FifoLock {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(() => release);
  }
}

type TxContext = {
  /** Set once the outermost transaction commits or rolls back. */
  closed: boolean;
  /** SAVEPOINT nesting depth (0 = outermost BEGIN). */
  depth: number;
};

const txContext = new AsyncLocalStorage<TxContext>();

class BunSqliteClient implements DbClient {
  private readonly lock = new FifoLock();

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
    const db = this.getDatabase();
    const ctx: TxContext = { closed: false, depth: 0 };
    const tx = this.boundExecutor(ctx);
    db.run("BEGIN");
    try {
      const result = await txContext.run(ctx, () => fn(tx));
      db.run("COMMIT");
      return result;
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Connection-level failure while rolling back; surface the original error.
      }
      throw err;
    } finally {
      ctx.closed = true;
      release();
    }
  }

  private async savepoint<T>(ctx: TxContext, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const db = this.getDatabase();
    ctx.depth += 1;
    const name = `db_client_sp_${ctx.depth}`;
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
    } finally {
      ctx.depth -= 1;
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

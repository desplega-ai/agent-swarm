import type { DbClient, TransactionOptions } from "./client";
import type { Dialect } from "./dialect";
import type { SqlQuery } from "./sql";

/**
 * What a repository runs statements through: the engine client plus the
 * dialect that renders `sql` text for it. Calls made inside a transaction
 * join it through the client's async-context routing, so a repository never
 * receives a transaction handle.
 */
export class SqlExecutor {
  constructor(
    readonly client: DbClient,
    readonly dialect: Dialect,
  ) {}

  query<T>(query: SqlQuery): Promise<T[]> {
    const { text, params } = query.render(this.dialect);
    return this.client.query<T>(text, params);
  }

  get<T>(query: SqlQuery): Promise<T | null> {
    const { text, params } = query.render(this.dialect);
    return this.client.get<T>(text, params);
  }

  run(query: SqlQuery): Promise<{ changes: number }> {
    const { text, params } = query.render(this.dialect);
    return this.client.run(text, params);
  }

  runTimed(query: SqlQuery): Promise<{ changes: number; executionMs: number }> {
    const { text, params } = query.render(this.dialect);
    return this.client.runTimed(text, params);
  }

  transaction<T>(fn: () => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.client.transaction(() => fn(), opts);
  }
}

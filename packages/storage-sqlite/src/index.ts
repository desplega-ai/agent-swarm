import {
  type Capabilities,
  type DbClient,
  SqlExecutor,
  type Storage,
  type TransactionOptions,
} from "@desplega/storage";
import { sqliteDialect } from "./dialect";
import { SqliteExtensionsRepository } from "./repositories/extensions";

export {
  type BusyRetryOptions,
  createBunSqliteClient,
  isInTransaction,
  SLOW_STATEMENT_WARN_MS,
} from "./client";
export { sqliteDialect } from "./dialect";

export type SqliteStorageOptions = {
  /** sqlite-vec loaded into the connection. */
  vectorSearch: boolean;
};

/** Assemble the SQLite engine over an existing bun:sqlite client. */
export function createSqliteStorage(client: DbClient, options: SqliteStorageOptions): Storage {
  const executor = new SqlExecutor(client, sqliteDialect);
  const capabilities: Capabilities = {
    fullTextSearch: true,
    vectorSearch: options.vectorSearch,
    dbQuery: true,
    dbQueryDialect: "sqlite",
  };
  return {
    dialect: sqliteDialect,
    capabilities,
    executor,
    client,
    repos: {
      extensions: new SqliteExtensionsRepository(executor),
    },
    transaction: <T>(fn: () => Promise<T>, opts?: TransactionOptions) =>
      client.transaction(() => fn(), opts),
    afterCommit: (fn) => client.afterCommit(fn),
    afterRollback: (fn) => client.afterRollback(fn),
    inTransaction: () => client.inTransaction(),
  };
}

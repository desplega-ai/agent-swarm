/**
 * Compatibility exports for the async database seam. The interface lives in
 * `@desplega/storage`, the bun:sqlite client in `@desplega/storage-sqlite`.
 * Call sites move to repositories (`getStorage().repos`) domain by domain.
 */
export {
  type DbClient,
  type DbExecutor,
  type DbParam,
  DbTransactionDeadlineError,
  type TransactionOptions,
} from "@desplega/storage";
export {
  type BusyRetryOptions,
  createSqliteClient as createBunSqliteClient,
  isInTransaction,
} from "./storage-root";

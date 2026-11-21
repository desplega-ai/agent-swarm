import type { Capabilities } from "./capabilities";
import type { DbClient, TransactionOptions } from "./client";
import type { Dialect } from "./dialect";
import type { SqlExecutor } from "./executor";
import type { ExtensionsRepository } from "./repositories/extensions";
import type { ModelsRepository } from "./repositories/models";
import type { RuntimePoolsRepository } from "./repositories/runtime-pools";

/** Every domain repository, by domain name. */
export type Repositories = {
  extensions: ExtensionsRepository;
  models: ModelsRepository;
  runtimePools: RuntimePoolsRepository;
};

/**
 * One engine, assembled: its repositories, its capabilities and the
 * transaction entry point. The API server holds exactly one.
 */
export interface Storage {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  readonly repos: Repositories;
  /** The executor the repositories share. */
  readonly executor: SqlExecutor;
  /**
   * The engine client. Exposed only for the transition while call sites move
   * into repositories; check:storage-boundary rejects new uses outside the
   * storage packages.
   */
  readonly client: DbClient;
  /**
   * Run `fn` atomically. Repository calls inside it join the transaction. The
   * callback may run more than once (decision D6): side effects go in
   * `afterCommit`.
   */
  transaction<T>(fn: () => Promise<T>, opts?: TransactionOptions): Promise<T>;
  afterCommit(fn: () => void | Promise<void>): void;
  afterRollback(fn: () => void): void;
  inTransaction(): boolean;
}

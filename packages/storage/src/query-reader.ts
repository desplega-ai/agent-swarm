/**
 * The read-only connection behind `db-query` (Postgres brief D10). User SQL
 * runs here in the native dialect of the engine, never on the application
 * connection.
 */
/**
 * Tables whose rows are credentials: OAuth tokens and client secrets, PKCE
 * verifiers, API and session token hashes, encrypted script-API bearers, and
 * encrypted Codex device-login state. `db-query` never reads them: SQLite
 * checks the compiled program, Postgres the privileges of the reader role.
 */
export const DB_QUERY_DENIED_TABLES: ReadonlySet<string> = new Set([
  "oauth_authorizations",
  "oauth_apps",
  "oauth_pending",
  "user_tokens",
  "session_tokens",
  "script_apis",
  "codex_oauth_device_flows",
]);

export type QueryReaderResult = {
  columns: string[];
  rows: unknown[][];
  /** Milliseconds the query ran. */
  elapsed: number;
  /** Rows the query matched; `rows` holds at most `maxRows` of them. */
  total: number;
};

export type QueryReaderOptions = {
  /** Wall-clock budget: the engine cancels the statement after it. */
  budgetMs: number;
  maxRows?: number;
};

/** The query read a table that the reader role cannot see. */
export class QueryReaderDeniedError extends Error {
  constructor(readonly tables: string[]) {
    super(`permission denied for ${tables.join(", ")}`);
    this.name = "QueryReaderDeniedError";
  }
}

/** The statement is not a query (a write, DDL or another command): db-query runs only queries. */
export class QueryReaderNotQueryError extends Error {
  constructor() {
    super("Only read-only queries are allowed");
    this.name = "QueryReaderNotQueryError";
  }
}

/** The query ran past its budget and the engine cancelled it. */
export class QueryReaderTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(`query exceeded its ${budgetMs}ms budget`);
    this.name = "QueryReaderTimeoutError";
  }
}

export interface QueryReader {
  run(sql: string, params: unknown[], options: QueryReaderOptions): Promise<QueryReaderResult>;
  close(): Promise<void>;
}

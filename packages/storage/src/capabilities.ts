/**
 * Named features an engine declares. Code tests a capability, never the
 * engine name.
 */
export type Capabilities = {
  /** Remote script runners require PostgreSQL. */
  readonly scriptRunners: boolean;
  /** Ranked full-text search (FTS5 on SQLite, tsvector on Postgres). */
  readonly fullTextSearch: boolean;
  /** Vector similarity search (sqlite-vec on SQLite, pgvector on Postgres). */
  readonly vectorSearch: boolean;
  /** The read-only `db-query` tool is available on this engine. */
  readonly dbQuery: boolean;
  /** Which SQL dialect `db-query` accepts. */
  readonly dbQueryDialect: "sqlite" | "postgres";
};

export type CapabilityName = {
  [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities];

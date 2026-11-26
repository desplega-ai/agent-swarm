import { SwarmToolError, swarmToolHttpError } from "./swarm-tool-error";

/** SQL dialect of the swarm database, the storage engine's `dbQueryDialect` capability. */
export type ScriptDbDialect = "sqlite" | "postgres";

/** Portable SQL text, or one text per dialect. */
export type ScriptDbSql = string | { sqlite: string; postgres: string };

export type ScriptDbRow = Record<string, unknown>;

/** `ctx.db`: the run's database dialect and a query helper over `ctx.swarm.db_query`. */
export type ScriptDb = {
  readonly dialect: ScriptDbDialect;
  query(sql: ScriptDbSql, params?: unknown[]): Promise<ScriptDbRow[]>;
};

/** The dialect a run sees when the host sent none: the `db_query` response convention. */
export const DEFAULT_SCRIPT_DB_DIALECT: ScriptDbDialect = "sqlite";

/** The SQL text for `dialect`. Throws an `invalid_args` SwarmToolError on any other shape. */
export function selectDialectSql(sql: unknown, dialect: ScriptDbDialect): string {
  if (typeof sql === "string") return sql;
  if (sql !== null && typeof sql === "object" && !Array.isArray(sql)) {
    const texts = sql as Record<string, unknown>;
    if (typeof texts.sqlite === "string" && typeof texts.postgres === "string") {
      return texts[dialect] as string;
    }
  }
  throw new SwarmToolError(
    "ctx.db.query: sql must be a string or an object { sqlite: string; postgres: string }",
    { code: "invalid_args", tool: "db_query" },
  );
}

/** Rows of a `ctx.swarm.db_query` result as objects keyed by column name. Throws a SwarmToolError on a failed query. */
export function dbQueryRows(result: unknown): ScriptDbRow[] {
  const envelope = (result ?? {}) as { success?: unknown; status?: unknown; data?: unknown };
  const data = (envelope.data ?? null) as { error?: unknown; columns?: unknown; rows?: unknown };
  if (envelope.success !== true) {
    const reason =
      data && typeof data === "object" && "error" in data ? String(data.error) : "api failed";
    const status = typeof envelope.status === "number" ? envelope.status : 0;
    throw swarmToolHttpError(
      "db_query",
      status,
      `ctx.db.query failed with ${String(envelope.status)}: ${reason}`,
    );
  }
  if (!data || !Array.isArray(data.rows)) {
    throw new SwarmToolError("ctx.db.query: db_query returned no rows", {
      code: "upstream",
      tool: "db_query",
    });
  }
  const columns = Array.isArray(data.columns) ? (data.columns as string[]) : [];
  return data.rows.map((row: unknown) =>
    Array.isArray(row)
      ? Object.fromEntries(columns.map((column, i) => [column, row[i]]))
      : (row as ScriptDbRow),
  );
}

/**
 * Build `ctx.db`. `dbQuery` is the run's `ctx.swarm.db_query`, so a query has
 * the same permissions, limits and errors as a direct `db_query` call.
 */
export function createScriptDb(
  dialect: ScriptDbDialect,
  dbQuery: (args: { sql: string; params?: unknown[] }) => Promise<unknown>,
): ScriptDb {
  return Object.freeze({
    dialect,
    async query(sql: ScriptDbSql, params?: unknown[] | null): Promise<ScriptDbRow[]> {
      const text = selectDialectSql(sql, dialect);
      // quickjs sends an omitted `params` across the boundary as null.
      return dbQueryRows(await dbQuery(params == null ? { sql: text } : { sql: text, params }));
    },
  });
}

import type { KvJsonFieldFilter, SqlQuery } from "@desplega/storage";
import { BaseKvRepository, EMPTY, sql, sqlJoin } from "@desplega/storage";

/** The field name of a `$."field"` path (the only path shape callers build). */
function fieldOf(path: string): string {
  const match = /^\$\."([^"\\]*)"$/.exec(path);
  if (!match) throw new Error(`unsupported JSON field path: ${path}`);
  return match[1] as string;
}

export class PostgresKvRepository extends BaseKvRepository {
  /**
   * SQLite's `json_extract(value, path) = ?`: a JSON string compares as text,
   * a number as a number, `true`/`false` as 1/0 (a bound JS boolean binds as
   * 1/0 there too). Objects, arrays and null never match a scalar. `IS JSON`
   * guards corrupt rows, as `json_valid` does on SQLite.
   */
  protected jsonFieldEquals(filters: readonly KvJsonFieldFilter[]): SqlQuery {
    if (filters.length === 0) return EMPTY;
    return sqlJoin(
      filters.map((f) => {
        const field = fieldOf(f.path);
        const node = sql`((value::jsonb) -> CAST(${field} AS text))`;
        const guard = sql`value_type = 'json' AND value IS JSON`;
        if (typeof f.value === "string") {
          return sql` AND (CASE WHEN ${guard} AND jsonb_typeof(${node}) = 'string' THEN (${node} #>> '{}') END) = CAST(${f.value} AS text)`;
        }
        const n = typeof f.value === "boolean" ? (f.value ? 1 : 0) : f.value;
        return sql` AND (CASE WHEN ${guard} THEN (CASE jsonb_typeof(${node}) WHEN 'number' THEN (${node} #>> '{}')::numeric WHEN 'boolean' THEN (CASE WHEN (${node} #>> '{}') = 'true' THEN 1 ELSE 0 END) END) END) = CAST(${n} AS numeric)`;
      }),
      EMPTY,
    );
  }
}

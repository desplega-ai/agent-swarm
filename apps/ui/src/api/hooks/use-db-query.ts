import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { DbQueryDialect, DbQueryRequest } from "../types";

/**
 * Catalog SQL for each storage engine. Each response of `/api/db-query` names
 * its `dialect`, so the page probes once with SQL that runs on both engines.
 * On Postgres the catalog queries run as the restricted reader role: the
 * tables it cannot read (the credential tables) are not in the list.
 */
const CATALOG_SQL: Record<
  DbQueryDialect,
  { defaultQuery: string; tableList: string; tableColumns: string }
> = {
  sqlite: {
    defaultQuery: "SELECT name, type FROM sqlite_master WHERE type='table' ORDER BY name",
    tableList: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    // Returns: cid, name, type, notnull, dflt_value, pk
    tableColumns: "SELECT * FROM pragma_table_info(?)",
  },
  postgres: {
    defaultQuery:
      "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    tableList:
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND has_table_privilege(format('%I.%I', table_schema, table_name), 'SELECT') ORDER BY table_name",
    // The same columns as SQLite's pragma_table_info, from pg_catalog: the
    // reader role cannot see key constraints in information_schema.
    tableColumns:
      "SELECT a.attnum AS cid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS dflt_value, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = to_regclass(format('public.%I', $1::text)) AND has_table_privilege(a.attrelid, 'SELECT') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
  },
};

/** The default query of the Debug page for an engine. */
export function defaultDebugSql(dialect: DbQueryDialect): string {
  return CATALOG_SQL[dialect].defaultQuery;
}

/** On-demand query execution (mutation) */
export function useDbQuery() {
  return useMutation({
    mutationFn: ({ sql, params }: DbQueryRequest) => api.dbQuery(sql, params),
  });
}

/** SQL dialect of the API's storage engine, read from a probe that runs on both engines. */
export function useDbDialect() {
  return useQuery({
    queryKey: ["db-dialect"],
    // An API from before the `dialect` field runs SQLite only.
    queryFn: async (): Promise<DbQueryDialect> =>
      (await api.dbQuery("SELECT 1 AS ok")).dialect ?? "sqlite",
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** Auto-fetch table list for sidebar */
export function useTableList(dialect: DbQueryDialect | undefined) {
  return useQuery({
    queryKey: ["db-tables", dialect],
    queryFn: () => api.dbQuery(CATALOG_SQL[dialect as DbQueryDialect].tableList),
    enabled: !!dialect,
    staleTime: 30_000,
  });
}

/** Fetch table columns on demand */
export function useTableColumns(tableName: string | null, dialect: DbQueryDialect | undefined) {
  return useQuery({
    queryKey: ["db-table-columns", dialect, tableName],
    queryFn: () =>
      api.dbQuery(CATALOG_SQL[dialect as DbQueryDialect].tableColumns, [tableName as string]),
    enabled: !!tableName && !!dialect,
    staleTime: 60_000,
  });
}

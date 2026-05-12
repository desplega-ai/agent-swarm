import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { DbQueryRequest } from "../types";

/** On-demand query execution (mutation) */
export function useDbQuery() {
  return useMutation({
    mutationFn: ({ sql, params }: DbQueryRequest) => api.dbQuery(sql, params),
  });
}

/** Auto-fetch table list for sidebar */
export function useTableList() {
  return useQuery({
    queryKey: ["db-tables"],
    queryFn: () => api.dbQuery("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    staleTime: 30_000,
  });
}

/** Fetch table columns on demand */
export function useTableColumns(tableName: string | null) {
  return useQuery({
    queryKey: ["db-table-columns", tableName],
    queryFn: () => api.dbQuery(`PRAGMA table_info('${tableName}')`),
    enabled: !!tableName,
    staleTime: 60_000,
  });
}

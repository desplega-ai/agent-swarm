import type { QueryClient } from "@tanstack/react-query";

export const STATUS_QUERY_KEY = ["status"] as const;

export function invalidateStatusQuery(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
}

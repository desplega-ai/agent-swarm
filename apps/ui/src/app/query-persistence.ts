import { defaultShouldDehydrateQuery, type Query } from "@tanstack/react-query";

/**
 * Which queries the localStorage persister writes. agent-fs results (Comb's
 * file bytes, comments, and the human's identity) stay in memory only: their
 * keys start with "agent-fs".
 */
export function shouldPersistQuery(query: Query): boolean {
  return defaultShouldDehydrateQuery(query) && query.queryKey[0] !== "agent-fs";
}

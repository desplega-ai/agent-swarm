import { defaultShouldDehydrateQuery, type Query } from "@tanstack/react-query";
import { PALETTE_QUERY_ROOT } from "../lib/command-palette/identity";

/** Query roots kept in memory only. */
const MEMORY_ONLY = new Set<unknown>([
  // agent-fs results: Comb's file bytes, comments, and the human's identity.
  "agent-fs",
  // Cmd+K search answers, which can name a user's private tasks.
  PALETTE_QUERY_ROOT,
]);

/** Which queries the localStorage persister writes. */
export function shouldPersistQuery(query: Query): boolean {
  return defaultShouldDehydrateQuery(query) && !MEMORY_ONLY.has(query.queryKey[0]);
}

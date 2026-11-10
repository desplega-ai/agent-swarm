import { defaultShouldDehydrateQuery, type Query } from "@tanstack/react-query";
import { PALETTE_QUERY_ROOT } from "../lib/command-palette/identity";

/** Query roots kept in memory only. */
const MEMORY_ONLY = new Set<unknown>([
  // agent-fs results: Comb's file bytes, comments, and the human's identity.
  "agent-fs",
  // Cmd+K search answers, which can name a user's private tasks.
  PALETTE_QUERY_ROOT,
]);

/**
 * A session detail with more tasks than this stays in memory. The persister
 * writes the whole cache to localStorage synchronously on the main thread
 * after every poll, and a long session's chain runs to megabytes.
 */
export const MAX_PERSISTED_SESSION_TASKS = 100;

/** Which queries the localStorage persister writes. */
export function shouldPersistQuery(query: Query): boolean {
  if (!defaultShouldDehydrateQuery(query)) return false;
  const [root, , part] = query.queryKey;
  if (MEMORY_ONLY.has(root)) return false;
  // Raw harness logs: large, and refetched whenever a task card opens them.
  if (root === "task" && part === "session-logs") return false;
  if (root === "session") {
    const chain = (query.state.data as { chain?: unknown } | undefined)?.chain;
    if (Array.isArray(chain) && chain.length > MAX_PERSISTED_SESSION_TASKS) return false;
  }
  return true;
}

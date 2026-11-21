/**
 * The memory store's former name and module. The store runs on either engine
 * now (`StorageMemoryStore` in ./storage-store); these re-exports keep the
 * existing imports.
 */

// The FTS backfill statements live in the SQLite memory repository; re-exported
// for the query-plan test.
export { FTS_SCAN_BATCH_SQL, MEMORY_ID_BATCH_SQL } from "@/be/storage-root";
export {
  type AgentMemoryRow,
  applyEditMode,
  computeRrfScore,
  fusedSimilarity,
  rowToCandidate,
  SEARCH_HEALTH_TTL_MS,
  StorageMemoryStore as SqliteMemoryStore,
} from "./storage-store";

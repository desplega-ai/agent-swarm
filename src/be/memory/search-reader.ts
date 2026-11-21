/**
 * Memory search reads off the API event loop. The read pool belongs to the
 * SQLite engine (packages/storage-sqlite/src/memory/search-reader.ts) and the
 * memory store reaches it as `getStorage().memoryIndexes.searchReader`; these
 * re-exports keep the test and diagnostic entry points.
 */
export {
  __resetMemorySearchReaderForTests,
  memorySearchReader,
  memorySearchReaderStats,
  SEARCH_READ_WORKERS,
} from "@/be/storage-root";

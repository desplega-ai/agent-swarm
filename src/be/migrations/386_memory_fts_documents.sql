-- No-op on SQLite (decision D12: one file per engine with the same ordinal).
-- SQLite keeps memory full-text search in the run-time FTS5 table memory_fts,
-- which src/be/memory/providers/sqlite-store.ts creates outside the migration
-- chain. The Postgres file of this ordinal adds the Postgres form of memory_fts:
-- one stored text-search document per memory, written with the memory.
SELECT 1;

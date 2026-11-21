-- No-op on SQLite (decision D12: one file per engine with the same ordinal).
-- SQLite keeps memory full-text and vector search in the run-time tables
-- memory_fts (FTS5) and memory_vec (sqlite-vec vec0), which
-- src/be/memory/providers/sqlite-store.ts creates outside the migration chain
-- (memory_vec is sized from EMBEDDING_DIMENSIONS and needs the extension).
-- The Postgres file of this ordinal adds their Postgres forms.
SELECT 1;

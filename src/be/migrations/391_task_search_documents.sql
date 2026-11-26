-- No-op on SQLite. This ordinal adds the stored task search documents of
-- Postgres (src/be/migrations/postgres/391_task_search_documents.sql). SQLite
-- already stores them in the FTS5 table agent_tasks_fts (257), which its
-- triggers keep in sync.
SELECT 1;

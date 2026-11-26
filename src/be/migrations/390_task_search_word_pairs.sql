-- No-op on SQLite. This ordinal adds the Postgres word-pair index for phrase
-- search on task text (src/be/migrations/postgres/390_task_search_word_pairs.sql).
-- SQLite's FTS5 table agent_tasks_fts (257) stores word positions, so a phrase
-- is already an index lookup there.
SELECT 1;

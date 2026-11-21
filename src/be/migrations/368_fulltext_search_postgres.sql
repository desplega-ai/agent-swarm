-- No-op on SQLite. This ordinal adds the Postgres full-text search indexes
-- (src/be/migrations/postgres/368_fulltext_search_postgres.sql, decision D15).
-- SQLite already has its FTS5 counterparts: skills_fts (239), skills_meta_fts
-- (241) and agent_tasks_fts (257), kept in sync by their triggers.
SELECT 1;

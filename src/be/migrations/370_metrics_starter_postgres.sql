-- No-op on SQLite. This ordinal rewrites the seeded starter dashboard in Postgres
-- SQL (src/be/migrations/postgres/370_metrics_starter_postgres.sql). The SQLite
-- chain keeps the SQLite definition of migration 092.
SELECT 1;

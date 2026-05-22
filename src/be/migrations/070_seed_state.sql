-- 070_seed_state.sql
-- Generic seed-state tracking for the built-in entity seeder framework.
--
-- The seeder framework (src/be/seed) re-seeds version-controlled entity
-- definitions (scripts now; workflows / schedules / skills later) into the DB
-- at API boot. To avoid clobbering user edits, it must distinguish a "pristine"
-- upstream copy (still byte-identical to what we last seeded) from one a user
-- has modified since. This table records, per (kind, key), the content hash the
-- framework last wrote, so the next run can compare:
--   upstream == seededHash  -> pristine       (safe to update if source changed)
--   upstream != seededHash  -> user-modified  (never overwrite)
--
-- `kind` namespaces the key space so the same table serves every seedable
-- entity kind without further schema changes.

CREATE TABLE seed_state (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  seededHash TEXT NOT NULL,
  seededAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, key)
);

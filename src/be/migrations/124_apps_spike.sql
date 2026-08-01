-- Spike-only app definitions. Runtime model rows live in the existing KV store;
-- the complete app schema and json-render page tree are embedded as JSON here.
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

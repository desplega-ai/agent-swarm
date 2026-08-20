-- Search-result access tracking became authoritative in the worker/API code
-- after this migration. Existing accessCount=0 rows are historical unknowns,
-- not evidence that a memory was never consumed.
CREATE TABLE IF NOT EXISTS memory_access_tracking (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  startedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

INSERT OR IGNORE INTO memory_access_tracking (id, startedAt)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
